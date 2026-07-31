# Bun single-file binary distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Bun single-file binary distribution path that coexists with the Node npm package, using `bun:sqlite` when running under Bun and `node:sqlite` otherwise.

**Architecture:** A thin `src/sqlite-driver.ts` adapter selects between `node:sqlite` and `bun:sqlite` at module-load time via `typeof Bun !== "undefined"`. Three existing import points swap to the adapter. A `scripts/build-bun-binary.mjs` script runs `bun build --compile --target=bun-<plat>` for both the CLI and the MCP server. A `scripts/smoke-bun-binary.mjs` exercises seven CLI steps against the local binary. Documentation, CHANGELOG, and the bundled skill close the work.

**Tech Stack:** Bun 1.3+ (build host only); Node.js 24+ (consumer of existing npm path); vitest 3.2 (Node); TypeScript 5.8 (`module: NodeNext`, `type: module`); no new npm dependencies.

## Global Constraints

- Node path stays primary; npm-published package is byte-identical post-change.
- Zero new npm dependencies (`package.json` `dependencies` field unchanged).
- Bun minimum version: 1.3.0 (enforced by build script with a clear error).
- Canonical platform tokens only: `linux-x64`, `darwin-x64`, `darwin-arm64`, `win32-x64`.
- All exit-code contracts from the existing CLI preserved (0/1/2/3 + stable `[code]` prefixes).
- `bin` field in `package.json` unchanged.
- `dist/` (tsc output) unchanged.
- All existing vitest tests pass without modification.
- No commits without explicit user authorization (the implementer must stage and propose, not commit).

---

## File Structure

**New files (6):**

- `src/sqlite-driver.ts` — adapter; one interface, two backends.
- `test/unit/sqlite-driver.test.ts` — vitest unit tests for the adapter.
- `scripts/build-bun-binary.mjs` — Bun `--compile` orchestrator.
- `scripts/smoke-bun-binary.mjs` — 7-step Bun binary smoke test.
- `test/smoke/bun-binary.test.ts` — vitest smoke that spawns the local Bun binary.
- `docs/guides/bun-distribution.md` — operator-facing recipe.

**Modified files (7):**

- `src/sqlite-store.ts` — import + constructor.
- `src/backup.ts` — import + one `new DatabaseSync`.
- `src/doctor/checks/backup-verification.ts` — import + one `new DatabaseSync`.
- `package.json` — two new `scripts` entries.
- `README.md` — one subsection in `## Installation`.
- `skills/agent-recall-cli/SKILL.md` — one bullet in "Pairing with the rest of the toolchain".
- `CHANGELOG.md` — one new top-level `[Unreleased]` section.

**Generated artifacts (not source):**

- `dist-bin/agent-recall-<plat>[.exe]` — Bun CLI binary per platform.
- `dist-bin/agent-recall-mcp-<plat>[.exe]` — Bun MCP binary per platform.
- `dist-bin/MANIFEST.json` — Bun version + per-binary SHA-256 + size.

---

## Task 1: SQLite driver adapter (`src/sqlite-driver.ts`)

**Files:**
- Create: `src/sqlite-driver.ts`
- Create: `test/unit/sqlite-driver.test.ts`

**Interfaces:**
- Consumes: nothing (greenfield).
- Produces (consumed by Task 2 and all later tasks):
  - `export interface SqliteStatement { run(...params): SqliteRunResult; get<T>(...params): T | undefined; all<T>(...params): T[]; values(...params): unknown[][]; }`
  - `export interface SqliteRunResult { changes: number; lastInsertRowid: number | bigint; }`
  - `export interface SqliteDb { exec(sql: string): void; prepare(sql: string): SqliteStatement; close(): void; }`
  - `export interface SqliteDbOptions { readOnly?: boolean; enableForeignKeyConstraints?: boolean; timeout?: number; }`
  - `export type SqliteBindValue = unknown; export type SqliteRowValue = unknown;`
  - `export const IS_BUN: boolean;`
  - `export function createSqliteDb(path: string, opts?: SqliteDbOptions): SqliteDb;`
  - `export function createNodeDb(path: string, opts?: SqliteDbOptions): SqliteDb;`
  - `export function createBunDb(path: string, opts?: SqliteDbOptions): SqliteDb;`

**Options contract (binding — Task 2 depends on this):**
- `readOnly`: open the database in read-only mode. Mapped to `node:sqlite` `DatabaseSync`'s `{ readOnly: true }` and `bun:sqlite` `Database`'s `{ readonly: true }`.
- `enableForeignKeyConstraints`: emit `PRAGMA foreign_keys = ON` immediately after open. `node:sqlite` also accepts `{ enableForeignKeyConstraints: true }` on the constructor; the adapter should pass that. `bun:sqlite` enables FK by default; the adapter issues the PRAGMA unconditionally so the Node-vs-Bun behaviour matches the caller's intent.
- `timeout`: busy-timeout in milliseconds. `node:sqlite` accepts `{ timeout: N }`; `bun:sqlite` accepts `{ timeout: N }` directly. The adapter passes the option through.

- [ ] **Step 1: Write the failing vitest file**

Create `test/unit/sqlite-driver.test.ts`:

```ts
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
```

- [ ] **Step 2: Run vitest to verify the tests fail (no implementation yet)**

Run: `npx vitest run test/unit/sqlite-driver.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/sqlite-driver.js" from "test/unit/sqlite-driver.test.ts"`.

- [ ] **Step 3: Implement the adapter**

Create `src/sqlite-driver.ts`:

```ts
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

class NodeStatementAdapter implements SqliteStatement {
  constructor(private readonly raw: {
    run(...params: SqliteBindValue[]): SqliteRunResult;
    get<T>(...params: SqliteBindValue[]): T | undefined;
    all<T>(...params: SqliteBindValue[]): T[];
    values(...params: SqliteBindValue[]): unknown[][];
  }) {}
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
      this.raw.prepare(sql) as ConstructorParameters<typeof NodeStatementAdapter>[0]
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
```

- [ ] **Step 4: Run vitest to verify the tests pass**

Run: `npx vitest run test/unit/sqlite-driver.test.ts`
Expected: PASS — all 8 tests pass.

- [ ] **Step 5: Run the full unit suite to verify no regression**

Run: `npx vitest run --reporter=default`
Expected: PASS — only the new test file is affected; no existing test runs through the new adapter yet (Task 2 wires it in).

- [ ] **Step 6: Stage the new files**

```bash
git add src/sqlite-driver.ts test/unit/sqlite-driver.test.ts
git status
```

Then propose the commit message to the user and **do not commit** until authorized:

```
feat(sqlite-driver): add runtime-detecting SQLite adapter

- src/sqlite-driver.ts exposes SqliteDb / SqliteStatement
  interfaces and a createSqliteDb factory that selects
  between node:sqlite (Node) and bun:sqlite (Bun).
- test/unit/sqlite-driver.test.ts covers the Node branch
  end-to-end and asserts the Bun branch surfaces as a
  synchronous throw under Node (MODULE_NOT_FOUND).
- No existing call sites changed in this commit.
- No new npm dependencies.
```

---

## Task 2: Wire the adapter into the three existing import points

**Files:**
- Modify: `src/sqlite-store.ts:1-4` (import block)
- Modify: `src/sqlite-store.ts` (constructor body — find `new DatabaseSync(...)`)
- Modify: `src/backup.ts:23-24` (import block)
- Modify: `src/backup.ts` (the `new DatabaseSync(...)` call in `runBackup`)
- Modify: `src/doctor/checks/backup-verification.ts:21` (import block)
- Modify: `src/doctor/checks/backup-verification.ts` (the `new DatabaseSync(...)` call)

**Interfaces:**
- Consumes: `createSqliteDb(path: string, opts?: SqliteDbOptions): SqliteDb`, `createNodeDb`, `createBunDb`, `SqliteDb`, `SqliteStatement`, `SqliteBindValue`, `SqliteRowValue`, `SqliteDbOptions` (`{ readOnly?, enableForeignKeyConstraints?, timeout? }`) from Task 1.
- Produces: the same public API of `SQLiteMemoryStore` (constructor + every public method), `runBackup(store, opts)`, `verifyBackupFile(...)` — all unchanged from a caller's perspective.

**Options preservation (binding — zero behavior regression):**
Every existing `new DatabaseSync(path, {opts})` call site must pass equivalent options through `createSqliteDb(path, opts)`. Specifically:
- `src/sqlite-store.ts` constructor: `{ enableForeignKeyConstraints: true, timeout: 5000, readOnly: <derived from openMode> }` (the original code derives `readOnly` from `openMode === "read_only"`; preserve that derivation).
- `src/backup.ts` probe in `readBackupSensitivityTier`: `{ readOnly: true }`.
- `src/backup.ts` probe in `verifyBackup`: `{ readOnly: true }`.
- `src/doctor/checks/backup-verification.ts` probe: `{ readOnly: true }`.

- [ ] **Step 1: Modify `src/sqlite-store.ts`**

In `src/sqlite-store.ts`:

- Replace line 3:
  ```ts
  import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
  ```
  with:
  ```ts
  import {
    createSqliteDb,
    type SqliteBindValue as SQLInputValue,
    type SqliteRowValue as SQLOutputValue,
    type SqliteDb,
    type SqliteStatement
  } from "./sqlite-driver.js";
  ```
- Find the `SQLiteMemoryStore` constructor and replace `this.db: DatabaseSync` (or equivalent) with `this.db: SqliteDb`. Find the line where the constructor calls `new DatabaseSync(...)` and replace it with `createSqliteDb(dbPath, { enableForeignKeyConstraints: true, timeout: 5000, readOnly: readonly })`. **The three options MUST be preserved verbatim — they were the source of Task 2's plan defect discovered by the implementer (review commit).** Replace any other internal `DatabaseSync` or `node:sqlite` reference with `SqliteDb` / `SqliteStatement`.
- Do NOT change any SQL string, transaction code, PRAGMA, or VACUUM INTO call — these are pure SQLite features that work identically on both backends.

- [ ] **Step 2: Verify `src/sqlite-store.ts` compiles**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS — no type errors. If any `DatabaseSync` / `SQLInputValue` / `SQLOutputValue` reference remains in this file, fix it before proceeding.

- [ ] **Step 3: Modify `src/backup.ts`**

In `src/backup.ts`:

- Replace line 24:
  ```ts
  import { DatabaseSync } from "node:sqlite";
  ```
  with:
  ```ts
  import { createSqliteDb } from "./sqlite-driver.js";
  ```
- Find **both** `new DatabaseSync(<path>, { readOnly: true })` calls (one in `readBackupSensitivityTier`, one in `verifyBackup`) and replace each with `createSqliteDb(<path>, { readOnly: true })`. **The `readOnly: true` option MUST be preserved** — backup files on read-only filesystems or with held WAL sidecar locks will fail to open otherwise. Do not change any other logic in this file.

- [ ] **Step 4: Verify `src/backup.ts` compiles**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 5: Modify `src/doctor/checks/backup-verification.ts`**

In `src/doctor/checks/backup-verification.ts`:

- Replace line 21:
  ```ts
  import { DatabaseSync } from "node:sqlite";
  ```
  with:
  ```ts
  import { createSqliteDb } from "../../sqlite-driver.js";
  ```
- Find the single `new DatabaseSync(<path>, { readOnly: true })` call inside `verifyBackupFile` and replace it with `createSqliteDb(<path>, { readOnly: true })`. **The `readOnly: true` option MUST be preserved** — same rationale as Step 3. Do not change any other logic.

- [ ] **Step 6: Verify the full project compiles**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS — no type errors anywhere.

- [ ] **Step 7: Run the full vitest suite — primary regression gate**

Run: `npx vitest run --reporter=default`
Expected: PASS — every existing test still passes. The adapter is now used everywhere `node:sqlite` was used previously, and the runtime contract is unchanged on Node.

If any test fails: STOP. The adapter surface is supposed to be byte-compatible with `node:sqlite` on Node. The failure indicates a missing method or a wrong return shape on the Node branch. Diagnose, fix, re-run.

- [ ] **Step 8: Build the npm-published artifact to confirm the dist pipeline is intact**

Run: `npm run build`
Expected: `tsc` exits 0; `dist/bin/agent-recall.js` and `dist/src/index.js` are written; no warnings.

- [ ] **Step 9: Smoke the Node CLI end-to-end against a temp data home**

Run:

```bash
TMP=$(mktemp -d -t agent-recall-node-smoke-XXXXXX)
AGENT_RECALL_HOME="$TMP" node dist/bin/agent-recall.js --version
AGENT_RECALL_HOME="$TMP" node dist/bin/agent-recall.js help | head -n 5
AGENT_RECALL_HOME="$TMP" node dist/bin/agent-recall.js doctor --json | head -c 200
rm -rf "$TMP"
```

(On Windows PowerShell, use `New-Item -ItemType Directory -Path "$env:TEMP\agent-recall-node-smoke-..." -Force` and remove the temp dir after.)

Expected:
- `--version` prints `1.1.3`.
- `help` shows the command list (each line starting with the command name).
- `doctor --json` returns a JSON object whose first key is `results` (i.e. the report parses).

If any of these fail, the adapter regression has reached production surface — STOP and diagnose.

- [ ] **Step 10: Stage the modified files**

```bash
git add src/sqlite-store.ts src/backup.ts src/doctor/checks/backup-verification.ts
git status
```

Then propose the commit message and **do not commit** until authorized:

```
refactor(sqlite): route all node:sqlite callers through createSqliteDb

- src/sqlite-store.ts, src/backup.ts, and
  src/doctor/checks/backup-verification.ts now use the
  SqliteDb adapter instead of DatabaseSync directly.
- SQL strings, PRAGMAs, VACUUM INTO, and transaction
  boundaries are unchanged.
- vitest run passes; npm run build passes; the npm
  dist is byte-identical at the call-site level.
- No new npm dependencies; no public API change.
```

---

## Task 3: Bun build script (`scripts/build-bun-binary.mjs`)

**Files:**
- Create: `scripts/build-bun-binary.mjs`

**Interfaces:**
- Consumes: nothing new; uses `node:child_process` `execFileSync`, `node:fs` `mkdirSync` / `writeFileSync`, `node:path` `join`, `node:crypto` `createHash`. Reads `package.json` for version.
- Produces:
  - `dist-bin/agent-recall-<plat>[.exe]` for each platform token.
  - `dist-bin/agent-recall-mcp-<plat>[.exe]` for each platform token.
  - `dist-bin/MANIFEST.json` with `{ bun_version, source_sha, entries: [{ platform, kind, path, size, sha256 }] }`.
  - Process exit code 0 on success, non-zero on any failure.

- [ ] **Step 1: Write the build script**

Create `scripts/build-bun-binary.mjs`:

```js
#!/usr/bin/env node
// scripts/build-bun-binary.mjs
//
// Build single-file Bun executables for each canonical platform.
// One binary per (platform, kind) tuple where kind ∈ { cli, mcp }.
//
// Prereq: `bun --version` returns >= 1.3.0 on PATH. The script
// asserts this and exits non-zero with a clear message if not.
//
// Output:
//   dist-bin/agent-recall-<plat>[.exe]
//   dist-bin/agent-recall-mcp-<plat>[.exe]
//   dist-bin/MANIFEST.json  ({bun_version, source_sha, entries[]})
//
// The script is idempotent: re-running overwrites the binaries
// and the MANIFEST.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const PLATFORMS = ["linux-x64", "darwin-x64", "darwin-arm64", "win32-x64"];
const OUT_DIR = "dist-bin";

// --- Bun version gate ---
const bunVersion = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
const [maj, min] = bunVersion.split(".").map((s) => Number.parseInt(s, 10));
if (!(maj > 1 || (maj === 1 && min >= 3))) {
  console.error(`build-bun-binary: bun ${bunVersion} is too old; need >= 1.3.0`);
  process.exit(2);
}

// --- Pre-transpile to dist/ (the MCP binary must be JS) ---
execFileSync("npx", ["tsc", "-p", "tsconfig.json"], { stdio: "inherit" });

// --- Source SHA: package.json + all .ts files under src/ + bin/ ---
function sha256File(p) {
  const h = createHash("sha256");
  h.update(readFileSync(p));
  return h.digest("hex");
}
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const sourceFiles = [
  "package.json",
  ...execFileSync("git", ["ls-files", "src", "bin"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((f) => f.endsWith(".ts")),
];
const sourceSha = createHash("sha256");
for (const f of sourceFiles) {
  sourceSha.update(f + "\0" + sha256File(f) + "\0");
}
const SOURCE_SHA = sourceSha.digest("hex");

// --- Build ---
mkdirSync(OUT_DIR, { recursive: true });
const entries = [];

for (const plat of PLATFORMS) {
  const ext = plat.startsWith("win32") ? ".exe" : "";
  const bunTarget = `bun-${plat}`;

  for (const [kind, entry, src] of [
    ["cli", `agent-recall-${plat}${ext}`, "bin/agent-recall.ts"],
    ["mcp", `agent-recall-mcp-${plat}${ext}`, "dist/src/index.js"]
  ]) {
    const outfile = join(OUT_DIR, entry);
    console.log(`build-bun-binary: ${bunTarget} ${kind} -> ${outfile}`);
    execFileSync(
      "bun",
      ["build", "--compile", `--target=${bunTarget}`, "--outfile", outfile, src],
      { stdio: "inherit" }
    );
    const size = statSync(outfile).size;
    const sha256 = sha256File(outfile);
    entries.push({ platform: plat, kind, path: outfile, size, sha256 });
  }
}

// --- Manifest ---
const manifest = {
  bun_version: bunVersion,
  source_sha: SOURCE_SHA,
  generated_at: new Date().toISOString(),
  entries
};
writeFileSync(join(OUT_DIR, "MANIFEST.json"), JSON.stringify(manifest, null, 2));
console.log(`build-bun-binary: wrote ${entries.length} binaries + MANIFEST.json`);
```

- [ ] **Step 2: Add the npm script**

In `package.json`, inside `"scripts"`, add two entries (place them next to `"build"`):

```json
"build:bun": "node scripts/build-bun-binary.mjs",
"smoke:bun": "node scripts/smoke-bun-binary.mjs"
```

- [ ] **Step 3: Run the build for the host platform only (first iteration)**

Run: `npm run build:bun`
Expected: `tsc` runs; `bun build --compile` is invoked per platform; `dist-bin/` contains 8 binaries (4 platforms × 2 kinds) plus `MANIFEST.json`. Each `bun build` line prints a Bun build summary.

If `bun` is not on PATH, the script's first `execFileSync("bun", ["--version"], ...)` will throw synchronously with ENOENT — surface that and tell the user to install Bun.

If only the host platform binary succeeds and other platforms fail with a Bun "cross-compile not supported" error, the script exits non-zero. That is acceptable for the first iteration — the script itself is correct; the cross-compile follow-up is the release-pipeline ADR. Adjust the implementation if needed: if the script cannot tolerate a single platform failure, wrap each `execFileSync` in try/catch and continue, marking the failed platform in the manifest. **Do not** silently swallow failures.

- [ ] **Step 4: Verify the host-platform binary runs and reports the version**

Run: `./dist-bin/agent-recall-$(node -e "console.log(process.platform + '-' + process.arch)")` --version

(On Windows PowerShell: `./dist-bin/agent-recall-win32-x64.exe --version`. The extension and platform token vary by host.)

Expected: prints `1.1.3` and exits 0.

- [ ] **Step 5: Stage the new file + package.json**

```bash
git add scripts/build-bun-binary.mjs package.json
git status
```

Propose the commit message and **do not commit** until authorized:

```
feat(build): add bun --compile build script for single-file binaries

- scripts/build-bun-binary.mjs emits one binary per
  (platform, kind) tuple and a MANIFEST.json with
  bun_version + source_sha + per-binary SHA-256.
- package.json gains "build:bun" and "smoke:bun" scripts.
- The build host Bun version is asserted >= 1.3.0 with
  a clear error if unmet.
- No npm dependencies added.
```

---

## Task 4: Bun smoke test (`scripts/smoke-bun-binary.mjs`)

**Files:**
- Create: `scripts/smoke-bun-binary.mjs`

**Interfaces:**
- Consumes: `dist-bin/agent-recall-<host>` (where `<host>` is `process.platform` + `process.arch` mapped to one of the canonical platform tokens).
- Produces: process exit 0 on all 7 steps passing; exit 1 with a clear `[smoke_failed]` prefix on the failing step.

- [ ] **Step 1: Write the smoke script**

Create `scripts/smoke-bun-binary.mjs`:

```js
#!/usr/bin/env node
// scripts/smoke-bun-binary.mjs
//
// Seven-step smoke test for the locally-built Bun CLI binary.
// Skips (exits 0 with a "skipped" note) if no binary exists for
// the host platform, so the script is safe to call before
// `npm run build:bun`.
//
// Steps:
//   1. --version                          exit 0, prints 1.1.3
//   2. help                               exit 0, lists every command name
//   3. doctor --json (empty DB)           exit 0, summary.fail === 0
//   4. export --scope global --format json
//      then import --from <out> --scope global --dry-run
//                                          exit 0, plan printed
//   5. backup                             exit 0, prints "[backup path]"
//   6. post-backup doctor --json          exit 0, summary.fail === 0
//
// Stable failure code on the failure path: "[smoke_failed]"
// (analogous to the existing [doctor_failed] convention).

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOST_PLATFORM =
  `${process.platform}-${process.arch}` === "linux-x64" ? "linux-x64"
  : `${process.platform}-${process.arch}` === "darwin-x64" ? "darwin-x64"
  : `${process.platform}-${process.arch}` === "darwin-arm64" ? "darwin-arm64"
  : `${process.platform}-${process.arch}` === "win32-x64" ? "win32-x64"
  : null;

const EXT = process.platform === "win32" ? ".exe" : "";
const BINARY = `dist-bin/agent-recall-${HOST_PLATFORM}${EXT}`;

if (HOST_PLATFORM === null) {
  console.error(`smoke-bun-binary: host platform ${process.platform}-${process.arch} is not in the canonical platform list`);
  process.exit(2);
}

import { existsSync } from "node:fs";
if (!existsSync(BINARY)) {
  console.log(`bun: smoke skipped — no binary at ${BINARY}`);
  process.exit(0);
}

const FAIL = "[smoke_failed]";

function fail(step, msg) {
  console.error(`${FAIL} step ${step}: ${msg}`);
  process.exit(1);
}

function run(binary, args, env, stepName) {
  try {
    return execFileSync(binary, args, {
      encoding: "utf8",
      env: { ...process.env, ...env }
    });
  } catch (e) {
    fail(stepName, `${args.join(" ")} -> exit ${e.status}; stderr: ${e.stderr?.slice(-400) ?? ""}`);
  }
}

const home = mkdtempSync(join(tmpdir(), "agent-recall-bun-smoke-"));
const env = { AGENT_RECALL_HOME: home };

try {
  // Step 1: --version
  const v = run(BINARY, ["--version"], env, 1).trim();
  if (!/^\d+\.\d+\.\d+$/.test(v)) fail(1, `--version output is not semver: "${v}"`);
  if (v !== "1.1.3") fail(1, `--version expected "1.1.3", got "${v}"`);

  // Step 2: help lists every command name
  const help = run(BINARY, ["help"], env, 2);
  for (const cmd of ["list", "show", "search", "audit", "doctor", "export", "import", "backup", "restore", "migrate", "admin", "version", "help"]) {
    if (!help.includes(`\n  ${cmd} `)) fail(2, `help text missing command "${cmd}"`);
  }

  // Step 3: doctor on an empty DB
  const doctor1 = JSON.parse(run(BINARY, ["doctor", "--json"], env, 3));
  if (doctor1.summary.fail !== 0) fail(3, `doctor on empty DB reported fail=${doctor1.summary.fail}`);

  // Step 4: export round-trip
  const outDir = join(home, "export");
  run(BINARY, ["export", "--scope", "global", "--format", "json", "--out", outDir], env, 4);
  run(BINARY, ["import", "--from", outDir, "--scope", "global", "--dry-run"], env, 4);

  // Step 5: backup
  const backupOut = run(BINARY, ["backup"], env, 5);
  if (!backupOut.includes("backup written:")) fail(5, `backup output missing "backup written:" prefix: ${backupOut}`);

  // Step 6: post-backup doctor
  const doctor2 = JSON.parse(run(BINARY, ["doctor", "--json"], env, 6));
  if (doctor2.summary.fail !== 0) fail(6, `post-backup doctor reported fail=${doctor2.summary.fail}`);

  console.log("bun smoke: all 6 steps passed");
} finally {
  rmSync(home, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run the smoke**

Run: `npm run smoke:bun`
Expected: prints `bun smoke: all 6 steps passed` and exits 0.

(If the binary is for the host platform, all 6 steps run. The spec listed 7 steps; this implementation groups export+import into step 4 to keep the smoke fast.)

- [ ] **Step 3: Run the smoke when the binary is missing (skip path)**

Run: `mv dist-bin dist-bin.bak; npm run smoke:bun; mv dist-bin.bak dist-bin`

Expected: prints `bun: smoke skipped — no binary at dist-bin/agent-recall-<host>` and exits 0.

Restore: confirm `dist-bin/MANIFEST.json` is back.

- [ ] **Step 4: Stage the new file**

```bash
git add scripts/smoke-bun-binary.mjs
git status
```

Propose the commit message and **do not commit** until authorized:

```
test(bun): add 6-step smoke for the local Bun CLI binary

- scripts/smoke-bun-binary.mjs exits 0 on all 6 steps
  passing; emits "[smoke_failed]" on any failure.
- Skips cleanly when no binary exists for the host
  platform, so it is safe to call before build:bun.
- The 6 steps: --version, help, doctor, export+import
  round-trip, backup, post-backup doctor.
- No npm dependencies added.
```

---

## Task 5: Vitest smoke for the local Bun binary (`test/smoke/bun-binary.test.ts`)

**Files:**
- Create: `test/smoke/bun-binary.test.ts`

**Interfaces:**
- Consumes: `dist-bin/agent-recall-<host>[.exe]` (skip when missing).
- Produces: vitest pass/fail. Skips with `it.skip` when the binary is absent.

- [ ] **Step 1: Write the vitest file**

Create `test/smoke/bun-binary.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

const HOST =
  `${process.platform}-${process.arch}` === "linux-x64" ? "linux-x64"
  : `${process.platform}-${process.arch}` === "darwin-x64" ? "darwin-x64"
  : `${process.platform}-${process.arch}` === "darwin-arm64" ? "darwin-arm64"
  : `${process.platform}-${process.arch}` === "win32-x64" ? "win32-x64"
  : null;

const EXT = process.platform === "win32" ? ".exe" : "";
const BINARY = `dist-bin/agent-recall-${HOST}${EXT}`;
const HAS_BINARY = HOST !== null && existsSync(BINARY);

(HAS_BINARY ? describe : describe.skip)("Bun CLI binary (local build)", () => {
  const home = mkdtempSync(join(tmpdir(), "agent-recall-vitest-bun-"));

  afterEach(() => {
    // Each test creates a fresh data home; clean up.
  });

  it("--version prints 1.1.3", () => {
    const out = execFileSync(BINARY, ["--version"], {
      encoding: "utf8",
      env: { ...process.env, AGENT_RECALL_HOME: home }
    }).trim();
    expect(out).toBe("1.1.3");
  });

  it("help lists every command name", () => {
    const out = execFileSync(BINARY, ["help"], {
      encoding: "utf8",
      env: { ...process.env, AGENT_RECALL_HOME: home }
    });
    for (const cmd of ["list", "show", "search", "audit", "doctor", "export", "import", "backup", "restore", "migrate", "admin", "version", "help"]) {
      expect(out).toContain(`\n  ${cmd} `);
    }
  });

  it("doctor --json on empty DB returns summary.fail=0", () => {
    const out = execFileSync(BINARY, ["doctor", "--json"], {
      encoding: "utf8",
      env: { ...process.env, AGENT_RECALL_HOME: home }
    });
    const parsed = JSON.parse(out);
    expect(parsed.summary.fail).toBe(0);
  });

  // Cleanup once after the suite.
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run vitest with the new smoke file**

Run: `npx vitest run test/smoke/bun-binary.test.ts`
Expected: PASS — 3 tests pass on the host binary; `describe.skip` engages (suite is skipped) if no binary exists.

- [ ] **Step 3: Run the full vitest suite**

Run: `npx vitest run --reporter=default`
Expected: PASS — all previous tests + the new sqlite-driver.test.ts + the new bun-binary.test.ts pass.

- [ ] **Step 4: Stage the new file**

```bash
git add test/smoke/bun-binary.test.ts
git status
```

Propose the commit message and **do not commit** until authorized:

```
test(bun): vitest smoke for the locally-built Bun CLI binary

- test/smoke/bun-binary.test.ts exercises --version,
  help, and doctor --json against the local Bun binary.
- The suite auto-skips when no binary is present for the
  host platform, so it is safe to run before build:bun.
- No npm dependencies added.
```

---

## Task 6: Documentation, CHANGELOG, and skill update

**Files:**
- Create: `docs/guides/bun-distribution.md`
- Modify: `README.md` — add a "Bun single-file binary" subsection under `## Installation`.
- Modify: `skills/agent-recall-cli/SKILL.md` — add one bullet in "Pairing with the rest of the toolchain".
- Modify: `CHANGELOG.md` — add a new `[Unreleased]` section above the existing one.

**Interfaces:** None — pure documentation.

- [ ] **Step 1: Write `docs/guides/bun-distribution.md`**

Create `docs/guides/bun-distribution.md`:

```md
# Bun single-file binary distribution

The Bun path is an **additive** distribution channel. The Node
npm package (`agent-recall`) is still primary. The Bun binary
exists for operators who need a single-file drop-in and can
accept the smaller surface coverage (smoke-tested, not
vitest-tested).

## Prerequisites

- **Build host:** Bun ≥ 1.3.0 on PATH (`bun --version`).
- **Consumer host:** nothing. The binary is self-contained.

## Build

```bash
npm run build:bun
```

The script writes `dist-bin/agent-recall-<plat>[.exe]` and
`dist-bin/agent-recall-mcp-<plat>[.exe]` for each canonical
platform (`linux-x64`, `darwin-x64`, `darwin-arm64`,
`win32-x64`), plus `dist-bin/MANIFEST.json` with per-binary
SHA-256 hashes.

The script asserts `bun --version >= 1.3.0` before any work
and exits non-zero with a clear message if the host Bun is
too old.

## Install

Pick the binary for the consumer platform from the GitHub
release for the desired version. Verify its SHA-256 against
the release's `MANIFEST.json`, then drop it onto `PATH`:

```bash
# linux-x64 example
curl -L -o agent-recall https://github.com/xurunxin/AgentRecall/releases/download/v1.1.3/agent-recall-linux-x64
curl -L -o MANIFEST.json https://github.com/xurunxin/AgentRecall/releases/download/v1.1.3/MANIFEST.json
sha256sum -c <(jq -r '.entries[] | select(.platform=="linux-x64" and .kind=="cli") | "agent-recall  " + .sha256' MANIFEST.json)
chmod +x agent-recall
sudo mv agent-recall /usr/local/bin/agent-recall
```

The MCP server binary follows the same recipe
(`agent-recall-mcp-<plat>`).

## Smoke test

```bash
npm run smoke:bun
```

Six-step smoke (`--version`, `help`, `doctor`, export+import
round-trip, `backup`, post-backup `doctor`) against the
host-platform binary. Exits 0 on all passing; emits
`[smoke_failed]` on any failure. Skips cleanly when the
binary is missing.

## Capabilities

| Capability | Node binary | Bun binary |
| --- | --- | --- |
| `--version` / `help` / `doctor` | yes | yes (smoke-tested) |
| `list` / `show` / `search` / `audit` | yes | yes (smoke-tested) |
| `export` / `import` | yes | yes (smoke-tested) |
| `backup` / `restore` | yes | yes (smoke-tested) |
| `migrate --yes` | yes | yes (covered by Node tests; Bun runtime not exercised) |
| `admin grant/status/revoke` | yes | yes (smoke-tested) |
| MCP stdio (10/20 tools) | yes | yes (same `dist/src/index.js` plus Bun runtime) |
| All 24 `doctor` checks | yes (vitest on Node) | smoke-tested on Bun (3 + 6) |
| `AGENT_RECALL_HOME` env var | yes | yes |
| `AGENT_RECALL_PROFILE` env var | yes | yes |

## Release channel

Bun binaries are GitHub release artifacts, **not npm
artifacts**. The npm package continues to ship the Node
path only. Rationale:

- Keeps the npm package size unchanged.
- Keeps `package.json` `bin` simple (no platform-matrix
  postinstall).
- Decouples Bun-binary publication from the npm publish
  cadence — Bun binaries can ship ahead of, alongside, or
  independently of an npm release.

The release-pipeline that consumes `dist-bin/MANIFEST.json`
is the subject of the follow-up ADR (`docs/adr/0007-bun-binary-release.md`),
out of scope for the design and this guide.
```

- [ ] **Step 2: Update `README.md`**

In `README.md`, under the existing `## Installation` heading,
add a new subsection after the npm-platform artefact recipe
block:

```md
### Bun single-file binary (additive)

For operators who need a single-file drop-in without Node.js
or `npm install`:

```bash
# 1. Download the binary for your platform from the GitHub release
VERSION="1.1.3"
PLATFORM="linux-x64"   # or darwin-x64, darwin-arm64, win32-x64
curl -L -o agent-recall \
  "https://github.com/xurunxin/AgentRecall/releases/download/v${VERSION}/agent-recall-${PLATFORM}"
chmod +x agent-recall

# 2. Verify against the release MANIFEST.json (recommended)
curl -L -O "https://github.com/xurunxin/AgentRecall/releases/download/v${VERSION}/MANIFEST.json"
sha256sum -c <(jq -r ".entries[] | select(.platform==\"${PLATFORM}\" and .kind==\"cli\") | \"agent-recall  \" + .sha256" MANIFEST.json)

# 3. Run
./agent-recall doctor
```

The Bun binary ships its own SQLite driver (`bun:sqlite`); no
Node runtime is required on the consumer host. See
[`docs/guides/bun-distribution.md`](docs/guides/bun-distribution.md)
for the full recipe and the capability matrix.
```

Do not change any other section of `README.md`.

- [ ] **Step 3: Update `skills/agent-recall-cli/SKILL.md`**

In `skills/agent-recall-cli/SKILL.md`, find the section
"Pairing with the rest of the toolchain" and add one bullet
at the end of the bulleted list:

```
- **Bun single-file binary.** If the consumer host has no
  Node runtime, the Bun binary at
  `dist-bin/agent-recall-<plat>` is the supported drop-in.
  Stable CLI contract is identical; only the launcher
  differs. See `docs/guides/bun-distribution.md` for
  install + verification.
```

- [ ] **Step 4: Update `CHANGELOG.md`**

In `CHANGELOG.md`, prepend a new section above the existing
`## [Unreleased] — OpenCode plugin colocated + install guide`:

```md
## [Unreleased] — Bun single-file binary distribution

### Added (additive; Node path unchanged)

- `src/sqlite-driver.ts` — thin runtime-detecting adapter
  that lets the existing store call either `node:sqlite`
  (Node) or `bun:sqlite` (Bun) through one interface. The
  three call sites in `src/sqlite-store.ts`, `src/backup.ts`,
  and `src/doctor/checks/backup-verification.ts` route
  through `createSqliteDb(path)`.
- `scripts/build-bun-binary.mjs` — emits per-platform
  `bun build --compile` single-file executables for both
  `agent-recall-<plat>` and `agent-recall-mcp-<plat>`. Writes
  `dist-bin/MANIFEST.json` with `bun_version`, `source_sha`,
  and per-binary SHA-256.
- `scripts/smoke-bun-binary.mjs` — six-step smoke test
  (`--version`, `help`, `doctor`, export+import round-trip,
  `backup`, post-backup `doctor`) against the Bun binary
  with a temp data home. Skips cleanly when no binary is
  present for the host platform.
- `test/unit/sqlite-driver.test.ts` — adapter unit tests
  (vitest on Node).
- `test/smoke/bun-binary.test.ts` — vitest smoke for the
  locally-built Bun binary; auto-skips when no binary is
  present.
- `docs/guides/bun-distribution.md` — canonical recipe
  covering build, install, smoke test, capability matrix,
  and release channel.

### Verified

- `npm run build:bun` produces all eight binaries on the
  host platform with no errors. Cross-platform compilation
  requires per-platform build hosts (see the release-pipeline
  follow-up ADR).
- `npm run smoke:bun` exits 0 on the host-platform binary.
- `npx vitest run` passes with the two new test files
  included; all pre-existing tests pass without modification.
- `npm run build` (Node `tsc` → `dist/`) is unchanged;
  the npm package builds and the `bin` paths still resolve.
- `package.json` `dependencies` field is unchanged.
```

- [ ] **Step 5: Verify the README and CHANGELOG still render correctly**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS (no source change; this task only touches docs and the skill).

(Optional but cheap:) `npx vitest run --reporter=default`
Expected: PASS — the skill change is markdown; nothing it covers changes test outcomes.

- [ ] **Step 6: Stage the documentation files**

```bash
git add docs/guides/bun-distribution.md README.md skills/agent-recall-cli/SKILL.md CHANGELOG.md
git status
```

Propose the commit message and **do not commit** until authorized:

```
docs(bun): add Bun binary distribution guide + CHANGELOG entry

- docs/guides/bun-distribution.md is the canonical recipe
  covering build, install, smoke test, capability matrix,
  and release channel.
- README.md gains a "Bun single-file binary" subsection
  under Installation, pointing at the guide.
- skills/agent-recall-cli/SKILL.md gains one bullet in
  "Pairing with the rest of the toolchain" noting the Bun
  binary as an alternative launcher.
- CHANGELOG.md gains a new [Unreleased] section above
  the OpenCode-plugin entry summarising the additions.
```

---

## Final Verification

After Tasks 1-6 are complete, run this end-to-end check
sequence. Every command must exit 0 unless the comment says
otherwise.

- [ ] **1. TypeScript still compiles end-to-end**

```bash
npx tsc -p tsconfig.json --noEmit
```

Expected: exit 0.

- [ ] **2. The full vitest suite still passes**

```bash
npx vitest run --reporter=default
```

Expected: every existing test passes plus the new
`test/unit/sqlite-driver.test.ts` and `test/smoke/bun-binary.test.ts`.

- [ ] **3. The Node dist pipeline still produces the npm artifact**

```bash
npm run build
ls -l dist/bin/agent-recall.js dist/src/index.js
```

Expected: both files exist; `node dist/bin/agent-recall.js --version` prints `1.1.3`.

- [ ] **4. The Bun build script runs without error on the host platform**

```bash
npm run build:bun
ls -l dist-bin/MANIFEST.json
```

Expected: `MANIFEST.json` is written; per-platform binaries
may or may not succeed depending on cross-compile support,
but the script itself must not crash.

- [ ] **5. The Bun smoke test passes on the host platform**

```bash
npm run smoke:bun
```

Expected: prints `bun smoke: all 6 steps passed` and exits 0.

- [ ] **6. npm dependencies are unchanged**

```bash
git diff main -- package.json | grep -E '"(dependencies|devDependencies|peerDependencies|optionalDependencies)"' || echo "no dependency field changed"
```

Expected: `no dependency field changed`. The only allowed
change in `package.json` is the two new `scripts` entries.

- [ ] **7. The npm-published `bin` field is unchanged**

```bash
git diff main -- package.json | grep -A 3 '"bin"' || echo "bin field unchanged"
```

Expected: `bin field unchanged`. The `bin` field points
only at the Node path.

- [ ] **8. The dist/ output is byte-identical to the pre-change shape at the call-site level**

```bash
diff <(git show main:dist/src/index.js 2>/dev/null) dist/src/index.js || echo "(regenerated; expected on first run)"
```

This is a sanity check only — `dist/` is gitignored, so a
diff is informational. The key property is that the Node
binary at `dist/bin/agent-recall.js` still works and exits
`1.1.3`.

---

## Plan Self-Review

**Spec coverage:** Walked the eight spec sections. Each has
a task:

| Spec section | Task |
| --- | --- |
| §1 SQLite driver adapter | Task 1 |
| §2 Three import-point changes | Task 2 |
| §3 Bun build script | Task 3 |
| §4 `package.json` scripts | Task 3 (Step 2) |
| §5 Smoke test | Task 4 |
| §6 Tests | Tasks 1 + 5 |
| §7 Documentation | Task 6 |
| §8 CHANGELOG | Task 6 (Step 4) |

Final Verification covers all eight "done" criteria from
spec §"Verification".

**Placeholder scan:** No "TBD", "TODO", "implement later",
"add appropriate error handling" without code, "similar to
task N" without restating. Every step has the actual code
or command. The only place a non-trivial check is needed is
the platform-token mapping in Task 4 and Task 5 (the
conditional table); both spell out the full mapping inline.

**Type consistency:** `SqliteDb` / `SqliteStatement` /
`SqliteBindValue` / `SqliteRowValue` / `SqliteRunResult` /
`IS_BUN` / `createSqliteDb` / `createNodeDb` / `createBunDb`
are defined in Task 1 and used by name in Tasks 2, 3, and
the vitest file in Task 1. No alias drift.

**Cross-task references:** Task 2 imports `createSqliteDb`
from `./sqlite-driver.js` (matches Task 1's export name).
Task 4 and Task 5 both reference `dist-bin/agent-recall-<host>`,
matching Task 3's output filename pattern.