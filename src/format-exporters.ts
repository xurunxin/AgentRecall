// src/format-exporters.ts
//
// Stage 8: export format switch. The MarkdownExporter
// (src/markdown-exporter.ts) becomes one of three exporters.
// FormatRouter picks the right one based on the `format`
// field of ExportScopeInput. Default is "markdown" for
// backward compatibility.
//
// New exporters:
// - JsonExporter: writes <scope>/MEMORY.json and per-topic
//   <scope>/topics/<topic>.json. Stable key order.
// - YamlExporter: writes <scope>/MEMORY.yaml and per-topic
//   <scope>/topics/<topic>.yaml. Hand-rolled YAML emitter
//   (no new deps); strings that look like booleans / numbers
//   / null are quoted to avoid interpretation.
//
// The export path is the same shape as MarkdownExporter:
// stage to a temp dir, then publish atomically.

import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { MemoryEntry, MemoryScope } from "./domain.js";
import type { BudgetUsage } from "./sqlite-store.js";
import { MarkdownExporter } from "./markdown-exporter.js";

export type ExportFormat = "markdown" | "json" | "yaml";

export type ExportScopeInput = {
  scope: MemoryScope;
  project_id?: string;
  entries: MemoryEntry[];
  budgetStatus: string | BudgetUsage;
  format?: ExportFormat;
};

export type ExportScopeResult = {
  indexPath: string;
  topicPaths: string[];
};

export type StagedScopeExport = ExportScopeResult & {
  stagingRoot: string;
  stagingScopeDir: string;
  scopeDir: string;
  format: ExportFormat;
};

const INDEX_FILENAMES: Record<ExportFormat, string> = {
  markdown: "MEMORY.md",
  json: "MEMORY.json",
  yaml: "MEMORY.yaml"
};

const TOPIC_EXTENSIONS: Record<ExportFormat, string> = {
  markdown: "md",
  json: "json",
  yaml: "yaml"
};

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
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
  return base;
}

function topicFilename(topic: string, format: ExportFormat): string {
  return `${safeTopicBase(topic)}.${TOPIC_EXTENSIONS[format]}`;
}

function scopeDir(input: Pick<ExportScopeInput, "scope" | "project_id">, root: string): string {
  return input.scope === "global" ? join(root, "global") : join(root, "projects", input.project_id ?? "unknown-project");
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
    `  - scope: ${entry.scope === "project" ? `project/${entry.project_id ?? "unknown-project"}` : "global"}`,
    `  - type: ${entry.type}`,
    `  - topic: ${entry.topic}`,
    `  - importance: ${entry.importance}; confidence: ${entry.confidence}; updated: ${entry.updated_at}`
  ].join("\n");
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

/**
 * Stage 8: common staging helper. Each exporter stages its
 * files into a temp dir under the export root's `.staging/`
 * subdir, then FormatRouter publishes the staged scope
 * atomically (rename over the live dir). This is the same
 * pattern MarkdownExporter uses; we lift it to a helper
 * so all three exporters share it.
 */
function stageFiles(
  format: ExportFormat,
  input: ExportScopeInput,
  writeScopeFiles: (root: string) => { indexPath: string; topicPaths: string[] }
): StagedScopeExport {
  const stagingParent = join(input.format ? join("", "") : "", ".staging");
  // The above is a no-op; the real staging dir comes from the
  // FormatRouter which holds the exportRoot.
  return stageFilesAt(format, input, writeScopeFiles, stagingParent);
}

function stageFilesAt(
  format: ExportFormat,
  input: ExportScopeInput,
  writeScopeFiles: (root: string) => { indexPath: string; topicPaths: string[] },
  exportRoot: string
): StagedScopeExport {
  const stagingParent = join(exportRoot, ".staging");
  mkdirSync(stagingParent, { recursive: true });
  const stagingRoot = mkdtempSync(join(stagingParent, "export-"));
  try {
    const finalScopeDir = scopeDir(input, exportRoot);
    const staged = writeScopeFiles(stagingRoot);
    return {
      indexPath: join(finalScopeDir, INDEX_FILENAMES[format]),
      topicPaths: staged.topicPaths.map((p) => join(finalScopeDir, "topics", basename(p))),
      stagingRoot,
      stagingScopeDir: scopeDir(input, stagingRoot),
      scopeDir: finalScopeDir,
      format
    };
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Stage 8: JSON exporter. Writes one file per topic plus
 * an index. The shape per file is a stable JSON object
 * with sorted top-level keys for diff-friendly output.
 */
class JsonExporter {
  constructor(private readonly exportRoot: string) {}

  exportScope(input: ExportScopeInput): ExportScopeResult {
    const staged = this.stageScope(input);
    const published = publishStagedScope(staged);
    published.complete();
    return { indexPath: staged.indexPath, topicPaths: staged.topicPaths };
  }

  stageScope(input: ExportScopeInput): StagedScopeExport {
    return stageFilesAt("json", input, (root) => this.writeScope(input, root), this.exportRoot);
  }

  private writeScope(input: ExportScopeInput, root: string): { indexPath: string; topicPaths: string[] } {
    const scopeDirPath = scopeDir(input, root);
    const topicsDir = join(scopeDirPath, "topics");
    mkdirSync(topicsDir, { recursive: true });
    const activeEntries = [...input.entries].filter((e) => e.status === "active");
    const topics = [...new Set(activeEntries.map((e) => e.topic))].sort(compareText);
    const highImportance = activeEntries.filter((e) => e.importance >= 4);
    const reviewDue = activeEntries
      .filter((e) => e.review_after !== undefined)
      .sort((a, b) => compareText(a.review_after ?? "", b.review_after ?? ""))
      .slice(0, 10);
    const scope = input.scope === "project" ? `project/${input.project_id ?? "unknown-project"}` : "global";

    const index = {
      scope,
      budget: budgetLabel(input.budgetStatus),
      topics: topics.map((t) => ({ name: t, file: `topics/${topicFilename(t, "json")}` })),
      high_importance: highImportance.map(entrySummary),
      review_due: reviewDue.map(entrySummary),
      generated_at: new Date().toISOString()
    };
    const indexPath = join(scopeDirPath, "MEMORY.json");
    writeJson(indexPath, index);

    const topicPaths = topics.map((topic) => {
      const filename = topicFilename(topic, "json");
      const path = join(topicsDir, filename);
      const entries = activeEntries.filter((e) => e.topic === topic);
      const data = {
        topic,
        scope,
        generated_at: new Date().toISOString(),
        entries
      };
      writeJson(path, data);
      return path;
    });

    return { indexPath, topicPaths };
  }
}

/**
 * Stage 8: YAML exporter. Hand-rolled minimal emitter
 * (no new deps). Strings that look like booleans, numbers,
 * or null are quoted to avoid interpretation by the parser.
 * Multi-line strings use block scalars.
 */
class YamlExporter {
  constructor(private readonly exportRoot: string) {}

  exportScope(input: ExportScopeInput): ExportScopeResult {
    const staged = this.stageScope(input);
    const published = publishStagedScope(staged);
    published.complete();
    return { indexPath: staged.indexPath, topicPaths: staged.topicPaths };
  }

  stageScope(input: ExportScopeInput): StagedScopeExport {
    return stageFilesAt("yaml", input, (root) => this.writeScope(input, root), this.exportRoot);
  }

  private writeScope(input: ExportScopeInput, root: string): { indexPath: string; topicPaths: string[] } {
    const scopeDirPath = scopeDir(input, root);
    const topicsDir = join(scopeDirPath, "topics");
    mkdirSync(topicsDir, { recursive: true });
    const activeEntries = [...input.entries].filter((e) => e.status === "active");
    const topics = [...new Set(activeEntries.map((e) => e.topic))].sort(compareText);
    const highImportance = activeEntries.filter((e) => e.importance >= 4);
    const reviewDue = activeEntries
      .filter((e) => e.review_after !== undefined)
      .sort((a, b) => compareText(a.review_after ?? "", b.review_after ?? ""))
      .slice(0, 10);
    const scope = input.scope === "project" ? `project/${input.project_id ?? "unknown-project"}` : "global";

    const indexLines: string[] = [];
    indexLines.push(yamlScalar("scope", scope));
    indexLines.push(yamlScalar("budget", budgetLabel(input.budgetStatus)));
    indexLines.push(yamlScalar("generated_at", new Date().toISOString()));
    indexLines.push("topics:");
    for (const t of topics) {
      indexLines.push(`  - name: ${yamlStringInline(t)}`);
      indexLines.push(`    file: topics/${topicFilename(t, "yaml")}`);
    }
    indexLines.push("high_importance:");
    if (highImportance.length === 0) {
      indexLines.push("  []");
    } else {
      for (const e of highImportance) indexLines.push(...yamlListItem(entrySummary(e), 2));
    }
    indexLines.push("review_due:");
    if (reviewDue.length === 0) {
      indexLines.push("  []");
    } else {
      for (const e of reviewDue) indexLines.push(...yamlListItem(entrySummary(e), 2));
    }

    const indexPath = join(scopeDirPath, "MEMORY.yaml");
    writeFileSync(indexPath, indexLines.join("\n") + "\n", "utf8");

    const topicPaths = topics.map((topic) => {
      const filename = topicFilename(topic, "yaml");
      const path = join(topicsDir, filename);
      const entries = activeEntries.filter((e) => e.topic === topic);
      const lines: string[] = [];
      lines.push(yamlScalar("topic", topic));
      lines.push(yamlScalar("scope", scope));
      lines.push(yamlScalar("generated_at", new Date().toISOString()));
      lines.push("entries:");
      for (const e of entries) lines.push(...yamlEntry(e, 2));
      writeFileSync(path, lines.join("\n") + "\n", "utf8");
      return path;
    });

    return { indexPath, topicPaths };
  }
}

function publishStagedScope(staged: StagedScopeExport): { complete(): void; rollback(): void } {
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

  return {
    complete: () => {
      if (!active) return;
      try {
        rmSync(staged.stagingRoot, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
      try {
        if (hadLiveExport) {
          rmSync(backupDir, { recursive: true, force: true });
        }
      } catch {
        // leaving a backup is safer than reporting failure
      }
      active = false;
    },
    rollback: () => {
      if (!active) return;
      rmSync(staged.scopeDir, { recursive: true, force: true });
      if (hadLiveExport && existsSync(backupDir)) {
        renameSync(backupDir, staged.scopeDir);
      }
      rmSync(staged.stagingRoot, { recursive: true, force: true });
      active = false;
    }
  };
}

// === JSON helpers ===

function writeJson(path: string, value: unknown): void {
  // Sort top-level keys for stable diffs; nested objects (entry
  // fields) are not re-sorted because that would lose the
  // MemoryEntry field order the rest of the code uses.
  const sorted = sortObjectKeys(value);
  writeFileSync(path, JSON.stringify(sorted, null, 2) + "\n", "utf8");
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort(compareText)) {
      out[key] = sortObjectKeys(obj[key]);
    }
    return out;
  }
  return value;
}

// === YAML helpers ===

const YAML_NULL_LIKE = new Set(["null", "Null", "NULL", "~"]);
const YAML_BOOL_LIKE = new Set([
  "true", "True", "TRUE", "false", "False", "FALSE",
  "yes", "Yes", "YES", "no", "No", "NO",
  "on", "On", "ON", "off", "Off", "OFF"
]);

function yamlStringInline(value: string): string {
  // Always quote to be safe — the personal-tool scale has
  // small enough files that this is fine. We use double
  // quotes and escape only the necessary characters.
  if (value.length === 0) return '""';
  // Numbers
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return JSON.stringify(value);
  if (YAML_BOOL_LIKE.has(value)) return JSON.stringify(value);
  if (YAML_NULL_LIKE.has(value)) return JSON.stringify(value);
  // Embedded special chars
  if (/[:#\-?{}[\],&*!|>'"%@`]/.test(value) || value.startsWith(" ") || value.endsWith(" ")) {
    return JSON.stringify(value);
  }
  return value;
}

function yamlScalar(key: string, value: string | number | boolean | null): string {
  if (value === null) return `${key}: null`;
  if (typeof value === "number" || typeof value === "boolean") return `${key}: ${value}`;
  return `${key}: ${yamlStringInline(String(value))}`;
}

function yamlListItem(value: string, indent: number): string[] {
  // Multiline string as block scalar.
  const pad = " ".repeat(indent);
  const lines = value.split("\n");
  return [`${pad}- |`, ...lines.map((line) => `${pad}  ${line}`)];
}

function yamlEntry(entry: MemoryEntry, indent: number): string[] {
  const pad = " ".repeat(indent);
  const lines: string[] = [];
  lines.push(`${pad}- id: ${yamlStringInline(entry.id)}`);
  lines.push(`${pad}  scope: ${yamlStringInline(entry.scope)}`);
  if (entry.project_id !== undefined) {
    lines.push(`${pad}  project_id: ${yamlStringInline(entry.project_id)}`);
  }
  lines.push(`${pad}  type: ${yamlStringInline(entry.type)}`);
  lines.push(`${pad}  topic: ${yamlStringInline(entry.topic)}`);
  lines.push(`${pad}  title: ${yamlStringInline(entry.title)}`);
  lines.push(`${pad}  body: |`);
  for (const line of entry.body.split("\n")) {
    lines.push(`${pad}    ${line}`);
  }
  lines.push(`${pad}  tags:`);
  if (entry.tags.length === 0) {
    lines.push(`${pad}    []`);
  } else {
    for (const t of entry.tags) lines.push(`${pad}    - ${yamlStringInline(t)}`);
  }
  lines.push(`${pad}  source:`);
  lines.push(`${pad}    kind: ${yamlStringInline(entry.source.kind)}`);
  if (entry.source.ref !== undefined) {
    lines.push(`${pad}    ref: ${yamlStringInline(entry.source.ref)}`);
  }
  lines.push(`${pad}  importance: ${entry.importance}`);
  lines.push(`${pad}  confidence: ${entry.confidence}`);
  lines.push(`${pad}  status: ${yamlStringInline(entry.status)}`);
  lines.push(`${pad}  created_at: ${yamlStringInline(entry.created_at)}`);
  lines.push(`${pad}  updated_at: ${yamlStringInline(entry.updated_at)}`);
  if (entry.last_accessed_at !== undefined) {
    lines.push(`${pad}  last_accessed_at: ${yamlStringInline(entry.last_accessed_at)}`);
  }
  if (entry.supersedes !== undefined && entry.supersedes.length > 0) {
    lines.push(`${pad}  supersedes:`);
    for (const s of entry.supersedes) lines.push(`${pad}    - ${yamlStringInline(s)}`);
  }
  if (entry.superseded_by !== undefined) {
    lines.push(`${pad}  superseded_by: ${yamlStringInline(entry.superseded_by)}`);
  }
  return lines;
}

/**
 * Stage 8: FormatRouter. Picks the right exporter based on
 * `input.format` and delegates. Default is "markdown" for
 * backward compatibility with callers that predate Stage 8.
 */
export class FormatRouter {
  private readonly markdown: MarkdownExporter;
  private readonly json: JsonExporter;
  private readonly yaml: YamlExporter;

  constructor(private readonly exportRoot: string) {
    this.markdown = new MarkdownExporter(exportRoot);
    this.json = new JsonExporter(exportRoot);
    this.yaml = new YamlExporter(exportRoot);
  }

  export(input: ExportScopeInput): ExportScopeResult {
    const format: ExportFormat = input.format ?? "markdown";
    if (format === "markdown") return this.markdown.exportScope(input);
    if (format === "json") return this.json.exportScope(input);
    if (format === "yaml") return this.yaml.exportScope(input);
    throw new Error(`unknown export format: ${format}`);
  }
}
