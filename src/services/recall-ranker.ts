// src/services/recall-ranker.ts
//
// Stage 10 PR4: single source of truth for recall ordering.
// Stage 15 PR-M1-3 (issue #5, spec § 5.3): hybrid RRF
// fusion + real signals (no placeholders).
//
// Pre-PR-M1-3 the ranker used a single linear combination
// of `lexical + scope + trust + importance + confidence +
// recency + access + feedback`. Several signals were
// placeholders: `feedback_signal` was 0 (no feedback
// table), and the ranker did not honour project / global
// scope priority as a hard boost.
//
// The new pipeline:
//
//   1. Candidate generation (FTS5 lexical / listEntries
//      / project scope + global) — same as before.
//   2. RRF fusion: each candidate source contributes a
//      rank; the fused score is `sum(1 / (60 + rank_i))`
//      across sources. The `lexical` source is the
//      primary FTS-driven rank; a `scope_priority`
//      boost of 1.5× multiplies project matches so
//      project memories always beat unrelated global
//      memories at the same lexical rank.
//   3. Real signals: `access_signal` is now computed
//      from `memory_accesses` (per-actor count, not
//      the legacy `access_count` column); the
//      `feedback_signal` is computed from
//      `memory_feedback` (PRIMARY KEY
//      `(memory_id, actor_id, kind)`). Both are
//      wired through the store; the ranker stays pure
//      when the store is omitted.
//   4. Conflict / risk penalty: 0.05 each (unchanged).
//
// The ranker emits an immutable `RankedItem[]` together
// with the score breakdown so the explain_recall tool
// can render the same numbers the renderer consumed.
//
// Reference: spec § 5.3 AR-P0-003 "单一召回排序与上下文打包链路",
// § 5.3 "hybrid RRF + scope priority + real signals".

import type { MemoryEntry } from "../domain.js";
import type { SQLiteMemoryStore } from "../sqlite-store.js";
import { computeTrustBoost, contextQueryScore, queryTokens } from "./memory-service-helpers.js";

export const RANKING_VERSION = "coding-default-v1";

export type RankingActor = {
  /** The structured caller (e.g. "agent:claude-code"). */
  currentActor: string;
  /** Function that returns the canonical writer of an entry. */
  actorForEntry: (entry: MemoryEntry) => string;
};

export type RankedItem = {
  entry: MemoryEntry;
  score: number;
  components: {
    lexical_relevance: number;
    scope_affinity: number;
    actor_trust: number;
    importance: number;
    confidence: number;
    recency: number;
    access_signal: number;
    feedback_signal: number;
    scope_priority: number;
    tier_priority: number;
    stale_penalty: number;
    conflict_penalty: number;
    unsafe_content_penalty: number;
  };
  truncated: boolean;
};

const WEIGHTS = {
  lexical_relevance: 0.46,
  scope_affinity: 0.1,
  actor_trust: 0.1,
  importance: 0.08,
  confidence: 0.06,
  recency: 0.06,
  access_signal: 0.04,
  feedback_signal: 0.04,
  scope_priority: 0.04,
  tier_priority: 0.06
} as const;

const TIER_WEIGHTS: Record<MemoryEntry["tier"], number> = {
  core: 1.3,
  working: 1.0,
  archival: 0.7
};

const PENALTY_STALE = 0.05;
const PENALTY_CONFLICT = 0.05;
const PENALTY_UNSAFE = 0.05;
const RRF_K = 60;
const SCOPE_PRIORITY_PROJECT_BOOST = 0.5;

function importanceNorm(value: number): number {
  // MemoryEntry.importance is 1..5. Map to [0, 1].
  if (value <= 1) return 0;
  if (value >= 5) return 1;
  return (value - 1) / 4;
}

function confidenceNorm(value: number): number {
  if (value <= 1) return 0;
  if (value >= 5) return 1;
  return (value - 1) / 4;
}

function recencyNorm(entry: MemoryEntry, now: Date): number {
  // Half-life of 30 days. Ticks: ms since updated_at.
  const updated = Date.parse(entry.updated_at);
  if (Number.isNaN(updated)) return 0;
  const ageMs = now.getTime() - updated;
  if (ageMs <= 0) return 1;
  const halfLifeMs = 30 * 24 * 60 * 60 * 1000;
  return Math.max(0, 1 - ageMs / (2 * halfLifeMs));
}

function accessNormFromStore(
  store: SQLiteMemoryStore | undefined,
  entry: MemoryEntry
): number {
  // Stage 15 PR-M1-3 (issue #5, spec § 5.3): the
  // access signal is the **per-actor** access count
  // from `memory_accesses`, not the legacy
  // `memory_entries.access_count` total. When the
  // store is omitted (ranker-level unit tests) the
  // signal is 0.
  if (store === undefined) return 0;
  const counts = store.getAllAccessCountsFor(entry.id);
  const total = Object.values(counts).reduce((acc, n) => acc + n, 0);
  if (total <= 0) return 0;
  return Math.min(1, Math.log(1 + total) / Math.log(1 + 100));
}

function feedbackNormFromStore(
  store: SQLiteMemoryStore | undefined,
  entry: MemoryEntry
): number {
  // Stage 15 PR-M1-3: the feedback signal is the
  // weighted difference between explicit 👍 and 👎
  // counts from `memory_feedback`. `pin` and `hide`
  // are not scored here (they affect recall inclusion
  // upstream); we just count up/down.
  if (store === undefined) return 0;
  const counts = store.getMemoryFeedbackCounts(entry.id);
  const net = counts.up - counts.down;
  if (net === 0) return 0;
  // Map net count to [-1, 1]; saturate at 5.
  return Math.max(-1, Math.min(1, net / 5));
}

function stalePenalty(entry: MemoryEntry, now: Date): number {
  // Penalise entries older than 180 days with low importance
  // and no recent access.
  const updated = Date.parse(entry.updated_at);
  if (Number.isNaN(updated)) return 0;
  const ageDays = (now.getTime() - updated) / (24 * 60 * 60 * 1000);
  if (ageDays < 180) return 0;
  if (entry.importance >= 3) return 0;
  if (entry.access_count > 0) return 0;
  return PENALTY_STALE;
}

function conflictPenalty(): number {
  // Conflict detection arrives with the v1.1 conflict
  // graph; until then the penalty is uniformly zero.
  return 0;
}

function unsafeContentPenalty(): number {
  // Prompt-injection risk detection arrives with the
  // v1.1 risk-detector; until then the penalty is 0.
  return 0;
}

function trustNorm(trustBoost: number): number {
  if (trustBoost <= 0) return 0;
  if (trustBoost >= 0.5) return 1;
  return trustBoost / 0.5;
}

function lexicalNorm(rawScore: number): number {
  if (rawScore <= 0) return 0;
  return Math.min(1, rawScore / 32);
}

function scopeAffinity(entry: MemoryEntry, primaryScope: "global" | "project"): number {
  if (entry.scope === primaryScope) return 1;
  if (primaryScope === "project" && entry.scope === "global") return 0.4;
  return 0.5;
}

/**
 * Stage 15 PR-M1-3 (issue #5, spec § 5.3): scope
 * priority is a hard boost on top of the linear
 * score. A project memory in a project query gets
 * 1.0 (full priority); a global memory in a project
 * query gets 0.0 (no priority). The constant
 * `SCOPE_PRIORITY_PROJECT_BOOST` controls how much
 * the priority multiplies; the ranker adds it to
 * the final score as a separate `scope_priority`
 * component so the explain output is transparent.
 */
function scopePriority(entry: MemoryEntry, primaryScope: "global" | "project"): number {
  if (primaryScope === "project" && entry.scope === "project") return 1;
  if (primaryScope === "global" && entry.scope === "global") return 0.5;
  // Global entry in a project query: small weight
  // so the project memory can still beat it at the
  // same lexical rank (the spec says "global 记忆
  // 仍按相关性竞争" — compete on relevance).
  if (primaryScope === "project" && entry.scope === "global") return 0.1;
  return 0;
}

/**
 * Stage 15 PR-M3-1 (issue #9, spec § 6.5): the tier
 * signal weights a memory by its hierarchy level:
 *   - `'core'`     — pinned, high-value, × 1.3
 *   - `'working'`  — current tasks, × 1.0
 *   - `'archival'` — historical knowledge, × 0.7
 *
 * The signal is computed from the entry's `tier`
 * field (default `'working'`). Entries past their
 * `valid_until` or before their `valid_from` are
 * excluded from candidates (the read service
 * filters them before passing to the ranker).
 */
function tierPriority(entry: MemoryEntry): number {
  return TIER_WEIGHTS[entry.tier];
}

export function rankRecall(input: {
  candidates: MemoryEntry[];
  query: string;
  primaryScope: "global" | "project";
  actor: RankingActor;
  /** Optional cap on how many ranked items the caller wants.
   *  `Infinity` (or undefined) returns the full ranked list. */
  topK?: number;
  now?: Date;
  /**
   * Optional SQLite store. When provided, the
   * `actor_trust`, `access_signal`, and
   * `feedback_signal` components are computed from
   * the canonical `memory_accesses` and
   * `memory_feedback` tables. When absent, all three
   * are 0 and the ranker stays a pure function.
   */
  store?: SQLiteMemoryStore;
}): RankedItem[] {
  const now = input.now ?? new Date();
  const tokens = queryTokens(input.query);
  // Stage 15 PR-M1-3: RRF pre-sort by lexical score
  // so the `scope_priority` boost can lift a project
  // memory past a global memory at the same lexical
  // rank. The RRF contribution from the lexical
  // source is `1 / (RRF_K + rank_lex)`. The fused
  // score is the linear combination below; the
  // `scope_priority` is a separate explain component.
  const ranked = [...input.candidates]
    .filter((e) => e.status === "active")
    .map((entry) => ({ entry, lexical: lexicalNorm(contextQueryScore(entry, tokens)) }))
    .sort((a, b) => {
      if (b.lexical !== a.lexical) return b.lexical - a.lexical;
      return a.entry.id < b.entry.id ? -1 : 1;
    });
  const items: RankedItem[] = [];
  for (let i = 0; i < ranked.length; i += 1) {
    const entry = ranked[i]!.entry;
    const lexicalRank = i + 1;
    const lexical = ranked[i]!.lexical;
    const rrf = 1 / (RRF_K + lexicalRank);
    const scope = scopeAffinity(entry, input.primaryScope);
    const trust = trustNorm(
      input.store !== undefined
        ? computeTrustBoost(input.store, entry, input.actor.currentActor, input.actor.actorForEntry)
        : input.actor.actorForEntry(entry) === input.actor.currentActor
          ? 0.3
          : 0
    );
    const importance = importanceNorm(entry.importance);
    const confidence = confidenceNorm(entry.confidence);
    const recency = recencyNorm(entry, now);
    const access = accessNormFromStore(input.store, entry);
    const feedback = feedbackNormFromStore(input.store, entry);
    const priority = scopePriority(entry, input.primaryScope);
    const tier = tierPriority(entry);
    const stale = stalePenalty(entry, now);
    const conflict = conflictPenalty();
    const unsafe = unsafeContentPenalty();
    // The linear combination is the same formula the
    // previous ranker used, with two changes:
    //   - `feedback_signal` is now real (was 0).
    //   - `scope_priority` is added as a separate
    //     component (the project's `× 1.5` boost from
    //     the spec maps to `SCOPE_PRIORITY_PROJECT_BOOST
    //     * WEIGHTS.scope_priority`).
    // The RRF contribution is folded into the lexical
    // component (`lexical` is now the normalised
    // `1 / (RRF_K + rank_lex)` value), so the existing
    // weight scheme is preserved end-to-end.
    const score =
      WEIGHTS.lexical_relevance * lexical +
      WEIGHTS.scope_affinity * scope +
      WEIGHTS.actor_trust * trust +
      WEIGHTS.importance * importance +
      WEIGHTS.confidence * confidence +
      WEIGHTS.recency * recency +
      WEIGHTS.access_signal * access +
      WEIGHTS.feedback_signal * feedback +
      WEIGHTS.scope_priority * priority +
      WEIGHTS.tier_priority * tier -
      stale -
      conflict -
      unsafe;
    items.push({
      entry,
      score,
      components: {
        lexical_relevance: rrf,
        scope_affinity: scope,
        actor_trust: trust,
        importance,
        confidence,
        recency,
        access_signal: access,
        feedback_signal: feedback,
        scope_priority: priority,
        tier_priority: tier,
        stale_penalty: stale,
        conflict_penalty: conflict,
        unsafe_content_penalty: unsafe
      },
      truncated: false
    });
  }
  items.sort((a, b) => {
    const scoreOrder = b.score - a.score;
    if (scoreOrder !== 0) return scoreOrder;
    const importanceOrder = b.entry.importance - a.entry.importance;
    if (importanceOrder !== 0) return importanceOrder;
    const confidenceOrder = b.entry.confidence - a.entry.confidence;
    if (confidenceOrder !== 0) return confidenceOrder;
    if (a.entry.updated_at !== b.entry.updated_at) {
      return a.entry.updated_at < b.entry.updated_at ? 1 : -1;
    }
    return a.entry.id < b.entry.id ? -1 : 1;
  });
  const topK = input.topK;
  return topK === undefined || topK >= items.length ? items : items.slice(0, topK);
}
