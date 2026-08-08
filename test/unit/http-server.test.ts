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
    // and (via `readAndParseBody`) the `data` / `end`
    // events. We emit a single `data` chunk with
    // the body, then `end`, so `readAndParseBody`
    // resolves to the provided buffer. The Bearer
    // token must match `opts.bearerToken` (the
    // route layer's `validateRequest` runs first).
    //
    // The test spies on
    // `StreamableHTTPServerTransport.prototype.handleRequest`
    // (see below) so the SDK's Hono-based
    // response writer is NOT actually invoked.
    // This keeps the mock minimal — we only
    // assert on the `parsedBody` argument the
    // route layer passes to the SDK, not on the
    // SDK's own response writing.
    const req = new EventEmitter() as unknown as IncomingMessage;
    (req as { method: string }).method = "POST";
    (req as { headers: Record<string, string> }).headers = {
      host: "127.0.0.1:7777",
      "content-type": "application/json",
      authorization: `Bearer ${bearerToken}`
    };
    (req as { url: string }).url = "/mcp";
    // Emit on the next tick so the listener
    // attached inside `readAndParseBody` is in
    // place before the `data` and `end` events
    // fire.
    process.nextTick(() => {
      req.emit("data", body);
      req.emit("end");
    });
    return req;
  }

  function makeReqWithSessionId(
    body: Buffer,
    bearerToken: string,
    sessionId: string
  ): IncomingMessage {
    // Same as `makeReq` but with an `mcp-session-id`
    // header so the route layer's follow-up branch
    // resolves the session via `sessions.get(id)`.
    // See `makeReq` for the mock's rationale.
    const req = new EventEmitter() as unknown as IncomingMessage;
    (req as { method: string }).method = "POST";
    (req as { headers: Record<string, string> }).headers = {
      host: "127.0.0.1:7777",
      "content-type": "application/json",
      authorization: `Bearer ${bearerToken}`,
      "mcp-session-id": sessionId
    };
    (req as { url: string }).url = "/mcp";
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
    // body without a real socket. The transport's
    // `handleRequest` is spied on (see below), so
    // the Hono adapter's response writer is NOT
    // actually invoked — the mock doesn't need a
    // `write` method for SSE streaming.
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

  function makeSessionCtx(opts: {
    memoryService?: unknown;
    identityResolver?: unknown;
    dataHome?: string;
    defaultActor?: string;
    capabilityStore?: unknown;
    activeProfile?: "core" | "extended";
    authorization?: unknown;
  } = {}) {
    // Minimal stand-in for the
    // `McpServerSessionContext` shape the
    // route layer hands to
    // `createMcpServerForSession`. The
    // factory reads `ctx.memoryService.store`
    // eagerly (it destructures it into the
    // resource-context object), so the
    // default below provides a `store`
    // shim. The tool handlers and resource
    // callbacks are never invoked in these
    // tests (the SDK's `handleRequest` is
    // spied on), so the shim's internals do
    // not need to be real.
    return {
      memoryService: { store: {} },
      identityResolver: {} as never,
      dataHome: opts.dataHome ?? home(),
      defaultActor: opts.defaultActor ?? "default-fallback",
      capabilityStore: { hasCapability: () => false },
      activeProfile: opts.activeProfile ?? "core",
      authorization: { max_sensitivity: "normal", actorMaxSensitivity: "normal" } as never,
      ...(opts.memoryService ? { memoryService: opts.memoryService } : {}),
      ...(opts.identityResolver ? { identityResolver: opts.identityResolver } : {}),
      ...(opts.capabilityStore ? { capabilityStore: opts.capabilityStore } : {}),
      ...(opts.authorization ? { authorization: opts.authorization } : {})
    } as Parameters<typeof import("../../src/mcp/http-server.js").handleHttpRequest>[3];
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
    //
    // Task 10 fix round 2: the test MUST also
    // assert on the `parsedBody` argument the
    // route layer passes to
    // `transport.handleRequest`. A raw Buffer
    // here means the SDK's Zod schema would
    // reject it with 400 "Parse error: Invalid
    // JSON-RPC message" — the original task-10
    // bug. A pre-parsed JS object passes the
    // Zod validation. The test spies on
    // `StreamableHTTPServerTransport.prototype.
    // handleRequest` to capture the call
    // arguments directly, bypassing the SDK's
    // Hono-based response writer (which is hard
    // to mock fully in a unit test — the mock
    // `ServerResponse` is too minimal for SSE
    // streaming, and the Hono adapter's body
    // drain fails on a plain `EventEmitter`
    // IncomingMessage, writing a 500 from
    // `handleFetchError` regardless of whether
    // the route layer's `parsedBody` is correct).
    const { handleHttpRequest } = await import("../../src/mcp/http-server.js");
    const { StreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/streamableHttp.js"
    );
    const handleRequestSpy = vi.spyOn(
      StreamableHTTPServerTransport.prototype,
      "handleRequest"
    ).mockResolvedValue(undefined);
    try {
      const sessions = new SessionManager();
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
      const sessionCtx = makeSessionCtx();
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
      await handleHttpRequest(req, res, sessions, sessionCtx, opts);
      // The session map must have exactly one entry,
      // and the actor must be the parsed value
      // (NOT the daemon-wide default).
      const internalMap = (sessions as unknown as {
        sessions: Map<string, { actor: SessionActor }>;
      }).sessions;
      const entries = [...internalMap.values()];
      expect(entries).toHaveLength(1);
      expect(entries[0]?.actor).toEqual({ kind: "user", id: "alice" });
      // The route layer MUST have called the
      // SDK's `handleRequest` with a pre-parsed
      // JS object as the third `parsedBody`
      // argument (NOT a raw Buffer). The SDK's
      // JSDoc documents `parsedBody` as
      // "Optional pre-parsed body from
      // body-parser middleware" — a JS object.
      // A Buffer would fail the SDK's
      // `JSONRPCMessageSchema.parse()` and
      // return 400 "Parse error: Invalid
      // JSON-RPC message". The fix passes the
      // pre-parsed JS object.
      expect(handleRequestSpy).toHaveBeenCalledTimes(1);
      const thirdArg = handleRequestSpy.mock.calls[0]?.[2];
      // The third argument must be a JS object
      // (the pre-parsed JSON), NOT a Buffer.
      expect(Buffer.isBuffer(thirdArg)).toBe(false);
      expect(thirdArg).toBeTypeOf("object");
      expect(thirdArg).not.toBeNull();
      // The pre-parsed object must have the
      // JSON-RPC `initialize` shape — the SDK
      // validates this via Zod.
      expect(thirdArg).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize"
      });
    } finally {
      handleRequestSpy.mockRestore();
    }
  });

  it("returns 400 + does not register when initialize lacks params.actor", async () => {
    // Spec § 错误处理 row: "MCP `initialize` 缺
    // `actor` → 400 + 关闭 transport（不入 map）".
    // The route layer writes a 400 response and
    // MUST NOT insert the session into the manager.
    const { handleHttpRequest } = await import("../../src/mcp/http-server.js");
    const sessions = new SessionManager();
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
    const sessionCtx = makeSessionCtx();
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
    await handleHttpRequest(req, res, sessions, sessionCtx, opts);
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

  it("delivers follow-up POST to the resolved session transport with parsedBody", async () => {
    // Task 10 fix round 2: a follow-up POST
    // (with an `mcp-session-id` header) must
    // reach the session's transport AND the
    // route layer must pass the pre-parsed JS
    // object as `parsedBody`. The original
    // implementation called
    // `transport.handleRequest(req, res)`
    // without a `parsedBody` — the SDK would
    // read from `req` (whose data events may
    // be consumed in some flows), and even if
    // it read fresh bytes, the SDK's Zod
    // schema would still process them. The
    // fix buffers the body and passes the
    // pre-parsed JS object as `parsedBody`,
    // mirroring the first-POST branch's
    // contract. The test spies on
    // `StreamableHTTPServerTransport.prototype.
    // handleRequest` to capture the call
    // arguments (see the first-POST test for
    // the rationale on bypassing the Hono
    // adapter's response writer).
    const { handleHttpRequest } = await import("../../src/mcp/http-server.js");
    const { StreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/streamableHttp.js"
    );
    const handleRequestSpy = vi.spyOn(
      StreamableHTTPServerTransport.prototype,
      "handleRequest"
    ).mockResolvedValue(undefined);
    try {
      const sessions = new SessionManager();
      // Pre-register a session under a fixed
      // id so the follow-up branch can resolve
      // it via `sessions.get(id)`.
      const followUpSessionId = "00000000-0000-0000-0000-000000000001";
      const followUpServer = makeServer();
      const followUpTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => followUpSessionId,
        enableDnsRebindingProtection: true
      });
      sessions.register(followUpSessionId, followUpServer, followUpTransport, { kind: "user", id: "alice" });
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
      const sessionCtx = makeSessionCtx();
      // A `tools/list` JSON-RPC body. NOT an
      // `initialize` — the follow-up branch
      // already has the session id from the
      // header, so this exercises the second-
      // request path.
      const body = Buffer.from(JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {}
      }));
      const req = makeReqWithSessionId(body, opts.bearerToken, followUpSessionId);
      const { res } = makeRes();
      await handleHttpRequest(req, res, sessions, sessionCtx, opts);
      // The follow-up branch must have called
      // the pre-registered transport's
      // `handleRequest` (NOT the first-POST
      // branch, which would create a NEW
      // transport).
      expect(handleRequestSpy).toHaveBeenCalledTimes(1);
      const thirdArg = handleRequestSpy.mock.calls[0]?.[2];
      // The third argument must be a JS
      // object (the pre-parsed JSON), NOT a
      // Buffer and NOT `undefined`. Passing
      // `undefined` would make the SDK re-read
      // from `req` (whose data events have
      // been consumed by `readAndParseBody`).
      // Passing a Buffer would fail the SDK's
      // Zod validation with 400 "Parse error".
      expect(Buffer.isBuffer(thirdArg)).toBe(false);
      expect(thirdArg).toBeTypeOf("object");
      expect(thirdArg).not.toBeNull();
      expect(thirdArg).not.toBeUndefined();
      // The pre-parsed object must have the
      // JSON-RPC `tools/list` shape.
      expect(thirdArg).toMatchObject({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list"
      });
      // The session map still has exactly one
      // entry (the pre-registered one) — the
      // follow-up branch did NOT create a new
      // session.
      const internalMap = (sessions as unknown as {
        sessions: Map<string, { actor: SessionActor }>;
      }).sessions;
      const entries = [...internalMap.values()];
      expect(entries).toHaveLength(1);
      expect(entries[0]?.actor).toEqual({ kind: "user", id: "alice" });
    } finally {
      handleRequestSpy.mockRestore();
    }
  });
});
