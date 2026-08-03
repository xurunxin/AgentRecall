# Unified CLI and MCP Executable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify the Node/npm and Bun CLI and MCP executables behind one launcher while preserving the existing `agent-recall-mcp` compatibility entry point and updating the project-internal CLI SKILL documentation.

**Architecture:** A small `src/launcher.ts` reads `argv[0]` and any CLI arguments. It dispatches to the existing CLI implementation (`bin/agent-recall.ts`) when CLI arguments are present, and to the existing MCP entry point (`src/index.ts`) when `argv[0]` is the compatibility name `agent-recall-mcp` or when no CLI arguments are present. The launcher owns the dispatch decision only; CLI and MCP implementations remain unchanged. The Node/npm `bin` and the Bun build script both point at the launcher.

**Tech Stack:** TypeScript 5.x, Node 24, Bun 1.3+, tsx for source development, Vitest 3.x.

## Global Constraints

- Node.js ≥ 24.0.0 (from `package.json` `engines.node`).
- Zero new runtime dependencies; the launcher is a TypeScript file that re-exports the existing CLI and MCP entry points.
- The existing CLI and MCP entry points (`bin/agent-recall.ts` and `src/index.ts`) remain the canonical source of behaviour. The launcher is a thin dispatcher.
- `agent-recall-mcp` must keep working without changes to existing MCP client configurations.
- The Bun build script must continue emitting two artifact names (`agent-recall-<plat>` and `agent-recall-mcp-<plat>`); both must be built from the same launcher source.
- The MCP stdout contract is preserved: no ordinary diagnostics on stdout while in MCP mode.
- The CLI exits with the same status codes as today.
- Public CLI subcommand surface is unchanged.
- Documentation updates in this plan are limited to the SKILL files requested by the user: `skills/agent-recall-cli/SKILL.md` and `skills/README.md`. Do not modify other documentation in this plan.

---

### Task 1: Introduce the unified launcher

**Files:**
- Create: `src/launcher.ts`
- Test: `test/unit/launcher.test.ts`

**Interfaces:**
- Consumes: `process.argv[0]` (the invoked executable name) and `process.argv.slice(2)` (the remaining arguments).
- Produces: a single Node ESM entry that performs argv-based dispatch and either delegates to the CLI implementation (`bin/agent-recall.ts`) or starts the MCP stdio server.

- [ ] **Step 1: Write the failing test**

Add `test/unit/launcher.test.ts`:

```ts
import { describe, it, expect } from "vitest";

type DispatchOutcome = "cli" | "mcp" | "mcp-explicit";

interface DispatchRequest {
  argv0: string;
  args: string[];
}

export type Dispatcher = (req: DispatchRequest) => Promise<DispatchOutcome> | DispatchOutcome;

// The launcher exports `dispatch` for testability
// without booting the CLI or MCP servers. The
// production `main()` wraps `dispatch` with the
// real process argv. Tests call `dispatch`
// directly to keep the test in-process.
import { dispatch } from "../../src/launcher.js";

describe("launcher dispatch (v1.1.4 unified executable)", () => {
  it("routes `agent-recall` with no arguments to MCP", async () => {
    expect(await dispatch({ argv0: "agent-recall", args: [] })).toBe("mcp");
  });

  it("routes `agent-recall` with a CLI subcommand to the CLI", async () => {
    expect(
      await dispatch({ argv0: "agent-recall", args: ["doctor"] })
    ).toBe("cli");
  });

  it("routes `agent-recall` with CLI options to the CLI", async () => {
    expect(
      await dispatch({
        argv0: "agent-recall",
        args: ["admin", "status", "--json"]
      })
    ).toBe("cli");
  });

  it("routes `agent-recall-mcp` to MCP regardless of arguments", async () => {
    expect(
      await dispatch({ argv0: "agent-recall-mcp", args: [] })
    ).toBe("mcp");
  });

  it("routes a path-form `agent-recall-mcp` to MCP", async () => {
    expect(
      await dispatch({
        argv0: "C:\\bin\\agent-recall-mcp.exe",
        args: []
      })
    ).toBe("mcp");
  });

  it("ignores a single explicit `mcp` alias on the unified binary", async () => {
    expect(await dispatch({ argv0: "agent-recall", args: ["mcp"] })).toBe(
      "mcp-explicit"
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/launcher.test.ts`
Expected: FAIL with `Cannot find module '../../src/launcher.js'` (or equivalent missing-module error).

- [ ] **Step 3: Implement the launcher dispatcher**

Create `src/launcher.ts`:

```ts
// src/launcher.ts
//
// v1.1.4 unified CLI and MCP executable.
//
// Routes argv[0] + argv[1..] to either the CLI
// implementation (`bin/agent-recall.ts`) or the
// MCP stdio server (`src/index.ts`). The
// launcher is a thin dispatcher; CLI / MCP
// behaviour is owned by their existing
// modules.
//
// Dispatch contract (see
// `docs/superpowers/specs/2026-08-04-unified-cli-mcp-executable-design.md`):
//
//   - argv[0] basename matches `agent-recall-mcp`
//     → MCP, regardless of arguments
//   - argv[0] basename matches `agent-recall`:
//       - no args           → MCP
//       - args[0] === "mcp" → MCP (explicit alias)
//       - else              → CLI (forward args)
//   - anything else       → CLI (forward args)
//
// The CLI module exports `main(args, ctx)` so
// the launcher can drive it without spawning a
// child process. The MCP module exports
// `startServer()` that resolves with the
// process exit code once the stdio server
// shuts down.

import { basename } from "node:path";
import { main as runCli } from "../bin/agent-recall.js";
import { startServer as runMcpServer } from "./index.js";
import { resolveCommandContext } from "./cli/context.js";

export type DispatchOutcome = "cli" | "mcp" | "mcp-explicit";

export interface DispatchRequest {
  argv0: string;
  args: string[];
}

function basenameOf(value: string): string {
  // Strip a trailing `.exe` (Windows launcher
  // suffix) before the final path separator so
  // `agent-recall-mcp.exe` and
  // `C:\\bin\\agent-recall-mcp` both compare
  // equal to `agent-recall-mcp`.
  return basename(value).replace(/\.exe$/i, "");
}

function isCompatibilityName(name: string): boolean {
  return name === "agent-recall-mcp";
}

function isCanonicalName(name: string): boolean {
  return name === "agent-recall";
}

export function decideMode(argv0: string, args: string[]): DispatchOutcome {
  const base = basenameOf(argv0);
  if (isCompatibilityName(base)) return "mcp";
  if (isCanonicalName(base) && args.length === 0) return "mcp";
  if (isCanonicalName(base) && args[0] === "mcp") return "mcp-explicit";
  return "cli";
}

export async function dispatch(
  req: DispatchRequest
): Promise<DispatchOutcome> {
  const mode = decideMode(req.argv0, req.args);
  if (mode === "mcp") {
    await runMcpServer();
    return "mcp";
  }
  if (mode === "mcp-explicit") {
    await runMcpServer();
    return "mcp-explicit";
  }
  // CLI mode: forward every argument except the
  // optional `mcp` alias. The CLI parser expects
  // argv[2..]; we feed it `args` directly.
  const ctx = await resolveCommandContext();
  await runCli(req.args, ctx);
  return "cli";
}

// The production entry. Reads `process.argv`,
// resolves the dispatch decision, and exits with
// the underlying implementation's return code.
async function main(): Promise<void> {
  const argv0 = process.argv[0] ?? "";
  const args = process.argv.slice(2);
  await dispatch({ argv0, args });
}

// `bin/agent-recall.ts` is invoked with
// `process.argv` as `string[]`; the CLI parser
// runs the first element. When the launcher
// drives the CLI directly it must NOT pass
// `process.argv[0]` (the launcher path) as the
// command name. `runCli(args, ctx)` above
// accepts the args slice without a path prefix
// so this is safe.
main().catch((error) => {
  // The CLI prints structured errors; the MCP
  // server never reaches this branch. Surface
  // unhandled errors on stderr and exit 1.
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/launcher.test.ts`
Expected: PASS. The tests use `dispatch` directly and never call `main`, so the underlying `bin/agent-recall.ts` and `src/index.ts` imports are only resolved; they are not executed.

- [ ] **Step 5: Run typecheck to confirm the CLI / MCP exports exist**

Run: `npm run typecheck`
Expected: PASS. `bin/agent-recall.ts` must already export `main(args, ctx)`; `src/index.ts` must already export `startServer()`; `src/cli/context.ts` must already export `resolveCommandContext()`. If any export is missing, this step reports an error and the implementer must stop and add the missing export in a separate commit. Do NOT modify the CLI / MCP service internals in this plan; only the named exports are required.

- [ ] **Step 6: Commit**

```bash
git add src/launcher.ts test/unit/launcher.test.ts
git commit -m "feat(launcher): add unified CLI/MCP dispatch"
```

---

### Task 2: Switch the Node/npm `bin` entry points to the launcher

**Files:**
- Modify: `package.json` (replace the two `bin` entries)
- Test: `npm run build && node dist/src/launcher.js --version` (positive control)

**Interfaces:**
- Consumes: `process.argv` from a parent process (npm-installed consumers).
- Produces: the same observable behaviour the two binaries produced before this plan, with the dispatcher deciding CLI vs MCP mode at runtime.

- [ ] **Step 1: Update `package.json` `bin`**

Open `package.json` and set:

```json
"bin": {
  "agent-recall": "./dist/src/launcher.js",
  "agent-recall-mcp": "./dist/src/launcher.js"
}
```

Do not modify any other field. The Node `bin` machinery always invokes a bin file with `process.argv[0]` set to the bin path, so the launcher's basename check resolves the dispatcher correctly.

- [ ] **Step 2: Rebuild the dist tree**

Run: `npm run build`
Expected: `dist/src/launcher.js` exists alongside the existing `dist/src/index.js` and `dist/bin/agent-recall.js`. The `tsc` invocation emits the new launcher because the `tsconfig.json` already includes `src/**/*.ts`.

- [ ] **Step 3: Smoke-test the launcher in CLI mode**

Run: `node dist/src/launcher.js help`
Expected: the existing CLI help text (the same output `node dist/bin/agent-recall.js help` would have produced). The dispatcher routes the `help` argument to the CLI.

- [ ] **Step 4: Smoke-test the launcher in MCP mode via the canonical name**

Run: `node dist/src/launcher.js </dev/null` (or `node -e "process.stdin.destroy()" && node dist/src/launcher.js`).
Expected: the MCP server starts; it does NOT print the CLI help; it consumes the JSON-RPC stream and exits 0 when stdin closes. The dispatcher routes the empty args to MCP.

- [ ] **Step 5: Smoke-test the compatibility name path**

Run: `node -e "require('node:fs').symlinkSync('dist/src/launcher.js', 'dist/src/agent-recall-mcp.js')" && node dist/src/agent-recall-mcp.js </dev/null`
Expected: the MCP server starts (the launcher's `decideMode` matches the basename `agent-recall-mcp`).

Note: this step is a manual check, not a test. It can be skipped if the previous two steps succeed and the test in Task 1 already proves the dispatcher routes the compatibility name to MCP.

- [ ] **Step 6: Run the project default test suite to confirm no regression**

Run: `npx vitest run --pool=forks --poolOptions.forks.singleFork`
Expected: PASS (557/557). The launcher is a new file; it does not affect the unit / integration / blackbox suites.

- [ ] **Step 7: Commit**

```bash
git add package.json
git commit -m "chore(bin): point agent-recall and agent-recall-mcp at the launcher"
```

---

### Task 3: Build the Bun artifacts from the unified launcher

**Files:**
- Modify: `scripts/build-bun-binary.mjs`

**Interfaces:**
- Consumes: the two existing artifact names.
- Produces: both `agent-recall-<plat>` and `agent-recall-mcp-<plat>` artifacts, now compiled from `dist/src/launcher.js`. The manifest entries keep their existing `kind` values (`cli`, `mcp`) so the existing release verification does not change shape.

- [ ] **Step 1: Read the current build table**

Open `scripts/build-bun-binary.mjs` and locate the `[["cli", ...], ["mcp", ...]]` array inside the platform loop. The script compiles `bin/agent-recall.ts` for `kind: "cli"` and `dist/src/index.js` for `kind: "mcp"`. Confirm the current source paths before editing.

- [ ] **Step 2: Switch the `cli` source to the launcher**

Change the table entry to:

```js
const builds = [
  ["cli", `agent-recall-${plat}${ext}`, "dist/src/launcher.js"],
  ["mcp", `agent-recall-mcp-${plat}${ext}`, "dist/src/launcher.js"]
];
```

Both rows now point at the launcher. The manifest `kind` values stay `cli` and `mcp` so the existing release verifier does not need to change. Note: the `cli` artifact is built from the same launcher source as the `mcp` artifact; the difference is the invoked binary name. The dispatcher's basename check distinguishes them at runtime.

- [ ] **Step 3: Build the local Bun artifact**

Run: `npm run build:bun`
Expected: every host-platform `kind: "cli"` and `kind: "mcp"` entry reports `status: "ok"`. Per-platform cross-compile failures are tolerated as documented in the existing script. The manifest continues to include both artifact names.

- [ ] **Step 4: Smoke-test the Bun CLI artifact**

Run: `dist-bin/agent-recall-<host-platform> --version` (Windows: `dist-bin\agent-recall-<host-platform>.exe --version`).
Expected: the launcher routes `--version` to the CLI; the CLI prints the server version (`1.1.4`).

- [ ] **Step 5: Smoke-test the Bun MCP artifact via the compatibility name**

Run: `dist-bin/agent-recall-mcp-<host-platform> </dev/null`.
Expected: the launcher routes via the compatibility name to MCP; the server starts; stdin EOF closes the process with exit code 0.

- [ ] **Step 6: Run the Bun smoke suite**

Run: `npm run smoke:bun`.
Expected: the existing six-step smoke continues to pass. The smoke exercises the CLI artifact; the launcher routes its args to the CLI.

- [ ] **Step 7: Commit**

```bash
git add scripts/build-bun-binary.mjs
git commit -m "build(bun): compile both artifacts from the unified launcher"
```

---

### Task 4: Update the project-internal CLI SKILL documentation

**Files:**
- Modify: `skills/agent-recall-cli/SKILL.md`
- Modify: `skills/README.md`

**Interfaces:**
- Consumes: the unified executable behaviour produced by Tasks 1-3.
- Produces: internal-agent SKILL docs that describe the unified executable, the canonical vs. compatibility name routing, and the v1.1.4 behaviour. No other documentation in this repository is touched.

- [ ] **Step 1: Rewrite `skills/agent-recall-cli/SKILL.md` front matter and binary table**

The current file (read with `read_file`) has a binary table:

```
| `agent-recall` | CLI: ... |
| `agent-recall-mcp` | MCP stdio server (separate binary, not covered here). |
```

Replace it with:

```
| `agent-recall` | Unified executable. No arguments starts the MCP stdio server. Any subcommand runs the CLI. |
| `agent-recall-mcp` | Compatibility MCP entry point. Always starts the MCP stdio server. The CLI and this binary are now the same launcher. |
```

Also update the file's `## Invocation` section: the line "For the MCP server surface (10 read/write/plan tools per profile), reach for the MCP client config instead — the CLI does not cover MCP" stays valid; add a new sentence: "The `agent-recall` binary itself is a launcher: invoke `agent-recall` with no arguments when you want MCP, or `agent-recall <subcommand>` when you want the CLI."

- [ ] **Step 2: Update the `## Health check (doctor)` section trigger text**

In `skills/agent-recall-cli/SKILL.md`, the user-trigger table mentions "is the store healthy?". The current row maps it to `[Health check](#health-check-doctor)`. Add a new trigger row to the same table: `"agent-recall (no args) starts MCP"` → `[Unified executable routing](#unified-executable-routing)`.

- [ ] **Step 3: Append the unified routing section to `skills/agent-recall-cli/SKILL.md`**

Append before the closing summary section:

```markdown
## Unified executable routing (v1.1.4)

Starting with v1.1.4 the `agent-recall` binary
is a single launcher that dispatches to
either the CLI or the MCP stdio server
based on its invocation.

| Invocation | Mode | Reason |
| --- | --- | --- |
| `agent-recall` (no arguments) | MCP | The MCP default; matches the historical `agent-recall-mcp` shape. |
| `agent-recall <subcommand> [opts]` | CLI | Any subcommand (including the explicit `mcp` alias) is forwarded to the CLI parser. |
| `agent-recall-mcp [anything]` | MCP | Compatibility entry point; the launcher recognises the basename and always starts MCP. |

Both names are produced by the same launcher
source (`src/launcher.ts`). Existing MCP
client configurations that invoke
`agent-recall-mcp` continue to work without
changes.
```

- [ ] **Step 4: Update `skills/README.md` to match the new SKILL description**

Read `skills/README.md` and locate the row that points at the CLI SKILL. Replace the description with the unified-executable summary: "Operate the unified `agent-recall` executable: CLI subcommands for health checks, memory inspection, export/import, backup/restore, schema migration, admin capability; the same binary with no arguments starts the MCP stdio server." The MCP-specific surface still lives in the MCP server documentation; this row covers the CLI dispatch half.

- [ ] **Step 5: Re-read both files to verify the wording**

Run: `read_file` on `skills/agent-recall-cli/SKILL.md` and `skills/README.md`.
Expected: both files describe the unified executable consistently. The CLI SKILL explicitly says the same source powers both `agent-recall` and `agent-recall-mcp`. The README row links the launcher to the same scope.

- [ ] **Step 6: Commit**

```bash
git add skills/agent-recall-cli/SKILL.md skills/README.md
git commit -m "docs(skills): describe unified CLI/MCP executable"
```

---

### Task 5: Wire the new `npm run launcher` development script

**Files:**
- Modify: `package.json` (add a `launcher` script alongside `cli`)

**Interfaces:**
- Consumes: the local source-level invocation of `src/launcher.ts`.
- Produces: a `npm run launcher -- <args>` developer command that runs the launcher directly through `tsx`, mirroring the existing `npm run cli` shortcut.

- [ ] **Step 1: Add the script entry**

In `package.json` add:

```json
"launcher": "tsx src/launcher.ts"
```

Place it directly under the existing `cli` and `cli:doctor` entries. Do not touch any other field.

- [ ] **Step 2: Smoke-test the dev script in CLI mode**

Run: `npm run launcher -- help`
Expected: the existing CLI help text.

- [ ] **Step 3: Smoke-test the dev script in MCP mode**

Run: `npm run launcher </dev/null` (or pipe a single `initialize` JSON-RPC frame and close stdin).
Expected: the launcher routes no-arguments to MCP; the server responds or exits 0 on stdin EOF.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore(dev): add npm run launcher shortcut"
```

---

### Task 6: Cross-platform CI verification

**Files:**
- Modify: none (verification only)

**Interfaces:**
- Consumes: the existing CI matrix at `.github/workflows/ci.yml` (Node 24, ubuntu / macos / windows-2022).
- Produces: a green CI run on commit `HEAD` after the previous tasks.

- [ ] **Step 1: Push the branch and wait for CI**

Run: `git push origin main`
Then: `gh run watch --repo xurunxin/AgentRecall --branch main --exit-status`
Expected: the run reports `success`. If a job fails, follow the systematic-debugging protocol: read the failure log, reproduce locally, then return to the failing task to fix it.

- [ ] **Step 2: Spot-check the Node `/usr/bin/agent-recall`-style smoke on every platform**

The CI already runs `npm test` and the unit suite. Confirm the launcher's smoke is implicitly covered by the existing CLI test suites (which already invoke `node dist/src/index.js` and `tsx bin/agent-recall.ts` directly). No new CI steps are required for this plan.

- [ ] **Step 3: Commit the verification summary (no code change) — or stop here**

If no code change is required, no commit is made. Mark this task complete in the todo list.
