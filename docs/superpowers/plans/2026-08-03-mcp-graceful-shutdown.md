# MCP Graceful Shutdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the Node and Bun-packaged MCP stdio servers close deterministically when the client closes stdin or sends a termination signal, without adding idle timeouts.

**Architecture:** Keep the MCP process resident while stdio is active. Add one idempotent shutdown closure in `src/index.ts`; trigger it from stdin `end`/`close` and Unix termination signals, close the MCP server before the SQLite store, and use a bounded shutdown wait so the host can reap the process. Add a focused black-box lifecycle test and run it against the built Node entrypoint plus the host Bun MCP binary.

**Tech Stack:** TypeScript, Node.js `child_process`, MCP SDK stdio transport, Vitest, Bun `build --compile`.

## Global Constraints

- Preserve the current stdio MCP protocol and do not add an idle timeout.
- Do not modify `node_modules` or add dependencies.
- Keep shutdown idempotent and best-effort; never emit normal protocol data to stdout.
- Preserve `AGENT_RECALL_VERBOSE_STDIO` gating for diagnostic shutdown messages.
- Rebuild `dist/` before compiling Bun binaries.

---

### Task 1: Add a failing packaged lifecycle regression test

**Files:**
- Create: `test/blackbox/mcp-shutdown.test.ts`
- Modify: `vitest.blackbox.config.ts` only if required to include the focused test

**Interfaces:**
- Consumes the built server at `dist/src/index.js` and, when present, `dist-bin/agent-recall-mcp-win32-x64.exe`.
- Produces assertions that a server exits after stdin EOF without parent SIGTERM/SIGKILL escalation.

- [ ] **Step 1: Add a helper that spawns one server and waits for startup**

Use `spawn` with `stdio: ["pipe", "pipe", "pipe"]`, a fresh `AGENT_RECALL_HOME`, `AGENT_RECALL_SUPPRESS_MCP_DEPRECATION=1`, and `AGENT_RECALL_VERBOSE_STDIO=1`. Resolve startup after the child is spawned; do not require a full MCP handshake for the shutdown-only case.

- [ ] **Step 2: Write the EOF exit test**

Call `child.stdin.end()`, await the child `close` event with a 2.5-second timeout, and assert `code === 0` and `signal === null`. Assert stderr contains `shutting down (stdin EOF)` so the test proves the application shutdown path, not incidental OS process exit.

- [ ] **Step 3: Add the Bun binary variant**

Run the same helper against `dist-bin/agent-recall-mcp-win32-x64.exe` when it exists; skip only the Bun-specific case when the binary is absent. Keep the Node case fail-closed because `npm run build` is required before the test.

- [ ] **Step 4: Run the focused test before implementation**

Run:

```bash
npx vitest run --config vitest.blackbox.config.ts test/blackbox/mcp-shutdown.test.ts
```

Expected: the new EOF assertions fail because the current server has no shutdown handler.

---

### Task 2: Implement idempotent graceful shutdown

**Files:**
- Modify: `src/index.ts:71-205`

**Interfaces:**
- Keep `main(): Promise<void>` as the entrypoint.
- Add a local `shutdown(reason: string): Promise<void>` closure after `server.connect(transport)` so it captures `server`, `service`, and `transport`.

- [ ] **Step 1: Register shutdown triggers**

After `await server.connect(transport)`, register `process.stdin.once("end", ...)`, `process.stdin.once("close", ...)`, and process signal listeners for `SIGINT` and `SIGTERM`. Each callback must call `void shutdown(reason)`.

- [ ] **Step 2: Implement the idempotent shutdown body**

Use a `let shuttingDown = false` guard. On the first trigger, optionally write one stderr line only when `AGENT_RECALL_VERBOSE_STDIO === "1"`; await `server.close()` with a 1.5-second unref'd timeout race; then call `service.store.close()` in a separate try/catch. Set `process.exitCode = 0` for a clean shutdown and let the event loop terminate naturally after cleanup.

- [ ] **Step 3: Handle shutdown errors without masking the original process**

Do not throw from stdin or signal callbacks. If `server.close()` or `store.close()` fails, retain the clean exit behavior only for the normal EOF path when the process is otherwise healthy; write diagnostics only under verbose mode. Ensure a second trigger cannot run cleanup twice.

- [ ] **Step 4: Run the focused test**

Run the same command from Task 1. Expected: Node and available Bun EOF tests pass.

---

### Task 3: Verify source behavior and rebuild artifacts

**Files:**
- Generated/modified by build: `dist/src/index.js`, related `dist/` output
- Generated/modified by build: `dist-bin/agent-recall-mcp-win32-x64.exe` and host-platform Bun artifacts plus `dist-bin/MANIFEST.json`

- [ ] **Step 1: Type-check and build Node output**

Run:

```bash
npm run typecheck
npm run build
```

Expected: both exit 0 and `dist/src/index.js` contains the shutdown implementation.

- [ ] **Step 2: Rebuild Bun binaries**

Run:

```bash
npm run build:bun
```

Expected: Bun 1.3+ builds the canonical platform matrix as available and writes an updated manifest. A non-host cross-compile failure is acceptable only under the script’s existing manifest/error contract; the host Windows MCP exe must be `status: "ok"`.

- [ ] **Step 3: Run the focused Node and Bun lifecycle probes**

Spawn `dist/src/index.js` and the Windows MCP exe, close stdin, and verify each exits within 2.5 seconds without sending a kill signal. Also run the existing CLI Bun smoke to ensure the rebuild did not affect the CLI binary:

```bash
npm run smoke:bun
```

---

### Task 4: Broaden regression verification

**Files:**
- No source changes expected.

- [ ] **Step 1: Run the focused black-box suite**

```bash
npx vitest run --config vitest.blackbox.config.ts test/blackbox/mcp-shutdown.test.ts
```

- [ ] **Step 2: Run existing MCP black-box coverage**

```bash
npm run test:blackbox
```

Expected: existing MCP tool/resource behavior and cleanup assertions remain green.

- [ ] **Step 3: Inspect the final artifact state**

Run:

```bash
git status --short
git diff -- src/index.ts test/blackbox/mcp-shutdown.test.ts
```

Confirm only the intended source/test changes and regenerated build artifacts are present; do not commit or push unless explicitly requested.

- [ ] **Step 4: Report evidence and remaining platform uncertainty**

Report exact test/build commands and outcomes. If cross-platform Bun artifacts cannot all be built locally, state which artifact was verified and which platforms remain CI-only.
