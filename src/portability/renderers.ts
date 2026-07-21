// src/portability/renderers.ts
//
// Stage 13 PR10 (spec § 6.7): the three format renderers
// that consume a `CanonicalScope` (see
// `canonical-model.ts`) and produce the bytes for an
// index file or a topic file.
//
// Each renderer is a pure function — given a `CanonicalScope`
// it returns the file body as a UTF-8 string. The atomic
// publisher (`atomic-publisher.ts`) is the only thing
// that writes the bytes to disk. Keeping the renderers
// pure makes the round-trip property testable:
//
//   const bytes = render(scope, format)
//   const parsed = parse(bytes, format)   // import path
//   expect(parsed).toEqual(scope)
//
// JSON / YAML emit *every* topic's entries once — both
// in the index (counts + per-topic filename) and in the
// per-topic file. Markdown omits the per-entry dump from
// the index (the topic file is the source of truth) but
// keeps the high_importance / review_due summaries so
// the index is a usable scan.

import type { MemoryEntry } from "../domain.js";
import type { CanonicalScope } from "./canonical-model.js";
import { ExportFormat } from "./canonical-model.js";

export const AUTHORITY_NOTICE =
  "Generated from SQLite. SQLite is authoritative; manual edits may be overwritten.";

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function scopeLabel(entry: Pick<MemoryEntry, "scope" | "project_id">): string {
  return entry.scope === "project" ? `project/${entry.project_id ?? "unknown-project"}` : "global";
}

function tagsLabel(tags: string[]): string {
  return tags.length === 0 ? "none" : tags.join(", ");
}

function sourceLabel(entry: MemoryEntry): string {
  return entry.source.ref === undefined ? entry.source.kind : `${entry.source.kind}:${entry.source.ref}`;
}

function entrySummaryMarkdown(entry: MemoryEntry): string {
  return [
    `- [${entry.id}] ${entry.title}`,
    `  - scope: ${scopeLabel(entry)}`,
    `  - type: ${entry.type}`,
    `  - topic: ${entry.topic}`,
    `  - tags: ${tagsLabel(entry.tags)}`,
    `  - importance: ${entry.importance}; confidence: ${entry.confidence}; updated: ${entry.updated_at}`
  ].join("\n");
}

function entryDetailMarkdown(entry: MemoryEntry & { writer?: string }): string {
  const writer = entry.writer !== undefined ? ` [writer: ${entry.writer}]` : "";
  return [
    `## ${entry.title}${writer}`,
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

// ----- Markdown -----

export function renderIndexMarkdown(scope: CanonicalScope): string {
  const topicLinks = scope.topics.map((t) => `- [${t.topic}](topics/${t.filename})`);
  const lines: string[] = [
    "# AgentRecall Export",
    "",
    `> ${AUTHORITY_NOTICE}`,
    "",
    `Scope: ${scope.scope}`,
    `Budget: ${scope.budget}`,
    "",
    "## Topics",
    "",
    ...(topicLinks.length === 0 ? ["_No active topics._"] : topicLinks),
    "",
    "## High Importance",
    "",
    ...(scope.high_importance.length === 0
      ? ["_No high-importance active memories._"]
      : scope.high_importance.map(entrySummaryMarkdown)),
    "",
    "## Review Due",
    "",
    ...(scope.review_due.length === 0
      ? ["_No active memories have review dates._"]
      : scope.review_due.map(entrySummaryMarkdown)),
    ""
  ];
  return lines.join("\n");
}

export function renderTopicMarkdown(topic: { topic: string; entries: MemoryEntry[] }, scope: CanonicalScope): string {
  const lines: string[] = [
    `# ${topic.topic}`,
    "",
    `> ${AUTHORITY_NOTICE}`,
    "",
    `Scope: ${scope.scope}`,
    "",
    ...topic.entries.map((entry) => entryDetailMarkdown(entry))
  ];
  return lines.join("\n");
}

// ----- JSON -----

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

export function renderIndexJson(scope: CanonicalScope): string {
  const index = {
    scope: scope.scope,
    budget: scope.budget,
    schema: {
      export: scope.export_schema_version,
      source: scope.source_schema_version
    },
    generated_at: scope.generated_at,
    entry_count: scope.all_entries.length,
    topics: scope.topics.map((t) => ({
      name: t.topic,
      slug: t.slug,
      file: `topics/${t.filename}`,
      entry_count: t.entries.length
    })),
    high_importance: scope.high_importance.map(entrySummaryMarkdown),
    review_due: scope.review_due.map(entrySummaryMarkdown)
  };
  return JSON.stringify(sortObjectKeys(index), null, 2) + "\n";
}

export function renderTopicJson(topic: { topic: string; entries: MemoryEntry[] }, scope: CanonicalScope): string {
  const data = {
    topic: topic.topic,
    scope: scope.scope,
    schema: {
      export: scope.export_schema_version,
      source: scope.source_schema_version
    },
    generated_at: scope.generated_at,
    entries: topic.entries
  };
  return JSON.stringify(sortObjectKeys(data), null, 2) + "\n";
}

// ----- YAML -----

const YAML_NULL_LIKE = new Set(["null", "Null", "NULL", "~"]);
const YAML_BOOL_LIKE = new Set([
  "true", "True", "TRUE", "false", "False", "FALSE",
  "yes", "Yes", "YES", "no", "No", "NO",
  "on", "On", "ON", "off", "Off", "OFF"
]);

function yamlStringInline(value: string): string {
  if (value.length === 0) return '""';
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return JSON.stringify(value);
  if (YAML_BOOL_LIKE.has(value)) return JSON.stringify(value);
  if (YAML_NULL_LIKE.has(value)) return JSON.stringify(value);
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

export function renderIndexYaml(scope: CanonicalScope): string {
  const lines: string[] = [];
  lines.push(yamlScalar("scope", scope.scope));
  lines.push(yamlScalar("budget", scope.budget));
  lines.push("schema:");
  lines.push(`  export: ${scope.export_schema_version}`);
  lines.push(`  source: ${scope.source_schema_version}`);
  lines.push(yamlScalar("generated_at", scope.generated_at));
  lines.push(`entry_count: ${scope.all_entries.length}`);
  lines.push("topics:");
  for (const t of scope.topics) {
    lines.push(`  - name: ${yamlStringInline(t.topic)}`);
    lines.push(`    slug: ${yamlStringInline(t.slug)}`);
    lines.push(`    file: topics/${t.filename}`);
    lines.push(`    entry_count: ${t.entries.length}`);
  }
  lines.push("high_importance:");
  if (scope.high_importance.length === 0) {
    lines.push("  []");
  } else {
    for (const e of scope.high_importance) lines.push(...yamlListItem(entrySummaryMarkdown(e), 2));
  }
  lines.push("review_due:");
  if (scope.review_due.length === 0) {
    lines.push("  []");
  } else {
    for (const e of scope.review_due) lines.push(...yamlListItem(entrySummaryMarkdown(e), 2));
  }
  return lines.join("\n") + "\n";
}

export function renderTopicYaml(topic: { topic: string; entries: MemoryEntry[] }, scope: CanonicalScope): string {
  const lines: string[] = [];
  lines.push(yamlScalar("topic", topic.topic));
  lines.push(yamlScalar("scope", scope.scope));
  lines.push("schema:");
  lines.push(`  export: ${scope.export_schema_version}`);
  lines.push(`  source: ${scope.source_schema_version}`);
  lines.push(yamlScalar("generated_at", scope.generated_at));
  lines.push("entries:");
  for (const e of topic.entries) lines.push(...yamlEntry(e, 2));
  return lines.join("\n") + "\n";
}

// ----- Dispatcher -----

export function renderIndex(scope: CanonicalScope, format: ExportFormat): string {
  if (format === "markdown") return renderIndexMarkdown(scope);
  if (format === "json") return renderIndexJson(scope);
  return renderIndexYaml(scope);
}

export function renderTopic(
  topic: { topic: string; entries: MemoryEntry[] },
  scope: CanonicalScope,
  format: ExportFormat
): string {
  if (format === "markdown") return renderTopicMarkdown(topic, scope);
  if (format === "json") return renderTopicJson(topic, scope);
  return renderTopicYaml(topic, scope);
}
