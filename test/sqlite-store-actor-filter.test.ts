// test/sqlite-store-actor-filter.test.ts
//
// Stage 4: actor filter on listEntries and searchEntries. The filter
// narrows results to memories whose "created" audit row was written
// by the given actor. Omitting the field preserves existing
// behavior (all actors).

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryAuditEvent, MemoryEntry } from "../src/domain.js";
import { SQLiteMemoryStore } from "../src/sqlite-store.js";

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? "mem_test_001",
    scope: "global",
    project_id: undefined,
    project_path: undefined,
    type: "fact",
    memory_kind: "semantic",
    topic: "stack",
    title: "primary datastore is postgres",
    body: "the project uses postgres for the primary datastore and analytics",
    tags: ["postgres", "stack"],
    source: { kind: "agent", ref: "test" },
    importance: 3,
    confidence: 4,
    status: "active",
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
    access_count: 0,
    expires_at: undefined,
    review_after: undefined,
    supersedes: [],
    superseded_by: undefined,
    token_estimate: 10,
    char_count: 60,
    ...overrides
  };
}

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-store-actor-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  return { store, dataHome };
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

describe("listEntries actor filter (stage 4)", () => {
  let store: SQLiteMemoryStore;

  beforeEach(() => ({ store } = setup()));
  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
  });

  it("returns all entries when actor is omitted", () => {
    store.insertEntry(makeEntry({ id: "mem_a", body: "first fact about postgres" }));
    store.appendAudit(auditFor("mem_a", "agent:claude-code"));
    store.insertEntry(makeEntry({ id: "mem_b", body: "second fact about postgres" }));
    store.appendAudit(auditFor("mem_b", "agent:cursor"));
    const all = store.listEntries({ scope: "global" });
    expect(all.length).toBe(2);
  });

  it("returns only entries whose created audit was by the given actor", () => {
    store.insertEntry(makeEntry({ id: "mem_a" }));
    store.appendAudit(auditFor("mem_a", "agent:claude-code"));
    store.insertEntry(makeEntry({ id: "mem_b" }));
    store.appendAudit(auditFor("mem_b", "agent:cursor"));
    const claudeOnly = store.listEntries({ scope: "global", actor: "agent:claude-code" });
    expect(claudeOnly.map((e) => e.id)).toEqual(["mem_a"]);
  });

  it("returns empty when the actor has written nothing", () => {
    store.insertEntry(makeEntry({ id: "mem_a" }));
    store.appendAudit(auditFor("mem_a", "agent:claude-code"));
    const empty = store.listEntries({ scope: "global", actor: "agent:nobody" });
    expect(empty).toEqual([]);
  });

  it("skips memories without a created audit row (defensive for pre-v2 data)", () => {
    store.insertEntry(makeEntry({ id: "mem_orphan" }));
    // no audit row written
    const all = store.listEntries({ scope: "global", actor: "agent:claude-code" });
    expect(all).toEqual([]);
  });
});

describe("searchEntries actor filter (stage 4)", () => {
  let store: SQLiteMemoryStore;

  beforeEach(() => ({ store } = setup()));
  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
  });

  it("narrows FTS results by actor", () => {
    store.insertEntry(makeEntry({ id: "mem_a", body: "uses postgres for primary datastore" }));
    store.appendAudit(auditFor("mem_a", "agent:claude-code"));
    store.insertEntry(makeEntry({ id: "mem_b", body: "uses postgres for analytics" }));
    store.appendAudit(auditFor("mem_b", "agent:cursor"));
    const claudeOnly = store.searchEntries({ query: "postgres", scope: "global", actor: "agent:claude-code" });
    expect(claudeOnly.map((e) => e.id)).toEqual(["mem_a"]);
  });

  it("combines with existing scope filter", () => {
    store.insertEntry(makeEntry({ id: "mem_a", scope: "global", body: "uses postgres globally" }));
    store.appendAudit(auditFor("mem_a", "agent:claude-code"));
    const filtered = store.searchEntries({ query: "postgres", scope: "global", actor: "agent:claude-code" });
    expect(filtered.length).toBe(1);
  });
});
