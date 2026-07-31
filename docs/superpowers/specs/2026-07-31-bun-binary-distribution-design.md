# Bun single-file binary distribution

Date: 2026-07-31
Branch: `feat/bun-binary-distribution`
Predecessor: `main` (v1.1.3, commit `@1.1.3`)

## Why

AgentRecall v1.1.3 ships two binaries through an npm package
whose runtime contract is "Node.js 24+ with the bundled
`dist/`". The dependency is small (no native modules — the
project uses Node's built-in `node:sqlite`) but the **installer
shape** is heavy for the common case:

- A consumer downloads the tarball, runs `npm install`, then
  either keeps `node_modules` around or shells out via `npx`.
- On air-gapped machines without `npm` registry access, the
  npm tarball cannot be installed at all (the package ships
  `dist/` but not `node_modules`).
- On locked-down machines where the operator is allowed to
  drop a single executable into `~/.local/bin` but not run
  `npm install`, there is no path forward.

A Bun-compiled single-file executable addresses all three
cases:

- No Node.js runtime requirement (Bun's `--compile` output is
  a self-contained binary; the consumer does not need Bun
  installed either — the binary bundles the runtime).
- No `npm install` step (the binary ships its own
  `node_modules`-equivalent code paths).
- One file per platform (`agent-recall-linux-x64`,
  `agent-recall-darwin-arm64`, `agent-recall-win32-x64.exe`),
  installable by `curl | sha256sum -c` + `chmod +x` + move to
  `PATH`.

The change is **additive**. The Node distribution stays
primary; the Bun binary is a parallel channel for operators
who need a single-file drop-in. There is no plan to remove
the Node path; it remains the npm-published, vitest-tested,
release-evidence-verified surface.

## What this design ships

### 1. SQLite driver adapter (`src/sqlite-driver.ts`, new)

A thin runtime-detecting factory that lets the existing store
code call either `node:sqlite` (when running under Node) or
`bun:sqlite` (when running under Bun) through one interface.

```ts
// src/sqlite-driver.ts

const IS_BUN = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

export type SqliteBindValue = unknown;
export type SqliteRowValue = unknown;

export interface SqliteStatement {
  run(...params: SqliteBindValue[]): {
    changes: number;
    lastInsertRowid: number | bigint;
  };
  get<T = SqliteRowValue>(...params: SqliteBindValue[]): T | undefined;
  all<T = SqliteRowValue>(...params: SqliteBindValue[]): T[];
  values(...params: SqliteBindValue[]): unknown[][];
}

export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export function createSqliteDb(path: string): SqliteDb {
  return IS_BUN ? createBunDb(path) : createNodeDb(path);
}
```

Backend implementations:

- `createNodeDb(path)` — `new (require("node:sqlite").DatabaseSync)(path)`
  wrapped to satisfy `SqliteDb`. The wrapper is a thin `class`
  with a `prepare` method that returns a `class` wrapping the
  raw `StatementSync`.
- `createBunDb(path)` — `new (require("bun:sqlite").Database)(path)`
  wrapped identically.

Both wrappers preserve the `.prepare(...).get<T>() /
.all<T>()` generic shape so call sites can keep their existing
`as Array<{ name: string }>` casts without change.

No new npm dependency. `bun:sqlite` and `node:sqlite` are
runtime built-ins; the adapter imports them via conditional
`require`/`import` so each runtime only loads its own backend.

### 2. Three import-point changes (no behaviour change)

Replace the `node:sqlite` imports and `DatabaseSync`
constructor calls in:

- `src/sqlite-store.ts` — line 3 (import), all `new
  SQLiteMemoryStore(...)` callers get a `new
  SQLiteMemoryStore(...)` whose constructor internally calls
  `createSqliteDb(path)`. The `DatabaseSync` type only appears
  in the constructor of `SQLiteMemoryStore`; the rest of the
  file talks to the raw `this.db` via duck typing. We change
  `this.db: ReturnType<typeof createSqliteDb>` and propagate
  through `this.db.exec / .prepare / .close`.
- `src/backup.ts` — line 24 (import), one `new DatabaseSync`
  call in `runBackup`. Swap to `createSqliteDb`. This is the
  only direct `node:sqlite` user in `backup.ts`; the rest of
  the file delegates to `ctx.store.backupHandle()`.
- `src/doctor/checks/backup-verification.ts` — line 21
  (import), one `new DatabaseSync` call in
  `verifyBackupFile`. Swap to `createSqliteDb`.

`SQLInputValue` / `SQLOutputValue` type imports in those
files become `SqliteBindValue` / `SqliteRowValue`. The
generic casts (`.all() as Array<{...}>`) are preserved
verbatim.

### 3. Bun build script (`scripts/build-bun-binary.mjs`, new)

A Node-runnable script that produces one single-file
executable per platform token. Bun's `--compile` requires the
target Bun to match (or near-match) the host platform; the
script documents this constraint in its header and emits a
per-platform manifest.

Targets (matching the existing release vocabulary in
`docs/adr/0003-extracted-artifact-lifecycle.md`):

| Platform token | Bun compile target | Output filename |
| --- | --- | --- |
| `linux-x64` | `bun-linux-x64` | `dist-bin/agent-recall-linux-x64` |
| `darwin-x64` | `bun-darwin-x64` | `dist-bin/agent-recall-darwin-x64` |
| `darwin-arm64` | `bun-darwin-arm64` | `dist-bin/agent-recall-darwin-arm64` |
| `win32-x64` | `bun-windows-x64` | `dist-bin/agent-recall-win32-x64.exe` |

Two binaries per platform:

1. `agent-recall-<plat>` — built from `bin/agent-recall.ts`
   (CLI).
2. `agent-recall-mcp-<plat>` — built from `dist/src/index.js`
   (MCP stdio server). The build script first runs `tsc` to
   produce `dist/`, then `bun build --compile` on the JS
   output. Running `bun build --compile` on `.ts` directly
   works but produces a bundle that re-parses TS at startup
   on Bun < 1.2; on Bun 1.3+ we still pre-transpile for
   consistency with the npm-published path.

Script structure:

```js
// scripts/build-bun-binary.mjs (sketch)
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const PLATFORMS = ["linux-x64", "darwin-x64", "darwin-arm64", "win32-x64"];
const OUT_DIR = "dist-bin";
mkdirSync(OUT_DIR, { recursive: true });

for (const plat of PLATFORMS) {
  execFileSync("tsc", ["-p", "tsconfig.json"], { stdio: "inherit" });
  execFileSync(
    "bun",
    [
      "build",
      "--compile",
      `--target=bun-${plat}`,
      "--outfile",
      join(OUT_DIR, `agent-recall-${plat}${plat.startsWith("win32") ? ".exe" : ""}`),
      "bin/agent-recall.ts"
    ],
    { stdio: "inherit" }
  );
  execFileSync(
    "bun",
    [
      "build",
      "--compile",
      `--target=bun-${plat}`,
      "--outfile",
      join(OUT_DIR, `agent-recall-mcp-${plat}${plat.startsWith("win32") ? ".exe" : ""}`),
      "dist/src/index.js"
    ],
    { stdio: "inherit" }
  );
}
```

The script writes `dist-bin/MANIFEST.json` with the Bun
version, source SHA, per-binary size + Bun version + target
triple, and a SHA-256 for each binary. This is the same shape
as the Node-side release evidence for the packaged tarball.

### 4. `package.json` scripts (additive, no `bin` change)

```json
{
  "scripts": {
    "build:bun": "node scripts/build-bun-binary.mjs",
    "smoke:bun": "node scripts/smoke-bun-binary.mjs"
  }
}
```

`bin` is unchanged. The npm package continues to publish the
Node path. Bun binaries are release artifacts, not npm
artifacts (see `docs/guides/bun-distribution.md` §"Release
channel").

### 5. Smoke test (`scripts/smoke-bun-binary.mjs`, new)

Runs the locally-built Bun binary against a temp data home
and asserts the same exit-code / stable-error-code contract
the Node CLI enforces:

| Step | Invocation | Expected |
| --- | --- | --- |
| 1 | `agent-recall-linux-x64 --version` | exit 0, prints `1.1.3` |
| 2 | `agent-recall-linux-x64 help` | exit 0, contains every command name from `src/cli/index.ts` HELP_TEXT |
| 3 | `agent-recall-linux-x64 doctor --json` (temp `AGENT_RECALL_HOME`) | exit 0, `summary.fail === 0` |
| 4 | `agent-recall-linux-x64 import --from <fixture> --scope global --dry-run` | exit 0, prints plan. `<fixture>` is a fresh export directory the smoke script generates by running step 5 first; if running step 4 standalone, the script can skip it with exit 0 + a "skipped" note. |
| 5 | `agent-recall-linux-x64 export --scope global --format json --out <tmp>` | exit 0, writes `<tmp>/manifest.json` |
| 6 | `agent-recall-linux-x64 backup` | exit 0, prints `[backup path]` |
| 7 | Re-run doctor on the post-backup DB | exit 0, `summary.fail === 0` |

The script locates the binary through `dist-bin/agent-recall-<host>`,
where `<host>` is the current `process.platform`+`process.arch`
mapped to the canonical platform tokens. If the binary does
not exist, the script exits 0 with a "skipped" message
(`bun: smoke skipped — no binary at dist-bin/agent-recall-<host>`)
so the smoke can run in CI before the build step without
hard-failing. The vitest unit test (see §6) provides the
fail-closed coverage on Node.

### 6. Tests

Two new test files, both vitest on Node:

**`test/unit/sqlite-driver.test.ts`** — adapter unit tests.

- `createSqliteDb` returns an object that satisfies
  `SqliteDb` under the Node runtime (the only runtime vitest
  exercises).
- A mocked `Bun` global (set via `vi.stubGlobal("Bun", {})`)
  flips the factory's branch into `createBunDb`. The
  implementation uses a module-level conditional
  `require("bun:sqlite")` inside `createBunDb` so under Node
  the branch throws `MODULE_NOT_FOUND`. The test mocks
  `createBunDb` directly (via `vi.spyOn` on the exported
  factory's branch selector, or by exposing `createBunDb` as
  a named export) and asserts the factory routes to the bun
  branch under the stub. The actual bun-types module is
  never loaded at test time.
- The wrapper around `node:sqlite`:
  - `prepare("SELECT 1").get()` returns `{ "1": 1 }`.
  - `prepare("SELECT ?").all<{x:number}>([42])` returns
    `[{x: 42}]`.
  - `prepare("INSERT ...").run()` returns
    `{ changes, lastInsertRowid }`.
- All four `.exec` / `.prepare` / `.run` / `.get` / `.all` /
  `.values` / `.close` paths return the documented shapes.

**`test/smoke/bun-binary.test.ts`** — vitest on Node that
spawns the locally-built Bun binary (if present) and asserts
step 1 and step 2 from §5. The other steps are covered by the
`scripts/smoke-bun-binary.mjs` script; the unit test stays
fast.

### 7. Documentation

Three documents gain new content; none loses old content.

**`docs/guides/bun-distribution.md`** (new) — the canonical
recipe for the Bun path:

- Prerequisites (Bun ≥ 1.3 on the build host; nothing on the
  consumer host).
- Build steps (`npm run build:bun`).
- Install steps (per-platform: download binary + `sha256sum -c`
  + `chmod +x` + move to `PATH`).
- Smoke test (`npm run smoke:bun`).
- Capability matrix vs the Node binary (what works, what does
  not — see §"Capabilities").
- Release channel explanation (Bun binaries are GitHub release
  artifacts, not npm artifacts; rationale: keeps the npm
  package lean and the npm-install path unchanged).

**`README.md`** — new "Bun single-file binary" subsection
under "Installation". One paragraph + a curl-style install
example for `linux-x64`. Links to `docs/guides/bun-distribution.md`.

**`skills/agent-recall-cli/SKILL.md`** — the "Pairing with the
rest of the toolchain" section gains a sub-bullet:

> If the consumer host has no Node runtime, the Bun
> single-file binary at `dist-bin/agent-recall-<plat>` is
> the supported drop-in. Stable CLI contract is identical;
> only the launcher differs.

### 8. CHANGELOG entry

A new top-level section in `CHANGELOG.md`:

```md
## [Unreleased] — Bun single-file binary distribution

### Added (additive; Node path unchanged)

- `src/sqlite-driver.ts` — thin runtime-detecting adapter
  that lets the existing store call either `node:sqlite`
  (Node) or `bun:sqlite` (Bun) through one interface.
- `scripts/build-bun-binary.mjs` — emits per-platform
  `bun build --compile` single-file executables for both
  `agent-recall-<plat>` and `agent-recall-mcp-<plat>`.
- `scripts/smoke-bun-binary.mjs` — 7-step smoke test that
  exercises `--version`, `help`, `doctor`, `import --dry-run`,
  `export`, `backup`, and post-backup `doctor` on the Bun
  binary against a temp data home.
- `test/unit/sqlite-driver.test.ts` — adapter unit tests
  (vitest on Node).
- `test/smoke/bun-binary.test.ts` — minimal vitest coverage
  of the locally-built Bun binary.
- `docs/guides/bun-distribution.md` — canonical recipe.
```

## What this design does NOT do

- **Replace the Node binary.** Node stays primary. Vitest
  stays on Node. The npm-published package is unchanged.
- **Migrate Vitest to Bun.** Test infrastructure stays on
  Node. The Bun path is verified through smoke tests + the
  adapter unit tests.
- **Define the Bun-binary release pipeline.** The
  `MANIFEST.json` shape is defined here; the GitHub Action
  that consumes it, the SHA-256 release-attachment workflow,
  and the cross-platform CI matrix are separate work
  (single follow-up ADR; tracked, not in this spec).
- **Cross-compile from a single host.** `bun build
  --compile --target=bun-darwin-arm64` from a `linux-x64`
  host requires either a Bun-supported cross-compile tool
  (current status: experimental) or a per-platform build
  host. The build script supports both; the CI matrix is
  the follow-up ADR's problem.
- **Change the existing MCP tool surface.** The Bun MCP
  binary is byte-for-byte the same JSON-RPC surface; tools,
  resources, profiles, capabilities are all unchanged.
- **Expose new public CLI commands.** The Bun path reuses
  the existing CLI dispatch table. `agent-recall --version`
  still prints `1.1.3`.

## Capabilities matrix (Node vs Bun path)

| Capability | Node binary | Bun binary |
| --- | --- | --- |
| `--version` / `help` / `doctor` | yes | yes (smoke-tested) |
| `list` / `show` / `search` / `audit` | yes | yes (smoke-tested) |
| `export` / `import` | yes | yes (smoke-tested) |
| `backup` / `restore` | yes | yes (smoke-tested) |
| `migrate --yes` | yes | yes (covered by Node tests; Bun runtime not exercised) |
| `admin grant/status/revoke` | yes | yes (smoke-tested) |
| MCP stdio (10/20 tools) | yes | yes (the Bun MCP binary is the same `dist/src/index.js` plus Bun runtime) |
| Profile-scoped admin capability | yes | yes |
| `AGENT_RECALL_HOME` env var | yes | yes |
| `AGENT_RECALL_PROFILE` env var | yes | yes |
| All 24 `doctor` checks | yes (vitest on Node) | smoke-tested on Bun (steps 3 + 7) |

## Risks and mitigations

1. **`bun:sqlite` PRAGMA defaults differ from `node:sqlite`.**
   Mitigation: the existing code sets
   `PRAGMA journal_mode = WAL`, `PRAGMA synchronous = NORMAL`,
   `PRAGMA busy_timeout = 5000`, `PRAGMA wal_autocheckpoint = 1000`
   explicitly in `SQLiteMemoryStore.open()`. Defaults are not
   relied upon.

2. **`VACUUM INTO` lock semantics differ between Node and
   Bun.** Both call into the same SQLite C library, so the
   SQL-level behavior is identical. Any difference would
   surface in the `backup` smoke step (step 6) — Bun's
   `VACUUM INTO` is exercised end-to-end against a temp DB.

3. **`DatabaseSync` vs `Database` option shapes.**
   `DatabaseSync(path)` and `Database(path)` both take a
   string path. The current code never passes options. If a
   future change does, the adapter's `createSqliteDb(path)`
   signature can grow options without changing call sites.

4. **TypeScript types for `bun:sqlite` (Bun's bundled
   types).** The adapter deliberately avoids importing
   bun-types. All statement handles are typed as
   `SqliteStatement` (our own interface) so `tsc` compiles
   the same source under both runtimes without type conflicts.
   Bun's runtime types are loaded at runtime via `require`,
   not at type-check time.

5. **Bun version drift.** Bun ≥ 1.3 is required for the
   `--compile` target flag combinations used here. The build
   script asserts the host Bun version (it exits non-zero if
   `< 1.3.0`). The README and `bun-distribution.md` document
   the minimum.

6. **MCP server stability under Bun.** Bun's Node-API
   compatibility is high but not perfect. The Bun MCP binary
   is built from already-transpiled `dist/src/index.js`, which
   uses Node's built-in modules (`node:fs`, `node:path`,
   `node:crypto`, `node:os`) and `@modelcontextprotocol/sdk`
   (a pure-JS package). Both are supported by Bun. If a Bun
   compatibility gap surfaces, the failure mode is the MCP
   binary failing to bind stdio at startup — caught by the
   MCP handshake smoke step (out of scope for this spec; the
   follow-up release pipeline spec should add it).

## Files touched (summary)

Added:

- `src/sqlite-driver.ts` (~80 lines)
- `scripts/build-bun-binary.mjs` (~80 lines)
- `scripts/smoke-bun-binary.mjs` (~120 lines)
- `test/unit/sqlite-driver.test.ts` (~60 lines)
- `test/smoke/bun-binary.test.ts` (~30 lines)
- `docs/guides/bun-distribution.md` (~150 lines)

Modified:

- `src/sqlite-store.ts` (3 lines: import + constructor type +
  `new DatabaseSync` → `createSqliteDb`)
- `src/backup.ts` (2 lines: import + `new DatabaseSync` →
  `createSqliteDb`)
- `src/doctor/checks/backup-verification.ts` (2 lines: import
  + `new DatabaseSync` → `createSqliteDb`)
- `package.json` (2 new scripts, no other change)
- `README.md` (one subsection in `## Installation`)
- `skills/agent-recall-cli/SKILL.md` (one bullet in "Pairing
  with the rest of the toolchain")
- `CHANGELOG.md` (one new top-level section)

Untouched:

- `dist/` build pipeline (Node-side `tsc` → `dist/`).
- All existing tests.
- The npm package manifest (`bin`, `files`, `dependencies`).
- The MCP tool surface, the profile-scoped admin capability,
  the identity-resolution modes, the sensitivity matrix.
- `docs/adr/*` (no ADR is opened for this design; the
  follow-up release-pipeline spec opens `0007-bun-binary-release.md`).

## Verification

After implementation, the spec's "done" criteria are:

1. `npm run build:bun` produces all eight binaries (4
   platforms × 2 binaries) without errors on a host Bun ≥
   1.3.
2. `npm run smoke:bun` exits 0 with all 7 steps passing on
   the host platform binary.
3. `npm test` (vitest on Node) passes with the two new test
   files included; all existing tests pass unchanged.
4. `npm run build` (tsc → dist/) still passes; the npm package
   still builds and the `package.json` `bin` paths still
   resolve.
5. The Node binary still exits `1.1.3` from
   `node dist/bin/agent-recall.js --version`.
6. The Bun binary exits `1.1.3` from
   `./dist-bin/agent-recall-linux-x64 --version`.
7. `node_modules` is unchanged (zero new dependencies).
8. The 6 new files + 7 modified files are the only diff
   against `main` on the `feat/bun-binary-distribution`
   branch.