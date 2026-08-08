// test/unit/http-server.test.ts
//
// Stage 4 / Task 9 + Task 10 of the mcp-process-lifecycle-
// and-shared-http plan. The shared-HTTP daemon entry
// point.
//
//   - Task 9 part: precondition tests — `runHttpServer`
//     MUST reject before touching the network when its
//     security preconditions aren't met (spec § 共享安全:
//     a daemon with no `allowedHosts` must not start at
//     all).
//
//   - Task 10 part: the first-POST branch in
//     `handleHttpRequest` parses the request body to
//     extract `params.actor`. The spec § 错误处理 row
//     "MCP `initialize` 缺 `actor` → 400 + 关闭
//     transport（不入 map）" pins the contract: an
//     initialize without a valid `params.actor` is
//     rejected, and the session is never inserted into
//     the manager's map. A valid actor is parsed and
//     used to register the session; a non-initialize
//     first POST falls back to the daemon-wide default
//     actor. The tests below cover the parsing helper
//     `parseInitializeBody` exhaustively and the route
//     layer's wiring of the helper.
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runHttpServer, parseInitializeBody } from "../../src/mcp/http-server.js";
import { SessionManager, type SessionActor } from "../../src/mcp/http-transport.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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

describe("parseInitializeBody", () => {
  // Spec § 错误处理 row: "MCP `initialize` 缺
  // `actor` → 400 + 关闭 transport（不入 map）".
  // The helper must extract the actor for a valid
  // initialize, reject missing / malformed actors,
  // and fall back to the daemon's default actor for
  // non-initialize bodies. The first-POST branch in
  // `handleHttpRequest` uses the outcome to drive
  // either registration or the 400 response.

  it("extracts actor from a valid initialize body", () => {
    const body = Buffer.from(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-01-01",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
        actor: { kind: "agent", id: "claude-code" }
      }
    }));
    expect(parseInitializeBody(body)).toEqual({
      outcome: "actor",
      actor: { kind: "agent", id: "claude-code" }
    });
  });

  it("rejects initialize without params.actor", () => {
    const body = Buffer.from(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-01-01",
        capabilities: {},
        clientInfo: { name: "test", version: "1" }
      }
    }));
    expect(parseInitializeBody(body)).toEqual({
      outcome: "reject",
      reason: "missing_actor"
    });
  });

  it("rejects initialize with params not an object", () => {
    // The spec's "缺 actor" path covers the case
    // where `params` itself is missing or not a
    // structured object (e.g. an array or a string).
    // The helper surfaces this as `missing_actor` so
    // the route layer can write a single 400 reason
    // back to the client.
    const body = Buffer.from(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: "not-an-object"
    }));
    expect(parseInitializeBody(body)).toEqual({
      outcome: "reject",
      reason: "missing_actor"
    });
  });

  it("rejects initialize with invalid actor.kind", () => {
    const body = Buffer.from(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-01-01",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
        actor: { kind: "not-a-valid-kind", id: "x" }
      }
    }));
    expect(parseInitializeBody(body)).toEqual({
      outcome: "reject",
      reason: "invalid_actor"
    });
  });

  it("rejects initialize with empty actor.id", () => {
    const body = Buffer.from(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-01-01",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
        actor: { kind: "agent", id: "" }
      }
    }));
    expect(parseInitializeBody(body)).toEqual({
      outcome: "reject",
      reason: "invalid_actor"
    });
  });

  it("rejects initialize with non-string actor.id", () => {
    const body = Buffer.from(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-01-01",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
        actor: { kind: "agent", id: 42 }
      }
    }));
    expect(parseInitializeBody(body)).toEqual({
      outcome: "reject",
      reason: "invalid_actor"
    });
  });

  it("accepts all three valid actor kinds", () => {
    // The `SessionActor` union ("agent" | "user" |
    // "service") is the canonical contract. The
    // helper must accept every member of the union
    // (not just the legacy "agent" default).
    for (const kind of ["agent", "user", "service"] as const) {
      const body = Buffer.from(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-01-01",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
          actor: { kind, id: "id-1" }
        }
      }));
      expect(parseInitializeBody(body)).toEqual({
        outcome: "actor",
        actor: { kind, id: "id-1" }
      });
    }
  });

  it("uses default-actor for a non-initialize body", () => {
    // A brand-new client that POSTs a non-initialize
    // method (`tools/list`, `notifications/initialized`,
    // etc.) is malformed: the SDK's stateful mode
    // requires an `initialize` first. The route layer
    // falls back to the daemon-wide default actor in
    // that case and lets the SDK reject the request.
    const body = Buffer.from(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {}
    }));
    expect(parseInitializeBody(body)).toEqual({ outcome: "default-actor" });
  });

  it("uses default-actor for unparseable body", () => {
    // If the body is not JSON (or is empty), the
    // helper cannot identify it as an initialize
    // request — it falls back to the default-actor
    // path. The SDK will reject the malformed
    // request downstream.
    expect(parseInitializeBody(Buffer.from("not json"))).toEqual({ outcome: "default-actor" });
    expect(parseInitializeBody(Buffer.from(""))).toEqual({ outcome: "default-actor" });
  });

  it("uses default-actor for a non-JSON-RPC JSON body", () => {
    // Valid JSON but not the JSON-RPC envelope
    // shape — no `method` field, or `method` is not
    // "initialize". Same fallback: default actor.
    const body = Buffer.from(JSON.stringify({ hello: "world" }));
    expect(parseInitializeBody(body)).toEqual({ outcome: "default-actor" });
  });
});

describe("handleHttpRequest first-POST branch", () => {
  // The route layer must register the session with
  // the parsed actor (not the daemon-wide default)
  // for a valid initialize, reject an initialize
  // without a valid actor with 400, and fall back to
  // the default actor for a non-initialize first
  // POST. The tests construct a real `SessionManager`
  // and a mock `McpServer`; the transport is real
  // (it is cheap to construct) and its
  // `handleRequest` is allowed to error on a
  // minimally-wired mock server — we only assert on
  // the side effects (session map state, response
  // status) that happen before the protocol work
  // would complete.

  function makeReq(body: Buffer, bearerToken: string): IncomingMessage {
    // Minimal `IncomingMessage` mock. The route
    // layer only reads `method`, `headers`, `url`,
    // and (via `readBody`) the `data` / `end` events.
    // We emit a single `data` chunk with the body,
    // then `end`, so `readBody` resolves to the
    // provided buffer. The Bearer token must match
    // `opts.bearerToken` (the route layer's
    // `validateRequest` runs first).
    const req = new EventEmitter() as unknown as IncomingMessage;
    (req as { method: string }).method = "POST";
    (req as { headers: Record<string, string> }).headers = {
      host: "127.0.0.1:7777",
      "content-type": "application/json",
      authorization: `Bearer ${bearerToken}`
    };
    (req as { url: string }).url = "/mcp";
    // Emit on the next tick so the listener
    // attached inside `readBody` is in place
    // before the `data` and `end` events fire.
    process.nextTick(() => {
      req.emit("data", body);
      req.emit("end");
    });
    return req;
  }

  function makeRes(): {
    res: ServerResponse;
    setHeader: ReturnType<typeof vi.fn>;
    writeHead: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  } {
    // `ServerResponse` mock. The route layer calls
    // `setHeader`, `writeHead(status, headers)`, and
    // `end(body?)`. The mock records each call so
    // the test can assert the response status and
    // body without a real socket.
    const setHeader = vi.fn();
    const writeHead = vi.fn().mockReturnThis();
    const end = vi.fn();
    const res = { setHeader, writeHead, end } as unknown as ServerResponse;
    return { res, setHeader, writeHead, end };
  }

  function makeServer() {
    // The transport's `connect()` only needs to
    // resolve — it does not need a real `McpServer`
    // because the test only asserts on the
    // side effects (session map, response). The
    // transport's `handleRequest` will error
    // downstream (it has no `onmessage` handler),
    // but the registration step has already
    // happened by then.
    return { connect: vi.fn().mockResolvedValue(undefined) } as unknown as McpServer;
  }

  it("registers the session with the parsed actor from initialize.params.actor", async () => {
    // Task 10: the first POST to /mcp is the MCP
    // `initialize` request. The route layer MUST
    // parse `params.actor` and register the session
    // with that actor — not with the daemon-wide
    // default. This is the spec § "actor 锁定" row
    // ("每客户端的 actor 从 initialize 中提取") plus
    // the shared-HTTP row in § 错误处理
    // ("缺 actor → 400").
    const { handleHttpRequest } = await import("../../src/mcp/http-server.js");
    const sessions = new SessionManager();
    const server = makeServer();
    const opts = {
      dataHome: home(),
      defaultActor: "default-fallback",
      activeProfile: "core",
      identityResolver: {} as never,
      memoryService: {} as never,
      capabilityStore: { hasCapability: () => false } as never,
      authorization: { actorMaxSensitivity: "normal", profile: "core" } as never,
      bind: { host: "127.0.0.1", port: 0 },
      allowedHosts: ["127.0.0.1:7777"],
      allowedOrigins: [],
      bearerToken: "test-token"
    };
    const body = Buffer.from(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-01-01",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
        actor: { kind: "user", id: "alice" }
      }
    }));
    const req = makeReq(body, opts.bearerToken);
    const { res } = makeRes();
    // The transport's `handleRequest` will throw
    // (no real `McpServer` connected; the transport
    // is constructed but its `onmessage` handler is
    // never wired up by the mock). The route layer
    // awaits the transport, so we wrap the call
    // to swallow the expected error and let the
    // test assert on the side effects that already
    // happened.
    try {
      await handleHttpRequest(req, res, server, sessions, opts);
    } catch {
      // Expected — see comment above.
    }
    // The session map must have exactly one entry,
    // and the actor must be the parsed value
    // (NOT the daemon-wide default).
    const internalMap = (sessions as unknown as {
      sessions: Map<string, { actor: SessionActor }>;
    }).sessions;
    const entries = [...internalMap.values()];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor).toEqual({ kind: "user", id: "alice" });
  });

  it("returns 400 + does not register when initialize lacks params.actor", async () => {
    // Spec § 错误处理 row: "MCP `initialize` 缺
    // `actor` → 400 + 关闭 transport（不入 map）".
    // The route layer writes a 400 response and
    // MUST NOT insert the session into the manager.
    const { handleHttpRequest } = await import("../../src/mcp/http-server.js");
    const sessions = new SessionManager();
    const server = makeServer();
    const opts = {
      dataHome: home(),
      defaultActor: "default-fallback",
      activeProfile: "core",
      identityResolver: {} as never,
      memoryService: {} as never,
      capabilityStore: { hasCapability: () => false } as never,
      authorization: { actorMaxSensitivity: "normal", profile: "core" } as never,
      bind: { host: "127.0.0.1", port: 0 },
      allowedHosts: ["127.0.0.1:7777"],
      allowedOrigins: [],
      bearerToken: "test-token"
    };
    const body = Buffer.from(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-01-01",
        capabilities: {},
        clientInfo: { name: "test", version: "1" }
      }
    }));
    const req = makeReq(body, opts.bearerToken);
    const { res, writeHead, end } = makeRes();
    await handleHttpRequest(req, res, server, sessions, opts);
    // 400 + missing_actor body.
    expect(writeHead).toHaveBeenCalledWith(400, expect.objectContaining({ "content-type": "application/json" }));
    const endArg = end.mock.calls[0]?.[0] as string | undefined;
    expect(endArg).toBeDefined();
    const parsed = JSON.parse(endArg!);
    expect(parsed.error).toBe("missing_actor");
    // Session map is empty.
    const internalMap = (sessions as unknown as {
      sessions: Map<string, unknown>;
    }).sessions;
    expect(internalMap.size).toBe(0);
  });
});
