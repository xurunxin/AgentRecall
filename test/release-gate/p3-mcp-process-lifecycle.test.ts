// test/release-gate/p3-mcp-process-lifecycle.test.ts
import { afterAll, describe, expect, it } from "vitest";
import { acquireOrJoin, release, pathFor } from "../../src/mcp/daemon-lock.js";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homes: string[] = [];
afterAll(() => { while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true }); });

describe("p3: mcp process lifecycle contract", () => {
  it("lockfile payload schema", async () => {
    const h = mkdtempSync(join(tmpdir(), "agent-recall-p3-"));
    homes.push(h);
    const r = await acquireOrJoin({
      dataHome: h,
      profile: "core",
      buildEndpoint: () => "http://127.0.0.1:1/mcp"
    });
    expect(r.lockPath).toBe(pathFor({ dataHome: h, profile: "core" }));
    await release({ lockPath: r.lockPath, expectedPid: process.pid });
    expect(existsSync(r.lockPath)).toBe(false);
  });
});
