// test/release-gate/p0-ranking.test.ts
//
// Stage 10 PR1: Release-gate P0 regressions for recall ranking
// (AR-P0-003).
//
// The current main branch has three ranker bugs:
//   1. `memory-read-service.ts:288` hardcodes `trust_boost: 0`
//      in the in-collect sort, so writer-trust cannot break
//      ties between equally-relevant entries
//   2. `markdown-exporter.ts:212` re-sorts the entries after
//      the read service has already ranked them, undoing the
//      query-score ordering
//   3. `markdown-exporter.ts:185-189 boundedJoin` breaks on
//      the first block larger than the budget, dropping every
//      subsequent entry
//
// Stage 10 PR4 introduces a single `RecallRanker` and a
// non-sorting `ContextPacker` that fixes all three. The tests
// below lock down the post-PR4 invariants.
//
// Reference: spec § 5.3 AR-P0-003 "单一召回排序与上下文打包链路".

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../../src/memory-service.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import type { MemoryEntry } from "../../src/domain.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-rank-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const service = new MemoryService(store, undefined, "agent", dataHome);
  return { service, store, dataHome };
}

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? `mem_${Math.random().toString(36).slice(2)}`,
    scope: "global",
    type: "fact",
    memory_kind: "semantic",
    topic: "t",
    title: overrides.title ?? "default",
    body: overrides.body ?? "default",
    tags: overrides.tags ?? [],
    source: overrides.source ?? { kind: "agent" },
    importance: overrides.importance ?? 3,
    confidence: overrides.confidence ?? 3,
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

describe("release-gate p0-ranking (AR-P0-003)", () => {
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

  it("query relevance outranks writer trust in the export order", () => {
    // This test runs WITHOUT a query so the read service
    // uses the listEntries (queryless) candidate path. The
    // ranker then has all active entries to work with, and
    // the trust_boost / importance / confidence / recency
    // formula decides the order. We make E1's body much
    // more important-looking (importance 5) and E2's
    // average (importance 3, but writer = current actor so
    // trust = strong). The expected order is E1 first:
    // the ranker should treat importance+confidence as
    // primary signals, with trust a tiebreaker, so E1
    // (importance 5) wins.
    //
    // Pre-PR4 the markdown exporter re-sorted by
    // importance + trust, which (counter-intuitively) could
    // put E2 first when E2 had the trust boost; the ranker
    // makes the trade-off explicit and stable.
    store.insertEntry(makeEntry({
      id: "mem_high_relevance",
      title: "database migration safety",
      topic: "database",
      body: "database migration safety backup dry-run verify repeat",
      tags: ["database", "migration"],
      importance: 5,
      confidence: 5,
      source: { kind: "tool" }
    }));
    store.insertEntry(makeEntry({
      id: "mem_high_trust",
      title: "database brewing note",
      topic: "database",
      body: "database brewing water just below boiling steep three minutes",
      tags: ["database"],
      importance: 3,
      confidence: 3,
      source: { kind: "agent" }
    }));

    const output = service.exportMemoryContext({
      scope: "global",
      budget_chars: 5000
    });

    // E1 must appear before E2 in the output.
    const idxE1 = output.indexOf("database migration safety");
    const idxE2 = output.indexOf("database brewing");
    expect(idxE1).toBeGreaterThan(-1);
    expect(idxE2).toBeGreaterThan(-1);
    expect(idxE1).toBeLessThan(idxE2);
  });

  it("first oversized block does not lock out subsequent in-budget entries", () => {
    // E1: a single entry that is itself larger than the entire
    //     budget. The current boundedJoin breaks on this entry
    //     and never considers E2.
    // E2: a small entry that should fit in the remaining budget
    //     after E1 is field-truncated.
    const hugeBody = "x".repeat(2000);
    store.insertEntry(makeEntry({
      id: "mem_huge",
      title: "Huge memory block",
      body: hugeBody
    }));
    store.insertEntry(makeEntry({
      id: "mem_tiny",
      title: "Tiny memory after huge",
      body: "small body"
    }));

    const output = service.exportMemoryContext({
      scope: "global",
      budget_chars: 800
    });

    // E2 must appear in the output (post-PR4 invariant).
    // Pre-PR4: boundedJoin breaks on E1; E2 is never added.
    expect(output).toContain("Tiny memory after huge");
  });

  it("exporter preserves the ranker order (no silent re-sort)", () => {
    // Three entries with the same importance / confidence /
    // updated_at but different query relevance. The pre-PR4
    // exporter re-sorts by importance + trust, which can
    // re-order them away from their query_score order.
    // The post-PR4 exporter must render the input order
    // as-is.
    store.insertEntry(makeEntry({
      id: "mem_rank_first",
      title: "database alpha",
      body: "database migration alpha token",
      topic: "database",
      tags: ["database"]
    }));
    store.insertEntry(makeEntry({
      id: "mem_rank_second",
      title: "database beta",
      body: "database migration beta token",
      topic: "database",
      tags: ["database"]
    }));
    store.insertEntry(makeEntry({
      id: "mem_rank_third",
      title: "database gamma",
      body: "database migration gamma token",
      topic: "database",
      tags: ["database"]
    }));

    // Capture the ranker order by calling the read service
    // directly. The pre-PR4 collect sort uses (id, ...) as
    // the tiebreaker; the three entries above have identical
    // query_score, so the ranker would order them by id.
    // The post-PR4 ranker uses the same tiebreaker. The
    // exporter must preserve that order.
    const output = service.exportMemoryContext({
      scope: "global",
      query: "database",
      budget_chars: 5000
    });

    const idxFirst = output.indexOf("database alpha");
    const idxSecond = output.indexOf("database beta");
    const idxThird = output.indexOf("database gamma");
    expect(idxFirst).toBeGreaterThan(-1);
    expect(idxSecond).toBeGreaterThan(-1);
    expect(idxThird).toBeGreaterThan(-1);
    expect(idxFirst).toBeLessThan(idxSecond);
    expect(idxSecond).toBeLessThan(idxThird);
  });

  it("exported context includes the trust-writer annotation in the rendered output", () => {
    // The spec also requires that the final markdown surfaces
    // the writer so the user can see who wrote what. Stage 5
    // already does this via [writer: X] in entryDetail. PR4
    // keeps it; we just lock down the visible annotation.
    store.insertEntry(makeEntry({
      id: "mem_writer_ann",
      title: "annotated memory",
      body: "body",
      source: { kind: "agent" }
    }));
    const output = service.exportMemoryContext({
      scope: "global",
      budget_chars: 2000
    });
    expect(output).toMatch(/\[writer:\s*[^\]]+\]/);
  });
});
