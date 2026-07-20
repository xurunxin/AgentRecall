// test/maintain-merge-duplicates.test.ts
//
// Stage 8: maintain_memories gains a `merge_duplicates` action
// that walks the duplicate groups from find_duplicates and
// supersedes all but the keep target. Default strategy is
// keep_first (lowest id alphabetically); keep_newest picks
// the most recently created memory as the keep target.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../src/memory-service.js";
import { SQLiteMemoryStore } from "../src/sqlite-store.js";
import type { MemoryAuditEvent, MemoryEntry } from "../src/domain.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-merge-dup-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const service = new MemoryService(store, undefined, "agent:test", dataHome);
  return { service, store, dataHome };
}

function makeEntry(overrides: Partial<MemoryEntry> & { title: string; body: string; created_at: string; }): MemoryEntry {
  return {
    id: overrides.id ?? `mem_${Math.random().toString(36).slice(2)}`,
    scope: "global",
    type: "fact",
    memory_kind: "semantic",
    topic: "t",
    title: overrides.title,
    body: overrides.body,
    tags: [],
    source: { kind: "agent" },
    importance: 3,
    confidence: 3,
    status: "active",
    created_at: overrides.created_at,
    updated_at: overrides.created_at,
    access_count: 0,
    supersedes: [],
    token_estimate: 1,
    char_count: 1
  } as MemoryEntry;
}

describe("maintainMemories merge_duplicates (stage 8)", () => {
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

  it("supersedes all-but-keep_first for same_title_and_body groups", () => {
    // Three entries with identical title + body -> one
    // same_title_and_body group of size 3. keep_first
    // picks the lowest id (alphabetical) and supersedes
    // the other two.
    const e1 = makeEntry({ id: "mem_aaa", title: "exact", body: "exact body", created_at: "2026-07-01T00:00:00.000Z" });
    const e2 = makeEntry({ id: "mem_bbb", title: "exact", body: "exact body", created_at: "2026-07-02T00:00:00.000Z" });
    const e3 = makeEntry({ id: "mem_ccc", title: "exact", body: "exact body", created_at: "2026-07-03T00:00:00.000Z" });
    for (const e of [e1, e2, e3]) store.insertEntry(e);

    const result = service.maintainMemories({
      action: "merge_duplicates",
      scope: "global",
      strategy: "keep_first"
    });

    expect(result.action).toBe("merge_duplicates");
    expect(result.changed).toBe(2);
    const aaa = store.peekEntry("mem_aaa");
    const bbb = store.peekEntry("mem_bbb");
    const ccc = store.peekEntry("mem_ccc");
    // mem_aaa is the keep target (lowest id); its status
    // stays active and superseded_by is undefined.
    expect(aaa?.status).toBe("active");
    expect(aaa?.superseded_by).toBeUndefined();
    // mem_bbb and mem_ccc are superseded by mem_aaa.
    expect(bbb?.status).toBe("superseded");
    expect(bbb?.superseded_by).toBe("mem_aaa");
    expect(ccc?.status).toBe("superseded");
    expect(ccc?.superseded_by).toBe("mem_aaa");
  });

  it("supersedes all-but-keep_newest (oldest two out of three)", () => {
    const e1 = makeEntry({ id: "mem_oldest", title: "exact", body: "exact body", created_at: "2026-07-01T00:00:00.000Z" });
    const e2 = makeEntry({ id: "mem_middle", title: "exact", body: "exact body", created_at: "2026-07-02T00:00:00.000Z" });
    const e3 = makeEntry({ id: "mem_newest", title: "exact", body: "exact body", created_at: "2026-07-03T00:00:00.000Z" });
    for (const e of [e1, e2, e3]) store.insertEntry(e);

    const result = service.maintainMemories({
      action: "merge_duplicates",
      scope: "global",
      strategy: "keep_newest"
    });

    expect(result.changed).toBe(2);
    // mem_newest is the keep target (most recent created_at);
    // mem_oldest and mem_middle are superseded.
    expect(store.peekEntry("mem_newest")?.status).toBe("active");
    expect(store.peekEntry("mem_newest")?.superseded_by).toBeUndefined();
    expect(store.peekEntry("mem_oldest")?.status).toBe("superseded");
    expect(store.peekEntry("mem_oldest")?.superseded_by).toBe("mem_newest");
    expect(store.peekEntry("mem_middle")?.status).toBe("superseded");
    expect(store.peekEntry("mem_middle")?.superseded_by).toBe("mem_newest");
  });

  it("skips size-1 groups (no work to do)", () => {
    // Two distinct titles -> two groups, each of size 1.
    // Nothing to merge.
    const a = makeEntry({ id: "mem_a", title: "alpha", body: "alpha body", created_at: "2026-07-01T00:00:00.000Z" });
    const b = makeEntry({ id: "mem_b", title: "beta", body: "beta body", created_at: "2026-07-02T00:00:00.000Z" });
    for (const e of [a, b]) store.insertEntry(e);

    const result = service.maintainMemories({
      action: "merge_duplicates",
      scope: "global"
    });
    expect(result.changed).toBe(0);
    expect(store.peekEntry("mem_a")?.status).toBe("active");
    expect(store.peekEntry("mem_b")?.status).toBe("active");
  });

  it("skips groups whose keep target is already superseded", () => {
    // Same title+body for mem_old and mem_new. mem_new is
    // already superseded. keep_first picks mem_old (lowest
    // id) as the keep target. Both mem_new and the
    // would-be-supersede-other (none in this 2-element
    // case) are in scope; we expect no error.
    const e1 = makeEntry({ id: "mem_old", title: "exact", body: "exact body", created_at: "2026-07-01T00:00:00.000Z" });
    const e2 = makeEntry({ id: "mem_new", title: "exact", body: "exact body", created_at: "2026-07-02T00:00:00.000Z" });
    for (const e of [e1, e2]) store.insertEntry(e);
    // Manually supersede mem_new
    store.updateEntry("mem_new", { status: "superseded", superseded_by: "mem_external", updated_at: "2026-07-02T00:00:00.000Z" });

    const result = service.maintainMemories({
      action: "merge_duplicates",
      scope: "global",
      strategy: "keep_first"
    });

    // mem_new is already superseded, not a candidate.
    // Group only has mem_old (active); size-1 after filter.
    // No merges happen.
    expect(result.changed).toBe(0);
    expect(store.peekEntry("mem_old")?.status).toBe("active");
  });

  it("writes one superseded audit event per merge", () => {
    const e1 = makeEntry({ id: "mem_aaa", title: "exact", body: "exact body", created_at: "2026-07-01T00:00:00.000Z" });
    const e2 = makeEntry({ id: "mem_bbb", title: "exact", body: "exact body", created_at: "2026-07-02T00:00:00.000Z" });
    const e3 = makeEntry({ id: "mem_ccc", title: "exact", body: "exact body", created_at: "2026-07-03T00:00:00.000Z" });
    for (const e of [e1, e2, e3]) store.insertEntry(e);

    service.maintainMemories({
      action: "merge_duplicates",
      scope: "global",
      strategy: "keep_first"
    });

    const aaaAudit = store.getAuditEvents("mem_aaa");
    const bbbAudit = store.getAuditEvents("mem_bbb");
    const cccAudit = store.getAuditEvents("mem_ccc");

    // mem_aaa: no superseded audit (it was kept).
    const aaaSuperseded = aaaAudit.filter((a: MemoryAuditEvent) => a.event === "superseded");
    expect(aaaSuperseded.length).toBe(0);
    // mem_bbb and mem_ccc: one superseded audit each,
    // pointing to mem_aaa.
    const bbbSuperseded = bbbAudit.filter((a) => a.event === "superseded");
    const cccSuperseded = cccAudit.filter((a) => a.event === "superseded");
    expect(bbbSuperseded.length).toBe(1);
    expect(bbbSuperseded[0]?.metadata?.superseded_by).toBe("mem_aaa");
    expect(cccSuperseded.length).toBe(1);
    expect(cccSuperseded[0]?.metadata?.superseded_by).toBe("mem_aaa");
  });
});
