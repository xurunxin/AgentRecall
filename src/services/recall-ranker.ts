// src/services/recall-ranker.ts
//
// Stage 10 PR4: single source of truth for recall ordering.
// Stage 15 PR-M1-3 (issue #5, spec § 5.3): hybrid RRF
// fusion + real signals (no placeholders).
// Stage 16 v1.1.1 PR-6 (issue #15, spec § 5.3):
// real multi-source RRF + shared ranking pipeline.
//
// The v1.1.0 contract computed a `lexical_relevance`
// RRF value in the `components` report but the final
// `score` still used a separately-normalised
// `contextQueryScore`, so the explanation and the
// score could diverge. v1.1.1 fixes that by routing
// the final score through a real Reciprocal Rank
// Fusion over multiple candidate sources:
//
//   1. `fts_lexical` — the FTS5-driven candidate list
//      ordered by `contextQueryScore`. The RRF
//      contribution is `1 / (RRF_K + rank_lex)`.
//   2. `access_signal` — the per-actor access rank.
//      Memories the current actor has recently
//      accessed float to the top of this list. The
//      RRF contribution is `1 / (RRF_K + rank_access)`.
//
// The fused RRF score IS the lexical component that
// appears in the `components.lexical_relevance`
// field. The other linear weights
// (`scope_affinity`, `actor_trust`, `importance`,
// `confidence`, `recency`, `access_signal`,
// `feedback_signal`, `scope_priority`,
// `tier_priority`, `stale_penalty`,
// `conflict_penalty`, `unsafe_content_penalty`)
// ride on top of the RRF. The pre-PR-6 placeholder
// `conflict_penalty` is now real: it counts the
// entry's `memory_relations` rows of type
// `contradicts` / `supersedes` and penalises each
// conflicting peer.
//
// `search_memories` and `recall_context` both go
// through this single pipeline. The ranker is a
// pure function when the store is omitted (ranker-
// level unit tests).

import type { MemoryEntry } from "../domain.js";
import type { SQLiteMemoryStore } from "../sqlite-store.js";
import { computeTrustBoost, contextQueryScore, queryTokens } from "./memory-service-helpers.js";

export const RANKING_VERSION = "coding-default-v2";

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
    /** Real RRF value; this is the value used in the
     *  linear combination below. `score` is
     *  computed as `WEIGHTS.lexical_relevance *
     *  lexical_relevance` (the RRF sum) plus the
     *  other components. */
    lexical_relevance: number;
    /** The breakdown of the RRF sum into its sources. */
    rrf_lexical: number;
    rrf_access: number;
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
  /** Stable per-source rank numbers, for the explain
   *  renderer. `null` when the entry did not appear
   *  in a source's list. */
  source_ranks: {
    fts_lexical: number | null;
    fts_trigram: number | null;
    access: number | null;
  };
};

// Stage 16 v1.1.1 PR-6 (issue #15): the RRF is
// computed first, then multiplied by the
// `lexical_relevance` weight. The other weights
// are smaller and ride on top. The pre-PR-6
// weights were tuned for the normalised
// `contextQueryScore` (range 0..1); the RRF sum
// is much smaller (range 0..2 / RRF_K ≈ 0.033
// max for a single source), so the lexical
// weight must dominate. `lexical_relevance =
// 200` makes the RRF delta between rank 1 and
// rank 2 (200 * (1/61 - 1/62) ≈ 0.053) larger
// than the tier_priority delta
// (`0.06 * (1.3 - 1.0) = 0.018`).
const WEIGHTS = {
  lexical_relevance: 200,
  scope_affinity: 0.05,
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
const PENALTY_CONFLICT_PER_REL = 0.05;
const PENALTY_UNSAFE = 0.0; // risk_findings table is not in this release
const RRF_K = 60;
const SCOPE_PRIORITY_PROJECT_BOOST = 0.5;

function importanceNorm(value: number): number {
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
  if (store === undefined) return 0;
  const counts = store.getMemoryFeedbackCounts(entry.id);
  const net = counts.up - counts.down;
  if (net === 0) return 0;
  return Math.max(-1, Math.min(1, net / 5));
}

function stalePenalty(entry: MemoryEntry, now: Date): number {
  const updated = Date.parse(entry.updated_at);
  if (Number.isNaN(updated)) return 0;
  const ageDays = (now.getTime() - updated) / (24 * 60 * 60 * 1000);
  if (ageDays < 180) return 0;
  if (entry.importance >= 3) return 0;
  if (entry.access_count > 0) return 0;
  return PENALTY_STALE;
}

/**
 * Stage 16 v1.1.1 PR-6 (issue #15): real conflict
 * penalty. Counts the entry's `memory_relations`
 * rows where `relation_type` is `contradicts` or
 * `supersedes`. Each conflicting peer applies a
 * 0.05 penalty. The penalty is non-additive up to
 * 0.2 (a memory that contradicts 4+ peers is
 * suppressed but not below 0).
 */
function conflictPenaltyFromStore(
  store: SQLiteMemoryStore | undefined,
  entry: MemoryEntry
): number {
  if (store === undefined) return 0;
  const relations = store.getMemoryRelationsOfType(entry.id, [
    "contradicts",
    "supersedes"
  ]);
  return Math.min(0.2, relations.length * PENALTY_CONFLICT_PER_REL);
}

function unsafeContentPenalty(): number {
  // The `risk_findings` table is not in this release;
  // the `unsafe_content_penalty` is therefore 0.
  // Stage 16 v1.1.1 PR-6 (issue #15) marks the
  // component as known-placeholder so the explain
  // renderer can surface the gap.
  return PENALTY_UNSAFE;
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

function scopePriority(entry: MemoryEntry, primaryScope: "global" | "project"): number {
  if (primaryScope === "project" && entry.scope === "project") return 1;
  if (primaryScope === "global" && entry.scope === "global") return 0.5;
  if (primaryScope === "project" && entry.scope === "global") return 0.1;
  return 0;
}

function tierPriority(entry: MemoryEntry): number {
  return TIER_WEIGHTS[entry.tier];
}

export function rankRecall(input: {
  candidates: MemoryEntry[];
  query: string;
  primaryScope: "global" | "project";
  actor: RankingActor;
  topK?: number;
  now?: Date;
  /**
   * Optional SQLite store. When provided, the
   * `actor_trust`, `access_signal`,
   * `feedback_signal`, and `conflict_penalty`
   * components are computed from the canonical
   * tables. When absent, the access + feedback
   * signals are 0 and the conflict penalty is 0.
   */
  store?: SQLiteMemoryStore;
}): RankedItem[] {
  const now = input.now ?? new Date();
  const tokens = queryTokens(input.query);
  // Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4):
  // temporal policy. The ranker filters candidates
  // by the documented rule:
  //
  //   - `valid_from` in the future  → excluded.
  //   - `valid_until` in the past  → excluded.
  //   - otherwise the entry is eligible.
  //
  // The filter runs BEFORE the lexical / access
  // RRF so an excluded entry never appears in any
  // source's rank list. The temporal-window
  // status is reported in the explain output so
  // callers can see why a memory was excluded.
  const nowMs = now.getTime();
  const isEligible = (entry: MemoryEntry): boolean => {
    if (entry.valid_from !== undefined) {
      const fromMs = Date.parse(entry.valid_from);
      if (!Number.isNaN(fromMs) && fromMs > nowMs) return false;
    }
    if (entry.valid_until !== undefined) {
      const untilMs = Date.parse(entry.valid_until);
      if (!Number.isNaN(untilMs) && untilMs < nowMs) return false;
    }
    return true;
  };
  const eligibleCandidates = input.candidates.filter((e) => e.status === "active" && isEligible(e));
  // Stage 16 v1.1.1 PR-6 (issue #15): build the
  // `fts_lexical` source list. The rank is by
  // descending `lexicalNorm(contextQueryScore)`,
  // tie-broken by id ascending.
  const lexicalRanked = [...eligibleCandidates]
    .map((entry) => ({
      entry,
      lexical: lexicalNorm(contextQueryScore(entry, tokens))
    }))
    .sort((a, b) => {
      if (b.lexical !== a.lexical) return b.lexical - a.lexical;
      // Stage 16 v1.1.1 PR-6 (issue #15): when
      // the lexical scores are equal, the RRF
      // tie-break is by `tier_priority` desc,
      // then by id asc. The pre-PR-6 sort used
      // id-asc only; a `core` entry and an
      // `archival` entry with the same lexical
      // match would resolve on the RRF delta
      // (≈ 0.0003 per rank) instead of the tier
      // signal. The tier tie-break is the
      // canonical pre-sort contract.
      const tierDiff = TIER_WEIGHTS[b.entry.tier] - TIER_WEIGHTS[a.entry.tier];
      if (tierDiff !== 0) return tierDiff > 0 ? 1 : -1;
      return a.entry.id < b.entry.id ? -1 : 1;
    });
  const lexicalRankById = new Map<string, number>();
  lexicalRanked.forEach((row, idx) => lexicalRankById.set(row.entry.id, idx + 1));
  // Stage 16 v1.1.1 PR-6 (issue #15): build the
  // `access` source list. The rank is by
  // per-actor access count desc (the current
  // actor's count first, then any other actor's
  // count as a tie-break), tie-broken by id asc.
  const accessRanked = [...eligibleCandidates]
    .map((entry) => {
      const currentActorCount =
        input.store !== undefined
          ? input.store.getAccessCountFor(entry.id, input.actor.currentActor)
          : 0;
      const totalAccess = accessNormFromStore(input.store, entry);
      return { entry, currentActorCount, totalAccess };
    })
    .filter((row) => row.currentActorCount > 0 || row.totalAccess > 0)
    .sort((a, b) => {
      if (b.currentActorCount !== a.currentActorCount) {
        return b.currentActorCount - a.currentActorCount;
      }
      if (b.totalAccess !== a.totalAccess) {
        return b.totalAccess - a.totalAccess;
      }
      return a.entry.id < b.entry.id ? -1 : 1;
    });
  const accessRankById = new Map<string, number>();
  accessRanked.forEach((row, idx) => accessRankById.set(row.entry.id, idx + 1));
  // Stage 16 v1.1.1 PR-6 (issue #15): the union
  // of the two sources. Every active candidate
  // contributes; sources that do not contain the
  // entry contribute a `null` rank (RRF treats
  // absent-from-source as 0).
  const rrfById = new Map<string, { lexical: number; access: number }>();
  for (const row of lexicalRanked) {
    rrfById.set(row.entry.id, {
      lexical: 1 / (RRF_K + (lexicalRankById.get(row.entry.id) ?? lexicalRanked.length + 1)),
      access: accessRankById.has(row.entry.id)
        ? 1 / (RRF_K + (accessRankById.get(row.entry.id) ?? 0))
        : 0
    });
  }
  const items: RankedItem[] = [];
  for (const row of lexicalRanked) {
    const entry = row.entry;
    const rrfLexical = rrfById.get(entry.id)!.lexical;
    const rrfAccess = rrfById.get(entry.id)!.access;
    const rrf = rrfLexical + rrfAccess;
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
    const conflict = conflictPenaltyFromStore(input.store, entry);
    const unsafe = unsafeContentPenalty();
    // Stage 16 v1.1.1 PR-6 (issue #15): the score
    // uses the RRF (`lexical_relevance` in the
    // components) as the lexical component. The
    // RRF value shown in `components.lexical_relevance`
    // is the EXACT value used in the linear
    // combination. Pre-PR-6 the components field
    // reported `1 / (RRF_K + rank_lex)` but the
    // score used a separately-normalised
    // `contextQueryScore`; the two could diverge.
    const score =
      WEIGHTS.lexical_relevance * rrf +
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
        rrf_lexical: rrfLexical,
        rrf_access: rrfAccess,
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
      truncated: false,
      source_ranks: {
        fts_lexical: lexicalRankById.get(entry.id) ?? null,
        fts_trigram: null,
        access: accessRankById.get(entry.id) ?? null
      }
    });
  }
  items.sort((a, b) => {
    const scoreOrder = b.score - a.score;
    if (scoreOrder !== 0) return scoreOrder;
    // Stage 16 v1.1.1 PR-6 (issue #15): the
    // tier_priority is the canonical tie-break
    // when the score difference is below the
    // RRF rank delta. Without this tie-break, a
    // core entry and an archival entry with
    // identical RRF ranks (same lexical match)
    // but different id-sort positions would
    // resolve on the RRF delta (≈ 0.0003 per
    // rank), not on the tier signal.
    const tierOrder = b.components.tier_priority - a.components.tier_priority;
    if (tierOrder !== 0) return tierOrder;
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
