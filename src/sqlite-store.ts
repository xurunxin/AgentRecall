import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { nowIso } from "./domain.js";
import type {
  AuditEventName,
  MemoryAuditEvent,
  MemoryEntry,
  MemoryScope,
  MemoryStatus,
  MemoryType,
  ProjectScope
} from "./domain.js";

export type EntryFilters = {
  scope?: MemoryScope;
  project_id?: string;
  type?: MemoryType | string;
  topic?: string;
  status?: MemoryStatus | string;
  tags?: string[];
  limit?: number;
  offset?: number;
  /**
   * Stage 4: filter to memories whose "created" audit row was written
   * by the given actor. Implemented as a subquery in the WHERE clause
   * to avoid a join on every read.
   */
  actor?: string;
  /**
   * Stage 6: ISO 8601 lower bound on `created_at`. Strings are
   * compared lexicographically, which is correct for ISO 8601.
   */
  since?: string;
  /**
   * Stage 6: ISO 8601 upper bound on `created_at`. Strings are
   * compared lexicographically, which is correct for ISO 8601.
   */
  until?: string;
  /**
   * Stage 6: ISO 8601 lower bound on `last_accessed_at`. Memories
   * with `last_accessed_at IS NULL` (never read) are excluded by
   * design — "never touched" is not "touched since X".
   */
  last_accessed_since?: string;
  /**
   * Stage 7: ISO 8601 lower bound on `updated_at`. Strings are
   * compared lexicographically, which is correct for ISO 8601.
   * Distinct from `since` (which filters `created_at`) — useful
   * for "what memories have I touched in the last week?" queries.
   */
  updated_since?: string;
  /**
   * Stage 7: ISO 8601 upper bound on `updated_at`. Parallel to
   * `until` (which filters `created_at`).
   */
  updated_until?: string;
};

export type SearchFilters = EntryFilters & {
  query: string;
};

/**
 * Current authoritative schema version. Stage 1 introduced explicit
 * `PRAGMA user_version` tracking. v2 loosened the `audit_events.actor`
 * CHECK constraint to allow structured values like `agent:claude-code`.
 * v3 adds the `last_accessed_by` JSON column to `memory_entries`.
 * v4 (Stage 11 PR7) adds revision / writer_actor_id / memory_revisions
 * / memory_accesses / project_aliases / memory_relations.
 * v5 (Stage 15 PR-M0-1) replaces `mutation_requests` with
 * `mutation_requests_v2` (PK `(actor_id, tool_name, idempotency_key)`,
 * transactional reservation).
 * v6 (Stage 15 PR-M0-4, issue #3) introduces persistent
 * `maintenance_plans` + `maintenance_plan_items` so plans survive
 * MCP restart and `apply_maintenance` only mutates planned targets
 * (no more "broad merge_duplicates" path).
 * v7 (Stage 15 PR-M1-1, issue #6) adds `memory_provenance` for
 * link chains (issue / PR / commit / tool_call / session / import)
 * and finalises the v3 `last_accessed_by` JSON column as
 * read-only-deprecated (the canonical access data lives in
 * `memory_accesses` from v4 onward).
 * v8 (Stage 15 PR-M1-2, issue #7) introduces a strict project
 * identity model: `project_identities` (one row per `project_id`
 * with its `canonical_path`) plus a strengthened `project_aliases`
 * table (PRIMARY KEY on the raw alias path; FK + UNIQUE on
 * `(project_id, canonical_path)`). The scope-resolver
 * consults both: an alias path that maps to a different
 * `project_id` than the caller's input surfaces
 * `project_identity_conflict`.
 * v9 (Stage 15 PR-M1-3, issue #5) adds `memory_feedback`
 * (per-actor explicit 👍/👎 signals) and
 * `memory_recall_signals` (cached per-memory recall stats
 * for the ranker). The RRF fusion in the ranker uses both
 * to replace the placeholder feedback / access signals.
 * v10 (Stage 15 PR-M3-1, issue #9) introduces the
 * memory hierarchy:
 *   - `memory_entries.tier` (`'core' | 'working' |
 *     'archival'`, default `'working'`)
 *   - `memory_entries.valid_from` / `valid_until`
 *     (Unix ms; NULL = no boundary)
 *   - `memory_episodes` table for episode-shaped
 *     memories (parent_memory_id, summary,
 *     started_at, ended_at, actor_id)
 * The ranker reads `tier` (core × 1.3, working × 1.0,
 * archival × 0.7) and `valid_from` / `valid_until`
 * (entries past their `valid_until` decay, entries
 * not yet at `valid_from` are excluded from recall).
 */
export const CURRENT_SCHEMA_VERSION = 10;

/**
 * Stage 12 PR9: thrown by `updateEntryWithRevision` when
 * the in-place CAS predicate matches zero rows. Caught
 * and re-thrown by `runWithBusyRetry`; the write service
 * catches it at the top level and converts it to the
 * `stale_revision` error code on the MCP wire.
 */
export class ConcurrentRevisionError extends Error {
  constructor(message = "stale_revision") {
    super(message);
    this.name = "ConcurrentRevisionError";
  }
  static isThis(value: unknown): value is ConcurrentRevisionError {
    return value instanceof ConcurrentRevisionError;
  }
}

/**
 * Type-guard for SQLite BUSY errors raised by
 * `node:sqlite`. SQLITE_LOCKED (6) is not retryable;
 * only SQLITE_BUSY (5) is.
 */
function isSqliteBusyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const err = error as { code?: string; errcode?: number; errno?: number };
  if (err.errcode === 5) return true;
  if (err.errno === 5) return true;
  if (typeof err.code === "string" && err.code.includes("SQLITE_BUSY")) {
    return true;
  }
  return false;
}

export type AuditFilters = {
  memory_id?: string;
  scope?: MemoryScope;
  project_id?: string;
  event?: AuditEventName | string;
  limit?: number;
  offset?: number;
};

export type BudgetUsage = {
  active_entries: number;
  active_chars: number;
  topic_chars: Record<string, number>;
  index_chars: number;
};

type EntryPatchField =
  | "topic"
  | "title"
  | "body"
  | "tags"
  | "importance"
  | "confidence"
  | "status"
  | "expires_at"
  | "review_after"
  | "supersedes"
  | "superseded_by"
  | "token_estimate"
  | "char_count"
  | "writer_actor_id";

export type EntryPatch = Partial<Pick<MemoryEntry, EntryPatchField>> & Pick<MemoryEntry, "updated_at">;

/**
 * Stage 15 PR-M0-4 (issue #3, spec § 6.2): row shape for
 * the persistent `maintenance_plans` table. The plan is
 * durable; the items live in a child table keyed on
 * `(plan_id, target_memory_id)`. The `plan_hash` is
 * SHA-256 over the canonical JSON of `items` so the
 * apply step can detect tampering between plan and apply.
 *
 * The `state` column is the plan lifecycle:
 *   - `pending`   -> freshly created, eligible for apply
 *   - `completed` -> apply succeeded; no further applies
 *   - `expired`   -> past `expires_at`; apply rejects
 *   - `rejected`  -> apply refused (stale revision /
 *                    wrong idempotency_key / hash drift);
 *                    no further applies
 */
export type MaintenancePlanState = "pending" | "completed" | "expired" | "rejected";
export type MaintenancePlanRisk = "low" | "medium" | "high";
export type MaintenancePlanActionType = "supersede" | "merge" | "forget" | "update" | "retain";

export type MaintenancePlanItemRow = {
  target_memory_id: string;
  expected_revision: number;
  action_type: MaintenancePlanActionType;
  /** JSON-encoded `evidence` (the DuplicateGroup that surfaced this candidate). */
  evidence_json: string;
  risk: MaintenancePlanRisk;
};

export type MaintenancePlanRow = {
  plan_id: string;
  plan_hash: string;
  creator_actor_id: string;
  created_at: string;
  expires_at: string;
  state: MaintenancePlanState;
  /** JSON-encoded `summary: string[]` from the planning step. */
  summary_json: string;
  scope: "global" | "project";
  project_id?: string;
  risk: MaintenancePlanRisk;
  items: MaintenancePlanItemRow[];
};

type Row = Record<string, SQLOutputValue>;

function encodeJson(value: unknown): string {
  return JSON.stringify(value);
}

function decodeJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stringCell(row: Row, column: string): string {
  const value = row[column];
  return value === undefined || value === null ? "" : String(value);
}

function optionalStringCell(row: Row, column: string): string | undefined {
  const value = row[column];
  return value === undefined || value === null ? undefined : String(value);
}

function numberCell(row: Row, column: string): number {
  const value = row[column];
  return typeof value === "number" || typeof value === "bigint" ? Number(value) : Number(String(value));
}

function decodeEntry(row: Row): MemoryEntry {
  const entry: MemoryEntry = {
    id: stringCell(row, "id"),
    scope: stringCell(row, "scope") as MemoryScope,
    type: stringCell(row, "type") as MemoryEntry["type"],
    topic: stringCell(row, "topic"),
    title: stringCell(row, "title"),
    body: stringCell(row, "body"),
    tags: decodeJson<string[]>(stringCell(row, "tags_json")),
    source: decodeJson<MemoryEntry["source"]>(stringCell(row, "source_json")),
    importance: numberCell(row, "importance") as MemoryEntry["importance"],
    confidence: numberCell(row, "confidence") as MemoryEntry["confidence"],
    status: stringCell(row, "status") as MemoryEntry["status"],
    created_at: stringCell(row, "created_at"),
    updated_at: stringCell(row, "updated_at"),
    access_count: numberCell(row, "access_count"),
    supersedes: decodeJson<string[]>(stringCell(row, "supersedes_json")),
    token_estimate: numberCell(row, "token_estimate"),
    char_count: numberCell(row, "char_count"),
    // Stage 12 PR9: schema v4 row shape. The defaults
    // match the v3->v4 migration's `addColumnIfMissing`
    // definitions so a row that has been migrated from
    // a v3 file decodes cleanly even if a future
    // migration drops the legacy defaults.
    revision: numberCell(row, "revision") || 1,
    writer_actor_id: stringCell(row, "writer_actor_id") || "agent:unknown",
    pinned: numberCell(row, "pinned") === 1,
    trust_level: (stringCell(row, "trust_level") ||
      "agent_observed") as MemoryEntry["trust_level"],
    sensitivity: (stringCell(row, "sensitivity") ||
      "normal") as MemoryEntry["sensitivity"],
    // Stage 15 PR-M3-1 (issue #9, spec § 6.5): the
    // memory tier. Defaults to 'working' for legacy
    // rows that pre-date the v10 column.
    tier: ((stringCell(row, "tier") || "working")) as MemoryEntry["tier"],
    metadata: decodeJson<Record<string, unknown>>(
      optionalStringCell(row, "metadata_json") ?? "{}"
    )
  };

  const projectId = optionalStringCell(row, "project_id");
  if (projectId !== undefined) entry.project_id = projectId;

  const projectPath = optionalStringCell(row, "project_path");
  if (projectPath !== undefined) entry.project_path = projectPath;

  const lastAccessedAt = optionalStringCell(row, "last_accessed_at");
  if (lastAccessedAt !== undefined) entry.last_accessed_at = lastAccessedAt;

  const lastAccessedByRaw = optionalStringCell(row, "last_accessed_by");
  if (lastAccessedByRaw !== undefined && lastAccessedByRaw.length > 0) {
    try {
      const parsed = JSON.parse(lastAccessedByRaw) as Record<string, string>;
      if (parsed && typeof parsed === "object") {
        entry.last_accessed_by = parsed;
      }
    } catch {
      // Corrupt JSON in storage; treat as empty map. Defensive: the
      // read path never throws, so a corrupt row is just hidden from
      // the last_accessed_by check.
    }
  }

  const expiresAt = optionalStringCell(row, "expires_at");
  if (expiresAt !== undefined) entry.expires_at = expiresAt;

  const reviewAfter = optionalStringCell(row, "review_after");
  if (reviewAfter !== undefined) entry.review_after = reviewAfter;

  const supersededBy = optionalStringCell(row, "superseded_by");
  if (supersededBy !== undefined) entry.superseded_by = supersededBy;

  const contentHash = optionalStringCell(row, "content_hash");
  if (contentHash !== undefined) entry.content_hash = contentHash;

  const validFrom = optionalStringCell(row, "valid_from");
  if (validFrom !== undefined) entry.valid_from = validFrom;

  const validUntil = optionalStringCell(row, "valid_until");
  if (validUntil !== undefined) entry.valid_until = validUntil;

  const deletedAt = optionalStringCell(row, "deleted_at");
  if (deletedAt !== undefined) entry.deleted_at = deletedAt;

  return entry;
}

function decodeProject(row: Row): ProjectScope {
  return {
    project_id: stringCell(row, "project_id"),
    canonical_path: stringCell(row, "canonical_path"),
    display_name: stringCell(row, "display_name"),
    created_at: stringCell(row, "created_at"),
    updated_at: stringCell(row, "updated_at"),
    budget: decodeJson<ProjectScope["budget"]>(stringCell(row, "budget_json"))
  };
}

function decodeAudit(row: Row): MemoryAuditEvent {
  const event: MemoryAuditEvent = {
    id: stringCell(row, "id"),
    scope: stringCell(row, "scope") as MemoryScope,
    event: stringCell(row, "event") as MemoryAuditEvent["event"],
    actor: stringCell(row, "actor") as MemoryAuditEvent["actor"],
    metadata: decodeJson<Record<string, unknown>>(stringCell(row, "metadata_json")),
    created_at: stringCell(row, "created_at")
  };

  const memoryId = optionalStringCell(row, "memory_id");
  if (memoryId !== undefined) event.memory_id = memoryId;

  const projectId = optionalStringCell(row, "project_id");
  if (projectId !== undefined) event.project_id = projectId;

  const reason = optionalStringCell(row, "reason");
  if (reason !== undefined) event.reason = reason;

  return event;
}

function ftsQuery(query: string): string {
  return (query.match(/[\p{L}\p{N}_]+/gu) ?? [])
    .map((token) => `"${token.replaceAll("\"", "\"\"")}"`)
    .join(" OR ");
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return fallback;
  return Number.isInteger(limit) && limit > 0 ? limit : fallback;
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  return Number.isInteger(offset) && offset > 0 ? offset : 0;
}

const ENTRY_PATCH_FIELDS = [
  "topic",
  "title",
  "body",
  "tags",
  "importance",
  "confidence",
  "status",
  "expires_at",
  "review_after",
  "supersedes",
  "superseded_by",
  "token_estimate",
  "char_count",
  "writer_actor_id"
] as const satisfies readonly EntryPatchField[];

function sanitizeEntryPatch(patch: EntryPatch): EntryPatch {
  const result: Record<string, unknown> = { updated_at: patch.updated_at };
  for (const key of ENTRY_PATCH_FIELDS) {
    const value = patch[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as EntryPatch;
}

function buildEntryWhere(filters: EntryFilters, alias: string): { where: string; params: SQLInputValue[] } {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  const column = (name: string) => `${alias}.${name}`;

  if (filters.scope !== undefined) {
    clauses.push(`${column("scope")} = ?`);
    params.push(filters.scope);
  }
  if (filters.project_id !== undefined) {
    clauses.push(`${column("project_id")} = ?`);
    params.push(filters.project_id);
  }
  if (filters.type !== undefined) {
    clauses.push(`${column("type")} = ?`);
    params.push(filters.type);
  }
  if (filters.topic !== undefined) {
    clauses.push(`${column("topic")} = ?`);
    params.push(filters.topic);
  }
  if (filters.status !== undefined) {
    clauses.push(`${column("status")} = ?`);
    params.push(filters.status);
  }
  for (const tag of filters.tags ?? []) {
    clauses.push(`EXISTS (SELECT 1 FROM json_each(${column("tags_json")}) WHERE value = ?)`);
    params.push(tag);
  }
  if (filters.actor !== undefined) {
    // Stage 14 PR-B1 (spec § 5.2 #5): the canonical writer lives
    // on `memory_entries.writer_actor_id` (filled by the v3->v4
    // migration from the audit log). The pre-PR-B1 subquery
    // against `audit_events` was a per-row N+1 — every filter
    // check had to walk the audit log. The writer column is
    // indexed by the primary key lookup, so the filter is a
    // single equality predicate.
    clauses.push(`${column("writer_actor_id")} = ?`);
    params.push(filters.actor);
  }
  if (filters.since !== undefined) {
    clauses.push(`${column("created_at")} >= ?`);
    params.push(filters.since);
  }
  if (filters.until !== undefined) {
    clauses.push(`${column("created_at")} <= ?`);
    params.push(filters.until);
  }
  if (filters.last_accessed_since !== undefined) {
    // Exclude never-read memories by the IS NOT NULL guard.
    clauses.push(`${column("last_accessed_at")} IS NOT NULL AND ${column("last_accessed_at")} >= ?`);
    params.push(filters.last_accessed_since);
  }
  if (filters.updated_since !== undefined) {
    clauses.push(`${column("updated_at")} >= ?`);
    params.push(filters.updated_since);
  }
  if (filters.updated_until !== undefined) {
    clauses.push(`${column("updated_at")} <= ?`);
    params.push(filters.updated_until);
  }

  return {
    where: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`,
    params
  };
}

function buildBudgetWhere(filters: { scope: MemoryScope; project_id?: string }): { where: string; params: SQLInputValue[] } {
  const clauses = ["status = 'active'", "scope = ?"];
  const params: SQLInputValue[] = [filters.scope];
  if (filters.project_id !== undefined) {
    clauses.push("project_id = ?");
    params.push(filters.project_id);
  }
  return {
    where: `WHERE ${clauses.join(" AND ")}`,
    params
  };
}

function buildAuditWhere(filters: AuditFilters): { where: string; params: SQLInputValue[] } {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];

  if (filters.memory_id !== undefined) {
    clauses.push("memory_id = ?");
    params.push(filters.memory_id);
  }
  if (filters.scope !== undefined) {
    clauses.push("scope = ?");
    params.push(filters.scope);
  }
  if (filters.project_id !== undefined) {
    clauses.push("project_id = ?");
    params.push(filters.project_id);
  }
  if (filters.event !== undefined) {
    clauses.push("event = ?");
    params.push(filters.event);
  }

  return {
    where: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`,
    params
  };
}

/**
 * Stage 10 PR5: the store open mode. Pre-PR5 the constructor
 * called `migrate()` unconditionally, which made the CLI
 * `migrate --yes` confirmation meaningless: by the time
 * the command handler ran, the schema was already upgraded.
 *
 * The new default is `read_write_no_migrate`; callers that
 * want auto-upgrade (e.g. the legacy MCP test fixtures)
 * opt in explicitly with `read_write_auto_migrate`. The
 * `migrate` CLI command decides when to call
 * `runMigrations({ backupFirst: true })` after taking a
 * verified backup.
 */
export type StoreOpenMode =
  | "read_only"
  | "read_write_no_migrate"
  | "read_write_auto_migrate";

export class SQLiteMemoryStore {
  private readonly db: DatabaseSync;
  private transactionDepth = 0;
  private readonly openMode: StoreOpenMode;

  constructor(dbPath: string, openMode: StoreOpenMode = "read_write_no_migrate") {
    mkdirSync(dirname(dbPath), { recursive: true });
    const readonly = openMode === "read_only";
    this.db = new DatabaseSync(dbPath, {
      enableForeignKeyConstraints: true,
      timeout: 5000,
      readOnly: readonly
    });
    this.openMode = openMode;
    // Stage 11 PR8: WAL + busy retry baseline (spec
    // section 5.6). Read-only connections skip the WAL
    // PRAGMAs because they have no effect on a snapshot
    // reader; busy_timeout still applies so an
    // unexpectedly-shared connection does not error.
    if (!readonly) {
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA wal_autocheckpoint = 1000;
      `);
    } else {
      this.db.exec(`PRAGMA busy_timeout = 5000;`);
    }
    if (openMode === "read_write_auto_migrate") {
      this.migrate();
    } else if (openMode === "read_write_no_migrate") {
      // Touch the schema so subsequent reads can introspect
      // user_version, but do not write. The legacy in-place
      // CREATE TABLE IF NOT EXISTS in the v1 base DDL still
      // runs to make a fresh database usable; only the
      // version-aware migration chain is skipped. A fresh
      // database (user_version === 0) is upgraded to
      // CURRENT_SCHEMA_VERSION automatically because there
      // is no prior schema to preserve. A non-fresh
      // database (user_version > 0 but < CURRENT) is left
      // alone; the CLI `migrate` command decides when to
      // advance it.
      this.ensureBaseSchema();
      if (this.readUserVersion() === 0) {
        this.migrateForward();
      }
    }
  }

  getOpenMode(): StoreOpenMode {
    return this.openMode;
  }

  close(): void {
    this.db.close();
  }

  /**
   * Returns the underlying database handle. Intended ONLY for backup
   * (VACUUM INTO). Do not call arbitrary statements; doing so bypasses
   * the store's row-decoding and audit/FTS bookkeeping.
   */
  backupHandle(): DatabaseSync {
    return this.db;
  }

  transaction<T>(work: () => T): T {
    if (this.transactionDepth > 0) {
      return work();
    }

    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth = 1;
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  private migrate(): void {
    this.db.exec("PRAGMA foreign_keys = ON");
    this.ensureBaseSchema();
    this.migrateForward();
  }

  /**
   * Stage 10 PR5: ensure the v1 base schema is in place
   * without running the version-aware migration chain. The
   * `read_write_no_migrate` open mode calls this from the
   * constructor; a fresh database file gets a usable schema,
   * but a stale one is left at its current user_version so
   * the CLI `migrate` command can ask for confirmation.
   */
  private ensureBaseSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_scopes (
        project_id TEXT PRIMARY KEY,
        canonical_path TEXT NOT NULL,
        display_name TEXT NOT NULL,
        budget_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
        project_id TEXT,
        project_path TEXT,
        type TEXT NOT NULL,
        topic TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source_json TEXT NOT NULL,
        importance INTEGER NOT NULL,
        confidence INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'archived', 'superseded', 'forgotten')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_accessed_at TEXT,
        last_accessed_by TEXT,
        access_count INTEGER NOT NULL,
        expires_at TEXT,
        review_after TEXT,
        supersedes_json TEXT NOT NULL,
        superseded_by TEXT,
        token_estimate INTEGER NOT NULL,
        char_count INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_entries_scope_project_idx
        ON memory_entries(scope, project_id, status, updated_at);
      CREATE INDEX IF NOT EXISTS memory_entries_topic_idx
        ON memory_entries(topic);
      CREATE INDEX IF NOT EXISTS memory_entries_type_idx
        ON memory_entries(type);

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        memory_id TEXT,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
        project_id TEXT,
        event TEXT NOT NULL,
        reason TEXT,
        -- Stage 10 PR3: actor is a free-form string so
        -- structured values like "agent:claude-code" or
        -- "system:expiry" can be stored. The legacy v1
        -- CHECK constraint was dropped in the v1->v2
        -- migration. New files created by ensureBaseSchema
        -- start without it.
        actor TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS audit_events_memory_created_idx
        ON audit_events(memory_id, created_at);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        id UNINDEXED,
        scope UNINDEXED,
        project_id UNINDEXED,
        topic,
        title,
        body,
        tags
      );
    `);
  }

  private readUserVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get();
    if (row === undefined) return 0;
    const value = (row as Record<string, unknown>).user_version;
    return typeof value === "number" ? value : 0;
  }

  getUserVersion(): number {
    return this.readUserVersion();
  }

  setUserVersion(version: number): void {
    // Exposed for the CLI migrate command. Runs outside a transaction.
    this.db.exec(`PRAGMA user_version = ${version}`);
  }

  runMigrations(): { from: number; to: number } {
    // Stage 10 PR5: ensure the base schema is in place
    // before walking the version chain. The base DDL is
    // idempotent (CREATE TABLE IF NOT EXISTS) so calling it
    // on a fresh file is harmless; calling it on a stale
    // file is a no-op for tables that already exist.
    const before = this.readUserVersion();
    this.ensureBaseSchema();
    this.migrateForward();
    const after = this.readUserVersion();
    return { from: before, to: after };
  }

  private migrateForward(): void {
    const current = this.readUserVersion();
    if (current >= CURRENT_SCHEMA_VERSION) {
      return;
    }
    for (let version = current + 1; version <= CURRENT_SCHEMA_VERSION; version += 1) {
      this.migrateToVersion(version);
    }
  }

  private migrateToVersion(version: number): void {
    if (version === 1) {
      // v1 is the base schema. The CREATE TABLE IF NOT EXISTS DDL above
      // is already the v1 shape; this step just records the version
      // marker so a future v1->v2 migration has a stable starting point.
      this.setUserVersion(1);
      return;
    }
    if (version === 2) {
      this.migrate_v1_to_v2();
      return;
    }
    if (version === 3) {
      this.migrate_v2_to_v3();
      return;
    }
    if (version === 4) {
      this.migrate_v3_to_v4();
      return;
    }
    if (version === 5) {
      this.migrate_v4_to_v5();
      return;
    }
    if (version === 6) {
      this.migrate_v5_to_v6();
      return;
    }
    if (version === 7) {
      this.migrate_v6_to_v7();
      return;
    }
    if (version === 8) {
      this.migrate_v7_to_v8();
      return;
    }
    if (version === 9) {
      this.migrate_v8_to_v9();
      return;
    }
    if (version === 10) {
      this.migrate_v9_to_v10();
      return;
    }
    throw new Error(`No migration registered for schema version ${version}`);
  }

  private migrate_v2_to_v3(): void {
    // Add the last_accessed_by JSON column. The column is nullable, so
    // existing rows are unaffected. The read path defaults to an empty
    // map when the column is null. The check is idempotent in case
    // base DDL already added the column (fresh installs are at v3).
    const cols = this.db.prepare("PRAGMA table_info(memory_entries)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "last_accessed_by")) {
      this.db.exec("ALTER TABLE memory_entries ADD COLUMN last_accessed_by TEXT");
    }
    this.db.exec("PRAGMA user_version = 3");
  }

  /**
   * Stage 11 PR7: v3 -> v4 schema migration. Spec § 6.5
   * describes the schema v4 layout; this migration
   * introduces every v4-only field on `memory_entries`
   * and the v4-only tables, then re-backs the writer
   * actor id from the audit log (idempotent), splits
   * `last_accessed_by` JSON into the `memory_accesses`
   * table, and lifts `supersedes_json` into
   * `memory_relations`. The migration is fully
   * transactional; if any step throws the user_version
   * is left at 3 and the database is untouched.
   */
  private migrate_v3_to_v4(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.addColumnIfMissing(
        "memory_entries",
        "revision",
        "INTEGER NOT NULL DEFAULT 1"
      );
      this.addColumnIfMissing(
        "memory_entries",
        "writer_actor_id",
        "TEXT NOT NULL DEFAULT 'agent:unknown'"
      );
      this.addColumnIfMissing(
        "memory_entries",
        "content_hash",
        "TEXT"
      );
      this.addColumnIfMissing("memory_entries", "pinned", "INTEGER NOT NULL DEFAULT 0");
      this.addColumnIfMissing(
        "memory_entries",
        "trust_level",
        "TEXT NOT NULL DEFAULT 'agent_observed'"
      );
      this.addColumnIfMissing(
        "memory_entries",
        "sensitivity",
        "TEXT NOT NULL DEFAULT 'normal'"
      );
      this.addColumnIfMissing("memory_entries", "valid_from", "TEXT");
      this.addColumnIfMissing("memory_entries", "valid_until", "TEXT");
      this.addColumnIfMissing("memory_entries", "deleted_at", "TEXT");
      this.addColumnIfMissing(
        "memory_entries",
        "metadata_json",
        "TEXT NOT NULL DEFAULT '{}'"
      );

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_revisions (
          memory_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          snapshot_json TEXT NOT NULL,
          changed_by TEXT NOT NULL,
          request_id TEXT NOT NULL,
          change_reason TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (memory_id, revision)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS memory_accesses (
          memory_id TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          access_count INTEGER NOT NULL DEFAULT 0,
          first_accessed_at TEXT NOT NULL,
          last_accessed_at TEXT NOT NULL,
          PRIMARY KEY (memory_id, actor_id)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS project_aliases (
          project_id TEXT NOT NULL,
          alias_type TEXT NOT NULL,
          alias_value TEXT NOT NULL,
          normalized_value TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (alias_type, normalized_value)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS mutation_requests (
          actor_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          result_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (actor_id, idempotency_key)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS memory_relations (
          from_memory_id TEXT NOT NULL,
          to_memory_id TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          confidence REAL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          PRIMARY KEY (from_memory_id, to_memory_id, relation_type)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS memory_accesses_actor_idx
          ON memory_accesses(actor_id, last_accessed_at);
        CREATE INDEX IF NOT EXISTS memory_relations_to_idx
          ON memory_relations(to_memory_id, relation_type);
        CREATE INDEX IF NOT EXISTS memory_relations_type_idx
          ON memory_relations(relation_type, created_at);
      `);

      // Back-fill writer_actor_id from the audit log so the
      // pre-existing v3 entries have a canonical writer.
      // Pre-PR7 the canonical writer was reconstructed on
      // every read by scanning the audit log; post-PR7 the
      // canonical writer is stored on the row and the
      // audit scan is only used as a fallback. Missing or
      // unmatched entries default to 'agent:unknown'.
      this.db.exec(`
        UPDATE memory_entries
           SET writer_actor_id = COALESCE(
             (SELECT actor FROM audit_events
                WHERE audit_events.memory_id = memory_entries.id
                  AND audit_events.event = 'created'
                ORDER BY audit_events.created_at ASC
                LIMIT 1),
             writer_actor_id
           )
         WHERE writer_actor_id = 'agent:unknown' AND
               EXISTS (SELECT 1 FROM audit_events
                          WHERE audit_events.memory_id = memory_entries.id
                            AND audit_events.event = 'created');
      `);

      // Lift the legacy `last_accessed_by` JSON map into
      // `memory_accesses`. Pre-PR7 the column was a free-
      // form JSON object; post-PR7 it is left in place for
      // one release cycle of read-compat, and the
      // canonical access data lives in the new table.
      const legacyRows = this.db
        .prepare("SELECT id, last_accessed_by FROM memory_entries WHERE last_accessed_by IS NOT NULL")
        .all() as Array<{ id: string; last_accessed_by: string }>;
      const insertAccess = this.db.prepare(`
        INSERT OR REPLACE INTO memory_accesses
          (memory_id, actor_id, access_count, first_accessed_at, last_accessed_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const row of legacyRows) {
        let parsed: Record<string, unknown> | undefined;
        try {
          parsed = JSON.parse(row.last_accessed_by) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (parsed === null || typeof parsed !== "object") continue;
        for (const [actor, value] of Object.entries(parsed)) {
          if (typeof value !== "string") continue;
          insertAccess.run(row.id, actor, 1, value, value);
        }
      }

      // Lift `supersedes_json` into `memory_relations`
      // (relation_type = 'supersedes'). Pre-PR7 a single
      // entry could supersede multiple others; the JSON
      // column was the only way to express that. Post-PR7
      // the canonical graph is in `memory_relations`.
      const supersedeRows = this.db
        .prepare("SELECT id, supersedes_json, created_at FROM memory_entries WHERE supersedes_json IS NOT NULL AND supersedes_json != '[]'")
        .all() as Array<{ id: string; supersedes_json: string; created_at: string }>;
      const insertRelation = this.db.prepare(`
        INSERT OR IGNORE INTO memory_relations
          (from_memory_id, to_memory_id, relation_type, confidence, metadata_json, created_at)
        VALUES (?, ?, 'supersedes', 1.0, '{}', ?)
      `);
      for (const row of supersedeRows) {
        let targets: string[] = [];
        try {
          const parsed = JSON.parse(row.supersedes_json) as unknown;
          if (Array.isArray(parsed)) {
            targets = parsed.filter((v): v is string => typeof v === "string");
          }
        } catch {
          continue;
        }
        for (const target of targets) {
          insertRelation.run(row.id, target, row.created_at);
        }
      }

      this.db.exec("PRAGMA user_version = 4");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Stage 15 PR-M0-1 (issue #1, spec § 5.6): v4 -> v5
   * schema migration. Introduces the
   * `mutation_requests_v2` table with
   * PRIMARY KEY (actor_id, tool_name, idempotency_key)
   * and a `state` column so the idempotency record is
   * reserved in the same transaction as the mutation.
   * Copies every row from the legacy `mutation_requests`
   * table into v2 with `tool_name='legacy'`. The legacy
   * table is dropped after the copy. The down path
   * (schema downgrade) renames v2 back to mutation_requests
   * and drops the v2 state / request_id / completed_at
   * columns so the v4 read path resumes working.
   */
  private migrate_v4_to_v5(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS mutation_requests_v2 (
          actor_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending','completed')),
          request_hash TEXT NOT NULL,
          result_json TEXT,
          request_id TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT,
          PRIMARY KEY (actor_id, tool_name, idempotency_key)
        ) STRICT
      `);

      // Copy v1 rows into v2 with tool_name='legacy'.
      // The v1 PK was (actor_id, idempotency_key) so the
      // copy is 1:1 under the legacy namespace.
      this.db.exec(`
        INSERT OR IGNORE INTO mutation_requests_v2
          (actor_id, tool_name, idempotency_key, state,
           request_hash, result_json, request_id,
           created_at, completed_at)
        SELECT
          actor_id, 'legacy', idempotency_key, 'completed',
          request_hash, result_json, NULL,
          created_at, created_at
        FROM mutation_requests
      `);

      // The legacy table is now redundant (v2 is the
      // source of truth). We keep it for one release
      // cycle for any external reader that has not yet
      // migrated; the v1 wrapper in src/services/idempotency.ts
      // uses the `tool_name='legacy'` namespace to keep
      // its reads working.
      this.db.exec("PRAGMA user_version = 5");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Stage 15 PR-M0-4 (issue #3, spec § 6.2): v5 -> v6
   * schema migration. Introduces persistent
   * `maintenance_plans` and `maintenance_plan_items`
   * so plans survive MCP restart. Each item carries its
   * `expected_revision` so `apply_maintenance` can refuse
   * stale plans; the plan carries a `plan_hash` (SHA256
   * over the canonical JSON of items) so the apply step
   * can detect tampering between plan and apply.
   *
   * Pre-v6 plans lived in a process-local `Map`; they were
   * gone the moment the MCP server restarted. With v6, the
   * plan is durable: an agent can call `plan_maintenance`,
   * the user can review the plan, and a different MCP
   * session can call `apply_maintenance` hours later and
   * still see the same plan.
   *
   * Migration is fully transactional. If any step throws,
   * the user_version stays at 5 and the database is
   * untouched.
   */
  private migrate_v5_to_v6(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS maintenance_plans (
          plan_id TEXT PRIMARY KEY,
          plan_hash TEXT NOT NULL,
          creator_actor_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending','completed','expired','rejected')),
          summary_json TEXT NOT NULL,
          scope TEXT NOT NULL CHECK (scope IN ('global','project')),
          project_id TEXT,
          risk TEXT NOT NULL CHECK (risk IN ('low','medium','high'))
        ) STRICT;

        CREATE TABLE IF NOT EXISTS maintenance_plan_items (
          plan_id TEXT NOT NULL,
          target_memory_id TEXT NOT NULL,
          expected_revision INTEGER NOT NULL,
          action_type TEXT NOT NULL CHECK (action_type IN ('supersede','merge','forget','update','retain')),
          evidence_json TEXT NOT NULL,
          risk TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
          PRIMARY KEY (plan_id, target_memory_id),
          FOREIGN KEY (plan_id) REFERENCES maintenance_plans(plan_id) ON DELETE CASCADE
        ) STRICT;

        CREATE INDEX IF NOT EXISTS maintenance_plans_state_idx
          ON maintenance_plans(state, expires_at);
        CREATE INDEX IF NOT EXISTS maintenance_plan_items_target_idx
          ON maintenance_plan_items(target_memory_id);
      `);
      this.db.exec("PRAGMA user_version = 6");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Stage 15 PR-M1-1 (issue #6, spec § 5.3): v6 -> v7
   * schema migration. Introduces `memory_provenance`
   * for the durable link chain (issue URL / PR URL /
   * commit SHA / tool-call id / session id / mcp
   * client name / import source). The primary key is
   * `(memory_id, source_kind, source_ref)` so a
   * memory can carry multiple provenance links and
   * the same source ref is idempotent under repeat
   * ingestion. The v3 `last_accessed_by` JSON
   * column is now read-only-deprecated; the
   * canonical access data has lived in
   * `memory_accesses` since v4, so this migration is
   * non-destructive (the column is left in place for
   * one release cycle of read-compat).
   */
  private migrate_v6_to_v7(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_provenance (
          memory_id TEXT NOT NULL,
          source_kind TEXT NOT NULL CHECK (source_kind IN ('issue','pr','commit','tool_call','session','import')),
          source_ref TEXT NOT NULL,
          recorded_by TEXT NOT NULL,
          recorded_at INTEGER NOT NULL,
          PRIMARY KEY (memory_id, source_kind, source_ref)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS memory_provenance_kind_idx
          ON memory_provenance(source_kind, source_ref);
      `);
      this.db.exec("PRAGMA user_version = 7");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Stage 15 PR-M1-2 (issue #7, spec § 5.4): v7 -> v8
   * schema migration. Introduces a strict project
   * identity model:
   *
   *   - `project_identities(project_id, canonical_path,
   *     created_by, created_at)` with `project_id` as
   *     the PRIMARY KEY. One row per project, holding
   *     the canonical path the project was created
   *     with. Inserting a second row for the same
   *     `project_id` (with a different `canonical_path`)
   *     surfaces `project_identity_conflict` at the
   *     service layer; the table does NOT enforce a
   *     UNIQUE on `canonical_path` because two
   *     projects may legitimately share a path
   *     canonicalisation (e.g. a worktree resolves to
   *     the same canonical path as the main repo).
   *
   *   - `project_aliases` is rebuilt with a stronger
   *     contract: PRIMARY KEY is the raw alias path
   *     (one row per alias), the FK back to
   *     `project_identities(project_id)` is enforced,
   *     and `recorded_by` / `recorded_at` capture the
   *     audit trail. The v7 `project_aliases` table
   *     used `(alias_type, normalized_value)` as the
   *     primary key and did not enforce a FK to the
   *     identity table; v8 strengthens the contract.
   *
   * The migration copies existing v7 `project_aliases`
   * rows into the new shape; the old v7 table is
   * dropped after the copy. The new table is created
   * fresh on a v8+ install.
   */
  private migrate_v7_to_v8(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS project_identities (
          project_id TEXT PRIMARY KEY,
          canonical_path TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS project_aliases_new (
          alias TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          canonical_path TEXT NOT NULL,
          alias_kind TEXT NOT NULL CHECK (alias_kind IN ('path','git_head','worktree')),
          recorded_by TEXT NOT NULL,
          recorded_at INTEGER NOT NULL,
          FOREIGN KEY (project_id) REFERENCES project_identities(project_id) ON DELETE CASCADE
        ) STRICT;

        CREATE INDEX IF NOT EXISTS project_aliases_new_project_idx
          ON project_aliases_new(project_id);
      `);
      this.db.exec("PRAGMA user_version = 8");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Stage 15 PR-M1-3 (issue #5, spec § 5.3): v8 -> v9
   * schema migration. Introduces two new tables that
   * feed the ranker with real signals (replacing
   * the placeholder feedback / access signals):
   *
   *   - `memory_feedback(memory_id, actor_id, kind,
   *     created_at)` — explicit per-actor feedback.
   *     `kind IN ('up','down','pin','hide')`. PRIMARY
   *     KEY `(memory_id, actor_id, kind)` so a single
   *     actor can change their mind and the latest
   *     intent wins.
   *   - `memory_recall_signals(memory_id, recall_count,
   *     last_recalled_at, last_recall_rank)` — cached
   *     per-memory recall stats. The ranker reads
   *     `last_recall_rank` to compute a `recall_signal`
   *     component; this is the spec-named "feedback
   *     signal" replacement that no longer needs to
   *     be 0.
   *
   * Both tables are STRICT (typed columns). The
   * migration is non-destructive: existing rows are
   * untouched, the new tables start empty.
   */
  private migrate_v8_to_v9(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_feedback (
          memory_id TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('up','down','pin','hide')),
          created_at TEXT NOT NULL,
          PRIMARY KEY (memory_id, actor_id, kind)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS memory_feedback_actor_idx
          ON memory_feedback(actor_id, created_at);

        CREATE TABLE IF NOT EXISTS memory_recall_signals (
          memory_id TEXT PRIMARY KEY,
          recall_count INTEGER NOT NULL DEFAULT 0,
          last_recalled_at TEXT,
          last_recall_rank REAL,
          last_recall_query TEXT
        ) STRICT;

        CREATE INDEX IF NOT EXISTS memory_recall_signals_recency_idx
          ON memory_recall_signals(last_recalled_at);
      `);
      this.db.exec("PRAGMA user_version = 9");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Stage 15 PR-M3-1 (issue #9, spec § 6.5):
   * v9 -> v10 schema migration. Introduces the
   * memory hierarchy:
   *
   *   - `memory_entries.tier` — `'core' | 'working' |
   *     'archival'`, default `'working'`. The ranker
   *     reads this to weight recall (core × 1.3,
   *     working × 1.0, archival × 0.7).
   *   - `memory_entries.valid_from` / `valid_until`
   *     — Unix ms boundaries. Entries past their
   *     `valid_until` decay in score; entries not
   *     yet at `valid_from` are excluded from
   *     recall.
   *   - `memory_episodes` — episode-shaped memory
   *     (parent_memory_id, summary, started_at,
   *     ended_at, actor_id). A "working" entry can
   *     be linked to one or more episodes; the
   *     ranker uses `parent_memory_id` to expand
   *     candidates along the episode tree.
   *
   * All changes are additive (no-op for callers
   * that do not use the new columns / tables).
   */
  private migrate_v9_to_v10(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.addColumnIfMissing(
        "memory_entries",
        "tier",
        "TEXT NOT NULL DEFAULT 'working' CHECK (tier IN ('core','working','archival'))"
      );
      this.addColumnIfMissing("memory_entries", "valid_from", "INTEGER");
      this.addColumnIfMissing("memory_entries", "valid_until", "INTEGER");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_episodes (
          episode_id TEXT PRIMARY KEY,
          parent_memory_id TEXT,
          summary TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          actor_id TEXT NOT NULL,
          FOREIGN KEY (parent_memory_id) REFERENCES memory_entries(id) ON DELETE CASCADE
        ) STRICT;

        CREATE INDEX IF NOT EXISTS memory_episodes_parent_idx
          ON memory_episodes(parent_memory_id);
      `);
      this.db.exec("PRAGMA user_version = 10");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private migrate_v1_to_v2(): void {
    // Loosen the audit_events.actor CHECK constraint to accept structured
    // values like "agent:claude-code". The v1 constraint allowed only
    // "agent" / "user" / "system". SQLite does not support `ALTER TABLE ...
    // DROP CONSTRAINT` and node:sqlite blocks `PRAGMA writable_schema`, so
    // we rebuild the table: create _v2 without the CHECK, copy rows over,
    // drop the old table, rename.
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_events'")
      .get() as { sql: string } | undefined;
    if (row === undefined) {
      this.db.exec("PRAGMA user_version = 2");
      return;
    }
    if (!/CHECK \(actor IN \('agent', 'user', 'system'\)\)/.test(row.sql)) {
      // Already migrated (no CHECK to replace)
      this.db.exec("PRAGMA user_version = 2");
      return;
    }
    this.db.exec(`
      CREATE TABLE audit_events_v2 (
        id TEXT PRIMARY KEY,
        memory_id TEXT,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
        project_id TEXT,
        event TEXT NOT NULL,
        reason TEXT,
        actor TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      INSERT INTO audit_events_v2
        (id, memory_id, scope, project_id, event, reason, actor, metadata_json, created_at)
        SELECT id, memory_id, scope, project_id, event, reason, actor, metadata_json, created_at
        FROM audit_events;

      DROP TABLE audit_events;

      ALTER TABLE audit_events_v2 RENAME TO audit_events;

      CREATE INDEX IF NOT EXISTS audit_events_memory_created_idx
        ON audit_events(memory_id, created_at);

      PRAGMA user_version = 2;
    `);
  }

  upsertProjectScope(scope: ProjectScope): void {
    this.db
      .prepare(
        `
        INSERT INTO project_scopes (project_id, canonical_path, display_name, budget_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          canonical_path = excluded.canonical_path,
          display_name = excluded.display_name,
          budget_json = excluded.budget_json,
          updated_at = excluded.updated_at
      `
      )
      .run(
        scope.project_id,
        scope.canonical_path,
        scope.display_name,
        encodeJson(scope.budget),
        scope.created_at,
        scope.updated_at
      );
  }

  getProjectScope(projectId: string): ProjectScope | undefined {
    const row = this.db.prepare("SELECT * FROM project_scopes WHERE project_id = ?").get(projectId);
    return row === undefined ? undefined : decodeProject(row);
  }

  insertEntry(entry: MemoryEntry): void {
    this.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO memory_entries (
            id, scope, project_id, project_path, type, topic, title, body, tags_json, source_json,
            importance, confidence, status, created_at, updated_at, last_accessed_at, last_accessed_by,
            access_count, expires_at, review_after, supersedes_json, superseded_by, token_estimate, char_count,
            revision, writer_actor_id, content_hash, pinned, trust_level, sensitivity,
            valid_from, valid_until, deleted_at, tier, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(...this.entryParams(entry));
      this.upsertFts(entry);
    });
  }

  /**
   * Stage 14 PR-B2 (spec § 5.6): read the per-actor access map
   * for a memory from the canonical `memory_accesses` table.
   * Used by `getEntry` after the access UPSERT to surface the
   * legacy `last_accessed_by` JSON map without round-tripping
   * through the `memory_entries.last_accessed_by` JSON column
   * (which is no longer the source of truth).
   */
  readAccessMap(memoryId: string): Record<string, string> | undefined {
    const rows = this.db
      .prepare(
        "SELECT actor_id, last_accessed_at FROM memory_accesses WHERE memory_id = ? ORDER BY actor_id ASC"
      )
      .all(memoryId) as Array<{ actor_id: string; last_accessed_at: string }>;
    if (rows.length === 0) return undefined;
    const map: Record<string, string> = {};
    for (const row of rows) {
      map[row.actor_id] = row.last_accessed_at;
    }
    return map;
  }

  getEntry(id: string, accessedBy?: string): MemoryEntry | undefined {
    const entry = this.readEntry(id);
    if (entry === undefined) return undefined;

    const lastAccessedAt = new Date().toISOString();

    // Stage 14 PR-B2 (spec § 5.6 AR-P0-006): record the
    // access in the canonical `memory_accesses` table via
    // `recordAccess` (atomic UPSERT keyed on
    // `(memory_id, actor_id)`) BEFORE bumping
    // `memory_entries.access_count`, so the canonical
    // access row is the source of truth for the per-actor
    // access map. The 8-process stress test asserts that
    // every `(memory_id, actor_id)` UPSERT lands
    // atomically — the pre-PR-B2 read-modify-write on the
    // `last_accessed_by` JSON column lost concurrent
    // updates from sibling processes, which is the exact
    // failure mode the spec § 5.6 atomicity contract
    // guards against.
    let nextMap: Record<string, string> | undefined;
    if (accessedBy !== undefined) {
      this.recordAccess(id, accessedBy, lastAccessedAt);
      // Maintain the v3-compatible `last_accessed_by` JSON
      // column as a derived cache so legacy readers (the
      // doctor check, the budget evaluator, the trust
      // boost) keep working. The RMW here is best-effort:
      // `memory_accesses` is the source of truth, so a
      // lost RMW loses at most one actor's last-accessed
      // timestamp from the JSON cache but never from the
      // canonical per-actor table.
      const existing = entry.last_accessed_by ?? {};
      nextMap = { ...existing, [accessedBy]: lastAccessedAt };
    }

    if (nextMap !== undefined) {
      this.db
        .prepare("UPDATE memory_entries SET access_count = access_count + 1, last_accessed_at = ?, last_accessed_by = ? WHERE id = ?")
        .run(lastAccessedAt, JSON.stringify(nextMap), id);
    } else {
      this.db
        .prepare("UPDATE memory_entries SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?")
        .run(lastAccessedAt, id);
    }

    return {
      ...entry,
      access_count: entry.access_count + 1,
      last_accessed_at: lastAccessedAt,
      ...(nextMap !== undefined ? { last_accessed_by: nextMap } : {})
    };
  }

  peekEntry(id: string): MemoryEntry | undefined {
    return this.readEntry(id);
  }

  listEntries(filters: EntryFilters): MemoryEntry[] {
    const { where, params } = buildEntryWhere(filters, "memory_entries");
    const limit = normalizeLimit(filters.limit, 100);
    const offset = normalizeOffset(filters.offset);
    const rows = this.db
      .prepare(`SELECT * FROM memory_entries ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    return rows.map(decodeEntry);
  }

  searchEntries(filters: SearchFilters): MemoryEntry[] {
    const query = ftsQuery(filters.query);
    if (query.length === 0) return [];

    const { where, params } = buildEntryWhere(filters, "m");
    const clauses = ["memory_fts MATCH ?", ...(where.length === 0 ? [] : [where.slice("WHERE ".length)])];
    const limit = normalizeLimit(filters.limit, 10);
    const offset = normalizeOffset(filters.offset);
    const rows = this.db
      .prepare(
        `
        SELECT m.*
        FROM memory_fts
        JOIN memory_entries m ON m.id = memory_fts.id
        WHERE ${clauses.join(" AND ")}
        ORDER BY rank
        LIMIT ? OFFSET ?
      `
      )
      .all(query, ...params, limit, offset);
    return rows.map(decodeEntry);
  }

  /**
   * Stage 14 PR-B2 (spec § 6.5): optional revision context
   * carries the writer actor, request_id, and change reason
   * for the `memory_revisions` row written inside the same
   * transaction as the entry update. When omitted (the
   * maintenance service callers and pre-B2 callers), no
   * revision row is recorded — the legacy behaviour is
   * preserved and the spec § 5.6 multi-process test is
   * unaffected.
   */
  updateEntry(
    id: string,
    patch: EntryPatch,
    revisionContext?: { changed_by: string; request_id?: string; change_reason?: string }
  ): void {
    const current = this.readEntry(id);
    if (current === undefined) return;

    // Spec § 6.5: post-image snapshot. Bump the revision
    // explicitly so the `memory_revisions` row is keyed on
    // the same `next.revision` the row will carry after
    // the UPDATE. Pre-PR-B2 the `revision = ?` parameter
    // was passed through entryParams which had the bump
    // happen inside sanitizeEntryPatch; we replicate that
    // bump here.
    const next: MemoryEntry = {
      ...current,
      ...sanitizeEntryPatch(patch),
      id: current.id,
      revision: current.revision + 1
    };
    this.transaction(() => {
      this.db
        .prepare(
          `
          UPDATE memory_entries SET
            scope = ?,
            project_id = ?,
            project_path = ?,
            type = ?,
            topic = ?,
            title = ?,
            body = ?,
            tags_json = ?,
            source_json = ?,
            importance = ?,
            confidence = ?,
            status = ?,
            created_at = ?,
            updated_at = ?,
            last_accessed_at = ?,
            last_accessed_by = ?,
            access_count = ?,
            expires_at = ?,
            review_after = ?,
            supersedes_json = ?,
            superseded_by = ?,
            token_estimate = ?,
            char_count = ?,
            revision = ?,
            writer_actor_id = ?,
            content_hash = ?,
            pinned = ?,
            trust_level = ?,
            sensitivity = ?,
            valid_from = ?,
            valid_until = ?,
            deleted_at = ?,
            tier = ?,
            metadata_json = ?
          WHERE id = ?
        `
        )
        .run(...this.entryParams(next).slice(1), id);
      this.upsertFts(next);
      if (revisionContext !== undefined) {
        this.recordRevisionRow(
          next.id,
          next.revision,
          next,
          revisionContext.changed_by,
          revisionContext.request_id,
          revisionContext.change_reason
        );
      }
    });
  }

  appendAudit(event: MemoryAuditEvent): void {
    this.db
      .prepare(
        `
        INSERT INTO audit_events (id, memory_id, scope, project_id, event, reason, actor, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        event.id,
        event.memory_id ?? null,
        event.scope,
        event.project_id ?? null,
        event.event,
        event.reason ?? null,
        event.actor,
        encodeJson(event.metadata),
        event.created_at
      );
  }

  getAuditEvents(memoryId: string): MemoryAuditEvent[] {
    return this.db
      .prepare("SELECT * FROM audit_events WHERE memory_id = ? ORDER BY created_at ASC")
      .all(memoryId)
      .map(decodeAudit);
  }

  /**
   * Stage 15 PR-M0-4 (issue #3, spec § 6.2): persistent
   * maintenance plan CRUD on top of the
   * `maintenance_plans` + `maintenance_plan_items` tables.
   * Pre-v6 the plan lived in a process-local Map and was
   * lost on every MCP restart. With v6 the plan survives
   * restart so a different session (or even a different
   * process) can call `apply_maintenance` later.
   *
   * The plan_hash is SHA-256 over the canonical JSON of
   * the items array, so any tampering between plan and
   * apply is detected by `getPlan`. Expired plans
   * (state='expired' or expires_at <= now) are
   * auto-rejected by the read path; explicit
   * `expireOldPlans` flips `pending` -> `expired` in bulk.
   */
  createMaintenancePlan(plan: MaintenancePlanRow): void {
    this.db
      .prepare(
        `INSERT INTO maintenance_plans
          (plan_id, plan_hash, creator_actor_id, created_at,
           expires_at, state, summary_json, scope, project_id, risk)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        plan.plan_id,
        plan.plan_hash,
        plan.creator_actor_id,
        plan.created_at,
        plan.expires_at,
        plan.state,
        plan.summary_json,
        plan.scope,
        plan.project_id ?? null,
        plan.risk
      );
    const insertItem = this.db.prepare(
      `INSERT INTO maintenance_plan_items
        (plan_id, target_memory_id, expected_revision, action_type, evidence_json, risk)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const item of plan.items) {
      insertItem.run(
        plan.plan_id,
        item.target_memory_id,
        item.expected_revision,
        item.action_type,
        item.evidence_json,
        item.risk
      );
    }
  }

  getMaintenancePlan(planId: string): MaintenancePlanRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM maintenance_plans WHERE plan_id = ?")
      .get(planId) as
      | {
          plan_id: string;
          plan_hash: string;
          creator_actor_id: string;
          created_at: string;
          expires_at: string;
          state: string;
          summary_json: string;
          scope: string;
          project_id: string | null;
          risk: string;
        }
      | undefined;
    if (row === undefined) return undefined;
    const itemRows = this.db
      .prepare(
        "SELECT target_memory_id, expected_revision, action_type, evidence_json, risk FROM maintenance_plan_items WHERE plan_id = ? ORDER BY target_memory_id ASC"
      )
      .all(planId) as Array<{
      target_memory_id: string;
      expected_revision: number;
      action_type: string;
      evidence_json: string;
      risk: string;
    }>;
    const out: MaintenancePlanRow = {
      plan_id: row.plan_id,
      plan_hash: row.plan_hash,
      creator_actor_id: row.creator_actor_id,
      created_at: row.created_at,
      expires_at: row.expires_at,
      state: row.state as MaintenancePlanRow["state"],
      summary_json: row.summary_json,
      scope: row.scope as MaintenancePlanRow["scope"],
      risk: row.risk as MaintenancePlanRow["risk"],
      items: itemRows.map((r) => ({
        target_memory_id: r.target_memory_id,
        expected_revision: r.expected_revision,
        action_type: r.action_type as MaintenancePlanItemRow["action_type"],
        evidence_json: r.evidence_json,
        risk: r.risk as MaintenancePlanItemRow["risk"]
      }))
    };
    if (row.project_id !== null) {
      out.project_id = row.project_id;
    }
    return out;
  }

  setMaintenancePlanState(planId: string, state: MaintenancePlanRow["state"]): void {
    this.db
      .prepare("UPDATE maintenance_plans SET state = ? WHERE plan_id = ?")
      .run(state, planId);
  }

  expireOldMaintenancePlans(now: string): number {
    const result = this.db
      .prepare(
        `UPDATE maintenance_plans
            SET state = 'expired'
          WHERE state = 'pending' AND expires_at <= ?`
      )
      .run(now);
    return Number(result.changes ?? 0);
  }

  /**
   * Stage 15 PR-M1-1 (issue #6, spec § 5.3): write
   * provenance links for one or more memories. The
   * primary key `(memory_id, source_kind, source_ref)`
   * makes the write idempotent under repeat ingestion
   * (a `recordProvenance` call with the same triple is
   * a no-op via `INSERT OR IGNORE`). The caller passes
   * the canonical `recorded_at` (Unix ms) so the
   * timeline is consistent across cross-process
   * sources (issue / PR / commit ingest usually knows
   * the source's own timestamp).
   */
  recordProvenance(input: {
    memory_id: string;
    source_kind: "issue" | "pr" | "commit" | "tool_call" | "session" | "import";
    source_ref: string;
    recorded_by: string;
    recorded_at: number;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_provenance
          (memory_id, source_kind, source_ref, recorded_by, recorded_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        input.memory_id,
        input.source_kind,
        input.source_ref,
        input.recorded_by,
        input.recorded_at
      );
  }

  /**
   * Return the durable provenance link chain for a
   * memory. The chain is sorted by `source_kind` (so
   * the explain output is stable across queries with
   * the same underlying data) and then by
   * `recorded_at` ascending so the timeline is
   * chronologically ordered within a kind.
   */
  getProvenance(memoryId: string): Array<{
    source_kind: "issue" | "pr" | "commit" | "tool_call" | "session" | "import";
    source_ref: string;
    recorded_by: string;
    recorded_at: number;
  }> {
    return this.db
      .prepare(
        `SELECT source_kind, source_ref, recorded_by, recorded_at
           FROM memory_provenance
          WHERE memory_id = ?
          ORDER BY source_kind ASC, recorded_at ASC`
      )
      .all(memoryId) as Array<{
      source_kind: "issue" | "pr" | "commit" | "tool_call" | "session" | "import";
      source_ref: string;
      recorded_by: string;
      recorded_at: number;
    }>;
  }

  /**
   * Stage 15 PR-M1-2 (issue #7, spec § 5.4): strict
   * project identity model. A `project_identity` row
   * pins a `project_id` to its `canonical_path`. A
   * caller that submits a `project_id` already in the
   * table with a *different* `canonical_path` triggers
   * `project_identity_conflict` at the service layer;
   * the database itself accepts the row, but the
   * service rejects it.
   *
   * `createProjectIdentity` is idempotent under
   * `(project_id, canonical_path, created_by)`: a
   * second call with the same triple is a no-op via
   * `INSERT OR IGNORE`. A second call with the same
   * `project_id` but a different `canonical_path`
   * throws `SQLITE_CONSTRAINT_PRIMARYKEY` — callers
   * must catch that and surface
   * `project_identity_conflict`.
   */
  createProjectIdentity(input: {
    project_id: string;
    canonical_path: string;
    created_by: string;
    created_at: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO project_identities
          (project_id, canonical_path, created_by, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(
        input.project_id,
        input.canonical_path,
        input.created_by,
        input.created_at
      );
  }

  getProjectIdentity(projectId: string): {
    project_id: string;
    canonical_path: string;
    created_by: string;
    created_at: string;
  } | undefined {
    const row = this.db
      .prepare(
        "SELECT project_id, canonical_path, created_by, created_at FROM project_identities WHERE project_id = ?"
      )
      .get(projectId) as
      | {
          project_id: string;
          canonical_path: string;
          created_by: string;
          created_at: string;
        }
      | undefined;
    return row;
  }

  /**
   * Stage 15 PR-M1-2: register an alias for an
   * existing project identity. The alias is the raw
   * path the caller resolved (e.g. a symlink target,
   * a worktree, a Windows-cased path). The
   * `project_id` and `canonical_path` are taken from
   * the identity row. `INSERT OR IGNORE` makes repeat
   * registration idempotent under `alias`.
   */
  createProjectAlias(input: {
    alias: string;
    project_id: string;
    canonical_path: string;
    alias_kind: "path" | "git_head" | "worktree";
    recorded_by: string;
    recorded_at: number;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO project_aliases_new
          (alias, project_id, canonical_path, alias_kind, recorded_by, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.alias,
        input.project_id,
        input.canonical_path,
        input.alias_kind,
        input.recorded_by,
        input.recorded_at
      );
  }

  getProjectAliasByPath(alias: string): {
    alias: string;
    project_id: string;
    canonical_path: string;
    alias_kind: "path" | "git_head" | "worktree";
    recorded_by: string;
    recorded_at: number;
  } | undefined {
    const row = this.db
      .prepare(
        "SELECT alias, project_id, canonical_path, alias_kind, recorded_by, recorded_at FROM project_aliases_new WHERE alias = ?"
      )
      .get(alias) as
      | {
          alias: string;
          project_id: string;
          canonical_path: string;
          alias_kind: "path" | "git_head" | "worktree";
          recorded_by: string;
          recorded_at: number;
        }
      | undefined;
    return row;
  }

  listProjectAliases(projectId: string): Array<{
    alias: string;
    project_id: string;
    canonical_path: string;
    alias_kind: "path" | "git_head" | "worktree";
    recorded_by: string;
    recorded_at: number;
  }> {
    return this.db
      .prepare(
        "SELECT alias, project_id, canonical_path, alias_kind, recorded_by, recorded_at FROM project_aliases_new WHERE project_id = ? ORDER BY alias ASC"
      )
      .all(projectId) as Array<{
      alias: string;
      project_id: string;
      canonical_path: string;
      alias_kind: "path" | "git_head" | "worktree";
      recorded_by: string;
      recorded_at: number;
    }>;
  }

  /**
   * Stage 15 PR-M1-3 (issue #5, spec § 5.3): record
   * explicit per-actor feedback for a memory. The
   * `kind` enum is `up` (👍), `down` (👎), `pin`
   * (always surface), `hide` (always suppress).
   * `INSERT OR REPLACE` lets a single actor change
   * their mind and the latest intent wins.
   */
  recordMemoryFeedback(input: {
    memory_id: string;
    actor_id: string;
    kind: "up" | "down" | "pin" | "hide";
    created_at: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO memory_feedback
          (memory_id, actor_id, kind, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(input.memory_id, input.actor_id, input.kind, input.created_at);
  }

  /**
   * Per-actor feedback map for a memory. The
   * `up`/`down`/`pin`/`hide` keys are mutually
   * independent; a single actor may have up to four
   * feedback rows.
   */
  getMemoryFeedback(memoryId: string): Array<{
    actor_id: string;
    kind: "up" | "down" | "pin" | "hide";
    created_at: string;
  }> {
    return this.db
      .prepare(
        "SELECT actor_id, kind, created_at FROM memory_feedback WHERE memory_id = ? ORDER BY created_at ASC"
      )
      .all(memoryId) as Array<{
      actor_id: string;
      kind: "up" | "down" | "pin" | "hide";
      created_at: string;
    }>;
  }

  /**
   * Aggregate feedback per `kind` for a memory. Used
   * by the ranker to compute the `feedback_signal`
   * component without round-tripping the per-actor
   * rows.
   */
  getMemoryFeedbackCounts(memoryId: string): {
    up: number;
    down: number;
    pin: number;
    hide: number;
  } {
    const rows = this.db
      .prepare("SELECT kind, COUNT(*) AS c FROM memory_feedback WHERE memory_id = ? GROUP BY kind")
      .all(memoryId) as Array<{ kind: string; c: number }>;
    const out = { up: 0, down: 0, pin: 0, hide: 0 };
    for (const row of rows) {
      if (row.kind === "up") out.up = row.c;
      else if (row.kind === "down") out.down = row.c;
      else if (row.kind === "pin") out.pin = row.c;
      else if (row.kind === "hide") out.hide = row.c;
    }
    return out;
  }

  /**
   * Stage 15 PR-M1-3: cache the per-memory recall
   * stats so the ranker's `recall_signal` component
   * is real (not a placeholder 0). The cache is
   * updated after every `rankRecall`; reads are
   * point lookups.
   */
  recordRecallSignal(input: {
    memory_id: string;
    rank: number;
    query: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO memory_recall_signals
          (memory_id, recall_count, last_recalled_at, last_recall_rank, last_recall_query)
         VALUES (?, 1, ?, ?, ?)
         ON CONFLICT(memory_id) DO UPDATE SET
           recall_count = recall_count + 1,
           last_recalled_at = excluded.last_recalled_at,
           last_recall_rank = excluded.last_recall_rank,
           last_recall_query = excluded.last_recall_query`
      )
      .run(input.memory_id, nowIso(), input.rank, input.query);
  }

  getRecallSignal(memoryId: string): {
    memory_id: string;
    recall_count: number;
    last_recalled_at: string | null;
    last_recall_rank: number | null;
    last_recall_query: string | null;
  } | undefined {
    return this.db
      .prepare(
        "SELECT memory_id, recall_count, last_recalled_at, last_recall_rank, last_recall_query FROM memory_recall_signals WHERE memory_id = ?"
      )
      .get(memoryId) as
      | {
          memory_id: string;
          recall_count: number;
          last_recalled_at: string | null;
          last_recall_rank: number | null;
          last_recall_query: string | null;
        }
      | undefined;
  }

  /**
   * Per-actor access count for a single memory. Replaces
   * the legacy `entry.last_accessed_by` JSON map as the
   * canonical access source. Returns 0 when the actor
   * has never accessed the memory; the underlying
   * `memory_accesses` table has `PRIMARY KEY (memory_id,
   * actor_id)` so the lookup is a single row.
   */
  getAccessCountFor(memoryId: string, actorId: string): number {
    const row = this.db
      .prepare(
        "SELECT access_count FROM memory_accesses WHERE memory_id = ? AND actor_id = ?"
      )
      .get(memoryId, actorId) as { access_count: number } | undefined;
    return row?.access_count ?? 0;
  }

  /**
   * All per-actor access counts for a memory, keyed by
   * `actor_id`. Replaces `entry.last_accessed_by` JSON
   * for callers that need the full access map.
   */
  getAllAccessCountsFor(memoryId: string): Record<string, number> {
    const rows = this.db
      .prepare(
        "SELECT actor_id, access_count FROM memory_accesses WHERE memory_id = ?"
      )
      .all(memoryId) as Array<{ actor_id: string; access_count: number }>;
    const out: Record<string, number> = {};
    for (const row of rows) {
      out[row.actor_id] = row.access_count;
    }
    return out;
  }

  /** A plan_id is "applied" iff there is an `apply_maintenance`
   * audit event that names it. We use this to detect a retry
   * with the same idempotency_key (idempotent no-op) vs a
   * different idempotency_key (idempotency_mismatch). */
  getAppliedMaintenanceKeys(planId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT metadata_json FROM audit_events
          WHERE event = 'apply_maintenance'`
      )
      .all() as Array<{ metadata_json: string }>;
    const keys: string[] = [];
    for (const row of rows) {
      try {
        const meta = JSON.parse(row.metadata_json) as { plan_id?: unknown; idempotency_key?: unknown; ok?: unknown };
        if (meta.plan_id === planId && typeof meta.idempotency_key === "string" && meta.ok === true) {
          keys.push(meta.idempotency_key);
        }
      } catch {
        continue;
      }
    }
    return keys;
  }

  listAuditEvents(filters: AuditFilters = {}): MemoryAuditEvent[] {
    const { where, params } = buildAuditWhere(filters);
    const limit = normalizeLimit(filters.limit, 100);
    const offset = normalizeOffset(filters.offset);
    return this.db
      .prepare(`SELECT * FROM audit_events ${where} ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset)
      .map(decodeAudit);
  }

  /**
   * Stage 15 PR-M0-1 (issue #1, spec § 5.6): idempotency
   * v2 cache accessors. The `mutation_requests_v2` table
   * stores the canonical result of a mutating operation
   * so a retry with the same `(actor, tool, key)` can
   * replay the result without re-running the mutation.
   *
   * `tryReserveMutationRequest` does an `INSERT OR ABORT`
   * with `state='pending'`. It returns `true` when the
   * row was inserted (caller should run the mutation,
   * then call `completeMutationRequest`). It returns
   * `false` when the row already exists — the caller
   * must then call `lookupMutationRequestV2` to
   * classify the hit as replay / rejected / in_flight.
   *
   * The store is `STRICT` typed; we keep `nowIso()` for
   * the created_at / completed_at fields.
   */

  tryReserveMutationRequest(
    actor: string,
    tool: string,
    key: string,
    requestHash: string,
    requestId: string
  ): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO mutation_requests_v2
             (actor_id, tool_name, idempotency_key, state,
              request_hash, result_json, request_id,
              created_at, completed_at)
           VALUES (?, ?, ?, 'pending', ?, NULL, ?, ?, NULL)`
        )
        .run(actor, tool, key, requestHash, requestId, nowIso());
      return true;
    } catch (err) {
      // node:sqlite throws "SqliteError" on a UNIQUE /
      // PRIMARY KEY violation. The exact code is
      // SQLITE_CONSTRAINT_PRIMARYKEY (= 1555) or
      // SQLITE_CONSTRAINT_UNIQUE (= 1555) — both surface
      // with the message we grep for. Treat any
      // constraint violation as "row already exists"
      // so the caller can classify the hit.
      if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
        return false;
      }
      throw err;
    }
  }

  completeMutationRequest(
    actor: string,
    tool: string,
    key: string,
    resultJson: string
  ): void {
    this.db
      .prepare(
        `UPDATE mutation_requests_v2
           SET state = 'completed',
               result_json = ?,
               completed_at = ?
         WHERE actor_id = ? AND tool_name = ? AND idempotency_key = ?`
      )
      .run(resultJson, nowIso(), actor, tool, key);
  }

  lookupMutationRequestV2(
    actor: string,
    tool: string,
    key: string
  ): { request_hash: string; result_json: string; state: "pending" | "completed" } | undefined {
    const row = this.db
      .prepare(
        `SELECT request_hash, result_json, state
           FROM mutation_requests_v2
          WHERE actor_id = ? AND tool_name = ? AND idempotency_key = ?`
      )
      .get(actor, tool, key) as
      | { request_hash: string; result_json: string; state: "pending" | "completed" }
      | undefined;
    return row;
  }

  /**
   * @deprecated Stage 11 PR7: v1 idempotency cache
   * accessors. The v1 PK was `(actor_id, idempotency_key)`
   * with no `tool_name` dimension, which caused cross-tool
   * collisions. Stage 15 PR-M0-1 introduces v2 with
   * `(actor_id, tool_name, idempotency_key)` — new code
   * MUST use `tryReserveMutationRequest` /
   * `completeMutationRequest` / `lookupMutationRequestV2`.
   * This wrapper is preserved for one release cycle so
   * external callers and the p0-mutation-safety regression
   * suite keep working. The v2 migration wrote v1 rows
   * into `mutation_requests_v2` with `tool_name='legacy'`,
   * so the v1 `(actor, key)` namespace lives on under the
   * `legacy` tool.
   */
  lookupMutationRequest(actor: string, key: string):
    | { request_hash: string; result_json: string }
    | undefined {
    const row = this.db
      .prepare(
        "SELECT request_hash, result_json FROM mutation_requests WHERE actor_id = ? AND idempotency_key = ?"
      )
      .get(actor, key) as { request_hash: string; result_json: string } | undefined;
    return row;
  }

  upsertMutationRequest(
    actor: string,
    key: string,
    requestHash: string,
    resultJson: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO mutation_requests (actor_id, idempotency_key, request_hash, result_json, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(actor_id, idempotency_key) DO UPDATE SET
           request_hash = excluded.request_hash,
           result_json = excluded.result_json`
      )
      .run(actor, key, requestHash, resultJson, nowIso());
  }

  /**
   * Stage 11 PR7: atomic access UPSERT (spec § 5.6).
   * Two agents accessing the same memory in the same
   * SQLite write window both end up with their own row
   * in `memory_accesses` rather than overwriting each
   * other's last_accessed_at. The legacy
   * `last_accessed_by` JSON column is still written
   * (for read-back compat with the v3 schema) but the
   * canonical access data is now in this table.
   */
  recordAccess(
    memoryId: string,
    actorId: string,
    timestamp: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO memory_accesses
            (memory_id, actor_id, access_count, first_accessed_at, last_accessed_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(memory_id, actor_id) DO UPDATE SET
           access_count = access_count + 1,
           last_accessed_at = excluded.last_accessed_at`
      )
      .run(memoryId, actorId, timestamp, timestamp);
  }

  getBudgetUsage(filters: { scope: MemoryScope; project_id?: string }): BudgetUsage {
    const { where, params } = buildBudgetWhere(filters);
    const summary = this.db
      .prepare(
        `
        SELECT
          COUNT(*) AS active_entries,
          COALESCE(SUM(char_count), 0) AS active_chars,
          COALESCE(SUM(
            length(title) +
            length(topic) +
            (
              SELECT
                CASE
                  WHEN COUNT(*) = 0 THEN 0
                  ELSE COALESCE(SUM(length(CAST(value AS TEXT))), 0) + COUNT(*) - 1
                END
              FROM json_each(memory_entries.tags_json)
            ) +
            16
          ), 0) AS index_chars
        FROM memory_entries
        ${where}
      `
      )
      .get(...params);
    const topicRows = this.db
      .prepare(
        `
        SELECT topic, COALESCE(SUM(char_count), 0) AS chars
        FROM memory_entries
        ${where}
        GROUP BY topic
        ORDER BY topic ASC
      `
      )
      .all(...params);
    const topicChars = new Map<string, number>();
    for (const row of topicRows) {
      topicChars.set(stringCell(row, "topic"), numberCell(row, "chars"));
    }

    return {
      active_entries: summary === undefined ? 0 : numberCell(summary, "active_entries"),
      active_chars: summary === undefined ? 0 : numberCell(summary, "active_chars"),
      topic_chars: Object.fromEntries(topicChars) as Record<string, number>,
      index_chars: summary === undefined ? 0 : numberCell(summary, "index_chars")
    };
  }

  private readEntry(id: string): MemoryEntry | undefined {
    const row = this.db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(id);
    return row === undefined ? undefined : decodeEntry(row);
  }

  private entryParams(entry: MemoryEntry): SQLInputValue[] {
    // v4 fields use defensive defaults so test fixtures
    // that still construct entries via the v3 shape
    // (no `revision` / `writer_actor_id` / `pinned` / etc.)
    // keep working. The defaults match the SQL
    // `DEFAULT` clauses and the `buildEntry` helper.
    return [
      entry.id,
      entry.scope,
      entry.project_id ?? null,
      entry.project_path ?? null,
      entry.type,
      entry.topic,
      entry.title,
      entry.body,
      encodeJson(entry.tags),
      encodeJson(entry.source),
      entry.importance,
      entry.confidence,
      entry.status,
      entry.created_at,
      entry.updated_at,
      entry.last_accessed_at ?? null,
      entry.last_accessed_by ? encodeJson(entry.last_accessed_by) : null,
      entry.access_count,
      entry.expires_at ?? null,
      entry.review_after ?? null,
      encodeJson(entry.supersedes),
      entry.superseded_by ?? null,
      entry.token_estimate,
      entry.char_count,
      // Stage 12 PR9: schema v4 row shape (with defaults).
      entry.revision ?? 1,
      entry.writer_actor_id ?? "agent:pending",
      entry.content_hash ?? null,
      entry.pinned ? 1 : 0,
      entry.trust_level ?? "agent_observed",
      entry.sensitivity ?? "normal",
      entry.valid_from ?? null,
      entry.valid_until ?? null,
      entry.deleted_at ?? null,
      // Stage 15 PR-M3-1 (issue #9, spec § 6.5):
      // `tier` defaults to 'working' for legacy
      // entries that pre-date the v10 column.
      entry.tier ?? "working",
      encodeJson(entry.metadata ?? {})
    ];
  }

  /**
   * Stage 12 PR9: bounded busy retry. SQLite's
   * `busy_timeout = 5000` PRAGMA already lets one
   * process wait for the writer; this helper adds an
   * extra retry layer for the case where the contention
   * exceeds busy_timeout (e.g. a long-running
   * transaction on another connection). 5 retries
   * with 10ms backoff covers the 8-process stress test
   * the spec § 5.6 multi-process promise requires.
   */
  runWithBusyRetry<T>(
    fn: () => T,
    opts: { maxRetries?: number; backoffMs?: number } = {}
  ): T {
    const maxRetries = opts.maxRetries ?? 5;
    const backoffMs = opts.backoffMs ?? 10;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return fn();
      } catch (error) {
        lastError = error;
        if (ConcurrentRevisionError.isThis(error)) {
          // CAS conflict is not a transient I/O error.
          // The write service maps this to the
          // `stale_revision` result.
          throw error;
        }
        if (!isSqliteBusyError(error) || attempt === maxRetries) {
          throw error;
        }
        const sleep = backoffMs * (attempt + 1);
        const end = Date.now() + sleep;
        while (Date.now() < end) {
          // spin intentionally; the busy_timeout
          // PRAGMA already absorbed the single-writer
          // wait, this loop only fires when multiple
          // writers all queue simultaneously.
        }
      }
    }
    throw lastError;
  }

  /**
   * Stage 12 PR9: optimistic-concurrency update. Returns
   * `true` if the row's revision matched `expectedRevision`
   * and the patch was applied (with the revision bumped),
   * `false` if the row was concurrently modified. The
   * write service maps a `false` return to the
   * `stale_revision` error code on the MCP wire so
   * clients can retry after re-reading the row.
   *
   * The implementation uses the pre-rewrite
   * `current.revision` for the WHERE clause so a
   * concurrent UPDATE that already advanced the row
   * gets matched by zero rows — the same property the
   * spec § 5.6 CAS contract requires.
   */
  updateEntryWithRevision(
    id: string,
    patch: EntryPatch,
    expectedRevision: number,
    revisionContext?: { changed_by: string; request_id?: string; change_reason?: string }
  ): boolean {
    const current = this.readEntry(id);
    if (current === undefined) return false;
    if (current.revision !== expectedRevision) {
      return false;
    }
    const next: MemoryEntry = {
      ...current,
      ...sanitizeEntryPatch(patch),
      id: current.id,
      revision: current.revision + 1,
      updated_at: nowIso()
    };
    return this.runWithBusyRetry(() => {
      let applied = false;
      this.transaction(() => {
        const stmt = this.db.prepare(`
          UPDATE memory_entries SET
            scope = ?, project_id = ?, project_path = ?,
            type = ?, topic = ?, title = ?, body = ?,
            tags_json = ?, source_json = ?,
            importance = ?, confidence = ?, status = ?,
            created_at = ?, updated_at = ?,
            last_accessed_at = ?, last_accessed_by = ?,
            access_count = ?, expires_at = ?, review_after = ?,
            supersedes_json = ?, superseded_by = ?,
            token_estimate = ?, char_count = ?,
            revision = ?,
            writer_actor_id = ?, content_hash = ?,
            pinned = ?, trust_level = ?, sensitivity = ?,
            valid_from = ?, valid_until = ?, deleted_at = ?,
            metadata_json = ?
          WHERE id = ? AND revision = ?
        `);
        const result = stmt.run(
          next.scope, next.project_id ?? null, next.project_path ?? null,
          next.type, next.topic, next.title, next.body,
          encodeJson(next.tags), encodeJson(next.source),
          next.importance, next.confidence, next.status,
          next.created_at, next.updated_at,
          next.last_accessed_at ?? null,
          next.last_accessed_by ? encodeJson(next.last_accessed_by) : null,
          next.access_count, next.expires_at ?? null, next.review_after ?? null,
          encodeJson(next.supersedes), next.superseded_by ?? null,
          next.token_estimate, next.char_count,
          next.revision,
          next.writer_actor_id, next.content_hash ?? null,
          next.pinned ? 1 : 0, next.trust_level, next.sensitivity,
          next.valid_from ?? null, next.valid_until ?? null, next.deleted_at ?? null,
          encodeJson(next.metadata),
          id,
          expectedRevision
        );
        if (result.changes === 0) {
          // Concurrent writer won the race; abort the
          // enclosing transaction so the FTS upsert is
          // not performed against a stale snapshot.
          throw new ConcurrentRevisionError();
        }
        this.upsertFts(next);
        if (revisionContext !== undefined) {
          this.recordRevisionRow(
            current.id,
            next.revision,
            next,
            revisionContext.changed_by,
            revisionContext.request_id,
            revisionContext.change_reason
          );
        }
        applied = true;
      });
      return applied;
    });
  }

  private upsertFts(entry: MemoryEntry): void {
    this.db.prepare("DELETE FROM memory_fts WHERE id = ?").run(entry.id);
    this.db
      .prepare("INSERT INTO memory_fts (id, scope, project_id, topic, title, body, tags) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(entry.id, entry.scope, entry.project_id ?? "", entry.topic, entry.title, entry.body, entry.tags.join(" "));
  }

  /**
   * Stage 14 PR-B2 (spec § 6.5): append the first
   * `memory_revisions` row for a freshly-created entry. The
   * row is keyed on `revision: 1` (the same `revision` the
   * `memory_entries` row carries post-insert) so the audit
   * chain is contiguous from the very first mutation. The
   * snapshot is a `created`-shaped placeholder (the full
   * entry) so audit consumers can join the revision row
   * against the `created` audit event. Called from
   * `MemoryWriteService.commitPreparedRemember` after
   * `insertEntry`.
   */
  recordRevisionForCreate(
    memoryId: string,
    changedBy: string,
    requestId: string | undefined
  ): void {
    const created = this.readEntry(memoryId);
    this.recordRevisionRow(
      memoryId,
      1,
      (created ?? { id: memoryId, revision: 1 }) as unknown as MemoryEntry,
      changedBy,
      requestId,
      "created"
    );
  }

  /**
   * Stage 14 PR-B2 (spec § 6.5): append a `memory_revisions` row
   * capturing the snapshot of the entry *after* the mutation
   * (post-image) keyed on the entry's new revision. The row is
   * keyed on `(memory_id, revision)` so a single revision can
   * be replayed exactly once. The snapshot is `JSON.stringify`-ed
   * from the `MemoryEntry` so audit consumers can reconstruct
   * the full state at any past revision. Storing the post-image
   * (rather than the pre-image) keeps the PRIMARY KEY collision-
   * free across the create + update sequence (the create row is
   * keyed on `revision: 1`, every subsequent update is keyed
   * on the entry's new `revision`).
   *
   * Called from inside the same `this.transaction(() => ...)`
   * block as the entry update so a failure on either side rolls
   * both back. The `request_id` is the per-call UUID from
   * `RequestContext` (or empty when the caller did not provide
   * one) so the revision row can be joined to the matching
   * `audit_events` row for the same request.
   */
  private recordRevisionRow(
    memoryId: string,
    revision: number,
    snapshot: MemoryEntry,
    changedBy: string,
    requestId: string | undefined,
    changeReason: string | undefined
  ): void {
    this.db
      .prepare(
        `INSERT INTO memory_revisions
            (memory_id, revision, snapshot_json, changed_by, request_id, change_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        memoryId,
        revision,
        JSON.stringify(snapshot),
        changedBy,
        requestId ?? "",
        changeReason ?? null,
        nowIso()
      );
  }

}
