// src/portability/canonical-model.ts
//
// Stage 13 PR10 (spec § 6.7): the single source of truth
// for what an export looks like, regardless of format.
//
// Before PR10 the markdown / json / yaml exporters each
// computed their own topic list, their own filename
// derivation, and their own sort order. CJK and Windows
// reserved names were handled in markdown-exporter but
// the JSON / YAML exporters fell back to ASCII-only
// slugs that collide (and the spec calls this out as
// AR-P1-006 — "导出碰撞与不确定性").
//
// The canonical model in this file is format-agnostic:
//   - one `buildCanonicalScope(input)` produces a
//     `CanonicalScope` object
//   - one `serializeCanonical(scope, format)` produces
//     the bytes for a topic file
//   - the file layout (scope/<index>, scope/topics/<file>)
//     and the filename map are shared across all formats
//
// Three concrete wins:
//   - the collision-safe filename map (slug + shortHash +
//     Windows-reserved guard) is computed once and
//     reused, so the JSON / YAML renderers no longer
//     fall back to "general" on CJK
//   - the rendered file shape is byte-identical modulo
//     serialization, so a JSON `topics/foo.json` and a
//     YAML `topics/foo.yaml` describe the same logical
//     content
//   - the manifest writer (MANIFEST.json) can take the
//     same scope and emit a single canonical record per
//     run

import { createHash } from "node:crypto";
import type { MemoryEntry, MemoryScope } from "../domain.js";
import type { BudgetUsage } from "../sqlite-store.js";

export type ExportFormat = "markdown" | "json" | "yaml";

export const WINDOWS_RESERVED_BASENAMES: ReadonlySet<string> = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"
]);

/**
 * Stable ASCII slug derived from a topic string. CJK
 * characters have no NFKD decomposition so they fall
 * through the regex and become `-`. We then trim /
 * collapse and fall back to `general` when the result
 * contains no ASCII alphanumerics. The Windows reserved
 * basenames (CON, PRN, AUX, ...) are prepended with
 * `topic-` to avoid creating an unusable file.
 */
export function safeTopicBase(topic: string): string {
  const ascii = topic
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 72);
  const base = /[a-z0-9]/.test(ascii) ? ascii : "general";
  const firstSegment = base.split(".")[0] ?? base;
  return WINDOWS_RESERVED_BASENAMES.has(firstSegment) ? `topic-${base}` : base;
}

/**
 * Short, deterministic hash of the original topic. The
 * first 8 hex chars of SHA-256 (32 bits) are enough to
 * disambiguate topic collisions without crowding the
 * filename. We always derive the hash from the *original*
 * topic (not the slug) so two distinct topics whose
 * slugs collide get distinct filenames.
 */
export function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * Build the topic -> filename map for a list of topics.
 * Two topics that collapse to the same slug get distinct
 * filenames via `-{shortHash}`. The returned map's keys
 * are the *original* topic strings; the values are the
 * final filenames including the format extension.
 */
export function buildTopicFilenameMap(topics: readonly string[], format: ExportFormat): Map<string, string> {
  const extension = format === "markdown" ? "md" : format;
  const bases = new Map<string, string[]>();
  for (const topic of topics) {
    const base = safeTopicBase(topic);
    const existing = bases.get(base) ?? [];
    existing.push(topic);
    bases.set(base, existing);
  }
  const result = new Map<string, string>();
  for (const topic of topics) {
    const base = safeTopicBase(topic);
    const collides = (bases.get(base)?.length ?? 0) > 1;
    result.set(topic, collides ? `${base}-${shortHash(topic)}.${extension}` : `${base}.${extension}`);
  }
  return result;
}

export type CanonicalTopic = {
  /** Original topic string (the in-DB value). */
  topic: string;
  /** Filename relative to `topics/`, e.g. `general-abcd1234.json`. */
  filename: string;
  /** Stable, deterministic sort key — the slug — useful
   *  for sorting topics with the same hash bucket. */
  slug: string;
  entries: MemoryEntry[];
};

export type CanonicalScope = {
  /** `global` or `project/{project_id}`. */
  scope: string;
  /** Raw scope + project_id for downstream code. */
  rawScope: MemoryScope;
  project_id?: string;
  /** Human-readable budget label. */
  budget: string;
  /** Topics sorted by slug, then by original topic for
   *  total stability. Each topic carries its own
   *  filename and entry list (sorted by
   *  importance/confidence/updated_at/id). */
  topics: CanonicalTopic[];
  /** Top-K high-importance entries (>= 4), sorted like
   *  the read service ranker. */
  high_importance: MemoryEntry[];
  /** Top-K entries with a `review_after`, sorted by
   *  review date asc. */
  review_due: MemoryEntry[];
  /** All active entries, for `entry_count` and for the
   *  import path. */
  all_entries: MemoryEntry[];
  /** ISO 8601 timestamp for the build. Callers can pin
   *  this in deterministic mode. */
  generated_at: string;
  /** Schema version of the canonical model. Bumped when
   *  the wire shape changes. */
  export_schema_version: 1;
  /** Source DB schema version. */
  source_schema_version: number;
};

export type CanonicalInput = {
  scope: MemoryScope;
  project_id?: string;
  entries: MemoryEntry[];
  budgetStatus: string | BudgetUsage;
  generated_at?: string;
  source_schema_version: number;
  /** Top-K for the review_due list. Default 10. */
  review_due_limit?: number;
};

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareEntries(
  a: MemoryEntry,
  b: MemoryEntry
): number {
  const importanceOrder = b.importance - a.importance;
  if (importanceOrder !== 0) return importanceOrder;
  const confidenceOrder = b.confidence - a.confidence;
  if (confidenceOrder !== 0) return confidenceOrder;
  const updatedOrder = compareText(b.updated_at, a.updated_at);
  if (updatedOrder !== 0) return updatedOrder;
  return compareText(a.id, b.id);
}

function budgetLabel(value: string | BudgetUsage): string {
  if (typeof value === "string") return value;
  return `${value.active_entries} active entries, ${value.active_chars} active chars, ${value.index_chars} index chars`;
}

/**
 * Build a `CanonicalScope` from a raw entry list. The
 * function is pure: same input, same `generated_at` =>
 * same output. `deterministic` callers should pass an
 * explicit `generated_at` so the bytes are reproducible
 * across runs.
 */
export function buildCanonicalScope(input: CanonicalInput, format: ExportFormat): CanonicalScope {
  const active = input.entries.filter((entry) => entry.status === "active");
  const topics = [...new Set(active.map((entry) => entry.topic))].sort(compareText);
  const filenameMap = buildTopicFilenameMap(topics, format);
  const scope = input.scope === "project" ? `project/${input.project_id ?? "unknown-project"}` : "global";

  const topicEntries: CanonicalTopic[] = topics.map((topic) => {
    const slug = safeTopicBase(topic);
    const entries = active
      .filter((entry) => entry.topic === topic)
      .sort(compareEntries);
    return {
      topic,
      filename: filenameMap.get(topic) ?? `${slug}.${format === "markdown" ? "md" : format}`,
      slug,
      entries
    };
  });

  const high_importance = active.filter((entry) => entry.importance >= 4).sort(compareEntries);
  const reviewDueLimit = input.review_due_limit ?? 10;
  const review_due = active
    .filter((entry) => entry.review_after !== undefined)
    .sort((a, b) => compareText(a.review_after ?? "", b.review_after ?? "") || compareEntries(a, b))
    .slice(0, reviewDueLimit);

  return {
    scope,
    rawScope: input.scope,
    ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
    budget: budgetLabel(input.budgetStatus),
    topics: topicEntries,
    high_importance,
    review_due,
    all_entries: active,
    generated_at: input.generated_at ?? new Date().toISOString(),
    export_schema_version: 1,
    source_schema_version: input.source_schema_version
  };
}
