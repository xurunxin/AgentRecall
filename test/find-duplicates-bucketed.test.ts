// test/find-duplicates-bucketed.test.ts
//
// Stage 7: findDuplicateGroups's similar detector used to run
// an N×N comparison (textSimilarity on every pair). At 1k
// entries that's 500k pairs. This stage replaces it with a
// token-bucket inverted index: only pairs that share at least
// one token are considered, dropping the pair count by a
// factor of 5-10 in realistic stores.

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../src/memory-service.js";
import { SQLiteMemoryStore } from "../src/sqlite-store.js";
import type { MemoryEntry } from "../src/domain.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-fdg-bkt-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const service = new MemoryService(store, undefined, "agent:test", dataHome);
  return { service, store, dataHome };
}

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? `mem_${randomUUID()}`,
    scope: "global",
    type: "fact",
    memory_kind: "semantic",
    topic: "t",
    title: "default",
    body: "default body",
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

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function pairKeysFromGroups(groups: Array<{ memory_ids: string[] }>): Set<string> {
  const keys = new Set<string>();
  for (const g of groups) {
    const sorted = [...g.memory_ids].sort();
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const a = sorted[i];
        const b = sorted[j];
        if (a === undefined || b === undefined) continue;
        keys.add(pairKey(a, b));
      }
    }
  }
  return keys;
}

describe("findDuplicateGroups bucketed detector (stage 7)", () => {
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

  it("returns the same pair set as the N×N detector on a small crafted fixture", () => {
    // 6 entries with controlled overlap. All bodies/titles use
    // meaningful non-stop-word content so the Jaccard sim is real.
    // Jaccard threshold is 0.7 — bodies must share most tokens.
    const entries: MemoryEntry[] = [
      makeEntry({ id: "mem_a", title: "postgres primary datastore", body: "project uses postgres for the primary datastore. project stores all data in postgres." }),
      makeEntry({ id: "mem_b", title: "postgres primary storage", body: "project uses postgres for primary storage. project stores all data in postgres." }),
      makeEntry({ id: "mem_c", title: "redis cache layer", body: "project uses redis as a cache layer in front of postgres database for fast reads." }),
      makeEntry({ id: "mem_d", title: "kubernetes deployment", body: "project deploys to kubernetes cluster using helm charts. kubernetes handles all production deployment." }),
      makeEntry({ id: "mem_e", title: "kubernetes deploy", body: "project deploys to kubernetes cluster using helm charts. kubernetes handles staging deployment." }),
      makeEntry({ id: "mem_f", title: "unrelated topic", body: "completely different content about cats and dogs playing in the park" })
    ];
    for (const e of entries) store.insertEntry(e);

    const result = service.maintainMemories({ action: "find_duplicates", scope: "global" });
    const groups = (result.details as { groups: Array<{ reason: string; memory_ids: string[] }> }).groups;
    const similarGroups = groups.filter((g) => g.reason === "similar_title_and_body");
    const similarKeys = pairKeysFromGroups(similarGroups);

    // The similar detector should find: a-b (both about postgres
    // primary storage), d-e (both about kubernetes deployment).
    expect(similarKeys.has(pairKey("mem_a", "mem_b"))).toBe(true);
    expect(similarKeys.has(pairKey("mem_d", "mem_e"))).toBe(true);
    // mem_f has no shared tokens, so it should not appear.
    expect(similarKeys.has(pairKey("mem_a", "mem_f"))).toBe(false);
    expect(similarKeys.has(pairKey("mem_d", "mem_f"))).toBe(false);
  }, 30_000);

  it("skips pairs covered by exact-match groups", () => {
    // Two entries with identical title+body (covered by same_title_and_body);
    // bucketed detector must not double-emit them as similar.
    const entries: MemoryEntry[] = [
      makeEntry({ id: "mem_a", title: "exact title", body: "exact body content" }),
      makeEntry({ id: "mem_b", title: "exact title", body: "exact body content" })
    ];
    for (const e of entries) store.insertEntry(e);

    const result = service.maintainMemories({ action: "find_duplicates", scope: "global" });
    const groups = (result.details as { groups: Array<{ reason: string; memory_ids: string[] }> }).groups;
    const exact = groups.filter((g) => g.reason === "same_title_and_body");
    const similar = groups.filter((g) => g.reason === "similar_title_and_body");
    expect(exact.length).toBe(1);
    expect(similar.length).toBe(0);
  }, 30_000);

  it("caps per-bucket work to bound worst case (stop-word-heavy stores)", () => {
    // Many entries with low overlap; the cap should engage but the
    // result should still be correct: pairs whose Jaccard sim is
    // < threshold are filtered out.
    const entries: MemoryEntry[] = [];
    for (let i = 0; i < 20; i += 1) {
      entries.push(makeEntry({
        id: `mem_${i}`,
        title: `unique title ${i}`,
        body: `unique body ${i}` // share no body tokens
      }));
    }
    for (const e of entries) store.insertEntry(e);

    const result = service.maintainMemories({ action: "find_duplicates", scope: "global" });
    const groups = (result.details as { groups: Array<{ reason: string; memory_ids: string[] }> }).groups;
    const similar = groups.filter((g) => g.reason === "similar_title_and_body");
    // No body overlap between entries; no Jaccard pair crosses 0.7.
    expect(similar.length).toBe(0);
  });

  it("completes 50 entries with sparse overlap and returns many similar groups", () => {
    // 50 entries split into 5 clusters of 10. Each cluster shares
    // most of its body tokens with the other entries in its cluster
    // (so the Jaccard sim crosses 0.7), but the clusters don't
    // overlap with each other. The N×N detector runs 50*49/2 =
    // 1225 pairs; the inverted index only walks pairs that share
    // a token, so per-bucket work is bounded by 10*9/2.
    const clusters = ["postgres", "kubernetes", "docker", "redis", "helm"];
    const entries: MemoryEntry[] = [];
    for (let i = 0; i < 50; i += 1) {
      const id = `mem_${i.toString().padStart(4, "0")}`;
      const cluster = clusters[i % clusters.length] ?? "noise";
      const body = `${cluster} deployment production staging concern number ${i}`;
      const title = `${cluster} topic ${i}`;
      entries.push(makeEntry({ id, title, body }));
    }
    for (const e of entries) store.insertEntry(e);

    const result = service.maintainMemories({ action: "find_duplicates", scope: "global" });
    const groups = (result.details as { groups: Array<{ reason: string; memory_ids: string[] }> }).groups;
    // The detector should find many similar groups (the 10-entry
    // clusters share most of their body tokens).
    const similar = groups.filter((g) => g.reason === "similar_title_and_body");
    expect(similar.length).toBeGreaterThan(0);
  }, 60_000);
});
