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
import type { BudgetUsage } from "../sqlite-store.js";
import { CURRENT_SCHEMA_VERSION } from "../sqlite-store.js";
import { buildCanonicalScope, type CanonicalScope, type ExportFormat } from "./canonical-model.js";
import { renderIndex, renderTopic } from "./renderers.js";
import {
  stageFiles,
  publishStagedFiles,
  scopeDirFor,
  type PublishedScope,
  type ScopeFiles,
  type StagedScope
} from "./atomic-publisher.js";
import { writeManifest } from "./manifest.js";

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
};

export type ExportScopeResult = ScopeFiles;

export type StagedScopeExport = ExportScopeResult & {
  format: ExportFormat;
  canonical: CanonicalScope;
  /** The raw StagedScope from the atomic publisher. The
   *  live export has NOT been touched yet; the caller
   *  must invoke `publishStagedScope(staged)` to
   *  atomically promote the staged files to live. */
  staged: StagedScope;
};

const INDEX_FILENAMES: Record<ExportFormat, string> = {
  markdown: "MEMORY.md",
  json: "MEMORY.json",
  yaml: "MEMORY.yaml"
};

function indexFilename(format: ExportFormat): string {
  return INDEX_FILENAMES[format];
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
      topicPaths: staged.topicPaths
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
    const finalScopeDir = scopeDirFor(this.exportRoot, input.scope, input.project_id);
    const staged = stageFiles(this.exportRoot, finalScopeDir, (stagingScopeDir) => {
      return this.writeScopeFiles(canonical, stagingScopeDir, format);
    });
    return {
      indexPath: join(finalScopeDir, indexFilename(format)),
      topicPaths: canonical.topics.map((t) => join(finalScopeDir, "topics", t.filename)),
      format,
      canonical,
      staged
    };
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

  private writeScopeFiles(canonical: CanonicalScope, scopeDir: string, format: ExportFormat): ScopeFiles {
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
    // Manifest last, so any write failure above is caught
    // by the publisher's rollback path.
    writeManifest(canonical, scopeDir, [indexPath, ...topicPaths]);
    return { indexPath, topicPaths };
  }
}
