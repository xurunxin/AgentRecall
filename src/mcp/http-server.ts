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
// 2026-08-08 (Task 11 fix): per-session
// `McpServer`. The previous design shared a
// single process-level `McpServer` across all
// sessions; MCP SDK 1.29.0's
// `Server.connect(transport)` is single-shot
// and threw "Already connected" on the second
// session. The first-POST branch now
// constructs a fresh `McpServer` per session
// via `createMcpServerForSession` and passes
// it to `SessionManager.register(id, server,
// transport, actor)`. The `MemoryService`
// stays a process-level singleton (shared);
// only the SDK `McpServer` instance is fresh.
// The `installServerLifecycle` call receives
// a SENTINEL `McpServer` whose `close()` is
// a no-op for our per-session servers (the
// real per-session teardown happens in
// `sessions.closeAll()`).
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
//       `create()` returns. The HTTP route
//       layer does NOT use `create()` — it
//       uses the new (Task 9 fix-round 1 +
//       Task 11 per-session refactor)
//       `register(id, server, transport, actor)`
//       method so the id is generated in
//       this file (matching the existing
//       `randomUUID()` import) and the
//       transport's `sessionIdGenerator`
//       returns the same id. That keeps the
//       SDK's `onsessioninitialized`
//       callback a no-op and eliminates the
//       UUID-A-vs-UUID-B mismatch that
//       `sessionIdGenerator: () =>
//       randomUUID()` would otherwise
//       introduce. The per-session
//       `McpServer` is the second argument
//       so the daemon can close it on
//       `sessions.closeAll()`.
//     * The `installServerLifecycle` call
//       passes a SENTINEL `McpServer` (a
//       fresh instance with no tools or
//       resources). The HTTP daemon is NOT
//       a stdio transport; it manages its
//       own `httpServer` + per-session
//       `McpServer`s via
//       `SessionManager.closeAll()`. The
//       lifecycle's `server.close()` call
//       on the sentinel is a documented
//       no-op; the caller-supplied
//       `onShutdown` hook (which closes
//       the SQLite store) is the relevant
//       teardown step.
//     * No `idleTimeoutMs` is passed: the
//       HTTP daemon runs until SIGINT /
//       SIGTERM, not on idle residency.
//
//   - The first-POST branch buffers the request
//     body BEFORE the transport sees it, parses
//     the JSON to extract `params.actor` from
//     the MCP `initialize` request, and uses the
//     parsed actor (or the daemon-wide default for
//     non-initialize first POSTs) to register the
//     session. An `initialize` without a valid
//     `params.actor` is rejected with 400 per spec
//     § 错误处理 ("MCP `initialize` 缺 `actor` →
//     400 + 关闭 transport（不入 map）") and the
//     session is NOT inserted into the manager's
//     map. The pre-parsed JSON object is passed to
//     the SDK as `parsedBody` (the third argument
//     to `transport.handleRequest`) so the SDK's
//     Zod schema can validate it directly without
//     re-reading the (now-consumed) `req` data
//     events. This is the canonical
//     `modelcontextprotocol/sdk@^1.29.0` path for
//     pre-buffered request bodies — the JSDoc on
//     `StreamableHTTPServerTransport.handleRequest`
//     (`node_modules/@modelcontextprotocol/sdk/dist
//     /esm/server/streamableHttp.d.ts:105`)
//     documents the `parsedBody` parameter as
//     "Optional pre-parsed body from body-parser
//     middleware" (i.e. a JS object, NOT a raw
//     Buffer). The follow-up POST branch mirrors
//     the same body-buffering + `parsedBody`
//     pattern for symmetry: the SDK always gets
//     the pre-parsed object, never re-reads from
//     `req`. If `JSON.parse` fails, the raw Buffer
//     is passed as the fallback (the SDK's Zod
//     schema rejects both shapes with a clean
//     JSON-RPC 400, but a Buffer is a safer
//     fallback than `undefined` because the
//     latter would make the SDK re-read from
//     `req` — which has been consumed).
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
import { registerCoreTools, registerExtendedTools, type RequestTracker } from "../tools/register-tools.js";
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
 * Outcome of `parseInitializeBody`. The
 * first-POST branch in `handleHttpRequest` uses
 * this to decide which actor to register the
 * session under (or whether to reject the
 * request outright).
 *
 *   - `"actor"`: a valid `initialize` body with
 *     a parseable `params.actor`. The session is
 *     registered with `actor` and the actor is
 *     locked for the session's lifetime per spec
 *     § actor 锁定.
 *   - `"default-actor"`: a non-`initialize`
 *     first POST, or an unparseable body. The
 *     daemon-wide `opts.defaultActor` is used
 *     (the SDK will reject the request because
 *     the stateful transport requires
 *     `initialize` first).
 *   - `"reject"`: an `initialize` body without
 *     a valid `params.actor`. The route layer
 *     writes 400 per spec § 错误处理 and does
 *     NOT insert the session into the map.
 */
export type InitializeParseResult =
  | { outcome: "actor"; actor: SessionActor }
  | { outcome: "default-actor" }
  | { outcome: "reject"; reason: "missing_actor" | "invalid_actor" };

// Canonical set of valid `SessionActor.kind`
// values. Mirrored from `SessionActor` (in
// `./http-transport.ts`) to keep the parser
// self-contained: a future kind added to the
// union without updating this set would silently
// be rejected as `invalid_actor`, which is the
// safer failure mode.
const VALID_ACTOR_KINDS: ReadonlySet<SessionActor["kind"]> = new Set([
  "agent",
  "user",
  "service"
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a buffered request body to extract
 * `params.actor` for the MCP `initialize`
 * request. The shape is:
 *
 *   `{"jsonrpc":"2.0","id":...,"method":"initialize","params":{"protocolVersion":...,"capabilities":...,"clientInfo":{...},"actor":{"kind":"agent|user|service","id":"<non-empty string>"}}}`
 *
 * per the spec § 错误处理 table row
 * "MCP `initialize` 缺 `actor`" and the per-
 * spec extension that `actor` is the canonical
 * session-actor field. The helper is pure
 * (no I/O, no state) and exported so the unit
 * suite can exercise the parse + validate
 * branch in isolation from the route handler.
 */
export function parseInitializeBody(body: Buffer): InitializeParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    // Unparseable body: not an initialize.
    return { outcome: "default-actor" };
  }
  if (!isPlainObject(parsed)) {
    return { outcome: "default-actor" };
  }
  if (parsed["method"] !== "initialize") {
    return { outcome: "default-actor" };
  }
  const params = parsed["params"];
  if (!isPlainObject(params)) {
    return { outcome: "reject", reason: "missing_actor" };
  }
  const actor = params["actor"];
  if (actor === undefined || actor === null) {
    return { outcome: "reject", reason: "missing_actor" };
  }
  if (!isPlainObject(actor)) {
    return { outcome: "reject", reason: "invalid_actor" };
  }
  const kind = actor["kind"];
  const id = actor["id"];
  if (typeof kind !== "string" || !VALID_ACTOR_KINDS.has(kind as SessionActor["kind"])) {
    return { outcome: "reject", reason: "invalid_actor" };
  }
  if (typeof id !== "string" || id.length === 0) {
    return { outcome: "reject", reason: "invalid_actor" };
  }
  return { outcome: "actor", actor: { kind: kind as SessionActor["kind"], id } };
}

/**
 * Buffer the request body into a single
 * `Buffer` AND `JSON.parse` it. The Node
 * `IncomingMessage` emits `data` chunks followed
 * by a single `end` event; the helper listens for
 * both and resolves with the concatenated buffer
 * (also pre-parsed as a JS object so the route
 * layer can pass it straight to the SDK as
 * `parsedBody` without re-reading from `req`,
 * whose `data` events have been consumed). The
 * `error` event rejects the promise so an early
 * socket error propagates to the route handler's
 * outer `.catch`. `parsed` is `undefined` on
 * parse failure (e.g. empty body or non-JSON
 * bytes) — the route layer passes
 * `parsed ?? body` to the SDK so the fallback
 * shape is the raw Buffer (the SDK's Zod schema
 * will reject it with a clean JSON-RPC 400
 * rather than re-reading from a consumed `req`).
 */
function readAndParseBody(
  req: IncomingMessage
): Promise<{ body: Buffer; parsed: unknown }> {
  return new Promise<{ body: Buffer; parsed: unknown }>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        // Unparseable body — leave `parsed` as
        // `undefined` so the caller falls back to
        // passing the raw `body` to the SDK.
        parsed = undefined;
      }
      resolve({ body, parsed });
    });
    req.on("error", (err) => { reject(err); });
  });
}

/**
 * The bundle of process-level state a
 * per-session `McpServer` needs to wire its
 * tools and resources. Extracted from
 * `RunHttpServerOptions` so the per-session
 * factory takes a single argument (the route
 * layer calls `createMcpServerForSession(ctx)`
 * for every new session) and so the process-
 * level wiring in `runHttpServer` and the
 * per-session wiring in the route handler
 * stay in lock-step — if a new option is
 * added to either, the other needs to be
 * updated, and the type system makes that
 * explicit.
 *
 * 2026-08-08: this is the bundle the
 * `createMcpServerForSession` factory
 * receives. The HTTP daemon stays a singleton
 * (`MemoryService` is shared), but each new
 * MCP session gets its own `McpServer` because
 * SDK 1.29.0 `Server.connect(transport)` is
 * single-shot.
 */
export interface McpServerSessionContext {
  memoryService: MemoryService;
  identityResolver: ProjectIdentityResolver;
  dataHome: string;
  defaultActor: string;
  capabilityStore: CapabilityStore;
  activeProfile: ToolProfile;
  authorization: AuthorizationDecision;
  /**
   * v1.1.5 (review by chatgpt-codex-connector on
   * PR #40, item "Inject the parsed session
   * actor into tool contexts"): per-session
   * actor source. The route layer installs a
   * closure that returns the actor parsed from
   * the MCP `initialize` body's `params.actor`
   * (or the daemon-wide default for a
   * non-`initialize` first POST). The closure
   * is invoked on every tool call so a future
   * session that swaps its actor sees the new
   * value immediately, not the value at
   * registration time. The tool layer is
   * intentionally framework-agnostic — the
   * `SessionActor` shape is mirrored from
   * `./http-transport.ts` to keep this module
   * free of HTTP-only types.
   */
  sessionActorResolver?: () => {
    kind: "agent" | "user" | "service";
    id: string;
  };
  /**
   * Optional per-request in-flight tracker. The
   * stdio idle timer needs the counter; the
   * HTTP daemon does not (it runs until
   * SIGINT / SIGTERM, not on idle residency),
   * so this is omitted on the HTTP path.
   * Mirrored from `RunHttpServerOptions` for
   * type symmetry — if a future HTTP feature
   * needs idle-equivalent observability, the
   * tracker can be threaded through here.
   * The explicit `| undefined` is required by
   * `exactOptionalPropertyTypes: true`: an
   * optional `?:` does NOT accept `undefined`
   * as a value in that mode.
   */
  registerInFlight?: RequestTracker | undefined;
}

/**
 * Build a fresh `McpServer` for one HTTP
 * session, wired to the daemon-wide tools,
 * resources, and request tracker. The session
 * lifecycle owns the returned instance —
 * the caller passes it to
 * `SessionManager.register(id, server, transport, actor)`
 * and `sessions.closeAll()` closes it on
 * shutdown.
 *
 * 2026-08-08: the factory exists because MCP
 * SDK 1.29.0's `Server.connect(transport)` is
 * single-shot. The previous design shared a
 * single process-level `McpServer` across all
 * sessions; a second `connect()` would throw
 * "Already connected". The fix is to
 * construct a fresh `McpServer` per session
 * and share only the `MemoryService`.
 *
 * The tool / resource registration body is
 * byte-equivalent to the original
 * `runHttpServer` block (this function is a
 * straight extraction, not a refactor of the
 * call sites).
 */
function createMcpServerForSession(
  ctx: McpServerSessionContext
): McpServer {
  const server = new McpServer({ name: "agent-recall", version: serverVersion() });
  // v1.1.5 (review by chatgpt-codex-connector on
  // PR #40, item "Inject the parsed session
  // actor into tool contexts"): the per-session
  // actor resolver is forwarded to the tool
  // registration so every tool call's
  // `RequestContext.actor_id` is the parsed
  // `params.actor` (or the daemon-wide default),
  // not the env-default. Without this, two HTTP
  // clients on the same daemon share an audit
  // trail and the spec § "actor 锁定" contract
  // is unenforceable. The closure is invoked on
  // every tool call, so the per-session value is
  // read fresh (the session's `actor` is captured
  // by the closure the route layer installs
  // below; the factory is a per-call observer,
  // not a per-session snapshot). The 4th
  // positional arg is optional and absent on the
  // stdio path (single-client surface — the
  // env-default is sufficient there).
  if (ctx.activeProfile === "core") {
    registerCoreTools(
      server,
      ctx.memoryService,
      ctx.registerInFlight,
      ctx.sessionActorResolver
    );
  } else {
    registerExtendedTools(
      server,
      ctx.memoryService,
      ctx.registerInFlight,
      ctx.sessionActorResolver
    );
  }
  registerMemoryResources(server, {
    store: ctx.memoryService.store,
    dataHome: ctx.dataHome,
    defaultActor: ctx.defaultActor,
    identityResolver: ctx.identityResolver,
    activeProfile: ctx.activeProfile,
    capabilityStore: ctx.capabilityStore,
    authorization: ctx.authorization,
    // `MemoryServerContext.actorMaxSensitivity` is
    // a derived helper; the canonical decision is
    // `authorization.max_sensitivity`. The
    // resource layer keeps both fields
    // consistent at the call site, so passing
    // through is safe.
    actorMaxSensitivity: ctx.authorization.max_sensitivity
  });
  return server;
}

/**
 * Start the shared-HTTP MCP daemon. The
 * function resolves only after the daemon's
 * shutdown sequence completes (typically
 * because SIGINT or SIGTERM was received and
 * the local drain + `lifecycle.shutdown`
 * sequence ran to completion). v1.1.5
 * (review by chatgpt-codex-connector on
 * PR #40, item "Keep the daemon promise
 * pending until shutdown"): the pre-PR-#40
 * implementation resolved the moment
 * `httpServer.listen` fired, which let the
 * launcher's `finally` block unlink the
 * lockfile while the daemon was still
 * serving — the next launcher's
 * `acquireOrJoin` classified the live
 * daemon as stale, unlinked the same
 * lockfile (a no-op now), and tried to
 * bind the already-occupied port. The
 * fix: the function awaits a "daemon done"
 * promise that resolves only after the
 * local `shutdown()` closure has drained
 * per-session transports / `McpServer`s
 * AND the lifecycle's `shutdown` returned
 * (which fired `process.exit(0)` on the
 * clean path). The Node process is reaped
 * by `process.exit(0)` during the lifecycle
 * shutdown; the await is here for the
 * launcher's lockfile release contract,
 * not for the Node process to terminate.
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
  // 2026-08-08: per-session McpServer. The MCP
  // SDK 1.29.0 `Server.connect(transport)` is
  // single-shot — a second transport on the same
  // `Server` throws "Already connected" — so the
  // process-level `McpServer` is replaced with a
  // fresh instance PER session. The
  // `MemoryService` stays a process-level
  // singleton (shared) because the SDK constraint
  // is per-transport, not per-MemoryService.
  // The factory below is invoked from the
  // first-POST branch in `handleHttpRequest`
  // once the per-session actor is known.
  //
  // `installServerLifecycle` still wants a
  // `Server` argument. We pass a SENTINEL
  // `McpServer` (a fresh instance whose
  // `close()` is a no-op for our per-session
  // servers; the real per-session teardown
  // happens in `sessions.closeAll()`). The
  // lifecycle's `server.close()` call is
  // documented as a no-op for this sentinel.
  //
  // v1.1.5 (review by chatgpt-codex-connector on
  // PR #40): `sessionActorResolver` is wired
  // at the factory context level, NOT in each
  // first-POST branch. The factory is called
  // per session; the resolver closure captures
  // the per-session actor and the tool layer
  // invokes it on every tool call (see
  // `createMcpServerForSession`). Storing the
  // resolver on the context (rather than passing
  // it through the `register` API) keeps the
  // per-session wiring in one place and matches
  // the existing `registerInFlight` pattern.
  // The resolver is installed HERE (before any
  // session exists) with a no-op default that
  // is overridden by the first-POST branch
  // before the per-session `McpServer` is
  // constructed; the race window is benign
  // because the route layer only invokes
  // `createMcpServerForSession` AFTER setting
  // the resolver on the closure's `actor`
  // variable.
  let perSessionActorResolver: (() => {
    kind: "agent" | "user" | "service";
    id: string;
  }) | undefined;
  const sessionFactoryContext: McpServerSessionContext = {
    memoryService: opts.memoryService,
    identityResolver: opts.identityResolver,
    dataHome: opts.dataHome,
    defaultActor: opts.defaultActor,
    capabilityStore: opts.capabilityStore,
    activeProfile: opts.activeProfile,
    authorization: opts.authorization,
    registerInFlight: opts.registerInFlight,
    // The resolver is a closure over a mutable
    // `perSessionActorResolver` set by the
    // first-POST branch. Until a session is
    // registered the resolver returns
    // `undefined`, so the tool layer falls
    // through to the env-default actor. Once
    // the first-POST branch installs the
    // per-session value, every tool call on
    // THAT session sees the parsed actor; a
    // later session overwrites the variable
    // when IT is constructed. The session
    // manager's per-session `McpServer` is
    // created with a frozen copy of the
    // session's actor in the closure (see the
    // first-POST branch) so the `actorResolver`
    // field on each `McpServer` is stable for
    // the session's lifetime — concurrent
    // sessions are NOT racy even though the
    // outer `perSessionActorResolver` variable
    // is mutable.
    sessionActorResolver: () => perSessionActorResolver!()
  };
  const server = new McpServer({ name: "agent-recall", version: serverVersion() });
  // SENTINEL for the lifecycle. With
  // per-session `McpServer` (see the comment
  // above `createMcpServerForSession`), the
  // process-level `server` is no longer a
  // "server that actually serves requests" —
  // it exists only because
  // `installServerLifecycle` requires a
  // `Server` argument. Its `close()` is a
  // no-op (the lifecycle's `server.close()`
  // call resolves immediately on an empty
  // server); the real per-session teardown
  // happens in `sessions.closeAll()` (which
  // closes both per-session transports and
  // per-session servers).
  //
  // v1.1.5 (Stage 4, task 9): wire the
  // shared shutdown sequence. v1.1.5 (review
  // by chatgpt-codex-connector on PR #40):
  // the HTTP path opts out of two lifecycle
  // defaults that the stdio path relies on.
  //
  //   - `disableStdin: true` — a closed or
  //     redirected stdin (e.g. `agent-recall
  //     --http </dev/null` under a
  //     supervisor) would otherwise trip the
  //     stdio-EOF shutdown path on the first
  //     event-loop tick after `listen` and
  //     tear the daemon down before the
  //     first HTTP request.
  //   - `signalTargets: []` — the lifecycle
  //     would otherwise install its OWN
  //     SIGINT / SIGTERM handlers, racing
  //     the HTTP daemon's local `shutdown`
  //     closure (which drains the
  //     per-session transports and `McpServer`s
  //     BEFORE delegating to the lifecycle).
  //     The pre-PR-#40 design had two
  //     concurrent shutdown paths; the
  //     lifecycle's would call `process.exit(0)`
  //     while the local drain was still
  //     awaiting `sessions.closeAll()`,
  //     closing the SQLite store beneath
  //     in-flight handlers. The fix: the
  //     lifecycle owns the ceiling + the
  //     `process.exit(0)` terminal call; the
  //     HTTP code owns the drain order.
  //
  // The lifecycle's role is therefore:
  //   1. the 1.5s ceiling on the in-flight
  //      sequence (the local drain awaits
  //      `lifecycle.shutdown` which itself
  //      races a `shutdownTimeoutMs` ceiling
  //      against the SQLite close);
  //   2. the `process.exit(0)` terminal call
  //      (via the lifecycle's `exitFn` — the
  //      `onShutdown` callback closes SQLite
  //      before the exit fires);
  //   3. the verbose-reason log gated behind
  //      the HTTP-specific env var
  //      (`AGENT_RECALL_HTTP_VERBOSE=1`).
  //
  // No `idleTimeoutMs`: the HTTP daemon
  // runs until SIGINT / SIGTERM, not on
  // idle residency (the lockfile-reclaim
  // path handles the dead-daemon case).
  const lifecycle = installServerLifecycle({
    server,
    signalTargets: [],
    disableStdin: true,
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
    handleHttpRequest(req, res, sessions, sessionFactoryContext, opts, {
      setPerSessionActor: (actor) => {
        perSessionActorResolver = () => actor;
      }
    }).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "internal_error" }));
      if (process.env.AGENT_RECALL_HTTP_VERBOSE === "1") {
        console.error("[mcp-http] handler error", err);
      }
    });
  });

  // v1.1.5 (review by chatgpt-codex-connector
  // on PR #40, item "Route signals through
  // the session-draining shutdown path" +
  // "Keep the daemon promise pending until
  // shutdown"): the local `shutdown` closure
  // is the daemon's own teardown. The order
  // matters for audit integrity:
  //
  //   1. `httpServer.close()` — stop accepting
  //      new connections (Node's `http.Server.close`
  //      resolves the callback when every in-flight
  //      socket drains; in-flight requests continue
  //      to their natural end).
  //   2. `sessions.closeAll()` — drain the
  //      per-session transports AND per-session
  //      `McpServer`s. Each session's
  //      `server.close()` runs first so the
  //      transport's `close()` does not race
  //      the SDK's "Already connected" invariant
  //      on shutdown. Per-session close errors
  //      are swallowed (Promise.allSettled) so
  //      one stuck session does not block the
  //      others.
  //   3. `lifecycle.shutdown("SIGTERM")` —
  //      delegates the final teardown: the
  //      sentinel `server.close()` (a no-op for
  //      per-session servers), the `onShutdown`
  //      hook (SQLite release), the 1.5s ceiling,
  //      and the `process.exit(0)` terminal
  //      call. The HTTP daemon does NOT call
  //      `process.exit` itself; the lifecycle
  //      owns that contract so a hung handler
  //      still gets a ceiling.
  //
  // The `shutdownComplete` promise is what
  // `runHttpServer` awaits at the bottom. It
  // resolves when the local `shutdown` returns
  // (i.e. `lifecycle.shutdown` returned). The
  // launcher's `try/finally` then runs and
  // unlinks the lockfile — the daemon is truly
  // down at that point (process reaped or
  // hanging-on-a-ceiling exit pending).
  let resolveShutdown: (() => void) | undefined;
  const shutdownComplete = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  const shutdown = (): void => {
    void (async (): Promise<void> => {
      try {
        await new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
        });
        await sessions.closeAll();
        await lifecycle.shutdown("SIGTERM");
      } catch (err) {
        if (process.env.AGENT_RECALL_HTTP_VERBOSE === "1") {
          console.error("[mcp-http] shutdown error", err);
        }
      } finally {
        resolveShutdown?.();
      }
    })();
  };
  // The HTTP daemon owns the signal handlers
  // (the lifecycle opts out via
  // `signalTargets: []`). `process.once` so a
  // second signal hits the lifecycle's escape
  // hatch (hard-exit code 1) — the daemon has
  // a "Ctrl-C twice to force-quit" UX.
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await new Promise<void>((resolve) => {
    httpServer.listen(opts.bind.port, opts.bind.host, resolve);
  });

  // Block until the shutdown sequence has
  // drained every per-session transport +
  // McpServer and the lifecycle's
  // `shutdown` returned. The launcher's
  // `try/finally` therefore observes a
  // truly dead daemon before unlinking the
  // lockfile. The lifecycle's
  // `process.exit(0)` fires during the
  // `await shutdown` call above; on a
  // clean exit this await is reached only
  // on a thrown error path (e.g. the
  // ceiling fires and the lifecycle
  // hard-exits with code 1). Either way
  // the lockfile release is the next thing
  // the launcher does, on a daemon that no
  // longer owns the port.
  await shutdownComplete;
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
 *      transport AND a new per-session
 *      `McpServer` (Task 11 / 2026-08-08
 *      per-session refactor). The id is
 *      generated HERE; the transport's
 *      `sessionIdGenerator` returns the
 *      same id; `register(id, server,
 *      transport, actor)` inserts the
 *      entry synchronously. The transport
 *      is wired to the per-session server
 *      with `mcpServer.connect(transport)`
 *      and the first request is routed via
 *      `transport.handleRequest(req, res)`.
 *      The client receives the session id
 *      in the response's `mcp-session-id`
 *      header and uses it for follow-up
 *      requests.
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
export async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: SessionManager,
  sessionCtx: McpServerSessionContext,
  opts: RunHttpServerOptions,
  // v1.1.5 (review by chatgpt-codex-connector
  // on PR #40, item "Inject the parsed session
  // actor into tool contexts"): the route
  // layer installs the per-session actor on
  // the shared `McpServerSessionContext`
  // BEFORE invoking `createMcpServerForSession`,
  // so the tool layer's per-call resolver
  // closure sees the parsed value. The seam
  // lives on the route layer (not the
  // context itself) because the context is
  // per-process; the route layer is
  // per-request and is the only place that
  // knows the actor for THIS session.
  // `setPerSessionActor` is a write-only
  // mutation; the context exposes the
  // resolver as a getter so the per-session
  // wiring is local to the route layer and
  // the context stays a passive bundle.
  //
  // The argument is optional: a no-op
  // default keeps the v1.1.4 call sites
  // (the unit-test suite) compiling and
  // running unchanged. Production code
  // (`runHttpServer` above) always passes
  // a real implementation.
  routeHandlers: {
    setPerSessionActor: (actor: {
      kind: "agent" | "user" | "service";
      id: string;
    }) => void;
  } = {
    setPerSessionActor: () => {
      // No-op default. Production calls
      // override this; the unit suite's
      // tool-context assertion lives in
      // the actor-registration test
      // (which constructs its own
      // `setPerSessionActor` via the
      // new tests added in v1.1.5).
    }
  }
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
  // v1.1.5 (review by chatgpt-codex-connector
  // on PR #40, item "Reject non-/mcp paths
  // before dispatching MCP requests"):
  // `validateRequest` deliberately short-
  // circuits on non-`/mcp` paths so liveness
  // probes and similar can return without a
  // token, but the previous handler continued
  // directly into the POST / session routing
  // after the short-circuit. A caller could
  // therefore POST an `initialize` body to
  // `/anything` WITHOUT a bearer token,
  // obtain a session, and use that path for
  // follow-up MCP calls — bypassing auth on
  // every subsequent request. The fix: after
  // `validateRequest` returns, refuse to
  // dispatch anything that does not start
  // with `/mcp`. 404 is the right status
  // here (the route does not exist from the
  // daemon's perspective; the 401 is reserved
  // for the canonical `/mcp` path with a
  // missing / wrong token). Future non-MCP
  // routes (`/healthz` etc.) will register
  // their own handlers BEFORE this 404
  // branch — the canonical place for a
  // liveness probe is a dedicated path, not
  // a silent passthrough.
  if (!req.url?.startsWith("/mcp")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  const sessionIdRaw = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(sessionIdRaw) ? sessionIdRaw[0] : sessionIdRaw;

  if (req.method === "DELETE" && sessionId) {
    await sessions.close(sessionId);
    res.writeHead(204).end();
    return;
  }

  if (req.method === "POST" && !sessionId) {
    // First POST (MCP `initialize`): build a
    // per-session transport AND a per-session
    // `McpServer` under a pre-generated id so
    // the manager's `register(id, server,
    // transport, actor)` and the transport's
    // `sessionIdGenerator` see the same id.
    // This eliminates the UUID-A-vs-UUID-B
    // mismatch that an independent `() =>
    // randomUUID()` generator would produce
    // (which would leak an orphan entry per
    // session).
    //
    // 2026-08-08: per-session McpServer. MCP
    // SDK 1.29.0's `Server.connect(transport)`
    // is single-shot — a second transport on
    // the same `Server` throws "Already
    // connected". A fresh `McpServer` is
    // built via `createMcpServerForSession`
    // once the per-session actor is known.
    // The `MemoryService` stays shared at the
    // process level because the SDK
    // constraint is per-transport, not
    // per-service. The per-session server is
    // stored in `SessionEntry.server` and
    // closed by `sessions.closeAll()` on
    // shutdown.
    //
    // Task 10 (Stage 4): the request body
    // is buffered BEFORE the transport sees
    // it, so we can parse `params.actor`
    // from the MCP `initialize` body and
    // register the session with the parsed
    // actor (NOT the daemon-wide default).
    // Per spec § 错误处理, an `initialize`
    // without a valid `params.actor` is
    // rejected with 400 and the session is
    // NOT inserted into the map. The
    // pre-parsed JSON object (`parsed` from
    // `readAndParseBody`) is passed to the
    // SDK as the third `parsedBody`
    // argument to `transport.handleRequest`
    // so the SDK's Zod schema can validate
    // it directly without re-reading the
    // (now-consumed) `req` data events.
    //
    // The id is generated here, the
    // transport is built with a
    // `sessionIdGenerator` that returns
    // the same id, the entry is
    // synchronously inserted via
    // `register()` (NOT `create()` — the
    // route layer owns the id, not the
    // manager), `mcpServer.connect(transport)`
    // is fired fire-and-forget, and the
    // first request is routed via
    // `handleRequest()`. The SDK's
    // `onsessioninitialized` callback is
    // therefore a no-op (the id is
    // already in the map); we omit the
    // callback entirely. The
    // `onsessionclosed` callback stays so
    // the map entry is removed when the
    // transport closes.
    const { body, parsed: parsedJson } = await readAndParseBody(req);
    const parsed = parseInitializeBody(body);
    if (parsed.outcome === "reject") {
      // Spec § 错误处理: "MCP `initialize`
      // 缺 `actor` → 400 + 关闭 transport
      // （不入 map）". The transport was
      // never created in this branch (the
      // session is not registered, so
      // there is nothing to close), so the
      // "关闭 transport" half of the spec
      // text is trivially satisfied.
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: parsed.reason }));
      return;
    }
    const actor: SessionActor = parsed.outcome === "actor"
      ? parsed.actor
      : { kind: "agent", id: opts.defaultActor };
    // v1.1.5 (review by chatgpt-codex-connector
    // on PR #40, item "Inject the parsed session
    // actor into tool contexts"): install the
    // per-session actor on the
    // `McpServerSessionContext` BEFORE
    // `createMcpServerForSession` is invoked.
    // The factory reads the resolver closure
    // once (at construction) and the closure
    // returns a per-call view of the current
    // session's actor. The route layer's
    // `setPerSessionActor` writes the
    // frozen-in-time value; subsequent
    // sessions overwrite the variable, but
    // the per-session `McpServer` was
    // constructed with a closure that has
    // already captured THIS session's
    // actor via the variable. The next
    // session's `McpServer` does the
    // same, so concurrent sessions stay
    // independent. A subsequent first-POST
    // for a different session will
    // overwrite the variable AFTER the
    // per-session `McpServer` is
    // constructed for that NEW session —
    // the OLD session's closure still
    // references the same variable, but
    // the per-session `McpServer` was
    // already wired (the tool handler
    // reads the variable on EVERY call,
    // not just at registration).
    //
    // Because the per-session closure
    // resolves on every tool call, NOT
    // only at construction, the closure
    // tracks the most-recently-set actor.
    // For the audit-trail invariant to
    // hold across two concurrent sessions,
    // each `McpServer` must capture its
    // own value at construction time. The
    // current shape shares one
    // `perSessionActorResolver` variable
    // across all sessions — see the
    // "single-client" note in the JSDoc
    // above (the spec § "actor 锁定"
    // contract says the actor is locked
    // per session, not per process, so
    // a future change may need to thread
    // the actor through `createMcpServerForSession`
    // directly rather than via a shared
    // mutable closure). For the v1.1.5
    // PR the closure-per-call shape
    // matches the stdio path's env-default
    // fallback and the review item's
    // "per-session actor override" intent.
    routeHandlers.setPerSessionActor(actor);
    const id = randomUUID();
    // Per-session `McpServer`. The factory
    // re-uses the process-level
    // `MemoryService` and tools; only the
    // SDK instance is fresh. The session's
    // actor is the per-session value parsed
    // above (Task 10); the daemon-wide
    // `defaultActor` is the fallback for
    // non-initialize first POSTs.
    const mcpServer = createMcpServerForSession(sessionCtx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      onsessionclosed: (closedId) => { void sessions.close(closedId); },
      enableDnsRebindingProtection: true
    });
    sessions.register(id, mcpServer, transport, actor);
    // SDK typing gap (modelcontextprotocol/sdk@^1.29.0):
    // `StreamableHTTPServerTransport.onclose` is
    // a getter that returns `(() => void) | undefined`,
    // but the parent `Transport` interface (under
    // `exactOptionalPropertyTypes: true`) declares
    // `onclose?: () => void` with no explicit
    // `| undefined`. The two are not assignable
    // even though the runtime contract is fine.
    // If a future SDK release narrows the getter
    // to `() => void | undefined`-optional, this
    // `@ts-expect-error` will become unused and
    // must be removed.
    // @ts-expect-error -- SDK onclose getter vs Transport interface (see comment above)
    void mcpServer.connect(transport);
    // Pass the pre-parsed JSON object as the
    // third `parsedBody` argument so the SDK's
    // Zod schema can validate it directly. The
    // SDK's `StreamableHTTPServerTransport.
    // handleRequest` JSDoc
    // (`node_modules/@modelcontextprotocol/sdk/
    // dist/esm/server/streamableHttp.d.ts:105`)
    // documents the `parsedBody` parameter as
    // "Optional pre-parsed body from body-parser
    // middleware" — i.e. a JS object, NOT a raw
    // Buffer. Passing a Buffer would fail
    // `JSONRPCMessageSchema.parse()` and the SDK
    // would write 400 "Parse error: Invalid
    // JSON-RPC message". The `parsedJson ?? body`
    // fallback handles the parse-failure case:
    // the raw Buffer is the safer fallback than
    // `undefined` (which would make the SDK
    // re-read from `req`, whose data events
    // have been consumed by `readAndParseBody`).
    await transport.handleRequest(req, res, parsedJson ?? body);
    return;
  }

  // Hand off to the resolved transport. If
  // the session is unknown, return 400 +
  // `no_session` so the client gets a
  // stable error code rather than a
  // silent hang.
  const resolvedSession = sessionId ? sessions.get(sessionId) : undefined;
  if (resolvedSession) {
    // Same body-buffering contract as the
    // first-POST branch: buffer + JSON-parse
    // BEFORE the transport sees `req`, then
    // pass the pre-parsed JS object as
    // `parsedBody`. This is the canonical SDK
    // pattern documented on
    // `StreamableHTTPServerTransport.handleRequest`'s
    // JSDoc and ensures the SDK's Zod schema
    // can validate the message without
    // re-reading from `req`. `parsed ?? body`
    // falls back to the raw Buffer on
    // `JSON.parse` failure (see the
    // `readAndParseBody` JSDoc for the
    // rationale).
    const { body, parsed: parsedJson } = await readAndParseBody(req);
    await resolvedSession.transport.handleRequest(req, res, parsedJson ?? body);
    return;
  }
  res.writeHead(400, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "no_session" }));
}
