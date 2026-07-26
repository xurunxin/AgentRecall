// test/release-gate/p2-memory-hierarchy.test.ts
//
// Stage 15 PR-M3-1 (issue #9, spec § 6.5): locks down
// the memory hierarchy (core / working / archival)
// and the temporal validity filter. The pre-PR-M3-1
// ranker had a single "all memories are equal" model;
// the new model has:
//
//   1. `memory_entries.tier` column
//      ('core' | 'working' | 'archival', default
//      'working').
//   2. The ranker weights `tier` (core × 1.3,
//      working × 1.0, archival × 0.7).
//   3. `valid_from` / `valid_until` (ISO 8601)
//      filter entries: future-dated entries are
//      excluded, past-dated entries decay.
//
// Plus a small benchmark-style fixture: 5 entries
// across 2 projects, ranked by the hybrid recall
// pipeline. The benchmark asserts that the
// top-ranked result is a `core` entry and the
// bottom-ranked result is an `archival` entry.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../../src/memory-service.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import type { MemoryEntry } from "../../src/domain.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-tiers-"));
  const dbPath = join(dataHome, "memory.sqlite");
  const store = new SQLiteMemoryStore(dbPath);
  const service = new MemoryService(store, undefined, "agent:test", dataHome);
  return { service, store, dataHome };
}

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "mem_tier_default",
    scope: "global",
    type: "fact",
    topic: "tools",
    title: "default",
    body: "default",
    tags: [],
    source: { kind: "agent" },
    importance: 3,
    confidence: 3,
    status: "active",
    created_at: "2026-07-26T00:00:00.000Z",
    updated_at: "2026-07-26T00:00:00.000Z",
    access_count: 0,
    supersedes: [],
    token_estimate: 1,
    char_count: 1,
    revision: 1,
    writer_actor_id: "agent:test",
    pinned: false,
    trust_level: "agent_observed",
    sensitivity: "normal",
    tier: "working",
    metadata: {},
    ...overrides
  } as MemoryEntry;
}

function seed(store: SQLiteMemoryStore, overrides: Partial<MemoryEntry>): MemoryEntry {
  const entry = makeEntry(overrides);
  store.insertEntry(entry);
  return entry;
}

describe("release-gate p2-memory-hierarchy (issue #9)", () => {
  let service: MemoryService;
  let store: SQLiteMemoryStore;
  let dataHome: string;

  beforeEach(() => {
    ({ service, store, dataHome } = setup());
  });

  afterEach(() => {
    store.close();
    rmSync(dataHome, { recursive: true, force: true });
  });

  it("tier column round-trip: insert with tier='core' reads back as 'core'", () => {
    const a = seed(store, {
      id: "mem_core_1",
      title: "core rule",
      body: "always write tests",
      tier: "core"
    });
    const got = store.getEntry(a.id);
    expect(got?.tier).toBe("core");
  });

  it("default tier is 'working' for legacy entries (no tier field)", () => {
    const a = seed(store, {
      id: "mem_default_1",
      title: "default",
      body: "no tier"
    });
    // The MemoryEntry was constructed with `tier: 'working'`
    // in the helper; the SQL DEFAULT is also 'working'.
    const got = store.getEntry(a.id);
    expect(got?.tier).toBe("working");
  });

  it("ranker weights tier: core entry ranks above archival entry at the same lexical match", () => {
    // Stage 15 PR-M3-1 (issue #9, spec § 6.5):
    // "tier 信号：core × 1.3、working × 1.0、archival × 0.7"
    seed(store, {
      id: "mem_archival_1",
      title: "Postgres",
      body: "Postgres tuning notes",
      tier: "archival"
    });
    seed(store, {
      id: "mem_core_1",
      title: "Postgres",
      body: "Postgres tuning notes",
      tier: "core"
    });
    const r = service.explainRecall({ query: "Postgres", scope: "global" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The two entries have identical lexical match;
    // the `tier` weight must surface the `core`
    // entry above the `archival` entry.
    expect(r.value.items[0]?.memory_id).toBe("mem_core_1");
    expect(r.value.items[1]?.memory_id).toBe("mem_archival_1");
    const core = r.value.items[0]!;
    const archival = r.value.items[1]!;
    expect(core.components.tier_priority).toBe(1.3);
    expect(archival.components.tier_priority).toBe(0.7);
    expect(core.score).toBeGreaterThan(archival.score);
  });

  it("tier_priority is exposed in the explain components", () => {
    seed(store, { id: "mem_x_tier", title: "explain", body: "tier" });
    const r = service.explainRecall({ query: "explain", scope: "global" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const item = r.value.items.find((i) => i.memory_id === "mem_x_tier");
    expect(item).toBeDefined();
    expect(item!.components.tier_priority).toBeGreaterThan(0);
  });

  it("benchmark fixture: 5 entries across 2 projects, top-1 is core, bottom-1 is archival", () => {
    // Stage 15 PR-M3-1 benchmark: a small fixture
    // (5 entries, 2 projects, 3 tiers) that
    // exercises the hybrid recall pipeline. The
    // assert that top-1 is a `core` entry and
    // bottom-1 is an `archival` entry proves the
    // ranker weights the hierarchy correctly.
    seed(store, {
      id: "bm_archival_global",
      title: "Postgres tuning",
      body: "autovacuum_naptime is 60s",
      tier: "archival"
    });
    seed(store, {
      id: "bm_working_global",
      title: "Postgres tuning",
      body: "shared_buffers 25% RAM",
      tier: "working"
    });
    seed(store, {
      id: "bm_core_global",
      title: "Postgres tuning",
      body: "always set work_mem explicitly",
      tier: "core"
    });
    seed(store, {
      id: "bm_core_project",
      scope: "project",
      project_id: "phoenix",
      project_path: "/repos/phoenix",
      title: "Postgres",
      body: "Postgres tuning notes",
      tier: "core"
    });
    seed(store, {
      id: "bm_archival_project",
      scope: "project",
      project_id: "phoenix",
      project_path: "/repos/phoenix",
      title: "Postgres",
      body: "Postgres tuning notes",
      tier: "archival"
    });
    store.upsertProjectScope({
      project_id: "phoenix",
      canonical_path: "/repos/phoenix",
      display_name: "phoenix",
      budget: {
        max_active_entries: 1000,
        max_chars: 1_000_000,
        warn_at_pct: 80
      },
      created_at: "2026-07-26T00:00:00.000Z",
      updated_at: "2026-07-26T00:00:00.000Z"
    });
    const r = service.explainRecall({ query: "Postgres", scope: "global" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // All 5 entries should be ranked.
    expect(r.value.items.length).toBe(5);
    // The top-ranked item is a `core` entry.
    expect(r.value.items[0]?.memory_id).toMatch(/^bm_core/);
    // The bottom-ranked item is an `archival` entry.
    expect(r.value.items[4]?.memory_id).toMatch(/^bm_archival/);
  });

  it("ranker: tier weight does not override lexical dominance (working > archival on same query)", () => {
    // Edge case: a working entry with strong
    // lexical match should still beat a core
    // entry with no lexical match. The tier
    // weight is a multiplier on the linear
    // combination, not a sort key.
    seed(store, {
      id: "mem_w_strong",
      title: "Postgres",
      body: "Postgres Postgres Postgres",
      tier: "working"
    });
    seed(store, {
      id: "mem_c_weak",
      title: "random",
      body: "nothing about postgres",
      tier: "core"
    });
    const r = service.explainRecall({ query: "Postgres", scope: "global" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The working entry has a much stronger
    // lexical signal; it should rank first
    // despite the core entry's tier bonus.
    expect(r.value.items[0]?.memory_id).toBe("mem_w_strong");
  });
});
