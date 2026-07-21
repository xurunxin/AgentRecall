import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { MemoryEntry, MemoryScope } from "./domain.js";
import type { BudgetUsage } from "./sqlite-store.js";
import { CanonicalExporter } from "./portability/exporter.js";
import { safeTopicBase, shortHash } from "./portability/canonical-model.js";
import { AUTHORITY_NOTICE } from "./portability/renderers.js";

export type ContextPackInput = {
  title: string;
  budget_chars: number;
  entries: Array<MemoryEntry & { trust_boost?: number; writer?: string }>;
};

export type ExportScopeInput = {
  scope: MemoryScope;
  project_id?: string;
  entries: MemoryEntry[];
  budgetStatus: string | BudgetUsage;
};

export type ExportScopeResult = {
  indexPath: string;
  topicPaths: string[];
};

export type StagedScopeExport = ExportScopeResult & {
  stagingRoot: string;
  stagingScopeDir: string;
  scopeDir: string;
};

export type PublishedScopeExport = ExportScopeResult & {
  complete(): void;
  rollback(): void;
};

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function safeTopicFilename(topic: string): string {
  return `${safeTopicBase(topic)}.md`;
}

function compareEntries(a: MemoryEntry & { trust_boost?: number }, b: MemoryEntry & { trust_boost?: number }): number {
  const importanceOrder = b.importance - a.importance;
  if (importanceOrder !== 0) return importanceOrder;

  // Stage 5: when importance ties, the calling actor's own
  // memories (or recently-touched ones) rank higher. Legacy
  // entries without trust_boost tie at 0 and fall through to
  // confidence / updated_at / id.
  const trustOrder = (b.trust_boost ?? 0) - (a.trust_boost ?? 0);
  if (trustOrder !== 0) return trustOrder;

  const confidenceOrder = b.confidence - a.confidence;
  if (confidenceOrder !== 0) return confidenceOrder;

  const updatedOrder = compareText(b.updated_at, a.updated_at);
  if (updatedOrder !== 0) return updatedOrder;

  return compareText(a.id, b.id);
}

function compareEntriesForTopic(a: MemoryEntry, b: MemoryEntry): number {
  const topicOrder = compareText(a.topic, b.topic);
  if (topicOrder !== 0) return topicOrder;
  return compareEntries(a, b);
}

function scopeLabel(entry: Pick<MemoryEntry, "scope" | "project_id">): string {
  return entry.scope === "project" ? `project/${entry.project_id ?? "unknown-project"}` : "global";
}

function sourceLabel(entry: MemoryEntry): string {
  return entry.source.ref === undefined ? entry.source.kind : `${entry.source.kind}:${entry.source.ref}`;
}

function tagsLabel(tags: string[]): string {
  return tags.length === 0 ? "none" : tags.join(", ");
}

function budgetLabel(value: string | BudgetUsage): string {
  if (typeof value === "string") {
    return value;
  }
  return `${value.active_entries} active entries, ${value.active_chars} active chars, ${value.index_chars} index chars`;
}

function entrySummary(entry: MemoryEntry): string {
  return [
    `- [${entry.id}] ${entry.title}`,
    `  - scope: ${scopeLabel(entry)}`,
    `  - type: ${entry.type}`,
    `  - topic: ${entry.topic}`,
    `  - tags: ${tagsLabel(entry.tags)}`,
    `  - importance: ${entry.importance}; confidence: ${entry.confidence}; updated: ${entry.updated_at}`
  ].join("\n");
}

function entryDetail(entry: MemoryEntry & { writer?: string }): string {
  const writerAnnotation = entry.writer !== undefined ? ` [writer: ${entry.writer}]` : "";
  return [
    `## ${entry.title}${writerAnnotation}`,
    "",
    `- memory_id: ${entry.id}`,
    `- scope: ${scopeLabel(entry)}`,
    `- type: ${entry.type}`,
    `- topic: ${entry.topic}`,
    `- tags: ${tagsLabel(entry.tags)}`,
    `- source: ${sourceLabel(entry)}`,
    `- importance: ${entry.importance}`,
    `- confidence: ${entry.confidence}`,
    `- updated_at: ${entry.updated_at}`,
    "",
    entry.body,
    ""
  ].join("\n");
}

function boundedJoin(blocks: string[], budgetChars: number): string {
  // Stage 10 PR4: token-aware / field-level packing.
  //
  // Pre-PR4 this routine broke on the first block larger than
  // the budget, so a single oversized memory could lock out
  // every smaller memory that followed it. The new strategy
  // (spec § 5.3):
  //   - blocks are processed in input order; the ranker is
  //     the single source of ordering truth.
  //   - a block that does not fit in the remaining budget
  //     is **skipped**, not partially rendered. The next,
  //     smaller block can still consume what is left.
  //   - field-level truncation is the ranker's job: the
  //     ranker records `truncated: true` on the
  //     corresponding RankedItem and the read-side
  //     pipeline can clip the entry body before it reaches
  //     the renderer.
  //   - the final output is clipped to `<= budgetChars`
  //     so spec § 5.3's `used_tokens <= requested_budget`
  //     invariant holds.
  const budget = Math.max(0, Math.floor(budgetChars));
  let output = "";
  for (const block of blocks) {
    const remaining = budget - output.length;
    if (remaining <= 0) break;
    if (block.length > remaining) {
      // Skip; let the next (smaller) block consume the
      // remaining budget.
      continue;
    }
    output += block;
  }
  if (output.length > budget) return output.slice(0, budget);
  return output;
}

function uniquePath(parent: string, prefix: string): string {
  let index = 0;
  while (true) {
    const candidate = join(parent, `${prefix}-${process.pid}-${Date.now()}-${index}`);
    if (!existsSync(candidate)) {
      return candidate;
    }
    index += 1;
  }
}

export class MarkdownExporter {
  private readonly inner: CanonicalExporter;

  constructor(private readonly exportRoot: string) {
    this.inner = new CanonicalExporter(exportRoot);
  }

  buildContextPack(input: ContextPackInput): string {
    // The context pack is a different concern from the
    // file export: it produces a budget-bounded markdown
    // string for an agent prompt, not a directory of
    // files. PR10 keeps the implementation here so the
    // call sites (read service, MCP tool) do not change.
    const title = input.title.trim().length > 0 ? input.title.trim() : "AgentRecall Context";
    const entries = input.entries.filter((entry) => entry.status === "active");
    const blocks = [
      [`# ${title}`, "", `> ${AUTHORITY_NOTICE}`, "", "## Memories", ""].join("\n"),
      ...entries.map((entry) => `${entryDetail(entry)}\n`)
    ];
    const body = boundedJoin(blocks, Math.max(0, input.budget_chars - 1)).trimEnd();
    if (body.length === 0) return "";
    return body.length >= input.budget_chars ? body : `${body}\n`;
  }

  /**
   * Backward-compat wrapper around `CanonicalExporter`.
   * The legacy callers (CLI, doctor, smoke tests) get
   * the same {indexPath, topicPaths} shape.
   */
  exportScope(input: ExportScopeInput): ExportScopeResult {
    return this.inner.exportScope({ ...input, format: "markdown" });
  }

  /**
   * Two-phase entry point: stage the scope to a temp
   * dir without touching the live export. The caller
   * inspects / mutates the staged files, then calls
   * `publishStagedScope` to atomically promote them.
   *
   * Pre-PR10 this was the legacy "stage + publish"
   * surface; PR10 splits the two phases so a throw
   * inside the staged scope does not corrupt the live
   * export. The failing-stage test fixture relies on
   * this property.
   */
  stageScope(input: ExportScopeInput): StagedScopeExport {
    const staged = this.inner.stageScope({ ...input, format: "markdown" });
    return {
      indexPath: staged.indexPath,
      topicPaths: staged.topicPaths,
      stagingRoot: staged.staged.stagingRoot,
      stagingScopeDir: staged.staged.stagingScopeDir,
      scopeDir: staged.staged.scopeDir
    };
  }

  /**
   * Atomically promote a previously-staged scope to
   * live. The returned handle's `complete()` cleans up
   * the staging + backup dirs; `rollback()` restores
   * the previous live export.
   */
  publishStagedScope(staged: StagedScopeExport): PublishedScopeExport {
    return this.inner.publishStagedScope({
      indexPath: staged.indexPath,
      topicPaths: staged.topicPaths,
      format: "markdown",
      canonical: {
        scope: "",
        rawScope: "global",
        budget: "",
        topics: [],
        high_importance: [],
        review_due: [],
        all_entries: [],
        generated_at: "",
        export_schema_version: 1,
        source_schema_version: 0
      },
      staged: {
        indexPath: staged.indexPath,
        topicPaths: staged.topicPaths,
        stagingRoot: staged.stagingRoot,
        stagingScopeDir: staged.stagingScopeDir,
        scopeDir: staged.scopeDir
      }
    });
  }
}
