import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSqliteDb,
  createNodeDb,
  createBunDb,
  IS_BUN
} from "../../src/sqlite-driver.js";

describe("sqlite-driver (Node path; vitest always runs on Node)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-recall-sqlite-driver-"));
    dbPath = join(dir, "test.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("IS_BUN is false under Node", () => {
    expect(IS_BUN).toBe(false);
  });

  it("createSqliteDb opens, writes, reads, closes (round-trip)", () => {
    const db = createSqliteDb(dbPath);
    db.exec("CREATE TABLE t (n INTEGER NOT NULL)");
    db.prepare("INSERT INTO t VALUES (?)").run(42);
    const row = db.prepare("SELECT n FROM t").get<{ n: number }>();
    expect(row).toEqual({ n: 42 });
    db.close();
  });

  it("createSqliteDb.run() returns { changes, lastInsertRowid }", () => {
    const db = createSqliteDb(dbPath);
    db.exec("CREATE TABLE t (n INTEGER NOT NULL)");
    const r = db.prepare("INSERT INTO t VALUES (?)").run(7);
    expect(r.changes).toBe(1);
    expect(Number(r.lastInsertRowid)).toBe(1);
    db.close();
  });

  it("createSqliteDb.all<T>() preserves the generic shape", () => {
    const db = createSqliteDb(dbPath);
    db.exec("CREATE TABLE t (n INTEGER NOT NULL)");
    db.prepare("INSERT INTO t VALUES (?)").run(1);
    db.prepare("INSERT INTO t VALUES (?)").run(2);
    const rows = db.prepare("SELECT n FROM t ORDER BY n").all<{ n: number }>();
    expect(rows).toEqual([{ n: 1 }, { n: 2 }]);
    db.close();
  });

  it("createSqliteDb.values() returns array-of-arrays", () => {
    const db = createSqliteDb(dbPath);
    db.exec("CREATE TABLE t (a INTEGER NOT NULL, b TEXT NOT NULL)");
    db.prepare("INSERT INTO t VALUES (?, ?)").run(1, "x");
    const values = db.prepare("SELECT a, b FROM t").values();
    expect(values).toEqual([[1, "x"]]);
    db.close();
  });

  it("createNodeDb is the Node branch and matches createSqliteDb surface", () => {
    const db = createNodeDb(dbPath);
    db.exec("SELECT 1");
    db.close();
  });

  it("createBunDb throws under Node (bun:sqlite unavailable)", () => {
    // bun:sqlite is not loadable in the Node runtime; the bun
    // branch must surface that as a synchronous throw.
    expect(() => createBunDb(dbPath)).toThrow();
  });

  it("createSqliteDb uses the Node branch when IS_BUN is false", () => {
    // Verify the routing contract directly: under vitest (Node),
    // createSqliteDb must succeed; under the bun branch, the
    // same call would throw.
    expect(IS_BUN).toBe(false);
    const db = createSqliteDb(dbPath);
    db.exec("SELECT 1");
    db.close();
  });

  it("createSqliteDb(path, { readOnly: true }) opens in read-only mode (writes fail)", () => {
    // Pre-populate the file so the read-only open succeeds
    // (node:sqlite fails to open a non-existent file in
    // read-only mode).
    const setup = createSqliteDb(dbPath);
    setup.exec("CREATE TABLE t (n INTEGER NOT NULL)");
    setup.prepare("INSERT INTO t VALUES (?)").run(7);
    setup.close();

    // Reopen in read-only mode.
    const db = createSqliteDb(dbPath, { readOnly: true });

    // Reading must still work.
    const row = db.prepare("SELECT n FROM t").get<{ n: number }>();
    expect(row).toEqual({ n: 7 });

    // Writing must fail under read-only mode.
    expect(() => {
      db.prepare("INSERT INTO t VALUES (?)").run(42);
    }).toThrow();

    db.close();
  });

  it("createSqliteDb(path, { enableForeignKeyConstraints: true }) enables FK enforcement", () => {
    const db = createSqliteDb(dbPath, {
      enableForeignKeyConstraints: true
    });
    const row = db
      .prepare("PRAGMA foreign_keys")
      .get<{ foreign_keys: number }>();
    expect(row?.foreign_keys).toBe(1);
    db.close();
  });

  it("createSqliteDb(path, { timeout: 1234 }) sets busy_timeout to 1234", () => {
    // Node 24's node:sqlite returns the busy_timeout pragma as
    // { timeout: N } (the underlying SQLite column name).
    const db = createSqliteDb(dbPath, { timeout: 1234 });
    const row = db.prepare("PRAGMA busy_timeout").get<{ timeout: number }>();
    expect(row?.timeout).toBe(1234);
    db.close();
  });
});
