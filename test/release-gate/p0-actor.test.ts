// test/release-gate/p0-actor.test.ts
//
// Stage 10 PR1: Release-gate P0 regressions for actor
// propagation (AR-P0-002).
//
// The current main branch hardcodes `actor: "agent"` on every
// mutation and maintenance audit event, even when the caller
// is a different agent / user. The fix (Stage 10 PR3) must:
//   1. propagate the structured RequestContext actor through
//      every mutation and maintenance path
//   2. distinguish system actors (system:expiry, system:dedup,
//      system:backup) from the requester via metadata.requested_by
//   3. keep parsing legacy bare values for backward compat
//
// These tests are red on current main and turn green after PR3.
//
// Reference: spec § 5.2 AR-P0-002 "端到端 RequestContext 与
// Actor 一致性".

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../../src/memory-service.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import { parseActor } from "../../src/actor.js";
import type { MemoryEntry } from "../../src/domain.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-actor-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  // Note: the third constructor arg is the default actor. After
  // PR3, passing a structured value (e.g. "agent:claude-code")
  // here is what every audit event should record. On current
  // main, this string is still used as the actor, but the
  // SQLite CHECK constraint restricts it to the bare value
  // set. The test below is structured so it will pass on the
  // fixed code and fail on the current one regardless.
  const service = new MemoryService(store, undefined, "agent:claude-code", dataHome);
  return { service, store, dataHome };
}

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? `mem_${Math.random().toString(36).slice(2)}`,
    scope: "global",
    type: "fact",
    memory_kind: "semantic",
    topic: "t",
    title: overrides.title ?? "actor test",
    body: overrides.body ?? "actor test body",
    tags: [],
    source: { kind: "agent" },
    importance: 3,
    confidence: 3,
    status: "active",
    created_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z",
    access_count: 0,
    supersedes: [],
    token_estimate: 1,
    char_count: 1,
    ...overrides
  } as MemoryEntry;
}

describe("release-gate p0-actor (AR-P0-002)", () => {
  let service: MemoryService;
  let store: SQLiteMemoryStore;

  beforeEach(() => {
    ({ service, store } = setup());
  });
  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
  });

  it("remember audit event records the structured caller actor", () => {
    const result = service.remember({
      scope: "global",
      type: "fact",
      topic: "t",
      title: "actor remember",
      body: "remembered body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const audits = store.listAuditEvents({ memory_id: result.value.memory_id });
    expect(audits.length).toBeGreaterThan(0);
    const created = audits.find((a) => a.event === "created");
    expect(created).toBeDefined();
    // After PR3 the created event actor must parse to the
    // structured caller. On current main, the actor is the
    // bare "agent" string regardless of defaultActor.
    if (created !== undefined) {
      const parsed = parseActor(created.actor);
      expect(parsed.name).toBe("claude-code");
    }
  });

  it("updateMemory audit event records the structured caller actor", () => {
    store.insertEntry(makeEntry({ id: "mem_actor_update", title: "u1", body: "b1" }));
    const result = service.updateMemory("mem_actor_update", {
      title: "u1 updated",
      body: "b1 updated"
    });
    expect(result.ok).toBe(true);
    const audits = store.listAuditEvents({ memory_id: "mem_actor_update" });
    const updated = audits.find((a) => a.event === "updated");
    expect(updated).toBeDefined();
    if (updated !== undefined) {
      const parsed = parseActor(updated.actor);
      expect(parsed.name).toBe("claude-code");
    }
  });

  it("mergeMemories audit event records the structured caller actor", () => {
    store.insertEntry(makeEntry({ id: "mem_merge_1", title: "merge 1", body: "merge body 1" }));
    store.insertEntry(makeEntry({ id: "mem_merge_2", title: "merge 2", body: "merge body 2" }));
    const result = service.mergeMemories({
      old_memory_ids: ["mem_merge_1", "mem_merge_2"],
      reason: "release-gate test merge",
      replacement: {
        scope: "global",
        type: "fact",
        topic: "merge",
        title: "merge result",
        body: "merged body",
        tags: [],
        source: { kind: "agent" },
        importance: 3,
        confidence: 3
      }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const audits = store.listAuditEvents({ memory_id: result.value.memory_id });
    expect(audits.length).toBeGreaterThan(0);
    // The created event for the new merged memory must record the
    // structured caller.
    const created = audits.find((a) => a.event === "created");
    expect(created).toBeDefined();
    if (created !== undefined) {
      const parsed = parseActor(created.actor);
      expect(parsed.name).toBe("claude-code");
    }
  });

  it("forgetMemory audit event records the structured caller actor", () => {
    store.insertEntry(makeEntry({ id: "mem_actor_forget", title: "f1", body: "fb" }));
    const result = service.forgetMemory("mem_actor_forget", "release-gate test forget");
    expect(result.ok).toBe(true);
    const audits = store.listAuditEvents({ memory_id: "mem_actor_forget" });
    const forgotten = audits.find((a) => a.event === "forgotten");
    expect(forgotten).toBeDefined();
    if (forgotten !== undefined) {
      const parsed = parseActor(forgotten.actor);
      expect(parsed.name).toBe("claude-code");
    }
  });

  it("expire_due maintenance audit distinguishes system executor from requester", () => {
    // The maintenance path executes as `system:expiry`; the
    // requester (defaultActor) must be preserved in metadata so
    // audit replay can show who asked for the maintenance.
    const pastExpiry = "2026-01-01T00:00:00.000Z";
    store.insertEntry(makeEntry({
      id: "mem_actor_expire",
      expires_at: pastExpiry
    }));
    service.maintainMemories({ action: "expire_due", scope: "global" });
    const audits = store.listAuditEvents({ memory_id: "mem_actor_expire" });
    const forgotten = audits.find((a) => a.event === "forgotten");
    expect(forgotten).toBeDefined();
    if (forgotten !== undefined) {
      // Executor is system; requester is in metadata.
      const parsed = parseActor(forgotten.actor);
      expect(parsed.kind).toBe("system");
      expect(parsed.name).toBe("expiry");
      expect((forgotten.metadata as { requested_by?: string }).requested_by).toBe("agent:claude-code");
    }
  });
});
