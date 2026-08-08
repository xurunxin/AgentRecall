// src/mcp/http-server.ts
//
// Stage 4 / Task 9 of the mcp-process-lifecycle-
// and-shared-http plan. The shared-HTTP daemon
// entry point: a real `node:http.Server` that
// listens on `127.0.0.1:port`, validates
// Bearer + Host/Origin via the Task 6
// `validateRequest` gate, and routes MCP
// requests to a per-session
// `StreamableHTTPServerTransport` registered
// with the Task 8 `SessionManager`.
//
// Design notes:
//
//   - All cross-task handoffs are honoured:
//     * `validateRequest` throws `HttpError`
//       with `error.status` (NOT
//       `error.statusCode`) — the catch arm
//       here reads `err.status` directly.
//     * The auth module is HTTP-framework-
//       agnostic by design; it does NOT
//       emit `WWW-Authenticate: Bearer`. Per
//       spec § 错误处理, the route layer is
//       responsible for setting that header
//       on the 401 path. The handler below
//       does so explicitly.
//     * The auth module never logs on failure
//       (the no-side-channel rule from
//       Task 6). The handler here also does
//       not log on auth failure: a single
//       `console.error` on the success path
//       (gated behind
//       `AGENT_RECALL_HTTP_VERBOSE=1`) is the
//       only stderr write in the file.
//     * `SessionManager.create()` is
//       synchronous (Task 8 contract): the
//       id is pre-generated, the entry is
//       inserted into the map before
//       `server.connect()` fires, and
//       `get(id)` is valid the moment
//       `create()` returns. The
//       `onsessioninitialized` callback's id
//       argument will always equal the
//       pre-generated id, so the
//       `forceRegister` fallback is a
//       defensive no-op for `create()`-built
//       transports; Task 10 will replace
//       the seam with explicit initialize-
//       body parsing.
//     * The `installServerLifecycle` call
//       passes `transport: undefined`. The
//       HTTP daemon is NOT a stdio transport;
//       it manages its own `httpServer` +
//       `SessionManager.closeAll()`. The
//       lifecycle's `server.close()` and the
//       caller-supplied `onShutdown` hook
//       (which closes the SQLite store) are
//       the relevant teardown steps.
//     * No `idleTimeoutMs` is passed: the
//       HTTP daemon runs until SIGINT /
//       SIGTERM, not on idle residency.
//
//   - The minimum-viable surface from the
//     brief: the daemon does NOT manage the
//     lockfile itself. The launcher calls
//     `acquireOrJoin` to derive the bearer
//     token, passes it in as `bearerToken`,
//     and the daemon uses it for auth. The
//     lockfile release is the launcher's
//     concern (it has the `lockPath`); the
//     daemon's `process.exit(0)` on shutdown
//     leaves the lockfile in place, which
//     the next launcher's `acquireOrJoin`
//     reclaims via the pid-alive probe.
//     Tracking the cleanup as a follow-up
//     is fine for this task's "minimum
//     working surface" contract; Task 10
//     will close the loop if needed.
//
//   - Precondition checks come FIRST. The
//     spec is explicit that a daemon with
//     no `allowedHosts` MUST NOT start at
//     all (the loopback + whitelist
//     contract cannot be enforced without
//     a whitelist). The test
//     `test/unit/http-server.test.ts` pins
//     the shape.
//
//   - Zero new dependencies: Node stdlib
//     (`node:http`, `node:crypto`) plus the
//     previously-shipped modules.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MemoryService } from "../memory-service.js";
import { registerCoreTools, registerExtendedTools } from "../tools/register-tools.js";
import { registerMemoryResources } from "./resources.js";
import type { ToolProfile } from "../tools/profile.js";
import { ProjectIdentityResolver } from "../scope-resolver.js";
import { serverVersion } from "../server-version.js";
import { CapabilityStore } from "../admin/capability.js";
import type { AuthorizationDecision } from "../services/auth-context.js";
import { installServerLifecycle } from "./server-lifecycle.js";
import { SessionManager, type SessionActor } from "./http-transport.js";
import { validateRequest, HttpError } from "./auth.js";

/**
 * The complete option surface `runHttpServer`
 * needs from the launcher. The launcher wires
 * the per-process state (data home, active
 * profile, capability, memory service, identity
 * resolver, bind config, host / origin
 * whitelists, bearer token) once and hands the
 * bundle to this function.
 */
export interface RunHttpServerOptions {
  dataHome: string;
  defaultActor: string;
  activeProfile: ToolProfile;
  identityResolver: ProjectIdentityResolver;
  memoryService: MemoryService;
  capabilityStore: CapabilityStore;
  authorization: AuthorizationDecision;
  bind: { host: string; port: number };
  allowedHosts: string[];
  allowedOrigins: string[];
  bearerToken: string;
  registerInFlight?: { onStart: () => void; onEnd: () => void };
}

/**
 * Start the shared-HTTP MCP daemon. The
 * function resolves only after the daemon's
 * shutdown sequence completes (typically
 * because SIGINT or SIGTERM was received and
 * the `installServerLifecycle` ceiling kicked
 * in); under normal operation the Node
 * process is reaped before this returns via
 * the lifecycle's `process.exit(0)` call.
 *
 * The function is fail-closed: an empty
 * `allowedHosts` throws before any network
 * resource is allocated, so a misconfigured
 * daemon cannot accidentally serve on an
 * open host.
 */
export async function runHttpServer(opts: RunHttpServerOptions): Promise<void> {
  if (!opts.allowedHosts || opts.allowedHosts.length === 0) {
    // Spec § 共享安全: a daemon with no
    // whitelist cannot enforce loopback /
    // DNS-rebinding protection, so the
    // safe behaviour is to refuse to start.
    // The unit test pins this message so a
    // future refactor cannot silently widen
    // the precondition.
    throw new Error("allowedHosts must be non-empty");
  }
  const sessions = new SessionManager();
  const server = new McpServer({ name: "agent-recall", version: serverVersion() });
  if (opts.activeProfile === "core") {
    registerCoreTools(server, opts.memoryService, opts.registerInFlight);
  } else {
    registerExtendedTools(server, opts.memoryService, opts.registerInFlight);
  }
  registerMemoryResources(server, {
    store: opts.memoryService.store,
    dataHome: opts.dataHome,
    defaultActor: opts.defaultActor,
    identityResolver: opts.identityResolver,
    activeProfile: opts.activeProfile,
    capabilityStore: opts.capabilityStore,
    authorization: opts.authorization,
    // `MemoryServerContext.actorMaxSensitivity` is
    // a derived helper; the canonical decision is
    // `authorization.max_sensitivity`. The
    // resource layer keeps both fields
    // consistent at the call site, so passing
    // through is safe.
    actorMaxSensitivity: opts.authorization.max_sensitivity
  });
  // v1.1.5 (Stage 4, task 9): wire the
  // shared shutdown sequence. The `transport`
  // option is omitted (rather than passed as
  // `undefined`) because the HTTP daemon owns
  // its own `httpServer.close()` and the
  // per-session transport cleanup (see the
  // `shutdown` closure below). The lifecycle's
  // role is the 1.5s ceiling on the in-flight
  // sequence, the SIGINT / SIGTERM trigger,
  // the `process.exit(0)` terminal call, and
  // the verbose-reason log gated behind the
  // HTTP-specific env var. No `idleTimeoutMs`:
  // the HTTP daemon runs until SIGINT / SIGTERM,
  // not on idle residency (the lockfile-reclaim
  // path handles the dead-daemon case).
  const lifecycle = installServerLifecycle({
    server,
    onShutdown: () => opts.memoryService.store.close(),
    onShutdownError: (e) => {
      // Diagnostics to stderr, never stdout.
      // The HTTP daemon does not own an
      // outbound stream, so a leak here is
      // not a protocol concern; we still
      // keep it inside the lifecycle's
      // error sink so the hot path stays
      // quiet on the success path.
      console.error("[mcp-http] shutdown error", e);
    },
    onShutdownStart: (r) => {
      if (process.env.AGENT_RECALL_HTTP_VERBOSE === "1") {
        console.error(`[mcp-http] shutdown (${r})`);
      }
    },
    shutdownTimeoutMs: 1500
  });

  const httpServer = createServer((req, res) => {
    handleHttpRequest(req, res, server, sessions, opts).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "internal_error" }));
      if (process.env.AGENT_RECALL_HTTP_VERBOSE === "1") {
        console.error("[mcp-http] handler error", err);
      }
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(opts.bind.port, opts.bind.host, resolve);
  });

  // The local shutdown closure is the
  // daemon's own teardown: stop accepting
  // new connections, drain the per-session
  // transports, then hand off to the
  // lifecycle for the final
  // `server.close` + `onShutdown` (SQLite
  // release) sequence plus the 1.5s
  // ceiling.
  const shutdown = async (): Promise<void> => {
    httpServer.close();
    await sessions.closeAll();
    await lifecycle.shutdown("SIGTERM");
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}

/**
 * Per-request route handler. The flow is:
 *
 *   1. Run the auth gate. On failure,
 *      translate the `HttpError` into a
 *      status + JSON body. The 401 path
 *      ALSO sets `WWW-Authenticate: Bearer`
 *      per spec § 错误处理 (the auth module
 *      does not emit the header by design).
 *   2. `DELETE` with a session id closes
 *      the session and returns 204.
 *   3. `POST` without a session id
 *      constructs a new per-session
 *      transport and registers it via
 *      `SessionManager.create`. The
 *      transport's `onsessioninitialized`
 *      callback carries a `forceRegister`
 *      fallback (defensive no-op for
 *      `create()`-built transports; the
 *      seam is for Task 10's
 *      initialize-body parsing).
 *   4. Otherwise, hand off to the resolved
 *      transport. If the session is
 *      unknown, return 400 + `no_session`.
 *
 * The handler is async; the wrapping
 * `createServer` callback catches any
 * rejection with a generic 500 so an
 * unhandled error does not leave the
 * connection hanging.
 */
async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  server: McpServer,
  sessions: SessionManager,
  opts: RunHttpServerOptions
): Promise<void> {
  try {
    validateRequest({
      req,
      expectedToken: opts.bearerToken,
      allowedHosts: opts.allowedHosts,
      allowedOrigins: opts.allowedOrigins ?? [],
      enforcePathPrefix: "/mcp"
    });
  } catch (err) {
    if (err instanceof HttpError) {
      // Per spec § 错误处理: a 401 must
      // carry the `WWW-Authenticate: Bearer`
      // challenge so a client can discover
      // the auth scheme without a 401 +
      // opaque JSON body. The auth module
      // is framework-agnostic and does not
      // emit this header, so the route
      // layer is the canonical writer. 403
      // paths (host / origin whitelist
      // misses) do NOT carry the header —
      // they are not auth challenges.
      if (err.status === 401) {
        res.setHeader("WWW-Authenticate", "Bearer");
      }
      res.writeHead(err.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.reason }));
      return;
    }
    throw err;
  }

  const sessionIdRaw = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(sessionIdRaw) ? sessionIdRaw[0] : sessionIdRaw;

  if (req.method === "DELETE" && sessionId) {
    await sessions.close(sessionId);
    res.writeHead(204).end();
    return;
  }

  if (req.method === "POST" && !sessionId) {
    // Build the per-session transport. The
    // transport's `sessionIdGenerator` is
    // independent of the SessionManager's
    // pre-generated id; the
    // `onsessioninitialized` callback is
    // therefore the seam where Task 10
    // will parse the initialize body to
    // extract an actor override. For Task
    // 9's minimum, the callback registers
    // the default actor via `forceRegister`
    // IF the id is not already in the map
    // (defensive — `create()` populates
    // the map synchronously with the
    // default actor, so the fallback is a
    // no-op for the current path).
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        const actor: SessionActor = { kind: "agent", id: opts.defaultActor };
        sessions.get(id) ?? sessions.forceRegister(id, transport, actor);
      },
      onsessionclosed: (id) => { void sessions.close(id); },
      enableDnsRebindingProtection: true
    });
    // Synchronous register per Task 8
    // contract: the entry is in the map
    // the moment `create()` returns, so a
    // follow-up `get(id)` succeeds
    // immediately.
    sessions.create(server, { kind: "agent", id: opts.defaultActor }, { transport });
  }

  // Hand off to the resolved transport. If
  // the session is unknown, return 400 +
  // `no_session` so the client gets a
  // stable error code rather than a
  // silent hang.
  const resolvedSession = sessionId ? sessions.get(sessionId) : undefined;
  if (resolvedSession) {
    await resolvedSession.transport.handleRequest(req, res);
    return;
  }
  res.writeHead(400, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "no_session" }));
}
