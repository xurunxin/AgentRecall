import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, SQLiteMemoryStore } from "../src/sqlite-store.js";

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "lm-mig-")), "memory.sqlite");
}

describe("SQLiteMemoryStore migrations", () => {
  let dbPath: string;
  let store: SQLiteMemoryStore;

  beforeEach(() => {
    dbPath = tmpDbPath();
  });

  afterEach(() => {
    store?.close();
  });

  it("creates a current schema on first run", () => {
    store = new SQLiteMemoryStore(dbPath);
    expect(store.getUserVersion()).toBe(CURRENT_SCHEMA_VERSION);
    // Stage 11 PR7 bumped CURRENT_SCHEMA_VERSION to 4
    // (memory_revisions / memory_accesses / project_aliases
    // / mutation_requests / memory_relations + the v4
    // columns on memory_entries). The v1->v2 chain is
    // still exercised by the "migrates a v1 database to
    // current" test below. Stage 15 PR-M0-4 bumped
    // schema to 6 (maintenance_plans).
    expect(CURRENT_SCHEMA_VERSION).toBe(6);
  });

  it("is a no-op when schema is already at latest version", () => {
    store = new SQLiteMemoryStore(dbPath);
    const result = store.runMigrations();
    expect(result).toEqual({ from: CURRENT_SCHEMA_VERSION, to: CURRENT_SCHEMA_VERSION });
  });

  it("migrates a v1 database (with the old actor CHECK constraint) to v2", () => {
    // Bootstrap a v1-shaped database directly with raw SQL
    const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
    db.exec(`
      CREATE TABLE audit_events (
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
      INSERT INTO audit_events (id, scope, event, actor, metadata_json, created_at)
        VALUES ('aud_x', 'global', 'created', 'agent', '{}', '2026-01-01T00:00:00.000Z');
    `);
    db.close();

    store = new SQLiteMemoryStore(dbPath);
    expect(store.getUserVersion()).toBe(CURRENT_SCHEMA_VERSION);

    // After migration, structured actor values must be insertable
    const inner = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true, readOnly: false });
    inner
      .prepare(
        "INSERT INTO audit_events (id, scope, event, actor, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run("aud_y", "global", "created", "agent:claude-code", "{}", "2026-01-02T00:00:00.000Z");
    inner.close();
  });

  it("exposes setUserVersion for tests and CLI", () => {
    store = new SQLiteMemoryStore(dbPath);
    store.setUserVersion(1);
    expect(store.getUserVersion()).toBe(1);
    const result = store.runMigrations();
    expect(result.from).toBe(1);
    expect(result.to).toBe(CURRENT_SCHEMA_VERSION);
  });
});
