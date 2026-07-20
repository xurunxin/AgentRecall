// src/services/recall-ranker.ts
//
// Stage 10 PR4: single source of truth for recall ordering.
//
// Pre-PR4 the read service computed a per-collect sort that
// hardcoded `trust_boost: 0`, the markdown exporter then
// re-sorted by importance + trust, and the ContextPacker
// (`boundedJoin`) bailed out on the first block larger than
// the budget. The three independent ordering decisions
// produced a different final order from the ranker, so the
// "trust boost" and "query_score" signals were not stable.
//
// The new pipeline:
//
//   Candidates (from FTS / listEntries / project scope + global)
//     -> RecallRanker.rank  (this file; score + sort + explain)
//     -> ContextPacker.pack (markdown-exporter; render only, no sort)
//
// The ranker emits an immutable `RankedItem[]` together with
// the score breakdown so the explain_recall tool can render
// the same numbers the renderer consumed.
//
// Reference: spec § 5.3 AR-P0-003 "单一召回排序与上下文打包链路".

import type { MemoryEntry } from "../domain.js";
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
    stale_penalty: number;
    conflict_penalty: number;
    unsafe_content_penalty: number;
  };
  truncated: boolean;
};

const WEIGHTS = {
  lexical_relevance: 0.5,
  scope_affinity: 0.12,
  actor_trust: 0.1,
  importance: 0.08,
  confidence: 0.06,
  recency: 0.06,
  access_signal: 0.04,
  feedback_signal: 0.04
} as const;

const PENALTY_STALE = 0.05;
const PENALTY_CONFLICT = 0.05;
const PENALTY_UNSAFE = 0.05;

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

function accessNorm(entry: MemoryEntry): number {
  // log(1 + count) / log(1 + 100), capped to 1.
  if (entry.access_count <= 0) return 0;
  return Math.min(1, Math.log(1 + entry.access_count) / Math.log(1 + 100));
}

function feedbackNorm(): number {
  // Stage 10 PR4 has no feedback table yet. Spec § 6.2
  // introduces record_memory_feedback in PR9; until then the
  // signal is uniformly zero.
  return 0;
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
  // Conflict detection arrives in Stage 12 PR9 (memory_relations
  // table). Until then no entry carries a conflict flag, so
  // the penalty is uniformly zero.
  return 0;
}

function unsafeContentPenalty(): number {
  // Prompt-injection risk detection arrives in Stage 12 PR9.
  // The penalty is zero until the risk-detector is wired in.
  return 0;
}

function trustNorm(trustBoost: number): number {
  // trustBoost is in [-1, 1] but in practice it's a small
  // positive number (0.3 strong, 0.1 soft). Map a [0, 0.5]
  // boost onto [0, 1] so the weight in the formula is
  // meaningful.
  if (trustBoost <= 0) return 0;
  if (trustBoost >= 0.5) return 1;
  return trustBoost / 0.5;
}

function lexicalNorm(rawScore: number): number {
  // contextQueryScore uses a weighted sum of (title: 8,
  // topic: 4, tags: 3, body: 1) per matching token. A
  // single-token match in the title is 8; a five-word query
  // where every word hits the body is 5. We treat 32+ as
  // full relevance.
  if (rawScore <= 0) return 0;
  return Math.min(1, rawScore / 32);
}

function scopeAffinity(entry: MemoryEntry, primaryScope: "global" | "project"): number {
  // When the caller is in a project context, project entries
  // get full affinity; global entries get a 0.5 boost only
  // when the caller asked for include_global. This matches
  // the spec: "project query 中，项目记忆获得 scope boost，
  // global 记忆仍按相关性竞争".
  if (entry.scope === primaryScope) return 1;
  if (primaryScope === "project" && entry.scope === "global") return 0.4;
  return 0.5;
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
}): RankedItem[] {
  const now = input.now ?? new Date();
  const tokens = queryTokens(input.query);
  const items: RankedItem[] = [];
  for (const entry of input.candidates) {
    if (entry.status !== "active") continue;
    const lexical = lexicalNorm(contextQueryScore(entry, tokens));
    const scope = scopeAffinity(entry, input.primaryScope);
    const trust = trustNorm(
      computeTrustBoost(entry, input.actor.currentActor, input.actor.actorForEntry)
    );
    const importance = importanceNorm(entry.importance);
    const confidence = confidenceNorm(entry.confidence);
    const recency = recencyNorm(entry, now);
    const access = accessNorm(entry);
    const feedback = feedbackNorm();
    const stale = stalePenalty(entry, now);
    const conflict = conflictPenalty();
    const unsafe = unsafeContentPenalty();
    const score =
      WEIGHTS.lexical_relevance * lexical +
      WEIGHTS.scope_affinity * scope +
      WEIGHTS.actor_trust * trust +
      WEIGHTS.importance * importance +
      WEIGHTS.confidence * confidence +
      WEIGHTS.recency * recency +
      WEIGHTS.access_signal * access +
      WEIGHTS.feedback_signal * feedback -
      stale -
      conflict -
      unsafe;
    items.push({
      entry,
      score,
      components: {
        lexical_relevance: lexical,
        scope_affinity: scope,
        actor_trust: trust,
        importance,
        confidence,
        recency,
        access_signal: access,
        feedback_signal: feedback,
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
    // Stable tiebreakers so the ranker is deterministic given
    // the same input set.
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
