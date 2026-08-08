#!/usr/bin/env node
// scripts/smoke-bun-binary.mjs
//
// Seven-step smoke test for the locally-built Bun CLI binary.
// Skips (exits 0 with a "skipped" note) if no binary exists for
// the host platform, so the script is safe to call before
// `npm run build:bun`.
//
// Steps:
//   1. --version                          exit 0, prints 1.1.5
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

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  console.log(`bun: smoke skipped \u2014 no binary at ${BINARY}`);
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
  if (v !== "1.1.5") fail(1, `--version expected "1.1.5", got "${v}"`);

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

  // Step 7: --http serve + initialize probe
  // Stage 4 / Task 11. Spawns the daemon in HTTP
  // mode and probes `initialize` end-to-end. The
  // bearer token is read from the lockfile the
  // launcher writes immediately before
  // `runHttpServer` binds the port; the file's
  // existence is the readiness signal. Per Task 10
  // the daemon rejects `initialize` without a
  // valid `params.actor`, so the probe body
  // includes the actor.
  //
  // Task 9 spec gap (deferred): the daemon's
  // `process.exit(0)` on a clean shutdown skips
  // the launcher's `try/finally release(...)` so
  // the lockfile is NOT removed by the daemon. The
  // outer `finally` (below) cleans up the entire
  // `home` directory, including any stray
  // `.mcp-<profile>.lock` left behind.
  const activeProfile = "core"; // matches the launcher's AGENT_RECALL_PROFILE default
  const httpLockPath = join(home, `.mcp-${activeProfile}.lock`);
  const http = spawn(BINARY, ["--http"], {
    env: { ...process.env, ...env, AGENT_RECALL_HTTP_VERBOSE: "1" }
  });
  try {
    // Wait up to 5s for the launcher to write the
    // lockfile (= the readiness signal: the
    // launcher's `acquireOrJoin` returns before
    // `runHttpServer` binds the port, so the file
    // existing means the daemon is about to start
    // listening on the configured port).
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (existsSync(httpLockPath)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!existsSync(httpLockPath)) {
      fail(7, `daemon did not write ${httpLockPath} within 5s`);
    }
    const lock = JSON.parse(readFileSync(httpLockPath, "utf8"));
    const endpoint = lock.endpoint;
    const token = lock.token;
    if (typeof token !== "string" || token.length === 0) {
      fail(7, `lockfile missing token: ${httpLockPath}`);
    }
    // Initialize probe (Task 10 requires
    // `params.actor`; the brief's body omitted it,
    // which would have been rejected with 400
    // `missing_actor`).
    //
    // The `accept: application/json,
    // text/event-stream` header is REQUIRED by
    // the MCP SDK's `StreamableHTTPServerTransport`:
    // without it the SDK's pre-flight 406s with
    // "Not Acceptable: Client must accept both
    // application/json and text/event-stream"
    // (the Bun smoke discovered this gap on
    // 2026-08-08; the Node test setup was lucky
    // because the SDK's Hono adapter is more
    // lenient for the initialize case on some
    // Node versions — but the contract is
    // explicit and the smoke should follow it).
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "smoke", version: "0" },
          actor: { kind: "agent", id: "smoke" }
        }
      })
    });
    if (res.status !== 200) {
      fail(7, `HTTP init status ${res.status} (expected 200)`);
    }
    // Follow-up probe (Task 11 / 2026-08-08):
    // the per-session `McpServer` fix must be
    // exercised end-to-end against the Bun
    // binary. We capture the `mcp-session-id`
    // header from the initialize response and
    // POST a `tools/list` on the same session
    // id; a 200 (or any 2xx — the SDK may
    // answer as JSON or SSE for `tools/list`)
    // proves the second `connect` did NOT
    // throw "Already connected" (the bug that
    // prompted the per-session refactor). The
    // previous smoke only verified the first
    // request, which passed even with the
    // shared-server bug.
    const sessionId = res.headers.get("mcp-session-id");
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      fail(7, `initialize response missing mcp-session-id header (headers: ${JSON.stringify(Object.fromEntries(res.headers))})`);
    }
    const followUp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "mcp-session-id": sessionId
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {}
      })
    });
    if (followUp.status < 200 || followUp.status >= 300) {
      fail(7, `HTTP follow-up tools/list status ${followUp.status} (expected 2xx; per-session McpServer bug?)`);
    }
  } finally {
    // Best-effort cleanup of the daemon. The
    // SIGTERM handler in `runHttpServer` triggers
    // the shutdown sequence; the outer `finally`
    // then removes the entire `home` (including
    // the lockfile) regardless of whether the
    // daemon managed to release it.
    try { http.kill("SIGTERM"); } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log("bun smoke: all 7 steps passed");
} finally {
  rmSync(home, { recursive: true, force: true });
}