// test/sqlite-store-updated-at.test.ts
//
// Stage 7: `updated_since` / `updated_until` on listEntries and
// searchEntries. Filters by `updated_at` (the column `remember`
// and `update_memory` bump on each write), parallel to the
// Stage 6 `since` / `until` pair that filters `created_at`.

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryAuditEvent, MemoryEntry } from "../src/domain.js";
import { SQLiteMemoryStore } from "../src/sqlite-store.js";

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? "mem_test",
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
    created_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z",
    access_count: 0,
    supersedes: [],
    token_estimate: 1,
    char_count: 1,
    // Stage 14 PR-B1: stamp writer_actor_id explicitly because
    // the test bypasses the write service.
    revision: 1,
    writer_actor_id: "agent:test",
    content_hash: undefined,
    pinned: false,
    trust_level: "agent_observed",
    sensitivity: "normal",
    valid_from: undefined,
    valid_until: undefined,
    deleted_at: undefined,
    metadata: {},
    ...overrides
  } as MemoryEntry;
}

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-uat-"));
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
    created_at: "2026-07-15T00:00:00.000Z"
  };
}

describe("listEntries updated_at filter (stage 7)", () => {
  let store: SQLiteMemoryStore;

  beforeEach(() => ({ store } = setup()));
  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
  });

  it("updated_since filters by updated_at", () => {
    store.insertEntry(makeEntry({ id: "mem_old", updated_at: "2026-07-10T00:00:00.000Z" }));
    store.appendAudit(auditFor("mem_old", "agent:claude-code"));
    store.insertEntry(makeEntry({ id: "mem_mid", updated_at: "2026-07-15T00:00:00.000Z" }));
    store.appendAudit(auditFor("mem_mid", "agent:claude-code"));
    store.insertEntry(makeEntry({ id: "mem_new", updated_at: "2026-07-20T00:00:00.000Z" }));
    store.appendAudit(auditFor("mem_new", "agent:claude-code"));

    const recent = store.listEntries({ scope: "global", updated_since: "2026-07-15T00:00:00.000Z" });
    const ids = recent.map((e) => e.id).sort();
    expect(ids).toEqual(["mem_mid", "mem_new"]);
  });

  it("updated_until filters by updated_at", () => {
    store.insertEntry(makeEntry({ id: "mem_old", updated_at: "2026-07-10T00:00:00.000Z" }));
    store.appendAudit(auditFor("mem_old", "agent:claude-code"));
    store.insertEntry(makeEntry({ id: "mem_mid", updated_at: "2026-07-15T00:00:00.000Z" }));
    store.appendAudit(auditFor("mem_mid", "agent:claude-code"));
    store.insertEntry(makeEntry({ id: "mem_new", updated_at: "2026-07-20T00:00:00.000Z" }));
    store.appendAudit(auditFor("mem_new", "agent:claude-code"));

    const old = store.listEntries({ scope: "global", updated_until: "2026-07-15T00:00:00.000Z" });
    const ids = old.map((e) => e.id).sort();
    expect(ids).toEqual(["mem_mid", "mem_old"]);
  });

  it("updated_since + updated_until forms a closed range", () => {
    store.insertEntry(makeEntry({ id: "mem_old", updated_at: "2026-07-10T00:00:00.000Z" }));
    store.appendAudit(auditFor("mem_old", "agent:claude-code"));
    store.insertEntry(makeEntry({ id: "mem_mid", updated_at: "2026-07-15T00:00:00.000Z" }));
    store.appendAudit(auditFor("mem_mid", "agent:claude-code"));
    store.insertEntry(makeEntry({ id: "mem_new", updated_at: "2026-07-20T00:00:00.000Z" }));
    store.appendAudit(auditFor("mem_new", "agent:claude-code"));

    const ranged = store.listEntries({
      scope: "global",
      updated_since: "2026-07-12T00:00:00.000Z",
      updated_until: "2026-07-18T00:00:00.000Z"
    });
    expect(ranged.map((e) => e.id)).toEqual(["mem_mid"]);
  });

  it("updated_since combines with the existing since/actor filters", () => {
    // mem_a: created 2026-07-10, updated 2026-07-12
    store.insertEntry(makeEntry({
      id: "mem_a",
      created_at: "2026-07-10T00:00:00.000Z",
      updated_at: "2026-07-12T00:00:00.000Z",
      writer_actor_id: "agent:claude-code"
    }));
    store.appendAudit(auditFor("mem_a", "agent:claude-code"));
    // mem_b: created 2026-07-20, updated 2026-07-20
    store.insertEntry(makeEntry({
      id: "mem_b",
      created_at: "2026-07-20T00:00:00.000Z",
      updated_at: "2026-07-20T00:00:00.000Z",
      writer_actor_id: "agent:claude-code"
    }));
    store.appendAudit(auditFor("mem_b", "agent:claude-code"));
    // mem_c: created 2026-07-20, updated 2026-07-20, but written by cursor
    store.insertEntry(makeEntry({
      id: "mem_c",
      created_at: "2026-07-20T00:00:00.000Z",
      updated_at: "2026-07-20T00:00:00.000Z",
      writer_actor_id: "agent:cursor"
    }));
    store.appendAudit(auditFor("mem_c", "agent:cursor"));

    const filtered = store.listEntries({
      scope: "global",
      actor: "agent:claude-code",
      updated_since: "2026-07-15T00:00:00.000Z"
    });
    expect(filtered.map((e) => e.id)).toEqual(["mem_b"]);
  });

  it("updated_since + since (created_at) can be combined", () => {
    // mem_a: created 2026-07-10 (old), updated 2026-07-20 (recent)
    store.insertEntry(makeEntry({
      id: "mem_a",
      created_at: "2026-07-10T00:00:00.000Z",
      updated_at: "2026-07-20T00:00:00.000Z"
    }));
    store.appendAudit(auditFor("mem_a", "agent:claude-code"));
    // mem_b: created 2026-07-20, updated 2026-07-20
    store.insertEntry(makeEntry({
      id: "mem_b",
      created_at: "2026-07-20T00:00:00.000Z",
      updated_at: "2026-07-20T00:00:00.000Z"
    }));
    store.appendAudit(auditFor("mem_b", "agent:claude-code"));

    // both updated recently, but only mem_b was created recently
    const filtered = store.listEntries({
      scope: "global",
      since: "2026-07-15T00:00:00.000Z",
      updated_since: "2026-07-15T00:00:00.000Z"
    });
    expect(filtered.map((e) => e.id)).toEqual(["mem_b"]);
  });

  it("no updated_at filters returns all active entries", () => {
    store.insertEntry(makeEntry({ id: "mem_a" }));
    store.appendAudit(auditFor("mem_a", "agent:claude-code"));
    store.insertEntry(makeEntry({ id: "mem_b" }));
    store.appendAudit(auditFor("mem_b", "agent:claude-code"));
    expect(store.listEntries({ scope: "global" }).length).toBe(2);
  });
});

describe("searchEntries updated_at filter (stage 7)", () => {
  let store: SQLiteMemoryStore;

  beforeEach(() => ({ store } = setup()));
  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
  });

  it("updated_since narrows FTS results by updated_at", () => {
    store.insertEntry(makeEntry({
      id: "mem_old",
      body: "uses postgres for primary datastore",
      updated_at: "2026-07-10T00:00:00.000Z"
    }));
    store.appendAudit(auditFor("mem_old", "agent:claude-code"));
    store.insertEntry(makeEntry({
      id: "mem_new",
      body: "uses postgres for analytics",
      updated_at: "2026-07-20T00:00:00.000Z"
    }));
    store.appendAudit(auditFor("mem_new", "agent:claude-code"));

    const recent = store.searchEntries({
      query: "postgres",
      scope: "global",
      updated_since: "2026-07-15T00:00:00.000Z"
    });
    expect(recent.map((e) => e.id)).toEqual(["mem_new"]);
  });

  it("updated_since + since narrows FTS by both timestamps", () => {
    store.insertEntry(makeEntry({
      id: "mem_old",
      body: "uses postgres primary",
      created_at: "2026-07-10T00:00:00.000Z",
      updated_at: "2026-07-20T00:00:00.000Z"
    }));
    store.appendAudit(auditFor("mem_old", "agent:claude-code"));
    store.insertEntry(makeEntry({
      id: "mem_new",
      body: "uses postgres analytics",
      created_at: "2026-07-20T00:00:00.000Z",
      updated_at: "2026-07-20T00:00:00.000Z"
    }));
    store.appendAudit(auditFor("mem_new", "agent:claude-code"));

    const filtered = store.searchEntries({
      query: "postgres",
      scope: "global",
      since: "2026-07-15T00:00:00.000Z",
      updated_since: "2026-07-15T00:00:00.000Z"
    });
    expect(filtered.map((e) => e.id)).toEqual(["mem_new"]);
  });
});
