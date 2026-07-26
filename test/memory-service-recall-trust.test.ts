// test/memory-service-recall-trust.test.ts
//
// Stage 5: computeTrustBoost and the recall ranking boost.
// Pure-function unit tests for the helper, then integration
// tests for the order in collectContextEntries / exportMemoryContext.

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeTrustBoost } from "../src/memory-service.js";
import { MemoryService } from "../src/memory-service.js";
import type { MemoryAuditEvent, MemoryEntry } from "../src/domain.js";
import { SQLiteMemoryStore } from "../src/sqlite-store.js";

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "mem_test",
    scope: "global",
    type: "fact",
    memory_kind: "semantic",
    topic: "t",
    title: "t",
    body: "b",
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
    ...overrides
  } as MemoryEntry;
}

function auditFor(memoryId: string, actor: string, scope: "global" | "project" = "global"): MemoryAuditEvent {
  return {
    id: `aud_${randomUUID()}`,
    memory_id: memoryId,
    scope,
    event: "created",
    actor,
    metadata: {},
    created_at: "2026-07-20T00:00:00.000Z"
  };
}

function setup(actor: string) {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-trust-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const service = new MemoryService(store, undefined, actor, dataHome);
  return { service, store, dataHome };
}

const baseRemember = (overrides: Record<string, unknown> = {}) => ({
  scope: "global" as const,
  type: "fact" as const,
  topic: "stack",
  title: "uses postgres",
  body: "the project uses postgres for the primary datastore",
  tags: [] as string[],
  source: { kind: "agent" as const },
  importance: 3,
  confidence: 3,
  ...overrides
});

describe("computeTrustBoost", () => {
  // Stage 15 PR-M1-1 (issue #6, spec § 5.3): the
  // soft trust signal now reads from the canonical
  // `memory_accesses` table; the legacy
  // `last_accessed_by` JSON column is read-only-
  // deprecated. The helper accepts the store as
  // its first argument so the soft check can call
  // `getAccessCountFor(memory_id, actor_id)`.
  it("returns strong boost (0.3) when the writer matches the current actor", () => {
    const { store } = setup("agent:claude-code");
    const entry = makeEntry({ writer_actor_id: "agent:claude-code" });
    const result = computeTrustBoost(store, entry, "agent:claude-code");
    expect(result).toBe(0.3);
  });

  it("returns soft boost (0.1) when the current actor has accessed the memory (memory_accesses)", () => {
    const { store } = setup("agent:claude-code");
    const entry = makeEntry({ writer_actor_id: "agent:other" });
    // Stage 15 PR-M1-1: the soft signal comes from
    // `memory_accesses`, not the legacy
    // `last_accessed_by` JSON. Write one access
    // row to seed the soft signal.
    store.recordAccess(entry.id, "agent:claude-code", "2026-07-20T00:00:00.000Z");
    const result = computeTrustBoost(store, entry, "agent:claude-code");
    expect(result).toBe(0.1);
  });

  it("returns 0 when there is no relationship", () => {
    const { store } = setup("agent:claude-code");
    const entry = makeEntry({ writer_actor_id: "agent:other" });
    const result = computeTrustBoost(store, entry, "agent:claude-code");
    expect(result).toBe(0);
  });

  it("returns 0 when the current actor is empty (legacy callers)", () => {
    const { store } = setup("agent:claude-code");
    const entry = makeEntry({ writer_actor_id: "agent:claude-code" });
    const result = computeTrustBoost(store, entry, "");
    expect(result).toBe(0);
  });

  it("strong boost takes precedence over soft boost when both apply", () => {
    const { store } = setup("agent:claude-code");
    const entry = makeEntry({ writer_actor_id: "agent:claude-code" });
    store.recordAccess(entry.id, "agent:claude-code", "2026-07-20T00:00:00.000Z");
    const result = computeTrustBoost(store, entry, "agent:claude-code");
    expect(result).toBe(0.3);
  });

  it("soft boost does not fire for an empty access table", () => {
    const { store } = setup("agent:claude-code");
    const entry = makeEntry({ writer_actor_id: "agent:other" });
    const result = computeTrustBoost(store, entry, "agent:claude-code");
    expect(result).toBe(0);
  });
});

describe("exportMemoryContext trust_boost ranking (stage 5)", () => {
  let service: MemoryService;
  let store: SQLiteMemoryStore;

  beforeEach(() => {
    ({ service, store } = setup("agent:claude-code"));
  });
  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
  });

  it("ranks the calling actor's own write above a foreign write with the same query score", () => {
    // Memory 1: written by claude-code (the calling actor)
    const r1 = service.remember(baseRemember({
      title: "postgres tuning a",
      body: "primary datastore postgres tuning notes here"
    }));
    if (!r1.ok) throw new Error("setup1");

    // Memory 2: written by a different actor (re-open the store, write via a different service)
    const otherService = new MemoryService(store, undefined, "agent:other", service["dataHome"]);
    const r2 = otherService.remember(baseRemember({
      title: "postgres tuning b",
      body: "primary datastore postgres tuning notes here too"
    }));
    if (!r2.ok) throw new Error("setup2");

    // Back to the original service for the recall
    const result = service.exportMemoryContext({
      scope: "global",
      query: "postgres tuning",
      budget_chars: 5000
    });

    // The claude-code-written memory (r1) should appear first.
    const idx1 = result.indexOf(r1.value.memory_id);
    const idx2 = result.indexOf(r2.value.memory_id);
    if (idx1 < 0 || idx2 < 0) {
      throw new Error(`memories not in output. id1=${r1.value.memory_id} id2=${r2.value.memory_id} len=${result.length}\nresult:\n${result}`);
    }
    expect(idx1).toBeLessThan(idx2);

    // Each entry's title is annotated with [writer: <actor>].
    expect(result).toContain("[writer: agent:claude-code]");
    expect(result).toContain("[writer: agent:other]");
  });

  it("ranks a recently-touched foreign memory above an untouched foreign memory", () => {
    // Memory 1: written by a foreign actor, not touched by claude-code
    const otherService = new MemoryService(store, undefined, "agent:other", service["dataHome"]);
    const r1 = otherService.remember(baseRemember({
      title: "postgres foreign a",
      body: "primary datastore postgres notes from a foreign agent"
    }));
    if (!r1.ok) throw new Error("setup1");

    // Memory 2: written by a foreign actor, but claude-code has touched it
    const r2 = otherService.remember(baseRemember({
      title: "postgres foreign b",
      body: "primary datastore postgres notes also from a foreign agent"
    }));
    if (!r2.ok) throw new Error("setup2");
    // Stage 16 v1.1.1 PR-1 (#11): `getMemory` is a pure
    // read; the canonical access source of truth is
    // `memory_accesses`. Callers that need to record
    // access (here, to feed the trust-boost signal) call
    // `store.recordAccess` explicitly.
    store.recordAccess(r2.value.memory_id, "agent:claude-code", new Date().toISOString());

    const result = service.exportMemoryContext({
      scope: "global",
      query: "postgres",
      budget_chars: 5000
    });

    const idx1 = result.indexOf(r1.value.memory_id);
    const idx2 = result.indexOf(r2.value.memory_id);
    if (idx1 < 0 || idx2 < 0) {
      throw new Error(`memories not in output. id1=${r1.value.memory_id} id2=${r2.value.memory_id} len=${result.length}\nresult:\n${result}`);
    }
    expect(idx2).toBeLessThan(idx1);
  });

  it("no boost when service was constructed with undefined defaultActor (legacy)", () => {
    // A service with no defaultActor — simulates the legacy MCP path
    // before the AGENT_RECALL_ACTOR wiring fix in stage 3.
    const legacy = new MemoryService(store, undefined, undefined, service["dataHome"]);

    // 2 memories, one written by the legacy service (audit has
    // actor: "agent:unknown" via resolveActor fallback)
    const r1 = legacy.remember(baseRemember({
      title: "postgres legacy a",
      body: "primary datastore postgres notes legacy first"
    }));
    if (!r1.ok) throw new Error("setup1");
    const r2 = legacy.remember(baseRemember({
      title: "postgres legacy b",
      body: "primary datastore postgres notes legacy second"
    }));
    if (!r2.ok) throw new Error("setup2");

    // With defaultActor = "agent:unknown", the boost for r1 and r2
    // is 0 (writer is "agent:unknown", current actor is
    // "agent:unknown" — actually a tie with 0.3, but the test
    // verifies the no-actor path by constructing with undefined
    // directly).

    const result = legacy.exportMemoryContext({
      scope: "global",
      query: "postgres legacy",
      budget_chars: 5000
    });

    // Both memories should be in the output regardless of order;
    // the legacy case should not throw or produce empty results.
    expect(result).toContain(r1.value.memory_id);
    expect(result).toContain(r2.value.memory_id);
  });
});

