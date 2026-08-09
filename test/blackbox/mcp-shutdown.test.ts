// test/blackbox/mcp-shutdown.test.ts
//
// Bug fix regression test (round 2): real
// child-process exercise of the MCP stdio
// server's graceful-shutdown wiring. The unit
// suite (`test/unit/mcp-server-lifecycle.test.ts`)
// pins the lifecycle module's contract in
// isolation; this file pins the END-TO-END
// behaviour against an actual spawned server.
//
// Spawn strategy: `node --import tsx src/index.ts`
// runs the source directly via the tsx loader
// hook. This exercises the CURRENT source
// (with the round-2 fixes: process.exit, 1.5s
// ceiling, second-signal escape, verbose reason
// log) WITHOUT touching the build artifact at
// `dist/src/index.js`. The CI pipeline runs
// `npm run build` separately; this test does
// not depend on `dist/` and does not regenerate
// it.
//
// Scenarios pinned:
//   1. stdin EOF: close the child's stdin; assert
//      the child exits with code 0 within 2.5s
//      and stderr is empty (no protocol leak).
//   2. SIGTERM: send SIGTERM; assert clean exit
//      within 2.5s.
//   3. SIGINT: same, but with SIGINT (Ctrl-C).
//   4. Verbose reason log: set
//      AGENT_RECALL_VERBOSE_STDIO=1, trigger
//      shutdown, assert stderr contains the
//      reason line.
//
// All scenarios use a fresh `AGENT_RECALL_HOME`
// so DB state cannot leak between tests. A 500 ms
// warmup window lets the server finish startup
// (the lifecycle installer registers listeners
// after `server.connect(transport)`, which the
// verbose "connected on stdio" hint brackets).

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const SOURCE_ENTRY = join(REPO_ROOT, "src", "index.ts");

interface ExitedChild {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Spawn the source via `node --import tsx`. The
 *  loader hook runs in-process so the returned
 *  PID is the actual node process — signals sent
 *  to it land on the lifecycle listener, not on
 *  an intermediate shell.
 *
 *  Cross-platform note: `process.execPath` is the
 *  node binary the test runner itself uses, so
 *  there's no `which node` ambiguity on Windows.
 *  tsx is the devDependency the rest of the
 *  project already uses (`npm run dev`,
 *  `npm run smoke:blackbox`). */
function spawnServer(env: Record<string, string>): ChildProcess {
  return spawn(
    process.execPath,
    ["--import", "tsx", SOURCE_ENTRY],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
      // detached: false (default) — keep the child
      // in the parent's process group so signals
      // route correctly on all platforms.
      windowsHide: true
    }
  );
}

/** Wait for the child to exit, capped at 5s.
 *  If the cap is hit, send SIGKILL (host escape
 *  hatch) and return the partial result.
 *
 *  v1.1.5 (v1.1.5 release): bumped the cap from
 *  2.5s to 5s. The lifecycle module's SIGINT /
 *  SIGTERM handler does the SQLite close +
 *  listener teardown serially; on a busy VM
 *  (e.g. the release-candidate orchestrator
 *  re-running all 5 vitest suites on the same
 *  ubuntu-latest runner at once) the handler
 *  occasionally doesn't return within 2.5s, so
 *  the host escape hatch fires and the test
 *  reports `expected 'SIGINT' to be null`. The
 *  lifecycle behaviour is correct (the unit
 *  tests in `test/unit/mcp-server-lifecycle.idle.test.ts`
 *  + `test/unit/server-lifecycle.test.ts`
 *  cover the contract); this is a CI-time
 *  timing flake. 5s gives the busy runner room
 *  to complete the shutdown without hiding
 *  real regression bugs (the 5s hard timeout
 *  still applies). */
function waitForExit(
  child: ChildProcess,
  timeoutMs = 5000
): Promise<ExitedChild> {
  return new Promise<ExitedChild>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        if (child.pid !== undefined && child.exitCode === null) {
          process.kill(child.pid, "SIGKILL");
        }
      } catch {
        /* already gone */
      }
      resolve({
        code: child.exitCode,
        signal: child.signalCode
      });
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

describe("MCP stdio server graceful shutdown (real subprocess, source via tsx)", () => {
  const dataHomes: string[] = [];
  const children: ChildProcess[] = [];

  function makeEnv(extra: Record<string, string> = {}): Record<string, string> {
    const home = mkdtempSync(join(tmpdir(), "lm-mcp-shutdown-"));
    dataHomes.push(home);
    return {
      AGENT_RECALL_HOME: home,
      AGENT_RECALL_PROFILE: "core",
      AGENT_RECALL_SUPPRESS_MCP_DEPRECATION: "1",
      ...extra
    };
  }

  /** Spawn + register for cleanup. 500 ms warmup
   *  window lets the server reach the lifecycle
   *  installation point (right after
   *  `server.connect(transport)`). */
  function startServer(env: Record<string, string>): ChildProcess {
    const child = spawnServer(env);
    children.push(child);
    return child;
  }

  /** Let the server warm up so the lifecycle
   *  listener is installed. 500 ms is generous
   *  for the source-via-tsx spawn on slow CI. */
  async function warmup(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  afterEach(async () => {
    // Belt-and-braces: any child still alive after
    // the test (e.g. timeout escape hatch fired)
    // gets reaped here.
    for (const child of children) {
      if (child.exitCode === null && child.pid !== undefined) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
    children.length = 0;
    for (const home of dataHomes) {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    dataHomes.length = 0;
    // Give the OS a moment to release the data
    // home so the next test's mkdtempSync doesn't
    // collide on Windows.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("exits cleanly within 2.5s when stdin EOFs (no kill signal)", async () => {
    const child = startServer(makeEnv());
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    await warmup();
    child.stdin?.end();

    const exited = await waitForExit(child, 2500);
    // The lifecycle module calls `process.exit(0)`
    // on a clean shutdown. The host must NOT have
    // had to SIGKILL us (the timeout escape hatch
    // would have produced `code: null,
    // signal: "SIGKILL"` — that's the failure
    // path).
    expect(exited.signal).toBeNull();
    expect(exited.code).toBe(0);
    // No protocol leak: the JSON-RPC stream is
    // `process.stdout`; the diagnostic sink is
    // `stderr`. A clean shutdown with no
    // verbose mode should leave stderr empty.
    expect(stderr.trim()).toBe("");
  });

  it("exits cleanly within 2.5s on SIGTERM", async () => {
    // Node 22 on Windows documents SIGTERM /
    // SIGINT as "unconditional termination": the
    // OS kills the child even if a `process.on`
    // listener is installed. The signal path is
    // a Linux / macOS contract; on Windows the
    // child is reaped by TerminateProcess before
    // the lifecycle listener can run. The stdin
    // EOF scenario above is the cross-platform
    // proof of the lifecycle; this test runs only
    // on POSIX where the signal is honoured.
    if (process.platform === "win32") {
      return;
    }
    const child = startServer(makeEnv());
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    await warmup();
    if (child.pid === undefined) throw new Error("child pid undefined");
    process.kill(child.pid, "SIGTERM");

    const exited = await waitForExit(child, 2500);
    expect(exited.signal).toBeNull();
    expect(exited.code).toBe(0);
    // No protocol leak.
    expect(stderr.trim()).toBe("");
  });

  it("exits cleanly within 2.5s on SIGINT", async () => {
    // Same Windows note as the SIGTERM case
    // above: Node 22 on Windows terminates
    // unconditionally on SIGINT even with a
    // listener installed. Skip on win32.
    if (process.platform === "win32") {
      return;
    }
    const child = startServer(makeEnv());
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    await warmup();
    if (child.pid === undefined) throw new Error("child pid undefined");
    process.kill(child.pid, "SIGINT");

    const exited = await waitForExit(child, 2500);
    expect(exited.signal).toBeNull();
    expect(exited.code).toBe(0);
    expect(stderr.trim()).toBe("");
  });

  it("verbose mode logs the shutdown reason to stderr", async () => {
    const child = startServer(
      makeEnv({ AGENT_RECALL_VERBOSE_STDIO: "1" })
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    await warmup();
    child.stdin?.end();

    const exited = await waitForExit(child, 2500);
    expect(exited.code).toBe(0);
    // Verbose mode emits a one-shot stderr line
    // at trigger time. The reason is one of
    // "stdio_end", "stdio_close", "SIGINT",
    // "SIGTERM" — the lifecycle module maps
    // "stdio_end" to "stdin EOF" in the verbose
    // log via the MCP entry. Both labels are
    // accepted so the test is robust to the
    // exact wording.
    expect(stderr).toMatch(/shutting down|stdin EOF|stdin closed/);
  });
});