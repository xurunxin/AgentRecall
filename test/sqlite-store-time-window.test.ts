// test/sqlite-store-time-window.test.ts
//
// Stage 6: time-window filters on listEntries and searchEntries.
// `since` and `until` filter by created_at; `last_accessed_since`
// filters by last_accessed_at. All combine freely with the
// existing actor filter from Stage 4.

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
  const dataHome = mkdtempSync(join(tmpdir(), "lm-tw-"));
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

describe("listEntries time-window filters (stage 6)", () => {
  let store: SQLiteMemoryStore;

  beforeEach(() => ({ store } = setup()));
  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
  });

  it("since filters by created_at", () => {
    store.insertEntry(makeEntry({ id: "mem_old", created_at: "2026-07-10T00:00:00.000Z" }));
    store.appendAudit(auditFor("mem_old", "agent:claude-code"));
    store.insertEntry(makeEntry({ id: "mem_mid", created_at: "2026-07-15T00:00:00.000Z" }));
    store.appendAudit(auditFor("mem_mid", "agent:claude-code"));
    store.insertEntry(makeEntry({ id: "mem_new", created_at: "2026-07-20T00:00:00.000Z" }));
    store.appendAudit(auditFor("mem_new", "agent:claude-code"));

    const recent = store.listEntries({ scope: "global", since: "2026-07-15T00:00:00.000Z" });
    const ids = recent.map((e) => e.id).sort();
    expect(ids).toEqual(["mem_mid", "mem_new"]);
  });

  it("until filters by created_at", () => {
    store.insertEntry(makeEntry({ id: "mem_old", created_at: "2026-07-10T00:00:00.000Z" }));
    store.appendAudit(auditFor("mem_old", "agent:claude-code"));
    store.insertEntry(makeEntry({ id: "mem_mid", created_at: "2026-07-15T00:00:00.000Z" }));
    store.appendAudit(auditFor("mem_mid", "agent:claude-code"));
    store.insertEntry(makeEntry({ id: "mem_new", created_at: "2026-07-20T00:00:00.000Z" }));
    store.appendAudit(auditFor("mem_new", "agent:claude-code"));

    const old = store.listEntries({ scope: "global", until: "2026-07-15T00:00:00.000Z" });
    const ids = old.map((e) => e.id).sort();
    expect(ids).toEqual(["mem_mid", "mem_old"]);
  });

  it("since + until forms a closed range", () => {
    store.insertEntry(makeEntry({ id: "mem_old", created_at: "2026-07-10T00:00:00.000Z" }));
    store.appendAudit(auditFor("mem_old", "agent:claude-code"));
    store.insertEntry(makeEntry({ id: "mem_mid", created_at: "2026-07-15T00:00:00.000Z" }));
    store.appendAudit(auditFor("mem_mid", "agent:claude-code"));
    store.insertEntry(makeEntry({ id: "mem_new", created_at: "2026-07-20T00:00:00.000Z" }));
    store.appendAudit(auditFor("mem_new", "agent:claude-code"));

    const ranged = store.listEntries({
      scope: "global",
      since: "2026-07-12T00:00:00.000Z",
      until: "2026-07-18T00:00:00.000Z"
    });
    expect(ranged.map((e) => e.id)).toEqual(["mem_mid"]);
  });

  it("last_accessed_since filters by last_accessed_at and excludes never-read memories", () => {
    store.insertEntry(makeEntry({ id: "mem_never" }));
    store.appendAudit(auditFor("mem_never", "agent:claude-code"));
    store.insertEntry(makeEntry({ id: "mem_recent" }));
    store.appendAudit(auditFor("mem_recent", "agent:claude-code"));
    // mark mem_recent as read recently
    store.getEntry("mem_recent", "agent:claude-code");

    const recent = store.listEntries({
      scope: "global",
      last_accessed_since: "2026-07-19T00:00:00.000Z"
    });
    expect(recent.map((e) => e.id)).toEqual(["mem_recent"]);
  });

  it("combines with the existing actor filter from Stage 4", () => {
    // claude-code wrote mem_a on 2026-07-10
    store.insertEntry(makeEntry({ id: "mem_a", created_at: "2026-07-10T00:00:00.000Z", writer_actor_id: "agent:claude-code" }));
    store.appendAudit(auditFor("mem_a", "agent:claude-code"));
    // claude-code wrote mem_b on 2026-07-20
    store.insertEntry(makeEntry({ id: "mem_b", created_at: "2026-07-20T00:00:00.000Z", writer_actor_id: "agent:claude-code" }));
    store.appendAudit(auditFor("mem_b", "agent:claude-code"));
    // cursor wrote mem_c on 2026-07-20
    store.insertEntry(makeEntry({ id: "mem_c", created_at: "2026-07-20T00:00:00.000Z", writer_actor_id: "agent:cursor" }));
    store.appendAudit(auditFor("mem_c", "agent:cursor"));

    const filtered = store.listEntries({
      scope: "global",
      actor: "agent:claude-code",
      since: "2026-07-15T00:00:00.000Z"
    });
    expect(filtered.map((e) => e.id)).toEqual(["mem_b"]);
  });

  it("no filters returns all active entries", () => {
    store.insertEntry(makeEntry({ id: "mem_a" }));
    store.appendAudit(auditFor("mem_a", "agent:claude-code"));
    store.insertEntry(makeEntry({ id: "mem_b" }));
    store.appendAudit(auditFor("mem_b", "agent:claude-code"));
    expect(store.listEntries({ scope: "global" }).length).toBe(2);
  });
});

describe("searchEntries time-window filters (stage 6)", () => {
  let store: SQLiteMemoryStore;

  beforeEach(() => ({ store } = setup()));
  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
  });

  it("since narrows FTS results by created_at", () => {
    store.insertEntry(makeEntry({ id: "mem_old", body: "uses postgres for primary datastore", created_at: "2026-07-10T00:00:00.000Z" }));
    store.appendAudit(auditFor("mem_old", "agent:claude-code"));
    store.insertEntry(makeEntry({ id: "mem_new", body: "uses postgres for analytics", created_at: "2026-07-20T00:00:00.000Z" }));
    store.appendAudit(auditFor("mem_new", "agent:claude-code"));

    const recent = store.searchEntries({
      query: "postgres",
      scope: "global",
      since: "2026-07-15T00:00:00.000Z"
    });
    expect(recent.map((e) => e.id)).toEqual(["mem_new"]);
  });

  it("until narrows FTS results by created_at", () => {
    store.insertEntry(makeEntry({ id: "mem_old", body: "uses postgres primary", created_at: "2026-07-10T00:00:00.000Z" }));
    store.appendAudit(auditFor("mem_old", "agent:claude-code"));
    store.insertEntry(makeEntry({ id: "mem_new", body: "uses postgres analytics", created_at: "2026-07-20T00:00:00.000Z" }));
    store.appendAudit(auditFor("mem_new", "agent:claude-code"));

    const old = store.searchEntries({
      query: "postgres",
      scope: "global",
      until: "2026-07-15T00:00:00.000Z"
    });
    expect(old.map((e) => e.id)).toEqual(["mem_old"]);
  });
});
