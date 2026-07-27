// src/portability/migration-adapter.ts
//
// Stage 16 v1.1.1 PR-4 (issue #13, spec § 6.7): explicit
// migration adapter for older export bundles. The v1
// export/import contract used an ad-hoc shape; v1.0
// introduced the canonical model (`export_schema_version: 1`);
// v1.1 added history surfaces but no version bump. The
// v1.1.1 contract introduces:
//
//   - `export_schema_version: 2`
//   - `bundle_hash` (sha256 of manifest + sorted entries)
//   - `import_batch_id` (UUID; assigned at plan time)
//   - optional `history` block (memory_revisions, audit
//     events, provenance) for full-history mode
//   - `trust_level` field on every entry; missing
//     `trust_level` defaults to `"imported"` on import
//
// This adapter recognises three bundle generations and
// normalises each to the v2 import shape:
//
//   - v0 (pre-Stage-13, raw entries without canonical
//     manifest): recognised by absence of
//     `MANIFEST.json`. The adapter synthesises a
//     minimum v1 manifest and forces the entries
//     through the canonical serializer.
//   - v1 (Stage 13 PR10 → Stage 15 PR-M0-3): recognised
//     by `export_schema_version === 1`. No history
//     block. The adapter leaves the manifest alone and
//     only forces `trust_level` to `"imported"`.
//   - v2 (Stage 16 PR-4): native. No transformation.
//
// The adapter NEVER writes to disk. It returns a
// normalised bundle that the live importer can consume.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { MemoryEntry } from "../domain.js";
import { MANIFEST_FILENAME, readManifest, type Manifest } from "./manifest.js";
import {
  canonicalJson,
  FULL_HISTORY_BUNDLE_VERSION,
  type FullHistoryBundle,
  type FullHistoryRevisionRow,
  type FullHistoryAuditRow,
  type FullHistoryRelationRow,
  type FullHistoryProvenanceRow
} from "./canonical-model.js";

export type BundleGeneration = "v0_raw" | "v1_canonical" | "v2_history" | "v3_full_history";

export type NormalisedBundle = {
  /** Which generation the source bundle was. */
  generation: BundleGeneration;
  /** Normalised v2 manifest (synthesised for v0 / v1). */
  manifest: Manifest;
  /** SHA-256 of the manifest + canonical-sorted entries. */
  bundle_hash: string;
  /** Per-entry normalised records (with default `trust_level`). */
  entries: MemoryEntry[];
  /**
   * Stage 18 v1.1.2 (issue #25, task 6): the v3
   * full-history graph. Only set when `generation ===
   * "v3_full_history"`. The apply phase replays the
   * revisions / audit events / relations / provenance
   * into the target store inside one transaction. For
   * snapshot bundles the field is `undefined`.
   */
  history?: FullHistoryBundle;
  /**
   * Stage 18 v1.1.2 (issue #25, task 6): the source-side
   * `defaultActor` recorded in the v3 bundle's `source`
   * block. Used by the apply phase to label the
   * `imported` audit-event metadata so a reviewer can
   * trace the row back to the exact source-side writer.
   * Only set when the bundle is `v3_full_history`.
   */
  source_actor_id?: string;
};

/** Stable JSON serialisation; re-exported here so legacy
 *  callers can keep importing from migration-adapter.
 *  (The implementation lives in canonical-model.ts.) */
export { canonicalJson };

/** Stage 18 v1.1.2 (issue #25, task 6): the v3 full-history
 *  bundle is written as a single `BUNDLE.json` file at the
 *  scope root. The MANIFEST.json's `bundle_version` field
 *  is the canonical detection signal; we still tolerate
 *  presence of `BUNDLE.json` as a fallback for partial /
 *  hand-rolled exports. */
export const FULL_HISTORY_BUNDLE_FILENAME = "BUNDLE.json";

/**
 * Detect the bundle's generation. The check is purely
 * based on what is on disk; callers should not pass a
 * `format` argument. v3 is detected via the presence of
 * `BUNDLE.json` at the scope root (the canonical
 * detection signal — the MANIFEST.json's `bundle_version`
 * field is the secondary hint, and an unsupported
 * `bundle_version` is caught by the strict validator in
 * `normaliseV3Bundle`).
 */
export function detectBundleGeneration(exportScopeDir: string): BundleGeneration {
  // v3 is detected by the presence of BUNDLE.json.
  // A bundle with a `bundle_version` field that is not
  // 3 (or with no MANIFEST.json) is NOT v3 — those
  // bundles fall through to the v0 / v1 / v2 detection
  // path and the strict validator surfaces
  // `bundle_garbled` when the BUNDLE.json is read.
  const bundlePath = join(exportScopeDir, FULL_HISTORY_BUNDLE_FILENAME);
  if (existsSync(bundlePath)) {
    return "v3_full_history";
  }
  const manifestPath = join(exportScopeDir, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    return "v0_raw";
  }
  const manifest = readManifest(exportScopeDir);
  const v = (manifest as Manifest & { bundle_version?: number }).bundle_version
    ?? (manifest as Manifest & { export_schema_version?: number }).export_schema_version
    ?? 1;
  if (v >= 2) return "v2_history";
  return "v1_canonical";
}

/**
 * Read and normalise a bundle. Returns the v2-shaped
 * bundle the live importer can consume.
 *
 * The function never throws on a recoverable case
 * (missing `trust_level`, missing optional fields). It
 * throws on the unrecoverable cases: a v0 bundle with
 * no `topics/` directory, a v3 bundle missing the
 * `BUNDLE.json` file, or a JSON parse failure.
 *
 * v3 bundles are validated up-front: missing
 * sections, duplicate source memory_ids, broken
 * revision/relation/provenance references, and a
 * mismatched bundle_hash all throw with a stable
 * `bundle_garbled` envelope. The import-time preflight
 * surfaces the same envelope via `PreflightError`.
 */
export function normaliseBundle(
  exportScopeDir: string,
  format: "json"
): NormalisedBundle {
  const generation = detectBundleGeneration(exportScopeDir);

  if (generation === "v3_full_history") {
    return normaliseV3Bundle(exportScopeDir);
  }

  let manifest: Manifest;
  let entries: MemoryEntry[];

  if (generation === "v0_raw") {
    // Pre-Stage-13 bundles had no manifest. Synthesise
    // a minimum v1 manifest so the rest of the import
    // pipeline (which assumes a manifest is present) can
    // run unchanged.
    const topicFiles = collectTopicFiles(exportScopeDir, format);
    const collected: MemoryEntry[] = [];
    for (const file of topicFiles) {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { entries?: MemoryEntry[] };
      if (parsed.entries) {
        for (const e of parsed.entries) collected.push(e);
      }
    }
    entries = collected;
    manifest = {
      manifest_version: 1,
      export_schema_version: 1,
      source_schema_version: 1,
      scope: "global",
      generated_at: new Date(0).toISOString(),
      entry_count: entries.length,
      topic_count: 0,
      files: []
    };
  } else {
    manifest = readManifest(exportScopeDir);
    entries = readCanonicalEntries(exportScopeDir, format);
  }

  // Force every entry to a `trust_level`. v1 bundles
  // never carried the field; v2 bundles always do. The
  // default is `"imported"` so a tampered bundle cannot
  // silently claim a stronger trust tier.
  for (const entry of entries) {
    if (entry.trust_level === undefined) {
      entry.trust_level = "imported";
    }
  }

  const bundle_hash = computeBundleHash(manifest, entries);

  return { generation, manifest, bundle_hash, entries };
}

function normaliseV3Bundle(exportScopeDir: string): NormalisedBundle {
  const bundlePath = join(exportScopeDir, FULL_HISTORY_BUNDLE_FILENAME);
  if (!existsSync(bundlePath)) {
    throw new Error(
      `v3 bundle has no ${FULL_HISTORY_BUNDLE_FILENAME} at ${exportScopeDir}`
    );
  }
  const raw = readFileSync(bundlePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `${FULL_HISTORY_BUNDLE_FILENAME} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${FULL_HISTORY_BUNDLE_FILENAME} is not a JSON object`);
  }
  const bundle = validateV3Bundle(parsed as Record<string, unknown>);
  // The bundle_hash check: compute the hash over the
  // bundle's payload (excluding the `source` identity
  // block). A mismatch surfaces `bundle_garbled`.
  const manifest = readManifest(exportScopeDir);
  const recomputed = computeFullHistoryBundleHashFor(bundle);
  const manifestHash = (manifest as Manifest & { bundle_hash?: string }).bundle_hash;
  if (manifestHash !== undefined && manifestHash !== recomputed) {
    throw new Error(
      `v3 bundle_hash mismatch: manifest=${manifestHash} recomputed=${recomputed}`
    );
  }
  // Force every entry to a default `trust_level` (a
  // tampered v3 bundle cannot silently claim a stronger
  // tier — the apply phase downgrades to "imported"
  // unless `restore_trust: true` is also set).
  for (const entry of bundle.entries) {
    if (entry.trust_level === undefined) {
      entry.trust_level = "imported";
    }
  }
  // v3 uses the bundle's `generated_at`; the manifest's
  // `generated_at` is informational (file-system
  // metadata).
  const syntheticManifest: Manifest = {
    manifest_version: 1,
    export_schema_version: 3 as unknown as 1,
    source_schema_version: bundle.source.schema_version,
    scope:
      bundle.scope.kind === "project"
        ? `project/${bundle.scope.project_id ?? "unknown-project"}`
        : "global",
    generated_at: bundle.generated_at,
    entry_count: bundle.entries.length,
    topic_count: new Set(bundle.entries.map((e: MemoryEntry) => e.topic)).size,
    files: []
  };
  return {
    generation: "v3_full_history",
    manifest: syntheticManifest,
    bundle_hash: recomputed,
    entries: bundle.entries,
    history: bundle,
    source_actor_id: bundle.source.actor_id
  };
}

function collectTopicFiles(exportScopeDir: string, format: "json"): string[] {
  const topicsDir = join(exportScopeDir, "topics");
  if (!existsSync(topicsDir)) {
    throw new Error(
      `v0 bundle has no manifest and no topics/ directory at ${exportScopeDir}`
    );
  }
  return readdirSync(topicsDir)
    .filter((f) => f.endsWith(`.${format}`))
    .map((f) => join(topicsDir, f));
}

function readCanonicalEntries(exportScopeDir: string, format: "json"): MemoryEntry[] {
  const topicsDir = join(exportScopeDir, "topics");
  if (!existsSync(topicsDir)) return [];
  const collected: MemoryEntry[] = [];
  for (const filename of readdirSync(topicsDir)) {
    if (!filename.endsWith(`.${format}`)) continue;
    const parsed = JSON.parse(
      readFileSync(join(topicsDir, filename), "utf8")
    ) as { entries?: MemoryEntry[] };
    if (parsed.entries) {
      for (const e of parsed.entries) collected.push(e);
    }
  }
  return collected;
}

/**
 * Stable bundle hash for snapshot bundles. The input bytes
 * are:
 *   1. The manifest's `generated_at` (so a re-bundled
 *      export with a different `generated_at` is
 *      distinguishable from the original).
 *   2. The entry ids, sorted ascending.
 *   3. For each id, the canonical JSON of the entry
 *      (sorted keys).
 *
 * The hash is content-only; the manifest's own `files[]`
 * sha256 set is the on-disk integrity check, this hash
 * is the import-side integrity check.
 */
export function computeBundleHash(manifest: Manifest, entries: MemoryEntry[]): string {
  const sortedIds = [...entries.map((e) => e.id)].sort();
  const h = createHash("sha256");
  h.update(manifest.generated_at);
  h.update("\n");
  for (const id of sortedIds) {
    const e = entries.find((x) => x.id === id);
    if (e === undefined) continue;
    h.update(id);
    h.update("\n");
    h.update(canonicalJson(e));
    h.update("\n");
  }
  return h.digest("hex");
}

/**
 * Allocate a stable import batch id. Two imports of the
 * same bundle at different times get distinct ids. The
 * id is opaque (UUIDv4) and is recorded on every
 * `audit_events` row generated by the apply.
 */
export function newImportBatchId(): string {
  return randomUUID();
}

// ============================================================
// Stage 18 v1.1.2 (issue #25, task 6): v3 bundle validator
// and hash helper. The validator is intentionally strict
// — every cross-reference is checked and every array's
// ordering invariant is checked. The function throws with
// a structured message; the preflight surfaces the same
// error envelope via `PreflightError = "bundle_garbled"`.
// ============================================================

function computeFullHistoryBundleHashFor(bundle: FullHistoryBundle): string {
  // We strip the `source` identity block; everything
  // else participates in the hash (see
  // `computeFullHistoryBundleHash` in canonical-model.ts
  // for the rationale).
  const { source: _source, ...rest } = bundle;
  void _source;
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`v3 bundle: ${label} must be an array`);
  }
  for (const v of value) {
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`v3 bundle: ${label} must contain only non-empty strings`);
    }
  }
  return value as string[];
}

function validateArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`v3 bundle: ${label} must be an array`);
  }
  return value;
}

function validateString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`v3 bundle: ${label} must be a non-empty string`);
  }
  return value;
}

function validateNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`v3 bundle: ${label} must be a finite number`);
  }
  return value;
}

function validatePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(`v3 bundle: ${label} must be a JSON object`);
  }
  return value;
}

function validateScopeKind(value: unknown): "global" | "project" {
  if (value !== "global" && value !== "project") {
    throw new Error(`v3 bundle: scope.kind must be "global" or "project" (got ${JSON.stringify(value)})`);
  }
  return value;
}

function validateProvenanceSourceKind(
  value: unknown
): "issue" | "pr" | "commit" | "tool_call" | "session" | "import" {
  const valid = ["issue", "pr", "commit", "tool_call", "session", "import"];
  if (typeof value !== "string" || !valid.includes(value)) {
    throw new Error(`v3 bundle: provenance.source_kind must be one of ${valid.join(", ")} (got ${JSON.stringify(value)})`);
  }
  return value as "issue" | "pr" | "commit" | "tool_call" | "session" | "import";
}

function validateRevision(value: unknown): FullHistoryRevisionRow {
  const obj = validatePlainObject(value, "revision row");
  return {
    revision_id: validateString(obj.revision_id, "revision.revision_id"),
    memory_id: validateString(obj.memory_id, "revision.memory_id"),
    revision: validateNumber(obj.revision, "revision.revision"),
    actor_id: validateString(obj.actor_id, "revision.actor_id"),
    reason: obj.reason === null || obj.reason === undefined ? null : validateString(obj.reason, "revision.reason"),
    request_id: obj.request_id === null || obj.request_id === undefined ? null : validateString(obj.request_id, "revision.request_id"),
    session_id: obj.session_id === null || obj.session_id === undefined ? null : validateString(obj.session_id, "revision.session_id"),
    tool_call_id: obj.tool_call_id === null || obj.tool_call_id === undefined ? null : validateString(obj.tool_call_id, "revision.tool_call_id"),
    created_at: validateString(obj.created_at, "revision.created_at"),
    snapshot: validatePlainObject(obj.snapshot, "revision.snapshot")
  };
}

function validateAuditEvent(value: unknown): FullHistoryAuditRow {
  const obj = validatePlainObject(value, "audit row");
  return {
    event_id: validateString(obj.event_id, "audit.event_id"),
    memory_id: obj.memory_id === null || obj.memory_id === undefined ? null : validateString(obj.memory_id, "audit.memory_id"),
    scope: validateScopeKind(obj.scope),
    project_id: obj.project_id === null || obj.project_id === undefined ? null : validateString(obj.project_id, "audit.project_id"),
    event: validateString(obj.event, "audit.event"),
    reason: obj.reason === null || obj.reason === undefined ? null : validateString(obj.reason, "audit.reason"),
    actor_id: validateString(obj.actor_id, "audit.actor_id"),
    request_id: obj.request_id === null || obj.request_id === undefined ? null : validateString(obj.request_id, "audit.request_id"),
    session_id: obj.session_id === null || obj.session_id === undefined ? null : validateString(obj.session_id, "audit.session_id"),
    tool_call_id: obj.tool_call_id === null || obj.tool_call_id === undefined ? null : validateString(obj.tool_call_id, "audit.tool_call_id"),
    metadata: validatePlainObject(obj.metadata, "audit.metadata"),
    created_at: validateString(obj.created_at, "audit.created_at")
  };
}

function validateRelation(value: unknown): FullHistoryRelationRow {
  const obj = validatePlainObject(value, "relation row");
  return {
    from_memory_id: validateString(obj.from_memory_id, "relation.from_memory_id"),
    to_memory_id: validateString(obj.to_memory_id, "relation.to_memory_id"),
    relation_type: validateString(obj.relation_type, "relation.relation_type"),
    confidence: obj.confidence === null || obj.confidence === undefined
      ? null
      : validateNumber(obj.confidence, "relation.confidence"),
    metadata: validatePlainObject(obj.metadata, "relation.metadata"),
    created_at: validateString(obj.created_at, "relation.created_at")
  };
}

function validateProvenance(value: unknown): FullHistoryProvenanceRow {
  const obj = validatePlainObject(value, "provenance row");
  return {
    memory_id: validateString(obj.memory_id, "provenance.memory_id"),
    source_kind: validateProvenanceSourceKind(obj.source_kind),
    source_ref: validateString(obj.source_ref, "provenance.source_ref"),
    recorded_by: validateString(obj.recorded_by, "provenance.recorded_by"),
    recorded_at: validateNumber(obj.recorded_at, "provenance.recorded_at")
  };
}

function validateEntry(value: unknown): MemoryEntry {
  const obj = validatePlainObject(value, "entry row");
  if (typeof obj.id !== "string" || obj.id.length === 0) {
    throw new Error("v3 bundle: entry.id must be a non-empty string");
  }
  if (obj.scope !== "global" && obj.scope !== "project") {
    throw new Error(`v3 bundle: entry.scope must be "global" or "project" (got ${JSON.stringify(obj.scope)})`);
  }
  // The apply phase validates the rest via the
  // RememberInput path; we only require the entry shape
  // to be parseable here. The downstream preflight
  // schema check is the authoritative gate.
  return obj as unknown as MemoryEntry;
}

function validateV3Bundle(raw: Record<string, unknown>): FullHistoryBundle {
  if (raw.bundle_version !== FULL_HISTORY_BUNDLE_VERSION) {
    throw new Error(
      `v3 bundle: bundle_version must be ${FULL_HISTORY_BUNDLE_VERSION} (got ${JSON.stringify(raw.bundle_version)})`
    );
  }
  const source = validatePlainObject(raw.source, "source");
  const sourceActorId = validateString(source.actor_id, "source.actor_id");
  const sourceSchemaVersion = validateNumber(source.schema_version, "source.schema_version");
  const dataHomeFingerprint =
    source.data_home_fingerprint === undefined || source.data_home_fingerprint === null
      ? undefined
      : validateString(source.data_home_fingerprint, "source.data_home_fingerprint");
  const scope = validatePlainObject(raw.scope, "scope");
  const scopeKind = validateScopeKind(scope.kind);
  const scopeProjectId =
    scope.project_id === undefined || scope.project_id === null
      ? undefined
      : validateString(scope.project_id, "scope.project_id");
  if (scopeKind === "project" && scopeProjectId === undefined) {
    throw new Error("v3 bundle: scope.kind=project requires scope.project_id");
  }
  if (scopeKind === "global" && scopeProjectId !== undefined) {
    throw new Error("v3 bundle: scope.kind=global MUST NOT carry scope.project_id");
  }
  const generatedAt = validateString(raw.generated_at, "generated_at");

  const entries = validateArray(raw.entries, "entries").map((value) => validateEntry(value));
  // Duplicate source memory_ids are a contract
  // violation — the apply phase cannot resolve which
  // target id to use.
  const seenIds = new Set<string>();
  for (const e of entries) {
    if (seenIds.has(e.id)) {
      throw new Error(`v3 bundle: duplicate source memory_id: ${e.id}`);
    }
    seenIds.add(e.id);
  }

  const revisions = validateArray(raw.revisions, "revisions").map((value) => validateRevision(value));
  // Reference integrity: every revision.memory_id must
  // point to an entry id.
  for (const r of revisions) {
    if (!seenIds.has(r.memory_id)) {
      throw new Error(`v3 bundle: revision.memory_id ${JSON.stringify(r.memory_id)} does not match any entry.id`);
    }
  }
  // Ordering: revisions are sorted by
  // (memory_id ASC, revision ASC). A bundle that breaks
  // the contract surfaces `bundle_garbled` here.
  for (let i = 1; i < revisions.length; i += 1) {
    const a = revisions[i - 1]!;
    const b = revisions[i]!;
    const byMemory = a.memory_id < b.memory_id ? -1 : a.memory_id > b.memory_id ? 1 : 0;
    if (byMemory > 0 || (byMemory === 0 && a.revision > b.revision)) {
      throw new Error(
        `v3 bundle: revisions not sorted ascending by (memory_id, revision) at index ${i}`
      );
    }
  }
  // Revisions for a single memory must be unique on
  // (memory_id, revision).
  const seenRevs = new Set<string>();
  for (const r of revisions) {
    const key = `${r.memory_id}:${r.revision}`;
    if (seenRevs.has(key)) {
      throw new Error(`v3 bundle: duplicate revision ${key}`);
    }
    seenRevs.add(key);
  }

  const auditEvents = validateArray(raw.audit_events, "audit_events").map((value) => validateAuditEvent(value));
  // Reference integrity: every audit.memory_id (when
  // not null) must point to an entry id.
  for (const a of auditEvents) {
    if (a.memory_id !== null && !seenIds.has(a.memory_id)) {
      throw new Error(
        `v3 bundle: audit.memory_id ${JSON.stringify(a.memory_id)} (event ${a.event_id}) does not match any entry.id`
      );
    }
  }

  const relations = validateArray(raw.relations, "relations").map((value) => validateRelation(value));
  // Reference integrity: relation endpoints may point
  // outside the imported set (the v1.1.2 contract does
  // not chase cross-scope edges), but every endpoint
  // MUST be a non-empty string. We do NOT enforce
  // entry-set membership; the apply phase silently
  // produces a dangling edge in the target when an
  // endpoint is missing, mirroring the source's
  // behaviour.
  for (const r of relations) {
    if (r.from_memory_id.length === 0 || r.to_memory_id.length === 0) {
      throw new Error(
        `v3 bundle: relation endpoints must be non-empty (got ${JSON.stringify(r.from_memory_id)}->${JSON.stringify(r.to_memory_id)})`
      );
    }
  }

  const provenance = validateArray(raw.provenance, "provenance").map((value) => validateProvenance(value));
  for (const p of provenance) {
    if (!seenIds.has(p.memory_id)) {
      throw new Error(
        `v3 bundle: provenance.memory_id ${JSON.stringify(p.memory_id)} does not match any entry.id`
      );
    }
  }

  return {
    bundle_version: FULL_HISTORY_BUNDLE_VERSION,
    source: {
      actor_id: sourceActorId,
      schema_version: sourceSchemaVersion,
      ...(dataHomeFingerprint !== undefined ? { data_home_fingerprint: dataHomeFingerprint } : {})
    },
    scope: {
      kind: scopeKind,
      ...(scopeProjectId !== undefined ? { project_id: scopeProjectId } : {})
    },
    generated_at: generatedAt,
    entries,
    revisions,
    audit_events: auditEvents,
    relations,
    provenance
  };
}
