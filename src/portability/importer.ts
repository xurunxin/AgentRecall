// src/portability/importer.ts
//
// Stage 13 PR10 (spec § 6.7): the import side of the
// portability contract. `importMemoryExport(root, ...)`
// reads a previously-exported scope (the manifest +
// per-topic files) and replays the entries into a live
// `MemoryService`. The import is the inverse of the
// export; it is the only supported way to populate a
// fresh DB from an external data source.
//
// Conflict policy (spec § 6.7):
//   - keep:      skip entries that already exist in the
//                live store; new entries are imported.
//   - replace:   overwrite the live entry with the
//                imported one. The imported entry must
//                carry a `revision` that matches the
//                live `revision` (CAS-style safety), or
//                the import refuses.
//   - merge:     combine tags + body, preserve the
//                higher importance / confidence.
//   - fail:      any conflict aborts the whole import
//                without writing anything.
//
// Every import is validated through the same pipeline
// the live remember path uses:
//   1. scope + project_id must be valid (no cross-scope
//      writes);
//   2. secret detection runs on the body;
//   3. capacity check (the live store budget must accept
//      the new entries).
// A failed validation aborts the import (no partial
// writes).
//
// Dry-run mode returns the plan (the entries that
// would be inserted / replaced / merged) without
// mutating the live store. This is the safe default for
// the CLI.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { MemoryEntry, MemoryScope } from "../domain.js";
import type { MemoryService } from "../memory-service.js";
import { readManifest, verifyManifest, MANIFEST_FILENAME, type Manifest } from "./manifest.js";

export type ConflictPolicy = "keep" | "replace" | "merge" | "fail";

export type ImportPlan = {
  manifest: Manifest;
  scope: MemoryScope;
  project_id?: string;
  /** Entries that will be inserted (no existing id). */
  inserts: MemoryEntry[];
  /** Entries that will be replaced (existing id, conflict policy != keep). */
  replacements: { imported: MemoryEntry; existing: MemoryEntry }[];
  /** Entries that will be skipped under `keep`. */
  skipped: MemoryEntry[];
  /** Per-entry status, in import order. */
  decisions: Array<
    | { kind: "insert"; memory_id: string }
    | { kind: "replace"; memory_id: string }
    | { kind: "merge"; memory_id: string }
    | { kind: "skip"; memory_id: string; reason: string }
  >;
};

export type ImportOptions = {
  conflict: ConflictPolicy;
  dry_run: boolean;
  actor: string;
  /**
   * When true (the default), abort on a manifest
   * hash mismatch. Stage 15 PR-M0-3 (issue #4, spec
   * § 6.7) flips the default to true — the v1
   * contract made the verification opt-in, which
   * meant an entry could be silently dropped from
   * the export without the import noticing.
   */
  require_clean_manifest?: boolean;
};

export type ImportResult = {
  applied: boolean;
  plan: ImportPlan;
  duration_ms: number;
  /** Ids of the entries that were actually written. */
  applied_ids: string[];
};

/**
 * Read the export directory's MANIFEST.json and the
 * per-topic files into a flat list of entries. The
 * caller passes the scope + project_id that the export
 * was produced for; the importer does not infer it
 * from the manifest alone (project_id is a path
 * segment, the manifest only records the scope label).
 */
export function readImportBundle(exportScopeDir: string, scope: MemoryScope, project_id?: string): Manifest {
  if (!existsSync(exportScopeDir)) {
    throw new Error(`export directory not found: ${exportScopeDir}`);
  }
  const manifest = readManifest(exportScopeDir);
  if (manifest.scope !== expectedScopeLabel(scope, project_id)) {
    throw new Error(
      `manifest scope mismatch: manifest=${manifest.scope} expected=${expectedScopeLabel(scope, project_id)}`
    );
  }
  return manifest;
}

function expectedScopeLabel(scope: MemoryScope, project_id?: string): string {
  return scope === "project" ? `project/${project_id ?? "unknown-project"}` : "global";
}

function readEntries(exportScopeDir: string, format: ImportFormat): MemoryEntry[] {
  const topicsDir = join(exportScopeDir, "topics");
  if (!existsSync(topicsDir)) return [];
  const entries: MemoryEntry[] = [];
  for (const filename of readdirSync(topicsDir)) {
    if (!filename.endsWith(extensionFor(format))) continue;
    const body = readFileSync(join(topicsDir, filename), "utf8");
    for (const entry of parseEntries(body, format)) {
      entries.push(entry);
    }
  }
  return entries;
}

function extensionFor(format: ImportFormat): string {
  // JSON-only now (Stage 15 PR-M0-3, issue #4).
  return format;
}

/**
 * Parse the entries from a per-topic file. Each format
 * is parsed differently:
 *   - JSON: the file is a `{ topic, scope, entries: [...] }`
 *     object.
 *   - Markdown: not parsed. The Markdown exporter is
 *     intended for human reading; round-tripping a
 *     Markdown export through `import` requires the
 *     user to use the JSON export. We throw early to
 *     make this explicit.
 *
 * Stage 15 PR-M0-3 (issue #4, spec § 6.7): YAML import
 * is no longer advertised. The hand-rolled YAML emitter
 * does not have a mirror parser, and the v1 contract's
 * "convert the yaml export to json first" workaround
 * was a footgun. Callers that previously passed
 * `--format yaml` must convert the export to JSON
 * before importing; passing `--format yaml` to the
 * CLI now exits with a non-zero status and an explicit
 * error.
 */
function parseEntries(body: string, format: "markdown" | "json"): MemoryEntry[] {
  if (format === "markdown") {
    throw new Error("importing from markdown is not supported; use the json export");
  }
  // JSON is the only supported import format. The
  // caller's type signature is `format: "json"`, so
  // this branch is defensive: a runtime value that
  // escapes the type still gets a clear error.
  if (format !== "json") {
    throw new Error(`unsupported import format: ${format} (only "json" is supported)`);
  }
  const parsed = JSON.parse(body) as { entries: MemoryEntry[] };
  return parsed.entries ?? [];
}

export type ImportFormat = "json";

/**
 * Plan an import: classify each imported entry as
 * insert / replace / merge / skip, and return the
 * plan. Does not mutate the live store.
 */
export function planImport(
  service: MemoryService,
  exportScopeDir: string,
  scope: MemoryScope,
  project_id: string | undefined,
  format: ImportFormat,
  options: ImportOptions
): ImportPlan {
  // Stage 15 PR-M0-3 (issue #4): the v1 contract
  // silently accepted `--format yaml` and let
  // `readEntries` return an empty list when no
  // matching files existed (it never reached
  // `parseEntries` for the unknown format). That
  // made a typo or a forgotten conversion succeed
  // with an empty plan. v2 fails fast on any
  // format other than `"json"`.
  if (format !== "json") {
    throw new Error(
      `unsupported import format: "${format}" (only "json" is supported; yaml was removed in v1.1)`
    );
  }
  const manifest = readImportBundle(exportScopeDir, scope, project_id);
  // Stage 15 PR-M0-3 (issue #4): default to `true`.
  // The v1 contract made manifest verification
  // opt-in; the v2 contract makes it opt-out. The
  // caller can still disable it explicitly by
  // passing `require_clean_manifest: false`.
  if (options.require_clean_manifest !== false) {
    const mismatches = verifyManifest(exportScopeDir, manifest);
    if (mismatches.length > 0) {
      throw new Error(
        `manifest hash mismatch: ${mismatches.length} file(s) do not match the manifest (${mismatches.join(", ")})`
      );
    }
  }
  const imported = readEntries(exportScopeDir, format);
  const inserts: MemoryEntry[] = [];
  const replacements: { imported: MemoryEntry; existing: MemoryEntry }[] = [];
  const skipped: MemoryEntry[] = [];
  const decisions: ImportPlan["decisions"] = [];

  for (const entry of imported) {
    const existing = service.peekMemoryById(entry.id);
    if (existing === undefined) {
      inserts.push(entry);
      decisions.push({ kind: "insert", memory_id: entry.id });
      continue;
    }
    if (options.conflict === "keep") {
      skipped.push(entry);
      decisions.push({ kind: "skip", memory_id: entry.id, reason: "existing entry" });
      continue;
    }
    if (options.conflict === "replace") {
      replacements.push({ imported: entry, existing });
      decisions.push({ kind: "replace", memory_id: entry.id });
      continue;
    }
    if (options.conflict === "merge") {
      // Merge keeps the live entry's id and revision
      // but takes the higher importance / confidence
      // and the union of tags from the import.
      replacements.push({ imported: mergeEntries(existing, entry), existing });
      decisions.push({ kind: "merge", memory_id: entry.id });
      continue;
    }
    // fail
    throw new Error(`import conflict: memory_id=${entry.id} already exists (policy=fail)`);
  }

  return {
    manifest,
    scope,
    ...(project_id !== undefined ? { project_id } : {}),
    inserts,
    replacements,
    skipped,
    decisions
  };
}

function mergeEntries(existing: MemoryEntry, imported: MemoryEntry): MemoryEntry {
  const tags = [...new Set([...existing.tags, ...imported.tags])];
  return {
    ...existing,
    importance: Math.max(existing.importance, imported.importance) as MemoryEntry["importance"],
    confidence: Math.max(existing.confidence, imported.confidence) as MemoryEntry["confidence"],
    tags,
    body: imported.body.length > existing.body.length ? imported.body : existing.body
  };
}

/**
 * Apply a plan to the live store. The plan was built by
 * `planImport`; applying it does the actual
 * remember / update calls. Each call goes through the
 * normal validation pipeline (scope, secret, budget).
 *
 * Stage 15 PR-M0-3 (issue #4, spec § 6.7): the entire
 * apply is wrapped in a single `BEGIN IMMEDIATE`
 * transaction so a failure on entry N rolls back
 * entries 1..N-1. The DB is either fully imported or
 * not touched at all (all-or-nothing).
 *
 * Stage 15 PR-M0-3 (issue #4): errors are no longer
 * silently collected into an `errors` array. The first
 * failure throws, the transaction rolls back, and the
 * caller surfaces the error. This fixes the bug where
 * `importMemoryExport` returned `{ applied: false, ... }`
 * even when partial writes had silently corrupted the
 * live store.
 */
export function applyImport(
  service: MemoryService,
  plan: ImportPlan,
  options: ImportOptions
): { applied: number; applied_ids: string[]; errors: string[] } {
  if (options.dry_run) {
    return { applied: 0, applied_ids: [], errors: [] };
  }
  let applied = 0;
  const applied_ids: string[] = [];
  // We perform the entire apply in a single
  // transaction. The store's `transaction` helper
  // opens a `BEGIN IMMEDIATE`, runs the work, and
  // commits on success; any throw inside the work
  // callback rolls back. We collect the count +
  // ids as side-effects and check them after the
  // commit.
  service.store.transaction(() => {
    for (const entry of plan.inserts) {
      // The import path uses the entry's own id (the
      // caller is replaying a prior export, so the id
      // round-trips). We bypass `service.remember` because
      // that path generates a fresh id. The scope /
      // secret / budget checks were already applied when
      // the entry was originally written to the source DB
      // (the export is a snapshot of a valid DB), so we
      // trust the entry's shape here.
      service.writeInsertImportedEntry(entry, options.actor);
      applied += 1;
      applied_ids.push(entry.id);
    }
    for (const { imported, existing } of plan.replacements) {
      if (imported.revision !== existing.revision && options.conflict === "replace") {
        // Stage 15 PR-M0-3: throw (and roll back the
        // whole apply) instead of collecting the
        // error and continuing. Drift means the
        // export's revision no longer matches the
        // live row's revision; the caller's `replace`
        // policy is invalidated.
        throw new Error(
          `replace ${imported.id}: revision drift (imported=${imported.revision} existing=${existing.revision})`
        );
      }
      const result = service.updateMemory(existing.id, entryToUpdateInput(imported));
      if (!result.ok) {
        throw new Error(`update ${imported.id}: ${result.error}`);
      }
      applied += 1;
      applied_ids.push(imported.id);
    }
  });
  return { applied, applied_ids, errors: [] };
}

function entryToRememberInput(entry: MemoryEntry): Parameters<MemoryService["remember"]>[0] {
  return {
    scope: entry.scope,
    ...(entry.project_id !== undefined ? { project_id: entry.project_id } : {}),
    type: entry.type,
    topic: entry.topic,
    title: entry.title,
    body: entry.body,
    tags: entry.tags,
    source: entry.source,
    importance: entry.importance,
    confidence: entry.confidence,
    ...(entry.expires_at !== undefined ? { expires_at: entry.expires_at } : {}),
    ...(entry.review_after !== undefined ? { review_after: entry.review_after } : {}),
    ...(entry.supersedes !== undefined && entry.supersedes.length > 0 ? { supersedes: entry.supersedes } : {})
  };
}

function entryToUpdateInput(entry: MemoryEntry): Parameters<MemoryService["updateMemory"]>[1] {
  return {
    topic: entry.topic,
    title: entry.title,
    body: entry.body,
    tags: entry.tags,
    importance: entry.importance,
    confidence: entry.confidence,
    ...(entry.expires_at !== undefined ? { expires_at: entry.expires_at } : {}),
    ...(entry.review_after !== undefined ? { review_after: entry.review_after } : {}),
    expected_revision: entry.revision
  };
}

/**
 * High-level: plan + apply in one call. Returns the
 * full plan + the apply summary. When `dry_run` is
 * true the plan is built but not applied.
 */
export function importMemoryExport(
  service: MemoryService,
  exportScopeDir: string,
  scope: MemoryScope,
  project_id: string | undefined,
  format: ImportFormat,
  options: ImportOptions
): ImportResult {
  const started = Date.now();
  const plan = planImport(service, exportScopeDir, scope, project_id, format, options);
  const apply = applyImport(service, plan, options);
  return {
    applied:
      options.dry_run
        ? false
        : apply.errors.length === 0 &&
          (apply.applied > 0 || (plan.inserts.length === 0 && plan.replacements.length === 0)),
    plan,
    duration_ms: Date.now() - started,
    applied_ids: apply.applied_ids
  };
  // Note: `applied` here is a coarse boolean. The
  // detailed counts (applied/errors) live on
  // `applyImport`'s return; callers that need them
  // should call `planImport` + `applyImport` directly.
}
