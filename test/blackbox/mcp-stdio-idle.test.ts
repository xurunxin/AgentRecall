// test/blackbox/mcp-stdio-idle.test.ts
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const BIN = "dist/src/index.js";
const homes = new Set<string>();
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

function spawnChild(idleMs: number) {
  const home = mkdtempSync(join(tmpdir(), "agent-recall-stdio-idle-"));
  homes.add(home);
  return spawn(process.execPath, [BIN], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENT_RECALL_HOME: home,
      AGENT_RECALL_SUPPRESS_MCP_DEPRECATION: "1",
      AGENT_RECALL_VERBOSE_STDIO: "1",
      AGENT_RECALL_STDIO_IDLE_MS: String(idleMs)
    }
  });
}

/** Wait `ms` milliseconds. Used as a warmup so the child
 *  finishes startup (≈400 ms on slow Windows) and arms its
 *  idle-timer `data` listener before the test interacts
 *  with stdin. Matches the pattern in mcp-shutdown.test.ts. */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("stdio idle exit", () => {
  it("exits cleanly via the idle-sentinel when idleMs=500 and no traffic", async () => {
    // v1.1.6 follow-up D1: replace the v1.1.5
    // cap-bounded wait (the 2.5 s `setTimeout` + SIGKILL
    // path that flaked on the release-candidate
    // orchestrator when 5 vitest suites ran in
    // parallel) with a sentinel-wait. The MCP entry
    // emits `[lifecycle] idle-sentinel\n` on stderr
    // immediately before `process.exit(0)` in the
    // idle-shutdown path (src/mcp/server-lifecycle.ts
    // `onShutdownComplete` hook). The test:
    //   1. spawns the MCP server with idleMs=500,
    //   2. waits 500 ms for startup + idle-timer arm,
    //   3. waits for the sentinel on stderr (the
    //      timeout is a CI-safety backstop, not the
    //      assertion — the sentinel drives exit),
    //   4. asserts exit code 0 AND sentinel seen.
    // The other two tests in this file (re-arm on
    // post-warmup traffic; idleMs=0 keeps the
    // process alive) still use cap-bounded timing
    // because they assert the process is STILL ALIVE
    // past a deadline, not that it exited.
    const child = spawnChild(500);
    const stderr: string[] = [];
    let sentinelSeen = false;
    child.stderr.on("data", (c) => {
      const s = c.toString();
      stderr.push(s);
      if (s.includes("idle-sentinel")) sentinelSeen = true;
    });
    // 500 ms warmup: let the child finish startup so
    // the idle timer is armed and counting. The
    // idleMs=500 window is measured from server
    // start; with no traffic it fires once and
    // re-arms never happen.
    await sleep(500);
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      // Backstop timeout: 5 s. The sentinel
      // should fire ~500 ms after startup so this
      // is a 10× safety margin. If the sentinel
      // never lands, the test fails with the
      // collected stderr in the assertion
      // message.
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ code: -1, signal: "SIGKILL" });
      }, 5000);
      child.on("close", (code, signal) => {
        clearTimeout(t);
        resolve({ code, signal });
      });
    });
    expect(exit.code, `stderr: ${stderr.join("")}`).toBe(0);
    expect(sentinelSeen, `stderr: ${stderr.join("")}`).toBe(true);
    // The verbose-reason log is still emitted under
    // AGENT_RECALL_VERBOSE_STDIO=1 (set in
    // `spawnChild`); the sentinel doesn't replace
    // it, the test just stops relying on the 2.5 s
    // cap.
    expect(stderr.join("")).toMatch(/stdio_idle_timeout/);
  });

  it("survives when traffic arrives after the warmup window", async () => {
    const child = spawnChild(2000);
    // 500 ms warmup: let the child finish startup and arm
    // its idle-timer `data` listener. The `\n` write must
    // arrive AFTER the listener is armed, otherwise the
    // MCP transport consumes the buffered byte first and
    // the timer is never re-armed.
    await sleep(500);
    child.stdin.write("\n");
    // 1500 ms cap: total wall time (warmup + cap) = 2000 ms
    // = idleMs. The `\n` re-armed the timer at +500 ms, so
    // the next fire is at +2500 ms — the child must still
    // be alive at the cap.
    const alive = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(true);
      }, 1500);
      child.on("close", () => {
        clearTimeout(t);
        resolve(false);
      });
    });
    expect(alive).toBe(true);
  });

  it("regression: idleMs=0 keeps the process alive past 2.5s", async () => {
    const child = spawnChild(0);
    // Warmup for symmetry with the other cases (the timer
    // is never armed here, so the warmup is not required
    // for correctness, but it keeps the case shape
    // consistent with the idleMs>0 cases).
    await sleep(500);
    const alive = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(true);
      }, 2500);
      child.on("close", () => {
        clearTimeout(t);
        resolve(false);
      });
    });
    expect(alive).toBe(true);
  });
});
