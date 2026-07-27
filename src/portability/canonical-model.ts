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
import type { BudgetUsage, SQLiteMemoryStore } from "../sqlite-store.js";

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

// ============================================================
// Stage 18 v1.1.2 (issue #25, task 6): the v3 full-history
// bundle schema. The v3 bundle is the canonical
// portability artifact for a `history_mode === "full_history"`
// import: every entry post-image, every memory_revisions
// row, every audit_events row, every memory_relations row,
// and every memory_provenance row linked to the imported
// entries.
//
// The bundle is deterministic. Stable ordering:
//   - entries: by id ascending
//   - revisions: by memory_id ASC, then revision ASC
//   - audit_events: by memory_id ASC, then created_at ASC, then id ASC
//   - relations: by from_memory_id ASC, to_memory_id ASC, relation_type ASC
//   - provenance: by memory_id ASC, source_kind ASC, recorded_at ASC
//
// Secret values are NEVER redacted from the bundle bytes
// (the user explicitly requested them — they are the
// payload). Errors and logs (the manifest / error envelope /
// import preflight message) MUST remain redacted; the
// bundle file itself is the user-facing output.
//
// The `source` block carries the source database identity
// (schema version + the source-side `defaultActor`).
// The `bundle_hash` is computed over the canonical-JSON
// serialisation of every section EXCEPT the `source`
// identity block; the identity is metadata, not content,
// so a re-bundle with a different `defaultActor` does not
// produce a different hash. Determinism is by canonical-JSON
// key order, not by declaration order.
// ============================================================

export const FULL_HISTORY_BUNDLE_VERSION = 3 as const;

export type FullHistoryRevisionRow = {
  /** Source-side unique id (UUID-like key minted at write time). */
  revision_id: string;
  /** Source-side memory_id (will be remapped on apply). */
  memory_id: string;
  revision: number;
  actor_id: string;
  reason: string | null;
  /** Per-call request id from the source's RequestContext (when available). */
  request_id: string | null;
  /** Optional chat session id from the source (when available). */
  session_id: string | null;
  /** Optional tool call id from the source (when available). */
  tool_call_id: string | null;
  created_at: string;
  /** JSON-encoded post-image snapshot of the entry at this revision. */
  snapshot: Record<string, unknown>;
};

export type FullHistoryAuditRow = {
  /** Source-side unique id (the source's `audit_events.id`). */
  event_id: string;
  memory_id: string | null;
  scope: MemoryScope;
  project_id: string | null;
  event: string;
  reason: string | null;
  actor_id: string;
  request_id: string | null;
  session_id: string | null;
  tool_call_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type FullHistoryRelationRow = {
  from_memory_id: string;
  to_memory_id: string;
  relation_type: string;
  confidence: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type FullHistoryProvenanceRow = {
  memory_id: string;
  source_kind: "issue" | "pr" | "commit" | "tool_call" | "session" | "import";
  source_ref: string;
  recorded_by: string;
  recorded_at: number;
};

export type FullHistoryBundle = {
  bundle_version: typeof FULL_HISTORY_BUNDLE_VERSION;
  source: {
    actor_id: string;
    schema_version: number;
    /** SHA-256 hex of `<data_home_path>@<schema_version>`. */
    data_home_fingerprint?: string;
  };
  scope: {
    kind: MemoryScope;
    project_id?: string;
  };
  generated_at: string;
  entries: MemoryEntry[];
  revisions: FullHistoryRevisionRow[];
  audit_events: FullHistoryAuditRow[];
  relations: FullHistoryRelationRow[];
  provenance: FullHistoryProvenanceRow[];
};

/**
 * Stable byte-comparable JSON serialisation. Keys are
 * sorted recursively, `undefined` values are dropped, and
 * arrays preserve their declared order. Two objects with
 * the same logical content produce identical bytes; this
 * is the contract the v3 `bundle_hash` relies on.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJson(v)).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return (
      "{" +
      keys
        .filter((k) => obj[k] !== undefined)
        .map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k]))
        .join(",") +
      "}"
    );
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`);
}

function safeParseJsonObject(raw: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} is not a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${label}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export type BuildFullHistoryInput = {
  scope: MemoryScope;
  project_id?: string;
  /** All active entries in the source scope. */
  entries: MemoryEntry[];
  /** Source-side default actor (the writer_actor_id for new writes). */
  actor_id: string;
  /** Source database schema version. */
  source_schema_version: number;
  /** Optional data home fingerprint (hash of `<data_home_path>@<schema_version>`). */
  data_home_fingerprint?: string;
  /** ISO 8601 timestamp pinned to the build. */
  generated_at: string;
  /** Underlying store; the builder pulls history rows from it. */
  store: Pick<SQLiteMemoryStore, "listRevisionRows" | "listRelationRows" | "listAuditEventRowsForMemory" | "getProvenance">;
};

function nullIfEmpty(s: string | undefined): string | null {
  return s === undefined || s.length === 0 ? null : s;
}

/**
 * Build a v3 full-history bundle from the live store. The
 * function is pure against the inputs (`store` is read-only
 * — listRevisionRows / listRelationRows / listAuditEventRowsForMemory /
 * getProvenance are all `SELECT`s); the same inputs produce
 * the same bytes.
 *
 * The deterministic ordering is documented on
 * `FullHistoryBundle`; the import side relies on it to
 * stably recompute the bundle hash.
 */
export function buildFullHistoryBundle(input: BuildFullHistoryInput): FullHistoryBundle {
  // 1. Entries: sorted by id ascending.
  const entries = [...input.entries].sort((a, b) => compareText(a.id, b.id));
  // 2. Audit + revision + provenance rows: only the rows
  //    linked to an imported entry are included. A
  //    provenance link to a memory outside the scope is
  //    surfaced under the relations section (the schema
  //    forbids orphan provenance), but a stale link to a
  //    forgotten memory is silently dropped.
  const entryIds = new Set(entries.map((e) => e.id));

  const revisions: FullHistoryRevisionRow[] = [];
  const auditEvents: FullHistoryAuditRow[] = [];
  const provenance: FullHistoryProvenanceRow[] = [];

  for (const entry of entries) {
    // Revisions: post-image snapshots keyed on
    // (memory_id, revision). We carry the full
    // snapshot JSON the source's `memory_revisions`
    // table stored; the apply phase replays them
    // verbatim under the target memory_id.
    const revRows = input.store.listRevisionRows(entry.id);
    for (const r of revRows) {
      const snapshot = safeParseJsonObject(r.snapshot_json, `revision snapshot (${entry.id} rev ${r.revision})`);
      revisions.push({
        revision_id: `rev_${entry.id}_${r.revision}`,
        memory_id: r.memory_id,
        revision: r.revision,
        actor_id: r.changed_by,
        reason: r.change_reason,
        request_id: nullIfEmpty(r.request_id),
        session_id: null,
        tool_call_id: null,
        created_at: r.created_at,
        snapshot
      });
    }
    // Audit events: only the rows that target this
    // memory. The `(memory_id, created_at, id)` ordering
    // is the canonical audit-trail order.
    const audRows = input.store.listAuditEventRowsForMemory(entry.id);
    for (const a of audRows) {
      const metadata = safeParseJsonObject(a.metadata_json, `audit metadata (${a.id})`);
      auditEvents.push({
        event_id: a.id,
        memory_id: a.memory_id,
        scope: a.scope,
        project_id: a.project_id,
        event: a.event,
        reason: a.reason,
        actor_id: a.actor,
        request_id: null,
        session_id: null,
        tool_call_id: null,
        metadata,
        created_at: a.created_at
      });
    }
    // Provenance: stable order is the source's
    // `getProvenance` order (source_kind ASC,
    // recorded_at ASC). The PRIMARY KEY
    // `(memory_id, source_kind, source_ref)` makes the
    // insertion idempotent on apply. `getProvenance` is
    // scoped to one memory_id so we attach it ourselves.
    const provRows = input.store.getProvenance(entry.id);
    for (const p of provRows) {
      provenance.push({
        memory_id: entry.id,
        source_kind: p.source_kind,
        source_ref: p.source_ref,
        recorded_by: p.recorded_by,
        recorded_at: p.recorded_at
      });
    }
  }

  // 3. Relations: rows where at least one endpoint is in
  //    the imported entry set. A relation to an external
  //    memory that was NOT imported is still included so
  //    the live graph retains the cross-scope edges (the
  //    apply phase inserts them under the source-side id;
  //    if the endpoint was not imported, the relation is
  //    a dangling edge in the target, which is the same
  //    property the source had — the v1.1.2 contract does
  //    NOT chase cross-scope edges).
  const allRelations = input.store.listRelationRows();
  const relations: FullHistoryRelationRow[] = [];
  for (const r of allRelations) {
    if (!entryIds.has(r.from_memory_id) && !entryIds.has(r.to_memory_id)) {
      continue;
    }
    relations.push({
      from_memory_id: r.from_memory_id,
      to_memory_id: r.to_memory_id,
      relation_type: r.relation_type,
      confidence: r.confidence,
      metadata: safeParseJsonObject(r.metadata_json, `relation metadata (${r.from_memory_id}->${r.to_memory_id})`),
      created_at: r.created_at
    });
  }

  // 4. Revisions: stable secondary sort by `revision_id`
  //    so two bundles with the same logical content
  //    produce the same hash.
  revisions.sort((a, b) =>
    compareText(a.memory_id, b.memory_id) ||
    a.revision - b.revision ||
    compareText(a.revision_id, b.revision_id)
  );
  auditEvents.sort((a, b) =>
    compareText(a.memory_id ?? "", b.memory_id ?? "") ||
    compareText(a.created_at, b.created_at) ||
    compareText(a.event_id, b.event_id)
  );
  provenance.sort((a, b) =>
    compareText(a.memory_id, b.memory_id) ||
    compareText(a.source_kind, b.source_kind) ||
    a.recorded_at - b.recorded_at
  );
  relations.sort((a, b) =>
    compareText(a.from_memory_id, b.from_memory_id) ||
    compareText(a.to_memory_id, b.to_memory_id) ||
    compareText(a.relation_type, b.relation_type)
  );

  const bundle: FullHistoryBundle = {
    bundle_version: FULL_HISTORY_BUNDLE_VERSION,
    source: {
      actor_id: input.actor_id,
      schema_version: input.source_schema_version,
      ...(input.data_home_fingerprint !== undefined
        ? { data_home_fingerprint: input.data_home_fingerprint }
        : {})
    },
    scope: {
      kind: input.scope,
      ...(input.project_id !== undefined ? { project_id: input.project_id } : {})
    },
    generated_at: input.generated_at,
    entries,
    revisions,
    audit_events: auditEvents,
    relations,
    provenance
  };
  return bundle;
}

/**
 * SHA-256 over the canonical-JSON serialisation of a v3
 * bundle, with the `source` identity block excluded. The
 * bundle bytes the importer writes are byte-stable for a
 * given content + generated_at; the hash is the
 * import-side integrity check. Excluding the `source`
 * identity means a re-bundle under a different
 * `defaultActor` does not produce a different hash
 * (identity is metadata, not content).
 */
export function computeFullHistoryBundleHash(bundle: FullHistoryBundle): string {
  // We strip the `source` block; everything else
  // participates in the hash.
  const { source: _source, ...rest } = bundle;
  void _source;
  const payload = canonicalJson(rest);
  return createHash("sha256").update(payload).digest("hex");
}

export function serializeFullHistoryBundle(bundle: FullHistoryBundle): string {
  // Deterministic: same content + same generated_at →
  // same bytes. We do NOT sort object keys globally
  // because the build path already produces
  // deterministic arrays; the canonical-JSON helper in
  // the hash function handles the key-order surface for
  // hash equality.
  return JSON.stringify(bundle, null, 2) + "\n";
}
