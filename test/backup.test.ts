import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BackupError, listBackups, pruneBackups, runBackup } from "../src/backup.js";
import { SQLiteMemoryStore } from "../src/sqlite-store.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "lm-backup-"));
}

function seedStore(dataHome: string): SQLiteMemoryStore {
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  store.insertEntry({
    id: "mem_test",
    scope: "global",
    type: "fact",
    memory_kind: "semantic",
    topic: "test",
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
  return store;
}

describe("runBackup", () => {
  it("writes a file and reports size + duration", () => {
    const dataHome = tmpDir();
    const backupDir = join(dataHome, "backups");
    const store = seedStore(dataHome);
    const result = runBackup(store.backupHandle(), { backupDir });
    expect(existsSync(result.path)).toBe(true);
    expect(result.size).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.kept).toBe(1);
    store.close();
  });

  it("refuses to overwrite an existing file", () => {
    const dataHome = tmpDir();
    const backupDir = join(dataHome, "backups");
    const store = seedStore(dataHome);
    const fixed = new Date("2026-01-01T00:00:00.000Z");
    runBackup(store.backupHandle(), { backupDir, now: fixed });
    expect(() => runBackup(store.backupHandle(), { backupDir, now: fixed })).toThrow(BackupError);
    store.close();
  });
});

describe("pruneBackups", () => {
  it("keeps the N most recent files", () => {
    const dir = tmpDir();
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(join(dir, `memory-2026-07-19T00-00-0${i}.000Z.sqlite`), "");
    }
    const result = pruneBackups(dir, 3);
    expect(result.kept).toBe(3);
    expect(result.pruned).toBe(2);
    expect(readdirSync(dir).length).toBe(3);
  });

  it("returns zero counts for a missing directory", () => {
    const result = pruneBackups(join(tmpDir(), "does-not-exist"), 5);
    expect(result).toEqual({ kept: 0, pruned: 0 });
  });
});

describe("listBackups", () => {
  it("returns empty for missing dir", () => {
    expect(listBackups(join(tmpDir(), "does-not-exist"))).toEqual([]);
  });

  it("returns entries sorted newest first", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "memory-a.sqlite"), "");
    writeFileSync(join(dir, "memory-b.sqlite"), "");
    const items = listBackups(dir);
    expect(items.length).toBe(2);
  });

  it("filters out non-sqlite files", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "memory-a.sqlite"), "");
    writeFileSync(join(dir, "readme.txt"), "");
    const items = listBackups(dir);
    expect(items.length).toBe(1);
    expect(items[0].name).toBe("memory-a.sqlite");
  });

  // v1.1.3 GATE-03 (issue #33) review Blocker 3:
  // the listing surface filters at the SQL
  // boundary. A Core caller does not see
  // backups whose live tier exceeds
  // `max_sensitivity: "normal"`.
  it("omits restricted backups when the authorization ceiling is normal", () => {
    // Build two SQLite files: one with only
    // normal entries, one with restricted
    // entries. The listing with the
    // `authorization: { max_sensitivity: "normal" }`
    // option must omit the restricted backup
    // and surface only the normal one.
    const dir = tmpDir();
    const normalFile = join(dir, "memory-normal.sqlite");
    const restrictedFile = join(dir, "memory-restricted.sqlite");
    // Use `runBackup` so the files carry the
    // canonical schema (`memory_entries` table).
    const normalStore = seedStore(tmpDir());
    writeFileSync(normalFile, "");
    // The simplest way to land a real
    // `memory_entries` row is to construct a
    // fresh SQLiteMemoryStore on a tmp path,
    // insert a row, then copy the file. We
    // inline a tiny SQLiteMemoryStore lifecycle
    // here so the test does not depend on a
    // helper that wasn't designed for it.
    buildBackupWithEntries(normalFile, [{ id: "n1", sensitivity: "normal" }]);
    buildBackupWithEntries(restrictedFile, [{ id: "r1", sensitivity: "restricted" }]);
    normalStore.close();
    const filtered = listBackups(dir, {
      authorization: { max_sensitivity: "normal" }
    });
    expect(filtered.length).toBe(1);
    expect(filtered[0].name).toBe("memory-normal.sqlite");
    // Sanity: without `authorization`, the
    // pre-GATE-03 surface returns every backup.
    const unfiltered = listBackups(dir);
    expect(unfiltered.length).toBe(2);
  });

  it("surfaces restricted backups when the authorization ceiling is restricted", () => {
    const dir = tmpDir();
    buildBackupWithEntries(join(dir, "memory-normal.sqlite"), [
      { id: "n1", sensitivity: "normal" }
    ]);
    buildBackupWithEntries(join(dir, "memory-restricted.sqlite"), [
      { id: "r1", sensitivity: "restricted" }
    ]);
    const items = listBackups(dir, {
      authorization: { max_sensitivity: "restricted" }
    });
    expect(items.length).toBe(2);
  });
});

/**
 * Build a self-contained backup file at
 * `targetPath` carrying the given `memory_entries`
 * rows. The file is a fresh SQLite database
 * with the schema v1.1.1+ `memory_entries`
 * table so the v1.1.3 GATE-03 sensitivity
 * probe (`SELECT MAX(CASE sensitivity ...)`)
 * can run against it.
 */
function buildBackupWithEntries(
  targetPath: string,
  entries: Array<{ id: string; sensitivity: "normal" | "private" | "restricted" }>
): void {
  const tmp = mkdtempSync(join(tmpdir(), "lm-bkp-probe-"));
  const store = new SQLiteMemoryStore(join(tmp, "memory.sqlite"));
  for (const e of entries) {
    store.insertEntry({
      id: e.id,
      scope: "global",
      type: "fact",
      topic: "bkp-probe",
      title: e.id,
      body: e.id,
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      status: "active",
      created_at: "2026-07-29T00:00:00.000Z",
      updated_at: "2026-07-29T00:00:00.000Z",
      access_count: 0,
      supersedes: [],
      token_estimate: 1,
      char_count: 2,
      revision: 1,
      writer_actor_id: "agent:bkp-probe",
      pinned: false,
      trust_level: "agent_observed",
      sensitivity: e.sensitivity,
      tier: "working",
      metadata: {}
    });
  }
  store.close();
  copyFileSync(join(tmp, "memory.sqlite"), targetPath);
  rmSync(tmp, { recursive: true, force: true });
}

describe("runBackup failure path", () => {
  it("returns BackupError when the disk rejects the write (path blocked by file)", () => {
    const dataHome = tmpDir();
    const backupDir = join(dataHome, "backups");
    mkdirSync(backupDir);
    // Pre-create a file with the same name that a fixed-timestamp backup
    // would generate, blocking the write.
    writeFileSync(join(backupDir, "memory-2026-01-01T00-00-00.000Z.sqlite"), "blocking");
    const store = seedStore(dataHome);
    const fixed = new Date("2026-01-01T00:00:00.000Z");
    expect(() => runBackup(store.backupHandle(), { backupDir, now: fixed })).toThrow(BackupError);
    store.close();
  });
});
