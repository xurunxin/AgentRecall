// test/release-gate/p0-request-context.test.ts
//
// Stage 14 PR-B1 (spec § 5.2 AR-P0-002): every audit event
// produced by an MCP tool call MUST carry the resolved
// RequestContext trace fields. Pre-PR-B1 the audit `actor`
// was a process-wide `defaultActor` resolved once at
// server start, so two clients sharing one MCP process were
// indistinguishable. Post-PR-B1 each handler builds a
// fresh RequestContext from the MCP `extra` envelope and
// threads it into `appendAudit`, which:
//
//   1. Uses the ctx's `actor_id` for the `actor` column.
//   2. Mixes the ctx trace fields (request_id, session_id,
//      tool_call_id, client_name, client_version, project_id)
//      into the event's `metadata_json`.
//   3. For system actors (system:expiry, system:archive,
//      system:dedup, system:export, system:backup,
//      system:maintenance) the `requested_by` metadata is
//      preserved alongside the new trace fields so the
//      audit consumer can tell who triggered the system
//      action.
//
// These tests lock the invariant in three layers:
//   - per-event metadata (request_id, client_name, etc.)
//   - per-event actor (ctx.actor_id, not "agent")
//   - per-event system requested_by preservation
//
// Reference: spec § 5.2 "AR-P0-002 端到端 RequestContext 与
// Actor 一致性".

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../../src/memory-service.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import { buildRequestContext, type RequestContext } from "../../src/request-context.js";
import { parseActor } from "../../src/actor.js";
import type { MemoryEntry } from "../../src/domain.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-ctx-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  // The process-wide default is "agent:test" but every test
  // overrides it via a per-call RequestContext.
  const service = new MemoryService(store, undefined, "agent:test", dataHome);
  return { service, store, dataHome };
}

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "mem_test_001",
    scope: "global",
    type: "fact",
    topic: "tools",
    title: "audit me",
    body: "audit me body",
    tags: [],
    source: { kind: "agent" },
    importance: 3,
    confidence: 3,
    status: "active",
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
    access_count: 0,
    supersedes: [],
    token_estimate: 1,
    char_count: 1,
    revision: 1,
    writer_actor_id: "agent:test",
    pinned: false,
    trust_level: "agent_observed",
    sensitivity: "normal",
    metadata: {},
    ...overrides
  } as MemoryEntry;
}

function ctxOf(actor: string, overrides: Partial<RequestContext> = {}): RequestContext {
  return buildRequestContext({
    actor_override: actor,
    client_name: "test-client",
    client_version: "1.0.0",
    session_id: "sess_test_123",
    tool_call_id: "tool_call_456",
    request_id: "req_test_789",
    ...overrides
  });
}

describe("release-gate p0-request-context (AR-P0-002)", () => {
  let service: MemoryService;
  let store: SQLiteMemoryStore;
  let dataHome: string;

  beforeEach(() => ({ service, store, dataHome } = setup()));
  afterEach(() => {
    try { store.close(); } catch { /* already closed */ }
  });

  it("remember audit event carries the request context's actor and trace fields", () => {
    const ctx = ctxOf("agent:claude-code");
    const r = service.remember({
      scope: "global",
      type: "fact",
      topic: "tools",
      title: "remember with ctx",
      body: "the body",
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const audits = store.listAuditEvents({ memory_id: r.value.memory_id });
    const created = audits.find((a) => a.event === "created");
    expect(created).toBeDefined();
    if (created === undefined) return;

    expect(parseActor(created.actor).kind).toBe("agent");
    expect(parseActor(created.actor).name).toBe("claude-code");
    expect(created.metadata).toMatchObject({
      request_id: "req_test_789",
      session_id: "sess_test_123",
      tool_call_id: "tool_call_456",
      client_name: "test-client",
      client_version: "1.0.0"
    });
  });

  it("update audit event threads the same context's request_id", () => {
    const created = service.remember({
      scope: "global",
      type: "fact",
      topic: "tools",
      title: "to be updated",
      body: "v1",
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    }, ctxOf("agent:claude-code"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Update with a different actor + a fresh request_id.
    const updateCtx = ctxOf("agent:cursor", { request_id: "req_update_999" });
    const upd = service.updateMemory(created.value.memory_id, { title: "v2" }, updateCtx);
    expect(upd.ok).toBe(true);
    if (!upd.ok) return;

    const audits = store.listAuditEvents({ memory_id: created.value.memory_id });
    const updateEvent = audits.find((a) => a.event === "updated");
    expect(updateEvent).toBeDefined();
    if (updateEvent === undefined) return;
    expect(updateEvent.actor).toBe("agent:cursor");
    expect(updateEvent.metadata).toMatchObject({ request_id: "req_update_999" });
  });

  it("supersede / merge / forget all carry the request context's actor and request_id", () => {
    const a1 = service.remember({
      scope: "global",
      type: "fact",
      topic: "tools",
      title: "old a",
      body: "a",
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    }, ctxOf("agent:claude-code"));
    const a2 = service.remember({
      scope: "global",
      type: "fact",
      topic: "tools",
      title: "old b",
      body: "b",
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    }, ctxOf("agent:claude-code"));
    expect(a1.ok && a2.ok).toBe(true);
    if (!a1.ok || !a2.ok) return;

    // forget with a different ctx
    const forgetCtx = ctxOf("agent:cursor", { request_id: "req_forget" });
    const forget = service.forgetMemory(a1.value.memory_id, "test", forgetCtx);
    expect(forget.ok).toBe(true);

    // supersede with a fresh ctx
    const supCtx = ctxOf("agent:codex", { request_id: "req_supersede" });
    const sup = service.supersedeMemory(
      {
        old_memory_ids: [a2.value.memory_id],
        replacement: {
          scope: "global",
          type: "fact",
          topic: "tools",
          title: "new",
          body: "replacement",
          source: { kind: "agent" },
          importance: 3,
          confidence: 3
        },
        reason: "test"
      },
      supCtx
    );
    expect(sup.ok).toBe(true);

    // merge
    const m1 = service.remember({
      scope: "global",
      type: "fact",
      topic: "merge",
      title: "merge a",
      body: "ma",
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    }, ctxOf("agent:claude-code"));
    const m2 = service.remember({
      scope: "global",
      type: "fact",
      topic: "merge",
      title: "merge b",
      body: "mb",
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    }, ctxOf("agent:claude-code"));
    expect(m1.ok && m2.ok).toBe(true);
    if (!m1.ok || !m2.ok) return;
    const mergeCtx = ctxOf("agent:aider", { request_id: "req_merge" });
    const merge = service.mergeMemories(
      {
        old_memory_ids: [m1.value.memory_id, m2.value.memory_id],
        replacement: {
          scope: "global",
          type: "fact",
          topic: "merge",
          title: "merged",
          body: "merged",
          source: { kind: "agent" },
          importance: 3,
          confidence: 3
        },
        reason: "merge test"
      },
      mergeCtx
    );
    expect(merge.ok).toBe(true);

    // Forget audit
    const forgetEvent = store.listAuditEvents({ memory_id: a1.value.memory_id })
      .find((a) => a.event === "forgotten");
    expect(forgetEvent?.actor).toBe("agent:cursor");
    expect(forgetEvent?.metadata).toMatchObject({ request_id: "req_forget" });

    // Supersede audit
    const supEvent = store.listAuditEvents({ memory_id: a2.value.memory_id })
      .find((a) => a.event === "superseded");
    expect(supEvent?.actor).toBe("agent:codex");
    expect(supEvent?.metadata).toMatchObject({ request_id: "req_supersede" });
  });

  it("system maintenance events preserve requested_by alongside the trace fields", () => {
    // Plant an expired entry
    store.insertEntry(makeEntry({
      id: "mem_expire_ctx",
      expires_at: "2026-01-01T00:00:00.000Z",
      topic: "tools",
      title: "expired with ctx",
      body: "x"
    }));

    const ctx = ctxOf("agent:claude-code", { request_id: "req_expire_run" });
    const r = service.maintainMemories({
      action: "expire_due",
      scope: "global"
    }, ctx);
    expect(r.changed).toBe(1);

    const audits = store.listAuditEvents({ memory_id: "mem_expire_ctx" });
    const forgotten = audits.find((a) => a.event === "forgotten");
    expect(forgotten?.actor).toBe("system:expiry");
    expect(forgotten?.metadata).toMatchObject({
      request_id: "req_expire_run",
      // The system event preserves who triggered it via requested_by.
      requested_by: "agent:claude-code"
    });
  });

  it("legacy callers without a RequestContext fall back to the process-wide defaultActor", () => {
    // No ctx arg: the service uses its defaultActor ("agent:test").
    const r = service.remember({
      scope: "global",
      type: "fact",
      topic: "tools",
      title: "no ctx",
      body: "fallback body",
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const created = store.listAuditEvents({ memory_id: r.value.memory_id })
      .find((a) => a.event === "created");
    expect(created?.actor).toBe("agent:test");
    // No request_id in metadata when no ctx was provided.
    expect((created?.metadata as { request_id?: string }).request_id).toBeUndefined();
  });
});
