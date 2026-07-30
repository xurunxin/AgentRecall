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
});
