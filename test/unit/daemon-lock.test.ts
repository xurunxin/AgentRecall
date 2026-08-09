// test/unit/daemon-lock.test.ts
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireOrJoin, pathFor, release } from "../../src/mcp/daemon-lock.js";

const homes: string[] = [];
afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "agent-recall-lock-"));
  homes.push(h);
  return h;
}

describe("daemon-lock", () => {
  it("acquireOrJoin writes a fresh lock when none exists", async () => {
    // Brief case 1 — capture the data home so the existence
    // assertion can be expressed directly without reverse-
    // engineering `lockPath`. Behaviour is identical to the
    // brief: the path returned by `pathFor` exists after the
    // call, the call returns `joined: false`, and the endpoint
    // matches what `buildEndpoint` produced.
    const h = home();
    const r = await acquireOrJoin({
      dataHome: h,
      profile: "core",
      buildEndpoint: () => "http://127.0.0.1:7777/mcp"
    });
    expect(r.joined).toBe(false);
    expect(r.endpoint).toBe("http://127.0.0.1:7777/mcp");
    expect(existsSync(pathFor({ dataHome: h, profile: "core" }))).toBe(true);
  });

  it("returns joined when lock points at current pid and probe passes", async () => {
    const h = home();
    const p = pathFor({ dataHome: h, profile: "core" });
    writeFileSync(p, JSON.stringify({
      pid: process.pid,
      endpoint: "http://127.0.0.1:9999/mcp",
      token: "deadbeef",
      transport: "tcp",
      started_at: new Date().toISOString(),
      version: "test",
      data_home: h,
      profile: "core"
    }));
    const r = await acquireOrJoin({
      dataHome: h,
      profile: "core",
      buildEndpoint: () => "http://127.0.0.1:9998/mcp",
      probe: async () => true
    });
    expect(r.joined).toBe(true);
    expect(r.endpoint).toBe("http://127.0.0.1:9999/mcp");
    expect(r.token).toBe("deadbeef");
  });

  it("reclaims stale lock when probe fails", async () => {
    const h = home();
    const p = pathFor({ dataHome: h, profile: "core" });
    writeFileSync(p, JSON.stringify({
      pid: 999999, // unlikely to be alive
      endpoint: "http://127.0.0.1:9999/mcp",
      token: "deadbeef",
      transport: "tcp",
      started_at: new Date().toISOString(),
      version: "test",
      data_home: h,
      profile: "core"
    }));
    const r = await acquireOrJoin({
      dataHome: h,
      profile: "core",
      buildEndpoint: () => "http://127.0.0.1:9998/mcp",
      probe: async () => false
    });
    expect(r.joined).toBe(false);
    expect(r.endpoint).toBe("http://127.0.0.1:9998/mcp");
    const fresh = JSON.parse(readFileSync(p, "utf8"));
    expect(fresh.pid).toBe(process.pid);
  });

  it("treats corrupt lock as missing and reclaims", async () => {
    const h = home();
    const p = pathFor({ dataHome: h, profile: "core" });
    writeFileSync(p, "{not valid json");
    const r = await acquireOrJoin({
      dataHome: h,
      profile: "core",
      buildEndpoint: () => "http://127.0.0.1:7777/mcp"
    });
    expect(r.joined).toBe(false);
    expect(r.endpoint).toBe("http://127.0.0.1:7777/mcp");
    const fresh = JSON.parse(readFileSync(p, "utf8"));
    expect(fresh.pid).toBe(process.pid);
  });

  it("release deletes the lock when pid matches", async () => {
    const h = home();
    const r = await acquireOrJoin({
      dataHome: h,
      profile: "core",
      buildEndpoint: () => "http://127.0.0.1:7777/mcp"
    });
    await release({ lockPath: r.lockPath, expectedPid: process.pid });
    expect(existsSync(r.lockPath)).toBe(false);
  });

  it("forwards the existing lock to the probe (v1.1.5 review by chatgpt-codex-connector on PR #40)", async () => {
    // v1.1.5 (review item "Probe the recorded
    // daemon instead of always reclaiming
    // it"): the pre-PR-#40 probe was a
    // zero-arg closure. Without the
    // recorded `LockPayload`, the launcher
    // could not construct a real HTTP
    // probe — every live daemon was
    // classified as stale, its lock was
    // unlinked, and a second launcher
    // bound the same port. The fix: the
    // probe receives the existing lock so
    // the caller can hit the recorded
    // endpoint with the recorded bearer
    // token. The test asserts:
    //   1. The probe receives the existing
    //      `LockPayload` as its single arg.
    //   2. The probe returning `true`
    //      causes `acquireOrJoin` to
    //      return `joined: true` (the
    //      launcher should NOT bind a
    //      new port).
    //   3. The lockfile is NOT replaced
    //      (the existing daemon's token
    //      is preserved).
    //
    // The probe is only invoked when
    // `existing.pid !== process.pid` AND
    // `pidAlive(existing.pid)` is `true`.
    // The same-pid short-circuit is the
    // canonical "self-join" path; the
    // dead-pid path skips the probe.
    // The test uses a different pid
    // (`OTHER_PID`) and stubs
    // `process.kill(OTHER_PID, 0)` to
    // return success so the probe is
    // the authoritative gate. The stub
    // is restored in `finally` so other
    // tests in the file are not affected.
    const h = home();
    const p = pathFor({ dataHome: h, profile: "core" });
    const OTHER_PID = 999_999_001;
    const recorded = {
      pid: OTHER_PID,
      endpoint: "http://127.0.0.1:9999/mcp",
      token: "deadbeef-token",
      transport: "tcp" as const,
      started_at: new Date().toISOString(),
      version: "test",
      data_home: h,
      profile: "core"
    };
    writeFileSync(p, JSON.stringify(recorded));
    // Stub `process.kill(pid, 0)` to return
    // success for the OTHER_PID. We don't
    // stub the function globally; we
    // monkey-patch the prototype's `kill`
    // method so the daemon-lock module's
    // `process.kill(existing.pid, 0)` call
    // sees success. The stub is restored
    // after the call.
    const origKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === OTHER_PID && signal === 0) return true;
      return origKill(pid, signal as never);
    }) as typeof process.kill);
    try {
      let captured: typeof recorded | undefined;
      const r = await acquireOrJoin({
        dataHome: h,
        profile: "core",
        buildEndpoint: () => "http://127.0.0.1:9998/mcp",
        probe: async (existing) => {
          captured = existing;
          return true;
        }
      });
      expect(captured).toBeDefined();
      expect(captured?.endpoint).toBe(recorded.endpoint);
      expect(captured?.token).toBe(recorded.token);
      expect(r.joined).toBe(true);
      // The original token is preserved
      // (the launcher is joining, not
      // reclaiming).
      expect(r.token).toBe(recorded.token);
      // The lockfile is NOT replaced.
      const onDisk = JSON.parse(readFileSync(p, "utf8"));
      expect(onDisk.token).toBe(recorded.token);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("a probe returning false reclaims the lock and writes a fresh token (v1.1.5 review)", async () => {
    // v1.1.5 (review item "Probe the recorded
    // daemon instead of always reclaiming
    // it"): the constant-`false` probe
    // (pre-PR-#40) was a bug — every live
    // daemon was classified as stale. The
    // post-PR-#40 behaviour: a probe that
    // returns `false` after seeing a
    // LIVE pid is the "recorded daemon is
    // unresponsive" signal — the launcher
    // reclaims. The test exercises this
    // path explicitly: the recorded pid
    // is `OTHER_PID` (not `process.pid`),
    // `pidAlive` is stubbed to `true`, the
    // probe sees the existing lock and
    // returns `false`, and the lock is
    // replaced with a fresh token.
    const h = home();
    const p = pathFor({ dataHome: h, profile: "core" });
    const OTHER_PID = 999_999_002;
    const recorded = {
      pid: OTHER_PID,
      endpoint: "http://127.0.0.1:9999/mcp",
      token: "stale-token",
      transport: "tcp" as const,
      started_at: new Date().toISOString(),
      version: "test",
      data_home: h,
      profile: "core"
    };
    writeFileSync(p, JSON.stringify(recorded));
    const origKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === OTHER_PID && signal === 0) return true;
      return origKill(pid, signal as never);
    }) as typeof process.kill);
    try {
      const r = await acquireOrJoin({
        dataHome: h,
        profile: "core",
        buildEndpoint: () => "http://127.0.0.1:9998/mcp",
        probe: async () => false
      });
      expect(r.joined).toBe(false);
      // Fresh token (32 raw bytes = 64 hex
      // chars), NOT the stale-token from
      // the recorded lock.
      expect(r.token).not.toBe(recorded.token);
      expect(r.token).toMatch(/^[0-9a-f]{64}$/);
      // The lockfile on disk is the fresh
      // claim.
      const onDisk = JSON.parse(readFileSync(p, "utf8"));
      expect(onDisk.token).toBe(r.token);
      expect(onDisk.pid).toBe(process.pid);
    } finally {
      killSpy.mockRestore();
    }
  });
});
