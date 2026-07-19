import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
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
});

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
