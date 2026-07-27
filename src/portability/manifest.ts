// src/portability/manifest.ts
//
// Stage 13 PR10 (spec § 6.7): the export manifest. The
// manifest is a `MANIFEST.json` written next to the
// index file in every scope directory. It records the
// export's metadata + a SHA-256 hash + size for every
// emitted file (index + topic files), so:
//   - a downstream `import` can verify the export
//     directory was not corrupted on disk
//   - the export is reproducible: re-running the export
//     with the same input + the same `generated_at`
//     produces the same hashes
//   - the agent can show the user "this is exactly the
//     data that was in the DB at <generated_at>"
//
// Format (canonical, key order is fixed):
//   {
//     "manifest_version": 1,
//     "export_schema_version": 1,
//     "source_schema_version": <n>,
//     "scope": "global" | "project/{project_id}",
//     "generated_at": "ISO 8601",
//     "entry_count": <n>,
//     "topic_count": <n>,
//     "files": [
//       { "path": "MEMORY.md", "size": 1234, "sha256": "..." },
//       { "path": "topics/general.md", "size": 567, "sha256": "..." },
//       ...
//     ]
//   }
//
// The manifest is written last, after the index + topic
// files. If the manifest write fails, the atomic
// publisher's `rollback()` can restore the previous
// export (which may be older but is at least intact).

import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { CanonicalScope } from "./canonical-model.js";

export const MANIFEST_FILENAME = "MANIFEST.json";
export const MANIFEST_VERSION = 1;

export type ManifestFile = {
  path: string;
  size: number;
  sha256: string;
};

export type Manifest = {
  manifest_version: typeof MANIFEST_VERSION;
  export_schema_version: 1;
  source_schema_version: number;
  scope: string;
  generated_at: string;
  entry_count: number;
  topic_count: number;
  files: ManifestFile[];
  /**
   * Stage 18 v1.1.2 (issue #25, task 6): the bundle's
   * wire-format version. `1` is the v1.1.0 snapshot
   * format; `2` is the v1.1.1 PR-4 history format; `3`
   * is the v1.1.2 full-history format (this release).
   * Older manifests that omit the field default to `1`
   * so the migration-adapter's `detectBundleGeneration`
   * stays compatible with hand-rolled exports.
   */
  bundle_version?: number;
  /**
   * Stage 18 v1.1.2 (issue #25, task 6): SHA-256 over
   * the canonical-JSON serialisation of the bundle
   * content (excluding the source-side identity block).
   * The preflight re-computes the hash and compares; a
   * mismatch surfaces `bundle_garbled`. Only set on v3
   * bundles.
   */
  bundle_hash?: string;
};

function sha256OfFile(path: string): string {
  // Stage 13 PR10: hash the full file content. We read
  // it in one shot because the exporter guarantees a
  // small total (per-scope, budget-bounded upstream). For
  // future-proofing we could stream, but at the personal-
  // tool scale the whole file fits in memory.
  const content = readFileSync(path);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Stage 18 v1.1.2 (issue #25, task 6): the exporter can
 * pin a `bundle_version` + `bundle_hash` on the manifest
 * when the export carries a v3 full-history bundle. The
 * import preflight reads these fields, computes the
 * expected hash, and rejects a tampered bundle.
 */
export type ManifestExtras = {
  bundleVersion?: number;
  bundleHash?: string;
};

/**
 * Build the manifest for an export. Computes the SHA-256
 * of every emitted file and returns a stable object. The
 * caller writes it to `MANIFEST.json` next to the index
 * file.
 */
export function buildManifest(scope: CanonicalScope, scopeDir: string, files: string[], extras: ManifestExtras = {}): Manifest {
  const records: ManifestFile[] = files.map((absPath) => {
    const relPath = relative(scopeDir, absPath).replace(/\\/g, "/");
    return {
      path: relPath,
      size: statSync(absPath).size,
      sha256: sha256OfFile(absPath)
    };
  });
  const baseManifest: Manifest = {
    manifest_version: MANIFEST_VERSION,
    export_schema_version: 1,
    source_schema_version: scope.source_schema_version,
    scope: scope.scope,
    generated_at: scope.generated_at,
    entry_count: scope.all_entries.length,
    topic_count: scope.topics.length,
    files: records
  };
  // Stage 18 v1.1.2 (issue #25, task 6): the v3
  // bundle surfaces its `bundle_version` + `bundle_hash`
  // on the manifest so the import preflight can verify
  // the bundle without re-reading the BUNDLE.json. The
  // snapshot mode (no extras) does NOT touch the manifest
  // — the existing v1.1.1 PR-4 surface is unchanged.
  if (extras.bundleVersion !== undefined) {
    baseManifest.bundle_version = extras.bundleVersion;
  }
  if (extras.bundleHash !== undefined) {
    baseManifest.bundle_hash = extras.bundleHash;
  }
  return baseManifest;
}

export function serializeManifest(manifest: Manifest): string {
  return JSON.stringify(manifest, null, 2) + "\n";
}

/**
 * Compute the manifest, serialize it, and write it to
 * `MANIFEST.json` next to the index file. Returns the
 * absolute path of the written manifest.
 */
export function writeManifest(scope: CanonicalScope, scopeDir: string, files: string[], extras: ManifestExtras = {}): string {
  const manifest = buildManifest(scope, scopeDir, files, extras);
  const path = join(scopeDir, MANIFEST_FILENAME);
  writeFileSync(path, serializeManifest(manifest), "utf8");
  return path;
}

/**
 * Read and parse a manifest from disk. The parser is
 * intentionally strict: a manifest with a missing
 * `manifest_version` or a mismatched version throws
 * rather than silently accepting the data. This is the
 * read-side counterpart of `writeManifest`; the import
// path consumes its output.
 */
export function readManifest(scopeDir: string): Manifest {
  const path = join(scopeDir, MANIFEST_FILENAME);
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<Manifest>;
  if (parsed.manifest_version !== MANIFEST_VERSION) {
    throw new Error(
      `manifest version mismatch: got ${String(parsed.manifest_version)}, expected ${MANIFEST_VERSION}`
    );
  }
  if (typeof parsed.export_schema_version !== "number") {
    throw new Error("manifest missing export_schema_version");
  }
  if (typeof parsed.source_schema_version !== "number") {
    throw new Error("manifest missing source_schema_version");
  }
  if (typeof parsed.scope !== "string") {
    throw new Error("manifest missing scope");
  }
  if (typeof parsed.generated_at !== "string") {
    throw new Error("manifest missing generated_at");
  }
  if (typeof parsed.entry_count !== "number") {
    throw new Error("manifest missing entry_count");
  }
  if (typeof parsed.topic_count !== "number") {
    throw new Error("manifest missing topic_count");
  }
  if (!Array.isArray(parsed.files)) {
    throw new Error("manifest missing files[]");
  }
  return parsed as Manifest;
}

/**
 * Verify that the files on disk still match the manifest's
 * recorded hashes. Returns the list of files that no
 * longer match (empty array = all good). Used by
// `verify_backup` and the import path before mutating the
// live DB.
 */
export function verifyManifest(scopeDir: string, manifest: Manifest): string[] {
  const mismatches: string[] = [];
  for (const record of manifest.files) {
    const absolute = join(scopeDir, record.path);
    let actual: string;
    let actualSize: number;
    try {
      actual = sha256OfFile(absolute);
      actualSize = statSync(absolute).size;
    } catch {
      mismatches.push(record.path);
      continue;
    }
    if (actual !== record.sha256 || actualSize !== record.size) {
      mismatches.push(record.path);
    }
  }
  return mismatches;
}
