// test/unit/daemon-lock.test.ts
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
});
