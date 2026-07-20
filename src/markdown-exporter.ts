import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { MemoryEntry, MemoryScope } from "./domain.js";
import type { BudgetUsage } from "./sqlite-store.js";

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

const AUTHORITY_NOTICE = "Generated from SQLite. SQLite is authoritative; manual edits may be overwritten.";
const WINDOWS_RESERVED_BASENAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9"
]);

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function safeTopicBase(topic: string): string {
  const ascii = topic
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 72);
  const base = /[a-z0-9]/.test(ascii) ? ascii : "general";
  return WINDOWS_RESERVED_BASENAMES.has(base.split(".")[0] ?? base) ? `topic-${base}` : base;
}

export function safeTopicFilename(topic: string): string {
  return `${safeTopicBase(topic)}.md`;
}

function topicFilenameMap(topics: string[]): Map<string, string> {
  const bases = new Map<string, string[]>();
  for (const topic of topics) {
    const base = safeTopicBase(topic);
    bases.set(base, [...(bases.get(base) ?? []), topic]);
  }

  const result = new Map<string, string>();
  for (const topic of topics) {
    const base = safeTopicBase(topic);
    const collides = (bases.get(base)?.length ?? 0) > 1;
    result.set(topic, collides ? `${base}-${shortHash(topic)}.md` : `${base}.md`);
  }
  return result;
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
  constructor(private readonly exportRoot: string) {}

  buildContextPack(input: ContextPackInput): string {
    const title = input.title.trim().length > 0 ? input.title.trim() : "AgentRecall Context";
    // Stage 10 PR4: the exporter is a renderer, not a ranker.
    // It trusts the input order supplied by the read service
    // (which routed everything through RecallRanker). The
    // pre-PR4 `.sort(compareEntries)` would re-rank by
    // importance + trust and override the query-score order;
    // it is removed here.
    const entries = input.entries.filter((entry) => entry.status === "active");
    const blocks = [
      [`# ${title}`, "", `> ${AUTHORITY_NOTICE}`, "", "## Memories", ""].join("\n"),
      ...entries.map((entry) => `${entryDetail(entry)}\n`)
    ];
    // Reserve one character for the trailing newline so the
    // final output length is `<= budget_chars` per spec § 5.3
    // ("used_tokens <= requested_budget"). When the body
    // already saturates the budget the trailing newline is
    // dropped to keep the contract.
    const body = boundedJoin(blocks, Math.max(0, input.budget_chars - 1)).trimEnd();
    if (body.length === 0) return "";
    return body.length >= input.budget_chars ? body : `${body}\n`;
  }

  exportScope(input: ExportScopeInput): ExportScopeResult {
    const staged = this.stageScope(input);
    let published: PublishedScopeExport | undefined;
    try {
      published = this.publishStagedScope(staged);
      published.complete();
      return {
        indexPath: staged.indexPath,
        topicPaths: staged.topicPaths
      };
    } catch (error) {
      if (published === undefined) {
        rmSync(staged.stagingRoot, { recursive: true, force: true });
      } else {
        published.rollback();
      }
      throw error;
    }
  }

  stageScope(input: ExportScopeInput): StagedScopeExport {
    const stagingParent = join(this.exportRoot, ".staging");
    mkdirSync(stagingParent, { recursive: true });
    const stagingRoot = mkdtempSync(join(stagingParent, "export-"));
    try {
      const staged = this.writeScope(input, stagingRoot);
      const finalScopeDir = this.scopeDir(input, this.exportRoot);
      return {
        indexPath: join(finalScopeDir, "MEMORY.md"),
        topicPaths: staged.topicPaths.map((path) => join(finalScopeDir, "topics", basename(path))),
        stagingRoot,
        stagingScopeDir: this.scopeDir(input, stagingRoot),
        scopeDir: finalScopeDir
      };
    } catch (error) {
      rmSync(stagingRoot, { recursive: true, force: true });
      throw error;
    }
  }

  publishStagedScope(staged: StagedScopeExport): PublishedScopeExport {
    const parent = dirname(staged.scopeDir);
    mkdirSync(parent, { recursive: true });
    const backupDir = uniquePath(parent, `.backup-${basename(staged.scopeDir)}`);
    const hadLiveExport = existsSync(staged.scopeDir);
    let active = true;

    if (hadLiveExport) {
      renameSync(staged.scopeDir, backupDir);
    }

    try {
      renameSync(staged.stagingScopeDir, staged.scopeDir);
    } catch (error) {
      if (hadLiveExport) {
        renameSync(backupDir, staged.scopeDir);
      }
      rmSync(staged.stagingRoot, { recursive: true, force: true });
      active = false;
      throw error;
    }

    const complete = (): void => {
      if (!active) return;
      try {
        rmSync(staged.stagingRoot, { recursive: true, force: true });
      } catch {
        // Cleanup is best-effort after the live export has been replaced.
      }
      try {
        if (hadLiveExport) {
          rmSync(backupDir, { recursive: true, force: true });
        }
      } catch {
        // Leaving a backup is safer than reporting a failed successful export.
      }
      active = false;
    };

    const rollback = (): void => {
      if (!active) return;
      rmSync(staged.scopeDir, { recursive: true, force: true });
      if (hadLiveExport && existsSync(backupDir)) {
        renameSync(backupDir, staged.scopeDir);
      }
      rmSync(staged.stagingRoot, { recursive: true, force: true });
      active = false;
    };

    return {
      indexPath: staged.indexPath,
      topicPaths: staged.topicPaths,
      complete,
      rollback
    };
  }

  private scopeDir(input: Pick<ExportScopeInput, "scope" | "project_id">, root: string): string {
    return input.scope === "global" ? join(root, "global") : join(root, "projects", input.project_id ?? "unknown-project");
  }

  private writeScope(input: ExportScopeInput, root: string): ExportScopeResult {
    const scopeDir =
      input.scope === "global" ? join(root, "global") : join(root, "projects", input.project_id ?? "unknown-project");
    const topicsDir = join(scopeDir, "topics");
    mkdirSync(topicsDir, { recursive: true });

    const activeEntries = [...input.entries].filter((entry) => entry.status === "active").sort(compareEntriesForTopic);
    const topics = [...new Set(activeEntries.map((entry) => entry.topic))].sort(compareText);
    const topicFiles = topicFilenameMap(topics);
    const topicLinks = topics.map((topic) => `- [${topic}](topics/${topicFiles.get(topic) ?? safeTopicFilename(topic)})`);
    const highImportance = activeEntries.filter((entry) => entry.importance >= 4).sort(compareEntries);
    const reviewDue = activeEntries
      .filter((entry) => entry.review_after !== undefined)
      .sort((a, b) => compareText(a.review_after ?? "", b.review_after ?? "") || compareEntries(a, b))
      .slice(0, 10);
    const scope = input.scope === "project" ? `project/${input.project_id ?? "unknown-project"}` : "global";
    const index = [
      "# AgentRecall Export",
      "",
      `> ${AUTHORITY_NOTICE}`,
      "",
      `Scope: ${scope}`,
      `Budget: ${budgetLabel(input.budgetStatus)}`,
      "",
      "## Topics",
      "",
      ...(topicLinks.length === 0 ? ["_No active topics._"] : topicLinks),
      "",
      "## High Importance",
      "",
      ...(highImportance.length === 0 ? ["_No high-importance active memories._"] : highImportance.map(entrySummary)),
      "",
      "## Review Due",
      "",
      ...(reviewDue.length === 0 ? ["_No active memories have review dates._"] : reviewDue.map(entrySummary)),
      ""
    ].join("\n");
    const indexPath = join(scopeDir, "MEMORY.md");
    writeFileSync(indexPath, index, "utf8");

    const topicPaths = topics.map((topic) => {
      const filename = topicFiles.get(topic) ?? safeTopicFilename(topic);
      const path = join(topicsDir, basename(filename));
      const entries = activeEntries.filter((entry) => entry.topic === topic).sort(compareEntries);
      const markdown = [
        `# ${topic}`,
        "",
        `> ${AUTHORITY_NOTICE}`,
        "",
        `Scope: ${scope}`,
        "",
        ...entries.map(entryDetail)
      ].join("\n");
      writeFileSync(path, markdown, "utf8");
      return path;
    });

    return { indexPath, topicPaths };
  }
}
