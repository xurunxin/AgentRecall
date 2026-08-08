// src/mcp/http-transport.ts
//
// Session-scoped transport registry for the
// shared-HTTP MCP daemon (Task 8 / Stage 3 of the
// mcp-process-lifecycle-and-shared-http plan).
//
// Each HTTP session that talks to the daemon
// gets its own `StreamableHTTPServerTransport`,
// which is paired with the `McpServer` instance
// the daemon constructs. `SessionManager` is the
// single owner of that map: it locks the actor at
// `create()` time, hands out the per-session
// transport on `get(id)`, and tears the session
// down on `close(id)` / `closeAll()`.
//
// Design notes (controller-locked):
//
//   - `create()` is **synchronous**: it generates
//     the session id, inserts the entry into the
//     map, and then fires `server.connect(transport)`
//     (fire-and-forget) all in one call. This is the
//     only way the unit test can pass — the mock
//     `server.connect()` resolves immediately
//     without firing the SDK's
//     `onsessioninitialized` callback, so we cannot
//     rely on that callback to populate the map.
//
//   - The id is pre-generated (via `randomUUID()`)
//     and passed to the transport's
//     `sessionIdGenerator` so the transport uses
//     *our* id when the production HTTP initialize
//     path fires. This means the SDK's
//     `onsessioninitialized` will be called with the
//     same id we already have in the map; the
//     callback's `if (!this.sessions.has(id))` guard
//     makes it a defensive no-op rather than a
//     re-registration race.
//
//   - The custom-transport path (test 3) bypasses
//     the SDK constructor entirely; we still
//     generate a UUID-shaped id so the registry
//     stays consistent. The provided transport is
//     used as-is for `connect()` and `close()`.
//
//   - `forceRegister` is exposed as a
//     production HTTP route seam. It is NOT
//     used in the current Task 9 / fix-round 1
//     shape (the route layer now generates
//     the id, builds the transport with a
//     matching `sessionIdGenerator`, and calls
//     the new `register(id, transport, actor)`
//     method synchronously — so the SDK's
//     `onsessioninitialized` callback is a
//     no-op). The seam stays for Task 10's
//     explicit initialize-body parsing
//     (override the actor on the first
//     request) without forcing the
//     synchronous-insert path to widen.
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * Who is on the other end of this MCP session.
 * Locked at `create()` time; the actor for a
 * given session never changes for the lifetime
 * of the session.
 */
export interface SessionActor {
  kind: "agent" | "user" | "service";
  id: string;
}

/**
 * Bookkeeping entry for one live HTTP session.
 * `server` is the per-session `McpServer`. The
 * SDK 1.29.0 `McpServer` composes a single
 * `Server` instance internally and forwards
 * `connect(transport)` to it; that inner
 * `Server` is single-shot (a second
 * `connect()` throws "Already connected").
 * So each session gets its OWN `McpServer`
 * instance (and therefore its own inner
 * `Server`) while sharing the process-level
 * `MemoryService`. The high-level `McpServer`
 * type is used (rather than the inner
 * `Server`) because it is the surface the
 * route layer constructs and the SDK API
 * consumers use. `transport` is the SDK
 * transport bound to that server; `actor`
 * is locked at `create()`; `createdAt` is
 * the ISO-8601 timestamp the session was
 * registered.
 */
export interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  actor: SessionActor;
  createdAt: string;
}

/**
 * Per-session transport registry. One instance
 * per daemon process.
 */
export class SessionManager {
  private readonly sessions = new Map<string, SessionEntry>();

  /**
   * Register a new session. Generates a UUID-shaped
   * id synchronously, inserts the entry into the
   * map (so `get(id)` is valid immediately), and
   * fires `server.connect(transport)` fire-and-forget.
   *
   * The returned id is OUR pre-generated id — it is
   * not read from `transport.sessionId` (which is
   * `undefined` until the SDK handles its first
   * HTTP initialize request, i.e. never in unit
   * tests with a mocked `server.connect()`).
   *
   * @param server   The `McpServer` instance to
   *                 bind the transport to.
   * @param actor    The actor for this session;
   *                 locked for the session's
   *                 lifetime.
   * @param options  Optional. `options.transport`
   *                 injects a pre-built transport
   *                 (used by the unit test for the
   *                 `close()` path; production code
   *                 lets the manager build the
   *                 default SDK transport).
   * @returns The session id (UUID-shaped).
   */
  create(
    server: McpServer,
    actor: SessionActor,
    options: { transport?: StreamableHTTPServerTransport } = {}
  ): string {
    // Pre-generate the id synchronously so we can
    // (a) register the entry before `connect()` is
    // fired and (b) hand the transport a
    // `sessionIdGenerator` that returns our id
    // (so the production SDK path stays in sync).
    const sessionId = randomUUID();

    const transport =
      options.transport ??
      new StreamableHTTPServerTransport({
        // The transport must use OUR pre-generated
        // id (not call `randomUUID()` itself), so
        // the `onsessioninitialized` callback sees
        // the same id we registered synchronously.
        sessionIdGenerator: () => sessionId,
        // Production-path safety net: when the
        // real SDK processes its first HTTP
        // initialize request, it fires this
        // callback with the id our generator
        // returned (i.e. our pre-generated id).
        // The entry is already in the map from
        // the synchronous insert above, so the
        // `!has` guard makes this a no-op rather
        // than a re-registration. For unit tests
        // (mocked `server.connect()`), this
        // callback is never fired at all.
        onsessioninitialized: (id) => {
          if (!this.sessions.has(id)) {
            this.sessions.set(id, { server, transport, actor, createdAt: new Date().toISOString() });
          }
        },
        onsessionclosed: (id) => {
          this.sessions.delete(id);
        },
        enableDnsRebindingProtection: true
      });

    // Register synchronously BEFORE firing
    // `connect()` so the entry is visible to
    // `get(id)` the moment `create()` returns.
    // This is the deviation from the brief's
    // Step 3 snippet (which relied on
    // `onsessioninitialized` to populate the
    // map) and the only way the unit test can
    // assert `mgr.get(id)?.actor.id === "claude-code"`
    // immediately after `create()`.
    this.sessions.set(sessionId, { server, transport, actor, createdAt: new Date().toISOString() });

    // Fire-and-forget the MCP server binding.
    // Any rejection from `connect()` surfaces as
    // an unhandled rejection; Task 9 (Stage 4)
    // will own the production connect-error
    // path. For unit tests, the mock resolves
    // immediately to `undefined`.
    //
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
    void server.connect(transport);

    return sessionId;
  }

  /**
   * Look up a session by id. Returns `undefined`
   * for unknown ids.
   */
  get(id: string): SessionEntry | undefined {
    return this.sessions.get(id);
  }

  /**
   * Register a transport under a caller-supplied
   * id. Synchronous map insertion; `get(id)` is
   * valid the moment `register()` returns. The id
   * is the caller's — this method does NOT
   * generate a UUID. The intended caller is the
   * HTTP route layer (Task 9), which generates
   * the id at the top of the new-session branch
   * and constructs the transport with a matching
   * `sessionIdGenerator` so the SDK's
   * `onsessioninitialized` callback sees the
   * same id (and is therefore a no-op rather
   * than a re-registration).
   *
   * Additive alongside `create()`: `create()`
   * stays for back-compat with the existing
   * unit tests and the Task 8 / Task 9 callers
   * that prefer the pre-generate-and-insert
   * shape. `register()` is the new path that
   * lets the route layer pin the id before the
   * transport is wired up, eliminating the
   * UUID-A-vs-UUID-B mismatch that a
   * `sessionIdGenerator: () => randomUUID()`
   * in the route layer would otherwise produce.
   *
   * 2026-08-08 update (per-session McpServer):
   * the route layer now constructs a fresh
   * `McpServer` per session (SDK 1.29.0's
   * `Server.connect(transport)` is single-shot;
   * a second transport on the same `Server`
   * throws "Already connected"). The `server`
   * is passed in here and stored in the entry
   * so the daemon can close it on
   * `sessions.closeAll()`. The `create()`
   * back-compat path also stores the
   * `McpServer` it constructed (or received
   * from the caller) in the same field.
   *
   * @param id        The pre-generated session
   *                  id (UUID-shaped, but this
   *                  method does not validate).
   * @param server    The per-session
   *                  `McpServer` (composes
   *                  its own `Server` internally
   *                  — see `SessionEntry.server`
   *                  for the SDK 1.29.0
   *                  "Already connected"
   *                  rationale).
   * @param transport The per-session
   *                  `StreamableHTTPServerTransport`.
   * @param actor     The actor for this session;
   *                  locked for the session's
   *                  lifetime.
   */
  register(
    id: string,
    server: McpServer,
    transport: StreamableHTTPServerTransport,
    actor: SessionActor
  ): void {
    this.sessions.set(id, {
      server,
      transport,
      actor,
      createdAt: new Date().toISOString()
    });
  }

  /**
   * Stage 4 / Task 9: defensive seam for the
   * HTTP route layer. When the SDK fires
   * `onsessioninitialized` with an id that is
   * NOT in the map (e.g. the transport was
   * constructed with its own `sessionIdGenerator`
   * rather than the one `create()` injected),
   * the route layer calls `forceRegister` to
   * add the entry after the fact. In the current
   * `create()` shape the SDK's callback always
   * sees the pre-generated id, so this is a
   * fallback for transports built outside
   * `create()`. The brief's `runHttpServer` uses
   * the seam to register the default actor on
   * first initialize; Task 10 will replace it
   * with explicit initialize-body parsing.
   *
   * 2026-08-08 update: also stores the
   * per-session `server` so the daemon can
   * close it on `sessions.closeAll()`.
   */
  forceRegister(
    id: string,
    server: McpServer,
    transport: StreamableHTTPServerTransport,
    actor: SessionActor
  ): void {
    this.sessions.set(id, {
      server,
      transport,
      actor,
      createdAt: new Date().toISOString()
    });
  }

  /**
   * Tear down a single session. Deletes the
   * entry from the map first (so a re-entrant
   * `close()` call is a no-op), then awaits
   * BOTH the per-session `McpServer.close()`
   * and the transport's `close()`. The
   * per-session server is closed first so the
   * transport's `close()` does not race with
   * the SDK's internal "Already connected"
   * invariant on shutdown. Per-session close
   * errors are swallowed — `closeAll()` uses
   * `Promise.allSettled` so a failure on one
   * session does not block the others.
   */
  async close(id: string): Promise<void> {
    const entry = this.sessions.get(id);
    if (!entry) return;
    this.sessions.delete(id);
    try { await entry.server.close(); } catch { /* swallow per-session errors */ }
    try { await entry.transport.close(); } catch { /* swallow per-session errors */ }
  }

  /**
   * Tear down every live session. Idempotent:
   * re-running on an already-drained manager is
   * a no-op.
   */
  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.allSettled(ids.map((id) => this.close(id)));
  }
}
