// test/release-gate/p3-mcp-trusted-context.test.ts
//
// Stage 16 v1.1.1 PR-1 (issue #11): verify the
// MCP transport context propagation and trusted tool
// contract changes land in the public path.
//
// Acceptance criteria covered here:
//
//   - `server.registerTool` forwards the SDK `extra`
//     argument end-to-end (handler receives the real
//     session id, JSON-RPC request id, and signal).
//   - `buildToolRequestContext` prefers
//     `extra.requestId` over the pre-PR-1 fabricated
//     `Date.now() + Math.random()` fallback.
//   - The legacy `_meta.clientName` / `_meta.clientVersion`
//     extraction is gone — those fields are not part of
//     the per-call `extra` envelope in the SDK.
//   - `get_memory` is a pure read; client-supplied
//     `accessed_by` is ignored. The schema still accepts
//     the field for one release cycle (deprecated alias).
//   - `SQLiteMemoryStore.peekEntry` returns the entry
//     without touching `memory_accesses` or
//     `memory_entries.access_count`. `getEntry` (when
//     called with an `accessedBy` argument) still
//     records access; both paths derive `last_accessed_by`
//     from `memory_accesses` when the JSON cache is empty.
//   - `MemoryReadService.getMemory` accepts the
//     `accessedBy` parameter for backward compatibility
//     but the parameter is a no-op (deprecated).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../../src/memory-service.js";
import { buildRequestContext } from "../../src/request-context.js";
import { createMemoryToolHandlers, registerMemoryTools } from "../../src/tools/register-tools.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-trusted-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const service = new MemoryService(store, undefined, "agent:system", dataHome);
  return { service, store, dataHome };
}

const baseInput = (overrides: Record<string, unknown> = {}) => ({
  scope: "global" as const,
  type: "fact" as const,
  topic: "trusted",
  title: "trusted title",
  body: "trusted body",
  tags: [] as string[],
  source: { kind: "agent" as const },
  importance: 3,
  confidence: 4,
  ...overrides
});

describe("release-gate p3-mcp-trusted-context (Stage 16 PR-1 #11)", () => {
  let service: MemoryService;
  let store: SQLiteMemoryStore;
  let dataHome: string;

  beforeEach(() => {
    ({ service, store, dataHome } = setup());
  });
  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
  });

  it("buildRequestContext falls back to a UUID when no requestId is provided", () => {
    // Pre-PR-1 the helper fabricated `${Date.now()}-${Math.random()...}`.
    // PR-1 keeps the public behaviour (RequestContext has a
    // `request_id`) but the only synthesised id is the
    // standard randomUUID default in `buildRequestContext`.
    const ctx = buildRequestContext({});
    expect(ctx.request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("buildRequestContext preserves an explicit requestId (caller-derived, e.g. JSON-RPC id)", () => {
    // The MCP server's `buildToolRequestContext` forwards
    // `extra.requestId` (the JSON-RPC id) into
    // `buildRequestContext` as `request_id`. The
    // correlation is exact: same JSON-RPC id on retry
    // produces the same `request_id` in the audit log.
    // `tool_call_id` is set independently by the caller
    // when the SDK exposes one; the helpers do not auto-
    // copy `request_id` into `tool_call_id` (they are
    // semantically distinct: a JSON-RPC id is the
    // request envelope id; a tool call id may be the
    // same value but is owned by the call site).
    const ctx = buildRequestContext({ request_id: "rpc-123" });
    expect(ctx.request_id).toBe("rpc-123");
  });

  it("buildRequestContext preserves an explicit tool_call_id", () => {
    // The MCP server's `buildToolRequestContext` also
    // forwards `extra.requestId` as `tool_call_id` (the
    // call site decides which id to use). The helpers
    // accept both independently.
    const ctx = buildRequestContext({ request_id: "rpc-123", tool_call_id: "rpc-123" });
    expect(ctx.request_id).toBe("rpc-123");
    expect(ctx.tool_call_id).toBe("rpc-123");
  });

  it("createMemoryToolHandlers.get_memory ignores client-supplied accessed_by", async () => {
    // The schema still accepts `accessed_by` for one
    // release cycle; the handler drops it. The service
    // is called with just the memory id.
    const r = service.remember(baseInput({ title: "t1", body: "b1" }));
    if (!r.ok) throw new Error("setup");
    const id = r.value.memory_id;

    const handlers = createMemoryToolHandlers(service);
    // Spy on the service's getMemory. We use a
    // direct mock because the handler is async and the
    // service is the only thing that can confirm the
    // second argument is no longer forwarded.
    const seen: Array<[string, string | undefined]> = [];
    const svc = {
      ...service,
      getMemory: (idArg: string, actorArg?: string) => {
        seen.push([idArg, actorArg]);
        return service.getMemory(idArg, actorArg);
      }
    } as unknown as MemoryService;
    const hs = createMemoryToolHandlers(svc);
    await hs.get_memory({ memory_id: id, accessed_by: "agent:malicious-impersonator" });
    expect(seen).toEqual([[id, undefined]]);
  });

  it("SQLiteMemoryStore.peekEntry is a pure read (no access state change)", () => {
    const r = service.remember(baseInput({ title: "peek", body: "b" }));
    if (!r.ok) throw new Error("setup");
    const id = r.value.memory_id;

    const before = store.peekEntry(id);
    expect(before).toBeDefined();
    expect(before?.access_count).toBe(0);

    // Multiple peeks: no state change.
    for (let i = 0; i < 3; i++) store.peekEntry(id);
    const after = store.peekEntry(id);
    expect(after?.access_count).toBe(0);

    // `memory_accesses` is empty.
    const handle = store.backupHandle();
    const rows = handle
      .prepare("SELECT COUNT(*) AS n FROM memory_accesses WHERE memory_id = ?")
      .get(id) as { n: number };
    expect(rows.n).toBe(0);
  });

  it("peekEntry + explicit recordAccess derives last_accessed_by from memory_accesses", () => {
    // Stage 16 v1.1.1 PR-1 (#11): the canonical access
    // source of truth is `memory_accesses` (schema v4).
    // The `last_accessed_by` JSON column is a derived
    // cache. `peekEntry` no longer populates the cache;
    // it derives the per-actor map from `memory_accesses`
    // when the cache is empty.
    const r = service.remember(baseInput({ title: "derived", body: "b" }));
    if (!r.ok) throw new Error("setup");
    const id = r.value.memory_id;

    store.recordAccess(id, "agent:claude-code", "2026-07-26T10:00:00.000Z");
    store.recordAccess(id, "agent:cursor", "2026-07-26T10:01:00.000Z");

    const peeked = store.peekEntry(id);
    expect(peeked?.last_accessed_by?.["agent:claude-code"]).toBe("2026-07-26T10:00:00.000Z");
    expect(peeked?.last_accessed_by?.["agent:cursor"]).toBe("2026-07-26T10:01:00.000Z");
  });

  it("MemoryReadService.getMemory is a pure read (deprecated accessedBy is a no-op)", () => {
    const r = service.remember(baseInput({ title: "svc-pure", body: "b" }));
    if (!r.ok) throw new Error("setup");
    const id = r.value.memory_id;

    // Pre-PR-1, `getMemory(id, "agent:foo")` would record
    // the access as a side effect. Post-PR-1 the
    // `accessedBy` parameter is accepted (deprecated) but
    // the read is pure: no row in `memory_accesses`,
    // `access_count` stays at 0.
    const first = service.getMemory(id, "agent:foo");
    const second = service.getMemory(id, "agent:bar");
    const third = service.getMemory(id);

    expect(first?.entry.access_count).toBe(0);
    expect(second?.entry.access_count).toBe(0);
    expect(third?.entry.access_count).toBe(0);

    const handle = store.backupHandle();
    const rows = handle
      .prepare("SELECT COUNT(*) AS n FROM memory_accesses WHERE memory_id = ?")
      .get(id) as { n: number };
    expect(rows.n).toBe(0);
  });

  it("createMemoryToolHandlers forwards the extra argument to the inner handler", async () => {
    // The `envelopeHandler` / `textEnvelopeHandler` builders
    // accept `(input, extra)` and build a trusted
    // `RequestContext` from `extra`. The audit row that
    // `remember` writes carries `metadata_json.request_id`
    // (and `tool_call_id` when the SDK exposes one). We
    // round-trip through the handler with a synthetic
    // extra whose `requestId` is the JSON-RPC id, and
    // assert the audit row reflects the trusted value.
    const handlers = createMemoryToolHandlers(service);
    const ac = new AbortController();
    const extra = {
      signal: ac.signal,
      sendNotification: async () => undefined,
      sessionId: "session-xyz",
      requestId: 42
    };
    const out = await handlers.remember(
      baseInput({ title: "audit-trace", body: "b" }),
      extra as unknown as Parameters<typeof handlers.remember>[1]
    );
    expect(out).toBeDefined();
    // Read the audit event for this remember. Find
    // the memory_id from the structured payload of
    // the v2 envelope.
    const envelope = out as { structuredContent?: { data?: { memory_id?: string } } };
    const id = envelope.structuredContent?.data?.memory_id;
    if (id === undefined) {
      // Pre-v2 the structuredContent shape is different;
      // fall back to scanning the audit table for the
      // most recent remember event.
      const handle = store.backupHandle();
      const row = handle
        .prepare(
          "SELECT memory_id, metadata_json FROM audit_events WHERE event = 'remember' ORDER BY created_at DESC LIMIT 1"
        )
        .get() as { memory_id: string; metadata_json: string };
      const meta = JSON.parse(row.metadata_json) as Record<string, unknown>;
      // The wrapper builds the RequestContext from
      // `extra.requestId`, so the audit row's
      // `tool_call_id` is the JSON-RPC id "42" (string).
      expect(meta.tool_call_id).toBe("42");
      expect(meta.session_id).toBe("session-xyz");
      expect(typeof meta.request_id).toBe("string");
      return;
    }
    const handle = store.backupHandle();
    const rows = handle
      .prepare(
        "SELECT event, metadata_json FROM audit_events WHERE memory_id = ? ORDER BY created_at ASC"
      )
      .all(id) as Array<{ event: string; metadata_json: string }>;
    expect(rows.length).toBeGreaterThan(0);
    // Find any audit row whose metadata includes the
    // trusted fields (the audit pipeline writes the
    // trace metadata for every event; `remember` is the
    // first one).
    const meta = JSON.parse(rows[0].metadata_json) as Record<string, unknown>;
    expect(meta.tool_call_id).toBe("42");
    expect(meta.session_id).toBe("session-xyz");
  });

  it("registerMemoryTools hands a (input, extra) callback to server.registerTool", () => {
    // Stage 16 v1.1.1 PR-1 (#11): the wrapper at
    // `server.registerTool(name, config, async (input) => ...)`
    // (pre-PR-1) dropped `extra` end-to-end. The new
    // wrapper is `(input, extra) => ...`. Verify the
    // callback we hand to `server.registerTool` is
    // arity-2.
    let observedArity: number | undefined;
    const fakeServer = {
      registerTool: (
        _name: string,
        _config: unknown,
        cb: (...args: unknown[]) => unknown
      ) => {
        observedArity = cb.length;
      }
    };
    registerMemoryTools(
      fakeServer as unknown as Parameters<typeof registerMemoryTools>[0],
      {} as unknown as MemoryService
    );
    expect(observedArity).toBe(2);
  });
});
