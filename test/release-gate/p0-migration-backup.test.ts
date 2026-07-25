// test/release-gate/p0-migration-backup.test.ts
//
// Stage 14 PR-A (spec § 5.4 AR-P0-004 / § 14): the CLI
// `migrate` command MUST take a verified backup of the live
// database BEFORE advancing user_version, and MUST print a
// restore command the user can run to roll back.
//
// Pre-PR-A the command called `store.runMigrations()`
// directly. There was no short-circuit on backup failure and
// no documented rollback path. The acceptance criteria
// below lock down the post-PR-A invariant:
//
//   1. A successful `migrate --yes` writes a backup file
//      under `<dataHome>/backups/`, verifies it with
//      `PRAGMA quick_check`, and prints the restore
//      command on stdout.
//   2. A failed pre-migration backup returns exit 2 with
//      a `backup_failed` error and does NOT advance
//      user_version.
//   3. The backup file's `user_version` matches the
//      pre-migration version (i.e. it captures the
//      pre-migration state, not the post-migration state).
//   4. The JSON output includes the backup path and a
//      `restore_command` the user can run verbatim.
//
// Reference: spec § 5.4 "AR-P0-004 显式迁移协议" and
// spec § 14 "迁移前必须生成 verified backup，并把 restore
// 命令打印给用户".

import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrateCommand } from "../../src/cli/commands/migrate.js";
import { parseArgs } from "../../src/cli/arg-parser.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import { listBackups } from "../../src/backup.js";

function tmpDataHome(): string {
  return mkdtempSync(join(tmpdir(), "lm-rg-mig-bk-"));
}

function seedV1Schema(dbPath: string): void {
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
  db.exec("PRAGMA user_version = 1");
  db.close();
}

describe("release-gate p0-migration-backup (PR-A)", () => {
  let dataHome: string;
  let store: SQLiteMemoryStore | undefined;
  let dbPath: string;

  beforeEach(() => {
    dataHome = tmpDataHome();
    dbPath = join(dataHome, "memory.sqlite");
  });
  afterEach(() => {
    if (store === undefined) return;
    try {
      store.close();
    } catch {
      // already closed
    }
  });

  it("writes a verified backup before advancing user_version", () => {
    seedV1Schema(dbPath);
    store = new SQLiteMemoryStore(dbPath);

    const result = migrateCommand({
      dataHome,
      args: parseArgs(["migrate", "--yes"]),
      store
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("migrated");
    expect(result.stdout).toMatch(/pre-migration backup: .+\.sqlite/);
    expect(result.stdout).toMatch(/to roll back: agent-recall restore --from .+ --confirm/);

    // The backup must be on disk, parseable, and carry the
    // pre-migration user_version (1).
    const backups = readdirSync(join(dataHome, "backups")).filter((n) => n.endsWith(".sqlite"));
    expect(backups.length).toBe(1);
    const backupPath = join(dataHome, "backups", backups[0]!);
    const probe = new DatabaseSync(backupPath, { readOnly: true });
    const version = probe.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
    probe.close();
    expect(version?.user_version).toBe(1);

    // Live DB is at the new version. Stage 15 PR-M0-4
    // bumped the schema from 5 -> 6 to introduce
    // `maintenance_plans` + `maintenance_plan_items`.
    expect(store.getUserVersion()).toBe(6);
  });

  it("blocks the migration when the pre-mutation backup cannot be written", () => {
    seedV1Schema(dbPath);
    store = new SQLiteMemoryStore(dbPath);

    // Block the backup directory by writing a file at
    // <dataHome>/backups. mkdirSync({recursive:true}) refuses
    // to create a directory on top of a non-directory file.
    const blockedPath = join(dataHome, "backups");
    writeFileSync(blockedPath, "blocks the backup directory");

    const result = migrateCommand({
      dataHome,
      args: parseArgs(["migrate", "--yes"]),
      store
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/pre-migration backup failed/);
    expect(result.stderr).not.toContain("migrated");

    // The user_version must NOT have advanced: the
    // migration never ran because the backup failed.
    expect(store.getUserVersion()).toBe(1);
  });

  it("emits structured JSON with backup metadata + restore_command", () => {
    seedV1Schema(dbPath);
    store = new SQLiteMemoryStore(dbPath);

    const result = migrateCommand({
      dataHome,
      args: parseArgs(["migrate", "--yes", "--json"]),
      store
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      from: number;
      to: number;
      backup: {
        path: string;
        size: number;
        duration_ms: number;
        schema_version: number;
        quick_check: string;
        restore_command: string;
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.from).toBe(1);
    // Stage 15 PR-M0-4: schema bumped to 6 with
    // maintenance_plans + maintenance_plan_items.
    expect(parsed.to).toBe(6);
    expect(parsed.backup.path).toMatch(/memory-.*\.sqlite$/);
    expect(parsed.backup.schema_version).toBe(1);
    expect(parsed.backup.quick_check).toBe("ok");
    expect(parsed.backup.restore_command).toBe(
      `agent-recall restore --from ${parsed.backup.path} --confirm`
    );
    expect(existsSync(parsed.backup.path)).toBe(true);
  });

  it("a no-op migration (already at current) still takes a backup and prints the restore hint", () => {
    // Fresh DB opens at v4 directly. Migrate is a no-op
    // but the safety contract is still satisfied: a backup
    // exists and a restore command is printed.
    store = new SQLiteMemoryStore(dbPath);

    const result = migrateCommand({
      dataHome,
      args: parseArgs(["migrate", "--yes"]),
      store
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no migration needed");
    expect(result.stdout).toMatch(/pre-migration backup:/);
    expect(result.stdout).toMatch(/to roll back:/);

    const listed = listBackups(join(dataHome, "backups"));
    expect(listed.length).toBe(1);
  });

  it("refuses to migrate without --yes even when the backup would succeed", () => {
    seedV1Schema(dbPath);
    store = new SQLiteMemoryStore(dbPath);

    const result = migrateCommand({
      dataHome,
      args: parseArgs(["migrate"]),
      store
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--yes");
    expect(store.getUserVersion()).toBe(1);
    // No backup should be written when --yes is absent.
    expect(listBackups(join(dataHome, "backups")).length).toBe(0);
  });
});
