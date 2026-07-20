import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
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
};

export type SearchFilters = EntryFilters & {
  query: string;
};

/**
 * Current authoritative schema version. Stage 1 introduced explicit
 * `PRAGMA user_version` tracking. v2 loosened the `audit_events.actor`
 * CHECK constraint to allow structured values like `agent:claude-code`.
 * v3 adds the `last_accessed_by` JSON column to `memory_entries`.
 */
export const CURRENT_SCHEMA_VERSION = 3;

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
  | "char_count";

export type EntryPatch = Partial<Pick<MemoryEntry, EntryPatchField>> & Pick<MemoryEntry, "updated_at">;

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
    char_count: numberCell(row, "char_count")
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
  "char_count"
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
    // Subquery: only include entries whose "created" audit row was
    // written by the given actor. The audit log is keyed by
    // (memory_id, event) so this is O(1) per memory via the index.
    clauses.push(`${column("id")} IN (SELECT memory_id FROM audit_events WHERE event = 'created' AND actor = ?)`);
    params.push(filters.actor);
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

export class SQLiteMemoryStore {
  private readonly db: DatabaseSync;
  private transactionDepth = 0;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true, timeout: 5000 });
    this.migrate();
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
    this.db.exec(`
      PRAGMA foreign_keys = ON;

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
        actor TEXT NOT NULL CHECK (actor IN ('agent', 'user', 'system')),
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
    this.migrateForward();
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
    const before = this.readUserVersion();
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
            access_count, expires_at, review_after, supersedes_json, superseded_by, token_estimate, char_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(...this.entryParams(entry));
      this.upsertFts(entry);
    });
  }

  getEntry(id: string, accessedBy?: string): MemoryEntry | undefined {
    const entry = this.readEntry(id);
    if (entry === undefined) return undefined;

    const lastAccessedAt = new Date().toISOString();

    // Update the per-agent access map. `decodeEntry` already parsed the
    // JSON column into a `Record<string, string>` (or left it undefined
    // for rows that have never been read with an actor). We extend that
    // map; a missing or undefined map is treated as empty.
    let nextMap: Record<string, string> | undefined;
    if (accessedBy !== undefined) {
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

  updateEntry(id: string, patch: EntryPatch): void {
    const current = this.readEntry(id);
    if (current === undefined) return;

    const next: MemoryEntry = { ...current, ...sanitizeEntryPatch(patch), id: current.id };
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
            char_count = ?
          WHERE id = ?
        `
        )
        .run(...this.entryParams(next).slice(1), id);
      this.upsertFts(next);
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

  listAuditEvents(filters: AuditFilters = {}): MemoryAuditEvent[] {
    const { where, params } = buildAuditWhere(filters);
    const limit = normalizeLimit(filters.limit, 100);
    const offset = normalizeOffset(filters.offset);
    return this.db
      .prepare(`SELECT * FROM audit_events ${where} ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset)
      .map(decodeAudit);
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
      entry.char_count
    ];
  }

  private upsertFts(entry: MemoryEntry): void {
    this.db.prepare("DELETE FROM memory_fts WHERE id = ?").run(entry.id);
    this.db
      .prepare("INSERT INTO memory_fts (id, scope, project_id, topic, title, body, tags) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(entry.id, entry.scope, entry.project_id ?? "", entry.topic, entry.title, entry.body, entry.tags.join(" "));
  }

}
