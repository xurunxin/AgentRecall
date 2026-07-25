import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, SQLiteMemoryStore } from "../src/sqlite-store.js";

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "lm-mig-v3-")), "memory.sqlite");
}

describe("SQLiteMemoryStore v2 -> v3 migration", () => {
  let dbPath: string;
  let store: SQLiteMemoryStore;

  beforeEach(() => {
    dbPath = tmpDbPath();
  });
  afterEach(() => {
    if (store === undefined) return;
    try {
      store.close();
    } catch {
      // already closed by the test
    }
  });

  it("creates a current schema on first run", () => {
    store = new SQLiteMemoryStore(dbPath);
    expect(store.getUserVersion()).toBe(CURRENT_SCHEMA_VERSION);
    // Stage 11 PR7 bumped CURRENT_SCHEMA_VERSION to 4
    // (memory_revisions, memory_accesses, project_aliases,
    // mutation_requests, memory_relations, plus the v4
    // columns on memory_entries). The v3-specific assertions
    // below still cover the v2->v3 step in isolation.
    // Stage 15 PR-M0-4 bumped the schema to 6
    // (maintenance_plans); the migration chain still
    // walks v2->v3->v4->v5->v6.
    expect(CURRENT_SCHEMA_VERSION).toBe(6);
  });

  it("migrates a v2 database to v3, preserving existing rows", () => {
    // Bootstrap a v2-shaped database: no last_accessed_by column yet.
    const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
    db.exec(`
      CREATE TABLE memory_entries (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
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
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_accessed_at TEXT,
        access_count INTEGER NOT NULL,
        expires_at TEXT,
        review_after TEXT,
        supersedes_json TEXT NOT NULL,
        superseded_by TEXT,
        token_estimate INTEGER NOT NULL,
        char_count INTEGER NOT NULL
      ) STRICT;
      INSERT INTO memory_entries (id, scope, type, topic, title, body, tags_json, source_json, importance, confidence, status, created_at, updated_at, access_count, supersedes_json, token_estimate, char_count)
        VALUES ('mem_v2', 'global', 'fact', 't', 't', 'b', '[]', '{"kind":"agent"}', 3, 3, 'active', '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z', 0, '[]', 1, 2);
      PRAGMA user_version = 2;
    `);
    db.close();

    store = new SQLiteMemoryStore(dbPath);
    // Stage 10 PR5: the default open mode is
    // read_write_no_migrate, so a non-fresh v2 DB stays at
    // v2 until the caller explicitly runs the migration
    // chain. The migration test now opts in explicitly
    // (mirroring the post-PR5 CLI `migrate --yes` flow).
    store.runMigrations();
    expect(store.getUserVersion()).toBe(CURRENT_SCHEMA_VERSION);

    // Pre-existing row is preserved; new column is null.
    const handle = new DatabaseSync(dbPath, { readOnly: true });
    const row = handle
      .prepare("SELECT id, last_accessed_by FROM memory_entries WHERE id = 'mem_v2'")
      .get() as { id: string; last_accessed_by: string | null };
    expect(row.id).toBe("mem_v2");
    expect(row.last_accessed_by).toBeNull();
    handle.close();
  });

  it("is a no-op when schema is already at v3", () => {
    store = new SQLiteMemoryStore(dbPath);
    const result = store.runMigrations();
    expect(result).toEqual({ from: CURRENT_SCHEMA_VERSION, to: CURRENT_SCHEMA_VERSION });
  });

  it("decodeEntry exposes last_accessed_by as a parsed map", () => {
    store = new SQLiteMemoryStore(dbPath);
    store.insertEntry({
      id: "mem_a",
      scope: "global",
      type: "fact",
      memory_kind: "semantic",
      topic: "t",
      title: "t",
      body: "b",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      status: "active",
      created_at: "2026-07-19T00:00:00.000Z",
      updated_at: "2026-07-19T00:00:00.000Z",
      access_count: 0,
      supersedes: [],
      token_estimate: 1,
      char_count: 2
    });
    const peeked = store.peekEntry("mem_a");
    expect(peeked?.last_accessed_by).toBeUndefined();
    store.close();
  });
});
