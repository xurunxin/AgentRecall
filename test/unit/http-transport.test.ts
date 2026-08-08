// test/unit/http-transport.test.ts
//
// Unit tests for `SessionManager` (Task 8 / Stage 3
// of the mcp-shared-http plan). Verifies the
// per-session transport registry contract:
//
//   - create() registers a session and returns a
//     UUID-shaped id synchronously.
//   - get() returns the entry by id (or undefined
//     for unknown ids).
//   - close() removes the entry from the map and
//     awaits the underlying transport's close().
//   - register(id, transport, actor) inserts an
//     entry under a caller-supplied id (Task 9
//     fix-round 1 seam; the route layer generates
//     the id and passes it in).
//
// The `makeServer()` mock deliberately does NOT
// fire the SDK's `onsessioninitialized` callback
// (real `server.connect()` would, but our mock
// resolves immediately with no HTTP request). This
// forces the implementation to register the session
// synchronously inside `create()` rather than rely
// on the SDK callback — which is the locked-in fix
// shape from the controller.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/mcp/http-transport.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

describe("SessionManager", () => {
  const mgrs: SessionManager[] = [];
  afterEach(() => { while (mgrs.length) mgrs.pop()?.closeAll(); });

  function makeServer() {
    return { connect: vi.fn().mockResolvedValue(undefined) } as unknown as McpServer;
  }

  it("create() registers session and returns id", () => {
    const mgr = new SessionManager();
    mgrs.push(mgr);
    const server = makeServer();
    const id = mgr.create(server, { kind: "agent", id: "claude-code" });
    expect(id).toMatch(/^[0-9a-f-]{8,}/i);
    expect(mgr.get(id)?.actor.id).toBe("claude-code");
  });

  it("get() returns undefined for unknown session", () => {
    const mgr = new SessionManager();
    mgrs.push(mgr);
    expect(mgr.get("nope")).toBeUndefined();
  });

  it("close() removes the session and awaits transport.close()", async () => {
    const mgr = new SessionManager();
    mgrs.push(mgr);
    const server = makeServer();
    const close = vi.fn().mockResolvedValue(undefined);
    const id = mgr.create(server, { kind: "agent", id: "x" }, { transport: { close } as unknown as { close(): Promise<void> } });
    await mgr.close(id);
    expect(close).toHaveBeenCalled();
    expect(mgr.get(id)).toBeUndefined();
  });

  it("register(id, transport, actor) inserts an entry under a caller-supplied id", () => {
    // Task 9 fix-round 1 seam: the route layer
    // generates the id and passes it in so the
    // transport's `sessionIdGenerator` and the
    // manager's map key agree (no UUID-A-vs-UUID-B
    // mismatch). The mock transport is a bare
    // object — we only assert the manager's
    // bookkeeping, not the transport's internals.
    const mgr = new SessionManager();
    mgrs.push(mgr);
    const transport = { close: vi.fn().mockResolvedValue(undefined) } as unknown as { close(): Promise<void> };
    const id = "caller-supplied-id-1";
    mgr.register(id, transport as never, { kind: "agent", id: "agent-default" });
    const entry = mgr.get(id);
    expect(entry).toBeDefined();
    expect(entry?.actor).toEqual({ kind: "agent", id: "agent-default" });
    expect(entry?.transport).toBe(transport);
    expect(entry?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
