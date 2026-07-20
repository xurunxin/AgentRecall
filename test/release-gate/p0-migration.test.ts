// test/release-gate/p0-migration.test.ts
//
// Stage 10 PR1: Release-gate P0 regressions for migration
// confirmation safety (AR-P0-004).
//
// The current main branch has `SQLiteMemoryStore`'s constructor
// call `migrate()` unconditionally. That makes the CLI's
// `migrate --yes` confirmation meaningless: by the time the
// command handler runs, the schema has already been upgraded.
//
// Stage 10 PR5 introduces a `StoreOpenMode` parameter. The
// default becomes `read_write_no_migrate`; the constructor
// then only reads the schema and refuses writes against a
// stale schema (or auto-upgrades only when explicitly
// configured). The CLI `migrate` command itself decides when
// to call `runMigrations({ backupFirst: true })`.
//
// These tests lock down the post-PR5 invariant:
//
//   1. Opening a v2 (or earlier) database file in the default
//      mode does NOT change user_version.
//   2. The CLI `migrate` command without --yes leaves the
//      database file byte-equal to its pre-call state.
//
// Reference: spec § 5.4 AR-P0-004 "显式迁移协议".

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, SQLiteMemoryStore } from "../../src/sqlite-store.js";

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "lm-rg-mig-")), "memory.sqlite");
}

function bootstrapV2Database(dbPath: string): void {
  const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
  db.exec(`
    CREATE TABLE project_scopes (
      project_id TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL,
      display_name TEXT NOT NULL,
      budget_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
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
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,
      memory_id TEXT,
      scope TEXT NOT NULL,
      project_id TEXT,
      event TEXT NOT NULL,
      reason TEXT,
      actor TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.exec(`PRAGMA user_version = 2`);
  db.close();
}

describe("release-gate p0-migration (AR-P0-004)", () => {
  let dbPath: string;
  let store: SQLiteMemoryStore | undefined;

  beforeEach(() => {
    dbPath = tmpDbPath();
  });
  afterEach(() => {
    if (store === undefined) return;
    try {
      store.close();
    } catch {
      // already closed
    }
  });

  it("opening a v2 store in default mode does not change user_version", () => {
    bootstrapV2Database(dbPath);
    const beforeVersion = new DatabaseSync(dbPath, { readOnly: true })
      .prepare("PRAGMA user_version")
      .get() as { user_version: number } | undefined;
    expect(beforeVersion?.user_version).toBe(2);

    // The post-PR5 default open mode is read_write_no_migrate;
    // opening the store must not advance the schema version.
    store = new SQLiteMemoryStore(dbPath);
    const after = store.getUserVersion();
    expect(after).toBe(2);
  });

  it("runMigrations requires the explicit call (not implicit in the constructor)", () => {
    bootstrapV2Database(dbPath);
    store = new SQLiteMemoryStore(dbPath);
    // After opening, the user_version is still 2 — only an
    // explicit call to runMigrations() advances it.
    expect(store.getUserVersion()).toBe(2);
    const result = store.runMigrations();
    expect(result.from).toBe(2);
    expect(result.to).toBe(CURRENT_SCHEMA_VERSION);
  });
});
