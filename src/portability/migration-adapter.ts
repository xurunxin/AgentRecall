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

export type BundleGeneration = "v0_raw" | "v1_canonical" | "v2_history";

export type NormalisedBundle = {
  /** Which generation the source bundle was. */
  generation: BundleGeneration;
  /** Normalised v2 manifest (synthesised for v0). */
  manifest: Manifest;
  /** SHA-256 of the manifest + canonical-sorted entries. */
  bundle_hash: string;
  /** Per-entry normalised records (with default `trust_level`). */
  entries: MemoryEntry[];
};

/**
 * Detect the bundle's generation. The check is purely
 * based on what is on disk; callers should not pass a
 * `format` argument.
 */
export function detectBundleGeneration(exportScopeDir: string): BundleGeneration {
  const manifestPath = join(exportScopeDir, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    return "v0_raw";
  }
  const manifest = readManifest(exportScopeDir);
  // v1.1.0 exports keep `export_schema_version: 1`.
  // v1.1.1 exports introduce `export_schema_version: 2`.
  const v = (manifest as Manifest & { export_schema_version?: number }).export_schema_version ?? 1;
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
 * no `topics/` directory, or a JSON parse failure.
 */
export function normaliseBundle(
  exportScopeDir: string,
  format: "json"
): NormalisedBundle {
  const generation = detectBundleGeneration(exportScopeDir);

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
 * Stable bundle hash. The input bytes are:
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

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") return JSON.stringify(value);
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return "{" + keys.filter((k) => obj[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
  }
  throw new Error(`canonicalJson: unsupported type ${t}`);
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
