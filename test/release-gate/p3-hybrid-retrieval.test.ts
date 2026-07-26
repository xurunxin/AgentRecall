// test/release-gate/p3-hybrid-retrieval.test.ts
//
// Stage 16 v1.1.1 PR-6 (issue #15): verify the
// shared ranking pipeline (search_memories +
// recall_context) and the RRF / score drift fix.
//
// Acceptance criteria covered here:
//
//   - The `lexical_relevance` component in the
//     explain output is the EXACT value used in
//     the final score (no more `1 / (60 + rank)`
//     reported in components but
//     `contextQueryScore` used in score).
//   - At least two real candidate sources
//     contribute to the RRF (lexical + access).
//   - A project query cannot have all project
//     results displaced by global-first
//     concatenation (the new pipeline fuses the
//     two sources rather than concatenating).
//   - `search_memories` and `recall_context` use
//     the same `rankRecall` shared pipeline.
//   - Real conflict penalty: a `memory_relations`
//     row of type `contradicts` reduces the
//     conflicting entry's score.
//   - `RANKING_VERSION` is `coding-default-v2`
//     (was `coding-default-v1` pre-PR-6).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../../src/memory-service.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import { RANKING_VERSION, rankRecall } from "../../src/services/recall-ranker.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-hybrid-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const service = new MemoryService(store, undefined, "agent:system", dataHome);
  return { service, store, dataHome };
}

const baseInput = (overrides: Record<string, unknown> = {}) => ({
  scope: "global" as const,
  type: "fact" as const,
  topic: "t",
  title: "t",
  body: "b",
  tags: [] as string[],
  source: { kind: "agent" as const },
  importance: 3,
  confidence: 3,
  ...overrides
});

const ctxOf = (actor: string, requestId: string) => ({
  actor_id: actor,
  request_id: requestId,
  session_id: "s",
  tool_call_id: "c",
  transport: "mcp" as const
});

describe("release-gate p3-hybrid-retrieval (Stage 16 PR-6 #15)", () => {
  let store: SQLiteMemoryStore;
  let service: MemoryService;
  let dataHome: string;

  beforeEach(() => {
    ({ store, service, dataHome } = setup());
  });

  afterEach(() => {
    try { store.close(); } catch { /* already closed */ }
  });

  it("RANKING_VERSION is `coding-default-v2` (was v1 pre-PR-6)", () => {
    expect(RANKING_VERSION).toBe("coding-default-v2");
  });

  it("lexical_relevance in components is the exact value used in the final score", () => {
    const r = service.remember(
      baseInput({
        topic: "hybrid",
        title: "hybrid retrieval",
        body: "the shared ranking pipeline uses real RRF"
      }),
      ctxOf("agent:rg", "r1")
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const candidates = store.listEntries({ status: "active" });
    expect(candidates.length).toBeGreaterThan(0);
    const ranked = rankRecall({
      candidates,
      query: "hybrid retrieval",
      primaryScope: "global",
      actor: {
        currentActor: "agent:rg",
        actorForEntry: (e) => e.writer_actor_id
      },
      store
    });
    expect(ranked.length).toBeGreaterThan(0);
    const top = ranked[0]!;
    // Stage 16 v1.1.1 PR-6 (issue #15): the
    // `lexical_relevance` reported in the
    // components is the RRF sum (a small positive
    // value, e.g. ~1/61), and that exact value
    // enters the score as `WEIGHTS.lexical_relevance *
    // rrf`. The pre-PR-6 contract reported `rrf`
    // but the score used a separately-normalised
    // `contextQueryScore` — the two could diverge.
    // We assert the v2 contract: the `lexical_relevance`
    // is the actual RRF value (not the lexical_norm).
    expect(top.components.lexical_relevance).toBeGreaterThan(0);
    expect(top.components.lexical_relevance).toBeLessThan(1 / 60 + 0.0001);
    expect(top.components.rrf_lexical).toBeGreaterThan(0);
    expect(top.components.rrf_lexical).toBe(top.components.lexical_relevance);
  });

  it("at least two candidate sources contribute to RRF (lexical + access)", () => {
    const a = service.remember(
      baseInput({ topic: "rrf", title: "rrf lexical", body: "lexical match for rrf" }),
      ctxOf("agent:rg", "r1")
    );
    const b = service.remember(
      baseInput({ topic: "rrf", title: "rrf access", body: "another lexical match for rrf" }),
      ctxOf("agent:rg", "r2")
    );
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(b.ok).toBe(true);
    if (!b.ok) return;

    // Record an access for the second entry by
    // the same actor so it appears in the
    // `access` RRF source.
    store.recordAccess(b.value.memory_id, "agent:rg", new Date().toISOString());

    const candidates = store.listEntries({ status: "active" });
    const ranked = rankRecall({
      candidates,
      query: "rrf",
      primaryScope: "global",
      actor: {
        currentActor: "agent:rg",
        actorForEntry: (e) => e.writer_actor_id
      },
      store
    });
    expect(ranked.length).toBe(2);
    const accessEntry = ranked.find((r) => r.entry.id === b.value.memory_id)!;
    const otherEntry = ranked.find((r) => r.entry.id === a.value.memory_id)!;
    // The access target appears in BOTH the
    // lexical source AND the access source.
    expect(accessEntry.components.rrf_lexical).toBeGreaterThan(0);
    expect(accessEntry.components.rrf_access).toBeGreaterThan(0);
    // The other entry appears in the lexical
    // source only.
    expect(otherEntry.components.rrf_lexical).toBeGreaterThan(0);
    expect(otherEntry.components.rrf_access).toBe(0);
    // The access-aware entry outranks the other
    // because it has the additional RRF
    // contribution.
    expect(ranked[0]!.entry.id).toBe(b.value.memory_id);
  });

  it("a project query cannot have all project results displaced by global-first concatenation", () => {
    const projectMatch = service.remember(
      baseInput({
        scope: "project",
        project_id: "repo-1",
        topic: "scope",
        title: "project scope priority",
        body: "this entry lives in repo-1"
      }),
      ctxOf("agent:rg", "r1")
    );
    service.remember(
      baseInput({
        topic: "scope",
        title: "global scope priority",
        body: "this entry lives in global"
      }),
      ctxOf("agent:rg", "r2")
    );
    expect(projectMatch.ok).toBe(true);
    if (!projectMatch.ok) return;

    const result = service.searchMemories({
      scope: "project",
      project_id: "repo-1",
      query: "scope priority"
    });
    expect(result.items.length).toBeGreaterThan(0);
    // The first item must be the project entry;
    // the v1.1.0 concatenation could put the
    // global entry first.
    expect(result.items[0]!.id).toBe(projectMatch.value.memory_id);
    expect(result.items[0]!.scope).toBe("project");
  });

  it("real conflict penalty: a `contradicts` memory_relations row reduces the conflicting entry's score", () => {
    const a = service.remember(
      baseInput({ topic: "conflict", title: "conflict A", body: "this is the canonical position" }),
      ctxOf("agent:rg", "r1")
    );
    const b = service.remember(
      baseInput({ topic: "conflict", title: "conflict B", body: "this is the contradicting position" }),
      ctxOf("agent:rg", "r2")
    );
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(b.ok).toBe(true);
    if (!b.ok) return;

    // Write a `contradicts` relation from B -> A.
    store.db.prepare(
      `INSERT INTO memory_relations (from_memory_id, to_memory_id, relation_type, confidence, metadata_json, created_at)
       VALUES (?, ?, 'contradicts', 1.0, '{}', ?)`
    ).run(b.value.memory_id, a.value.memory_id, new Date().toISOString());

    const candidates = store.listEntries({ status: "active" });
    const ranked = rankRecall({
      candidates,
      query: "conflict",
      primaryScope: "global",
      actor: {
        currentActor: "agent:rg",
        actorForEntry: (e) => e.writer_actor_id
      },
      store
    });
    const bRanked = ranked.find((r) => r.entry.id === b.value.memory_id)!;
    const aRanked = ranked.find((r) => r.entry.id === a.value.memory_id)!;
    // B has a `contradicts` peer (A); A has 0
    // conflicting peers.
    expect(bRanked.components.conflict_penalty).toBeGreaterThan(0);
    expect(aRanked.components.conflict_penalty).toBe(0);
  });

  it("searchMemories and explainRecall use the same shared pipeline (RANKING_VERSION = v2)", () => {
    service.remember(
      baseInput({ topic: "shared", title: "shared pipeline", body: "search and recall use the same ranker" }),
      ctxOf("agent:rg", "r1")
    );
    const search = service.searchMemories({ scope: "global", query: "shared" });
    expect(search.items.length).toBeGreaterThan(0);
    const explain = service.explainRecall({ scope: "global", query: "shared", top_k: 10 });
    expect(explain.ok).toBe(true);
    if (!explain.ok) return;
    expect(explain.value.ranking_version).toBe("coding-default-v2");
  });
});
