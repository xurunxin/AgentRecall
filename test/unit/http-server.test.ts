// test/unit/http-server.test.ts
//
// Stage 4 / Task 9 of the mcp-process-lifecycle-and-
// shared-http plan. The shared-HTTP daemon entry
// point. Precondition tests only — the bind-and-listen
// smoke and the per-session routing path are covered
// by the Task 10 / Task 11 work; this file pins the
// minimum-viable shape: `runHttpServer` MUST reject
// before touching the network when its security
// preconditions aren't met (specifically, when the
// host whitelist is empty — the spec § 共享安全 rule
// that an HTTP daemon with no `allowedHosts` must not
// start at all).
//
// Fix-round 1: the per-session routing logic
// (`handleHttpRequest`'s `if (POST && !sessionId)`
// branch) was rewritten to pre-generate the id,
// build the transport with a matching
// `sessionIdGenerator`, and call
// `transport.handleRequest(req, res)` synchronously
// so the first `initialize` POST actually reaches
// the SDK. A bind-and-listen test that exercises
// this path is deferred to a follow-up — it needs
// a live `httpServer` plus a real or stubbed
// `StreamableHTTPServerTransport`, which is a
// larger surface than the brief's precondition-only
// test list.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runHttpServer } from "../../src/mcp/http-server.js";

const homes: string[] = [];
afterAll(() => { while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true }); });

function home() {
  const h = mkdtempSync(join(tmpdir(), "agent-recall-http-test-"));
  homes.push(h);
  return h;
}

describe("runHttpServer preconditions", () => {
  it("rejects without allowedHosts", async () => {
    await expect(
      runHttpServer({
        dataHome: home(),
        defaultActor: "agent",
        activeProfile: "core",
        identityResolver: {} as never,
        memoryService: {} as never,
        capabilityStore: { hasCapability: () => false } as never,
        authorization: { actorMaxSensitivity: "normal", profile: "core" } as never,
        bind: { host: "127.0.0.1", port: 0 }
      })
    ).rejects.toThrow(/allowedHosts/);
  });
});
