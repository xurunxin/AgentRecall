// src/sqlite-driver.ts
//
// Runtime-detecting SQLite driver.
//
// Background:
//   - The project uses Node's built-in `node:sqlite`
//     (DatabaseSync) in src/sqlite-store.ts, src/backup.ts,
//     and src/doctor/checks/backup-verification.ts.
//   - Bun does NOT ship `node:sqlite`; it ships `bun:sqlite`
//     with class name `Database`.
//   - This adapter exposes one interface so the existing
//     call sites work under both runtimes. The Node branch
//     is the default; the Bun branch is selected at module
//     load via `typeof Bun !== "undefined"`.
//
// No new npm dependencies. Both backends are runtime
// built-ins. The Bun branch loads `bun:sqlite` via
// `createRequire` so the module is never evaluated under
// Node.

import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";

const requireESM = createRequire(import.meta.url);

export type SqliteBindValue = unknown;
export type SqliteRowValue = unknown;

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(...params: SqliteBindValue[]): SqliteRunResult;
  get<T = SqliteRowValue>(...params: SqliteBindValue[]): T | undefined;
  all<T = SqliteRowValue>(...params: SqliteBindValue[]): T[];
  values(...params: SqliteBindValue[]): unknown[][];
}

export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export const IS_BUN: boolean =
  typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

// --- Node backend (node:sqlite) ---

// Structural type for the raw node:sqlite StatementSync.
// NOTE: node:sqlite's StatementSync does NOT expose a `values()`
// method (verified on Node 24.x). The values() requirement on
// SqliteStatement is satisfied by materializing from `all()` +
// `columns()` to preserve column order, without disturbing the
// object-row form returned by `get()` / `all()` for existing
// call sites wired up in Task 2.
interface NodeStatementRaw {
  run(...params: SqliteBindValue[]): SqliteRunResult;
  get<T>(...params: SqliteBindValue[]): T | undefined;
  all<T>(...params: SqliteBindValue[]): T[];
  columns(): Array<{ name: string }>;
}

class NodeStatementAdapter implements SqliteStatement {
  constructor(private readonly raw: NodeStatementRaw) {}
  run(...params: SqliteBindValue[]): SqliteRunResult {
    return this.raw.run(...params);
  }
  get<T>(...params: SqliteBindValue[]): T | undefined {
    return this.raw.get<T>(...params);
  }
  all<T>(...params: SqliteBindValue[]): T[] {
    return this.raw.all<T>(...params);
  }
  values(...params: SqliteBindValue[]): unknown[][] {
    // node:sqlite does not expose StatementSync.values(); compute
    // array-of-arrays from all() + columns() so the SqliteStatement
    // contract is satisfied without disturbing object-row callers.
    const cols = this.raw.columns();
    const rows = this.raw.all<Record<string, SqliteBindValue>>(...params);
    return rows.map((row) => cols.map((c) => row[c.name]));
  }
}

class NodeDbAdapter implements SqliteDb {
  constructor(private readonly raw: {
    exec(sql: string): void;
    prepare(sql: string): unknown;
    close(): void;
  }) {}
  exec(sql: string): void {
    this.raw.exec(sql);
  }
  prepare(sql: string): SqliteStatement {
    return new NodeStatementAdapter(
      this.raw.prepare(sql) as NodeStatementRaw
    );
  }
  close(): void {
    this.raw.close();
  }
}

export function createNodeDb(path: string): SqliteDb {
  return new NodeDbAdapter(new DatabaseSync(path));
}

// --- Bun backend (bun:sqlite) ---

interface BunDatabaseRaw {
  exec(sql: string): void;
  prepare(sql: string): unknown;
  close(): void;
}

interface BunStatementRaw {
  run(...params: SqliteBindValue[]): SqliteRunResult;
  get<T>(...params: SqliteBindValue[]): T | undefined;
  all<T>(...params: SqliteBindValue[]): T[];
  values(...params: SqliteBindValue[]): unknown[][];
}

class BunStatementAdapter implements SqliteStatement {
  constructor(private readonly raw: BunStatementRaw) {}
  run(...params: SqliteBindValue[]): SqliteRunResult {
    return this.raw.run(...params);
  }
  get<T>(...params: SqliteBindValue[]): T | undefined {
    return this.raw.get<T>(...params);
  }
  all<T>(...params: SqliteBindValue[]): T[] {
    return this.raw.all<T>(...params);
  }
  values(...params: SqliteBindValue[]): unknown[][] {
    return this.raw.values(...params);
  }
}

class BunDbAdapter implements SqliteDb {
  constructor(private readonly raw: BunDatabaseRaw) {}
  exec(sql: string): void {
    this.raw.exec(sql);
  }
  prepare(sql: string): SqliteStatement {
    return new BunStatementAdapter(this.raw.prepare(sql) as BunStatementRaw);
  }
  close(): void {
    this.raw.close();
  }
}

export function createBunDb(path: string): SqliteDb {
  // bun:sqlite is only available at Bun runtime. Loading via
  // createRequire throws MODULE_NOT_FOUND under Node, which
  // surfaces as the synchronous throw the unit tests assert.
  const mod = requireESM("bun:sqlite") as {
    Database: new (path: string) => BunDatabaseRaw;
  };
  return new BunDbAdapter(new mod.Database(path));
}

export function createSqliteDb(path: string): SqliteDb {
  return IS_BUN ? createBunDb(path) : createNodeDb(path);
}
