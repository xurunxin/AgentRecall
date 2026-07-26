// test/release-gate/p2-hybrid-recall.test.ts
//
// Stage 15 PR-M1-3 (issue #5, spec § 5.3): locks down
// the hybrid RRF + scope priority + real signals
// pipeline. The pre-PR-M1-3 ranker had placeholder
// signals (`feedback_signal` was 0, `access_signal`
// read the legacy `access_count` column instead of
// `memory_accesses`) and did not honour project /
// global scope priority as a hard boost. Post-PR-M1-3
// the ranker:
//
//   1. Uses `memory_accesses` (per-actor) for the
//      `access_signal` component.
//   2. Uses `memory_feedback` (per-actor 👍/👎) for
//      the `feedback_signal` component.
//   3. Adds a `scope_priority` component that lifts
//      project memories past global memories at the
//      same lexical rank.
//   4. Exposes real (non-zero) values for every
//      signal in the explain output.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../../src/memory-service.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import type { MemoryEntry } from "../../src/domain.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-hr-"));
  const dbPath = join(dataHome, "memory.sqlite");
  const store = new SQLiteMemoryStore(dbPath);
  const service = new MemoryService(store, undefined, "agent:test", dataHome);
  return { service, store, dataHome };
}

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "mem_hr_default",
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
    metadata: {},
    ...overrides
  } as MemoryEntry;
}

function seed(store: SQLiteMemoryStore, overrides: Partial<MemoryEntry>): MemoryEntry {
  const entry = makeEntry(overrides);
  store.insertEntry(entry);
  return entry;
}

describe("release-gate p2-hybrid-recall (issue #5)", () => {
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

  it("project memory ranks above unrelated global memory at the same lexical match", () => {
    // Stage 15 PR-M1-3 (issue #5, spec § 5.3):
    // "project query 中，项目记忆获得 scope boost,
    // global 记忆仍按相关性竞争". Two entries with
    // identical lexical match for the query; the
    // project entry wins because of the
    // `scope_priority` component.
    seed(store, {
      id: "mem_g_postgres",
      scope: "global",
      title: "Postgres setup",
      body: "Postgres tuning notes"
    });
    seed(store, {
      id: "mem_p_postgres",
      scope: "project",
      project_id: "phoenix",
      project_path: "/repos/phoenix",
      title: "Project Postgres",
      body: "Postgres tuning notes"
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
    const r = service.explainRecall({
      query: "Postgres",
      scope: "project",
      project_id: "phoenix",
      include_global: true
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items.length).toBe(2);
    expect(r.value.items[0]?.memory_id).toBe("mem_p_postgres");
    expect(r.value.items[1]?.memory_id).toBe("mem_g_postgres");
  });

  it("real feedback_signal: a 👍 on a memory lifts it past a 👎 on another", () => {
    seed(store, { id: "mem_fb_low", title: "low ranked", body: "alpha" });
    seed(store, { id: "mem_fb_high", title: "high ranked", body: "alpha" });
    // Stage 15 PR-M1-3: explicit feedback.
    service.recordFeedback({ memory_id: "mem_fb_high", kind: "up" });
    service.recordFeedback({ memory_id: "mem_fb_low", kind: "down" });
    const r = service.explainRecall({ query: "alpha", scope: "global" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const high = r.value.items.find((i) => i.memory_id === "mem_fb_high");
    const low = r.value.items.find((i) => i.memory_id === "mem_fb_low");
    expect(high).toBeDefined();
    expect(low).toBeDefined();
    expect(high!.components.feedback_signal).toBeGreaterThan(0);
    expect(low!.components.feedback_signal).toBeLessThan(0);
    expect(high!.score).toBeGreaterThan(low!.score);
  });

  it("real access_signal: per-actor accesses via memory_accesses", () => {
    const a = seed(store, { id: "mem_acc_a", title: "mem A", body: "common" });
    const b = seed(store, { id: "mem_acc_b", title: "mem B", body: "common" });
    // Stage 15 PR-M1-3: 3 actors accessed `a`,
    // 1 actor accessed `b`. The per-actor access
    // count from `memory_accesses` (not the legacy
    // `access_count` column, which is 0) drives the
    // `access_signal` component.
    store.recordAccess(a.id, "agent:alpha", "2026-07-26T00:00:00.000Z");
    store.recordAccess(a.id, "agent:beta", "2026-07-26T00:00:00.000Z");
    store.recordAccess(a.id, "agent:gamma", "2026-07-26T00:00:00.000Z");
    store.recordAccess(b.id, "agent:alpha", "2026-07-26T00:00:00.000Z");
    const r = service.explainRecall({ query: "common", scope: "global" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const itemA = r.value.items.find((i) => i.memory_id === a.id);
    const itemB = r.value.items.find((i) => i.memory_id === b.id);
    expect(itemA).toBeDefined();
    expect(itemB).toBeDefined();
    expect(itemA!.components.access_signal).toBeGreaterThan(itemB!.components.access_signal);
  });

  it("explain_recall exposes real computed signals (no placeholder 0 for trust, feedback, access)", () => {
    // The spec invariant: the ranker's
    // `score_components` exposes real values, not
    // placeholder 0s.
    const a = seed(store, { id: "mem_x_1", title: "explain target", body: "alpha beta gamma" });
    // Seed real signals: feedback + access.
    service.recordFeedback({ memory_id: a.id, kind: "up" });
    store.recordAccess(a.id, "agent:test", "2026-07-26T00:00:00.000Z");
    const r = service.explainRecall({ query: "explain", scope: "global" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const item = r.value.items.find((i) => i.memory_id === a.id);
    expect(item).toBeDefined();
    const c = item!.components;
    expect(c.lexical_relevance).toBeGreaterThan(0);
    expect(c.scope_affinity).toBeGreaterThan(0);
    expect(c.actor_trust).toBeGreaterThan(0);
    expect(c.feedback_signal).toBeGreaterThan(0);
    expect(c.access_signal).toBeGreaterThan(0);
  });

  it("recordFeedback rejects unknown memory_id with not_found", () => {
    const r = service.recordFeedback({ memory_id: "mem_does-not-exist", kind: "up" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("not_found");
  });

  it("recordFeedback is idempotent under (memory_id, actor_id, kind)", () => {
    const a = seed(store, { id: "mem_idem", title: "idem", body: "x" });
    service.recordFeedback({ memory_id: a.id, kind: "up", actor_id: "agent:test" });
    service.recordFeedback({ memory_id: a.id, kind: "up", actor_id: "agent:test" });
    const rows = store.getMemoryFeedback(a.id);
    const up = rows.filter((r) => r.kind === "up");
    expect(up.length).toBe(1);
  });

  it("recordRecallSignal + getRecallSignal round-trip", () => {
    const a = seed(store, { id: "mem_sig", title: "signal", body: "x" });
    store.recordRecallSignal({ memory_id: a.id, rank: 0.05, query: "test" });
    store.recordRecallSignal({ memory_id: a.id, rank: 0.04, query: "test" });
    const got = store.getRecallSignal(a.id);
    expect(got?.recall_count).toBe(2);
    expect(got?.last_recall_rank).toBe(0.04);
  });
});
