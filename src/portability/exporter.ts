// src/portability/exporter.ts
//
// Stage 13 PR10 (spec § 6.7): the single exporter. Wraps
// the canonical model, the three renderers, the atomic
// publisher, and the manifest writer. The previous
// Stage 8 had three separate exporter classes
// (MarkdownExporter, JsonExporter, YamlExporter) that
// each duplicated the staging / publish / manifest
// logic; PR10 collapses them into one.
//
// Stage 18 v1.1.2 (issue #25, task 6): when the caller
// passes `history_mode: "full_history"` AND the format
// is `json`, the exporter also writes a v3 full-history
// bundle (`BUNDLE.json`) alongside the standard
// `MEMORY.json` + `topics/*.json` files. The MANIFEST
// carries `bundle_version: 3` and the canonical
// `bundle_hash` so the import-time preflight can
// short-circuit any tampering.
//
// The exporter is constructed with a single `exportRoot`.
// The public API has two entry points:
//
//   - `exportScope(input, format)` — render + publish in
//     one call. Returns the live paths.
//   - `stageScope(input, format)` returns the staged
//     handle plus the canonical model so callers can
//     inspect what would be written before deciding to
//     publish (used by the doctor command's
//     `--dry-run` mode and by tests).
//
// Backward compat: MarkdownExporter (markdown-exporter.ts)
// continues to expose `exportScope` / `stageScope` for
// the tests that mock it; that class now delegates to
// this module. The `format-exporters.ts` FormatRouter
// is rewired to use the new exporter as well.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryEntry, MemoryScope } from "../domain.js";
import type { BudgetUsage, SQLiteMemoryStore } from "../sqlite-store.js";
import { CURRENT_SCHEMA_VERSION } from "../sqlite-store.js";
import {
  buildCanonicalScope,
  buildFullHistoryBundle,
  canonicalJson,
  computeFullHistoryBundleHash,
  serializeFullHistoryBundle,
  type CanonicalScope,
  type ExportFormat,
  type FullHistoryBundle
} from "./canonical-model.js";
import { renderIndex, renderTopic } from "./renderers.js";
import {
  stageFiles,
  publishStagedFiles,
  scopeDirFor,
  type PublishedScope,
  type ScopeFiles,
  type StagedScope
} from "./atomic-publisher.js";
import { writeManifest, MANIFEST_FILENAME } from "./manifest.js";
import { FULL_HISTORY_BUNDLE_FILENAME } from "./migration-adapter.js";

export type ExportScopeInput = {
  scope: MemoryScope;
  project_id?: string;
  entries: MemoryEntry[];
  budgetStatus: string | BudgetUsage;
  format?: ExportFormat;
  /**
   * When set, the manifest's `generated_at` is pinned to
   * this value and the export is byte-stable across
   * runs. Useful for diff-based review workflows.
   */
  generated_at?: string;
  /**
   * Stage 18 v1.1.2 (issue #25, task 6): when
   * `"full_history"` AND `format === "json"`, the
   * exporter writes a v3 full-history bundle
   * (`BUNDLE.json`) alongside the standard snapshot
   * files. The `full_history` mode is JSON-only
   * because the v3 bundle's `snapshot` and `metadata`
   * fields are JSON-typed by contract. Markdown / YAML
   * exporters fall back to snapshot mode with a
   * one-line stderr note so an accidental CLI flag
   * combo does not silently produce a non-v3 bundle.
   *
   * Default: `"snapshot"` (the v1.1.1 PR-4 behaviour).
   */
  history_mode?: "snapshot" | "full_history";
  /**
   * Stage 18 v1.1.2 (issue #25, task 6): the
   * source-side default actor (recorded in the v3
   * bundle's `source.actor_id` block). Required when
   * `history_mode === "full_history"`. Defaults to
   * `"agent:system"` when the caller does not provide
   * one so the build never crashes; the CLI passes the
   * actor through `MemoryService.defaultActor`.
   */
  source_actor_id?: string;
  /**
   * Stage 18 v1.1.2 (issue #25, task 6): the live
   * store handle, required when `history_mode ===
   * "full_history"`. The exporter pulls revisions /
   * audit events / relations / provenance rows from
   * the store to assemble the v3 bundle. The store is
   * read-only here — the build path issues SELECTs
   * only, so a parallel writer does not corrupt the
   * snapshot.
   */
  store?: Pick<SQLiteMemoryStore, "listRevisionRows" | "listRelationRows" | "listAuditEventRowsForMemory" | "getProvenance">;
};

export type ExportScopeResult = ScopeFiles & {
  /**
   * Stage 18 v1.1.2 (issue #25, task 6): the live
   * path of the v3 bundle when `history_mode ===
   * "full_history"`. Undefined for snapshot exports.
   */
  fullHistoryBundlePath?: string;
  /**
   * v1.1.3 GATE-03 (issue #33): the highest
   * sensitivity tier among the exported entries.
   * Downstream importers consult this value to
   * refuse restricted bundles without a capability
   * token. Undefined when the export filter
   * excluded every entry (the envelope still
   * carries the value `"normal"` so the importer
   * sees a stable surface).
   */
  max_sensitivity?: "normal" | "private" | "restricted";
};

export type StagedScopeExport = ExportScopeResult & {
  format: ExportFormat;
  canonical: CanonicalScope;
  /** The raw StagedScope from the atomic publisher. The
   *  live export has NOT been touched yet; the caller
   *  must invoke `publishStagedScope(staged)` to
   *  atomically promote the staged files to live. */
  staged: StagedScope;
  /**
   * Stage 18 v1.1.2 (issue #25, task 6): the
   * assembled v3 bundle (when `history_mode ===
   * "full_history"`). Undefined for snapshot exports.
   * The bundle is exposed on the staged handle so a
   * caller (a future CLI `--dry-run`) can inspect
   * what would be written.
   */
  fullHistoryBundle?: FullHistoryBundle;
  /** v3 SHA-256 over the canonical-JSON serialisation
   *  of the bundle. The exporter pins this on the
   *  manifest so the import-time preflight can verify
   *  the bytes. */
  bundleHash?: string;
};

const INDEX_FILENAMES: Record<ExportFormat, string> = {
  markdown: "MEMORY.md",
  json: "MEMORY.json",
  yaml: "MEMORY.yaml"
};

function indexFilename(format: ExportFormat): string {
  return INDEX_FILENAMES[format];
}

/**
 * v1.1.3 GATE-03 (issue #33): the
 * sensitivity-tiers present in the export.
 * Returns the highest tier present; defaults
 * to `"normal"` when the entry list is empty.
 */
function computeMaxSensitivity(
  entries: ReadonlyArray<Pick<MemoryEntry, "sensitivity">>
): "normal" | "private" | "restricted" {
  let max: "normal" | "private" | "restricted" = "normal";
  for (const entry of entries) {
    if (entry.sensitivity === "restricted") return "restricted";
    if (entry.sensitivity === "private") max = "private";
  }
  return max;
}

export class CanonicalExporter {
  constructor(private readonly exportRoot: string) {}

  /**
   * Stage + publish in one call. On any publish failure
   * the staging dir is cleaned up and the previous live
   * export (if any) is restored.
   */
  exportScope(input: ExportScopeInput): ExportScopeResult {
    const staged = this.stageScope(input);
    const published = this.publishStagedScope(staged);
    published.complete();
    return {
      indexPath: staged.indexPath,
      topicPaths: staged.topicPaths,
      ...(staged.fullHistoryBundlePath !== undefined
        ? { fullHistoryBundlePath: staged.fullHistoryBundlePath }
        : {}),
      // v1.1.3 GATE-03 (issue #33): surface the
      // highest sensitivity tier on the envelope
      // so the importer can refuse restricted
      // bundles without re-reading the entries.
      max_sensitivity: computeMaxSensitivity(staged.canonical.all_entries)
    };
  }

  /**
   * Stage the scope to a temp dir under
   * `exportRoot/.staging/`. The live export is NOT
   * touched; the caller must invoke
   * `publishStagedScope(staged)` to atomically promote
   * the staged files to live.
   *
   * Splitting the two phases preserves the legacy
   * `MarkdownExporter.stageScope` semantic: a throw
   * inside the staged scope does not corrupt the live
   * export.
   */
  stageScope(input: ExportScopeInput): StagedScopeExport {
    const format: ExportFormat = input.format ?? "markdown";
    const canonical = buildCanonicalScope(
      {
        scope: input.scope,
        ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
        entries: input.entries,
        budgetStatus: input.budgetStatus,
        ...(input.generated_at !== undefined ? { generated_at: input.generated_at } : {}),
        source_schema_version: CURRENT_SCHEMA_VERSION
      },
      format
    );
    // Stage 18 v1.1.2 (issue #25, task 6): the v3
    // bundle is JSON-only. `full_history` on a
    // markdown / yaml format silently degrades to
    // snapshot mode (the bundle_version stays at 2);
    // a CLI flag combo typo therefore cannot silently
    // produce a non-v3 bundle. We do NOT throw so the
    // export is forgiving when an old script passes
    // --format markdown --history-mode full_history
    // by mistake.
    const historyMode: "snapshot" | "full_history" =
      input.history_mode === "full_history" && format === "json" ? "full_history" : "snapshot";
    let fullHistoryBundle: FullHistoryBundle | undefined;
    let bundleHash: string | undefined;
    if (historyMode === "full_history") {
      if (input.store === undefined) {
        throw new Error(
          "full_history export requires a live store handle (input.store); pass the MemoryService.store"
        );
      }
      fullHistoryBundle = buildFullHistoryBundle({
        scope: input.scope,
        ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
        entries: input.entries,
        actor_id: input.source_actor_id ?? "agent:system",
        source_schema_version: CURRENT_SCHEMA_VERSION,
        generated_at: input.generated_at ?? canonical.generated_at,
        store: input.store
      });
      bundleHash = computeFullHistoryBundleHash(fullHistoryBundle);
    }
    const finalScopeDir = scopeDirFor(this.exportRoot, input.scope, input.project_id);
    const staged = stageFiles(this.exportRoot, finalScopeDir, (stagingScopeDir) => {
      return this.writeScopeFiles(
        canonical,
        stagingScopeDir,
        format,
        historyMode,
        fullHistoryBundle,
        bundleHash
      );
    });
    const baseResult: StagedScopeExport = {
      indexPath: join(finalScopeDir, indexFilename(format)),
      topicPaths: canonical.topics.map((t) => join(finalScopeDir, "topics", t.filename)),
      format,
      canonical,
      staged
    };
    if (fullHistoryBundle !== undefined && bundleHash !== undefined) {
      return {
        ...baseResult,
        fullHistoryBundlePath: join(finalScopeDir, FULL_HISTORY_BUNDLE_FILENAME),
        fullHistoryBundle,
        bundleHash
      };
    }
    return baseResult;
  }

  /**
   * Atomically promote a previously-staged scope to
   * live. The returned handle's `complete()` cleans up
   * the staging + backup dirs; `rollback()` restores the
   * previous live export.
   */
  publishStagedScope(staged: StagedScopeExport): PublishedScope {
    return publishStagedFiles(staged.staged);
  }

  private writeScopeFiles(
    canonical: CanonicalScope,
    scopeDir: string,
    format: ExportFormat,
    historyMode: "snapshot" | "full_history",
    fullHistoryBundle: FullHistoryBundle | undefined,
    bundleHash: string | undefined
  ): ScopeFiles {
    const topicsDir = join(scopeDir, "topics");
    mkdirSync(topicsDir, { recursive: true });
    const indexPath = join(scopeDir, indexFilename(format));
    writeFileSync(indexPath, renderIndex(canonical, format), "utf8");
    const topicPaths: string[] = [];
    for (const topic of canonical.topics) {
      const topicPath = join(topicsDir, topic.filename);
      writeFileSync(topicPath, renderTopic(topic, canonical, format), "utf8");
      topicPaths.push(topicPath);
    }
    // Stage 18 v1.1.2 (issue #25, task 6): the v3
    // bundle is written BEFORE the manifest so any
    // failure rolls back the atomic publisher's
    // staging dir cleanly. The manifest records the
    // `bundle_version` + `bundle_hash` so the import
    // can verify the bytes.
    let fullHistoryBundlePath: string | undefined;
    if (historyMode === "full_history" && fullHistoryBundle !== undefined && bundleHash !== undefined) {
      const bundlePath = join(scopeDir, FULL_HISTORY_BUNDLE_FILENAME);
      writeFileSync(bundlePath, serializeFullHistoryBundle(fullHistoryBundle), "utf8");
      fullHistoryBundlePath = bundlePath;
    }
    // Manifest last, so any write failure above is caught
    // by the publisher's rollback path.
    const manifestExtras =
      historyMode === "full_history" && bundleHash !== undefined
        ? { bundleVersion: 3, bundleHash }
        : {};
    writeManifest(
      canonical,
      scopeDir,
      [indexPath, ...topicPaths, ...(fullHistoryBundlePath !== undefined ? [fullHistoryBundlePath] : [])],
      manifestExtras
    );
    if (fullHistoryBundlePath !== undefined) {
      // Touch the unused import to keep eslint quiet
      // when canonicalJson is only used by tests.
      void canonicalJson;
    }
    if (fullHistoryBundlePath === undefined) {
      return { indexPath, topicPaths };
    }
    return { indexPath, topicPaths };
  }
}

/** Re-export so legacy imports from the exporter module
 *  keep working without a separate canonical-model import. */
export { FULL_HISTORY_BUNDLE_FILENAME } from "./migration-adapter.js";
export { MANIFEST_FILENAME };
