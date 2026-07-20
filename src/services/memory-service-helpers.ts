// src/services/memory-service-helpers.ts
//
// Stage 9: shared helpers extracted from MemoryService so
// the three sub-services (Read / Write / Maintenance) can
// reuse them without depending on MemoryService itself.
//
// The helpers fall into three groups:
// - Pure functions (no class state): comparison, parsing,
//   fingerprinting, env-var reads.
// - State-taking functions: actor lookup, audit appending,
//   budget evaluation — they take the SQLiteMemoryStore and
//   the resolver / defaultActor as parameters.
// - Constants: env-var names, default values.

import { createHash } from "node:crypto";
import {
  estimateIndexChars,
  evaluateBudget,
  type BudgetAccepted
} from "../budget-governor.js";
import { resolveActor } from "../actor.js";
import {
  DEFAULT_GLOBAL_BUDGET,
  DEFAULT_PROJECT_BUDGET,
  createAuditId,
  nowIso,
  type MemoryAuditEvent,
  type MemoryBudget,
  type MemoryEntry,
  type MemoryScope,
  type ProjectScope,
  type Result
} from "../domain.js";

// Re-export so the sub-services can import the global budget
// default from this module without reaching into domain.ts.
export { DEFAULT_GLOBAL_BUDGET };
import type { BudgetUsage, SQLiteMemoryStore } from "../sqlite-store.js";
import type { ValidatedRememberInput } from "../write-validator.js";

// ============================================================
// Constants (Stage 7: env-configurable trust weights)
// ============================================================

export const DEFAULT_STRONG_TRUST_BOOST = 0.3;
export const DEFAULT_SOFT_TRUST_BOOST = 0.1;
export const ENV_TRUST_STRONG = "AGENT_RECALL_TRUST_STRONG";
export const ENV_TRUST_SOFT = "AGENT_RECALL_TRUST_SOFT";

// ============================================================
// Pure helpers: comparison, parsing, fingerprinting
// ============================================================

export function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function parseTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function isDue(timestamp: string | undefined, now: string): boolean {
  const dueAt = parseTimestamp(timestamp);
  const current = parseTimestamp(now);
  return dueAt !== undefined && current !== undefined && dueAt <= current;
}

export function normalizeDuplicateText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function duplicateFingerprint(
  reason: "same_title_and_body" | "same_title" | "same_body" | "similar_title_and_body",
  key: string
): string {
  return createHash("sha256").update(`${reason}\n${key}`).digest("hex").slice(0, 12);
}

export function queryTokens(query: string | undefined): string[] {
  if (query === undefined) return [];
  return [...new Set((query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((token) => token.length > 0))].sort();
}

export function contextQueryScore(entry: MemoryEntry, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const title = entry.title.toLowerCase();
  const topic = entry.topic.toLowerCase();
  const tags = entry.tags.join(" ").toLowerCase();
  const body = entry.body.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (title.includes(token)) score += 8;
    if (topic.includes(token)) score += 4;
    if (tags.includes(token)) score += 3;
    if (body.includes(token)) score += 1;
  }
  return score;
}

export type ContextScore = {
  entry: MemoryEntry;
  query_score: number;
  trust_boost: number;
};

export function compareContextScores(a: ContextScore, b: ContextScore): number {
  const queryOrder = b.query_score - a.query_score;
  if (queryOrder !== 0) return queryOrder;

  const trustOrder = b.trust_boost - a.trust_boost;
  if (trustOrder !== 0) return trustOrder;

  const importanceOrder = b.entry.importance - a.entry.importance;
  if (importanceOrder !== 0) return importanceOrder;

  const confidenceOrder = b.entry.confidence - a.entry.confidence;
  if (confidenceOrder !== 0) return confidenceOrder;

  const updatedOrder = compareText(b.entry.updated_at, a.entry.updated_at);
  if (updatedOrder !== 0) return updatedOrder;

  return compareText(a.entry.id, b.entry.id);
}

export function compareLowValueCandidates(a: MemoryEntry, b: MemoryEntry): number {
  const importanceOrder = a.importance - b.importance;
  if (importanceOrder !== 0) return importanceOrder;

  const confidenceOrder = a.confidence - b.confidence;
  if (confidenceOrder !== 0) return confidenceOrder;

  const updatedOrder = compareText(a.updated_at, b.updated_at);
  if (updatedOrder !== 0) return updatedOrder;

  return compareText(a.id, b.id);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeScopeFromInput(input: unknown): MemoryScope {
  return isRecord(input) && input.scope === "project" ? "project" : "global";
}

export function safeProjectIdFromInput(input: unknown): string | undefined {
  return isRecord(input) && typeof input.project_id === "string" ? input.project_id : undefined;
}

export function parseEnvFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    process.stderr.write(
      `agent-recall: invalid ${name}="${raw}", using default ${fallback}\n`
    );
    return fallback;
  }
  return parsed;
}

// ============================================================
// State-taking helpers: actor lookup, audit, budget
// ============================================================

/**
 * Walk the audit log to find the first "created" event for
 * this entry. That event's actor is the canonical writer.
 * Fall back to the legacy kind if no audit row is found.
 */
export function actorForEntry(
  store: SQLiteMemoryStore,
  entry: MemoryEntry
): string {
  const events = store.getAuditEvents(entry.id);
  const created = events.find((e) => e.event === "created");
  if (created !== undefined) return created.actor;
  return entry.source.kind;
}

export function budgetFor(
  store: SQLiteMemoryStore,
  entry: { scope: MemoryScope; project_id?: string | undefined }
): MemoryBudget {
  if (entry.scope === "global") {
    return DEFAULT_GLOBAL_BUDGET;
  }
  return store.getProjectScope(entry.project_id ?? "")?.budget ?? DEFAULT_PROJECT_BUDGET;
}

export function activeEntriesFor(
  store: SQLiteMemoryStore,
  entry: Pick<MemoryEntry, "scope" | "project_id">
): MemoryEntry[] {
  return store.listEntries({
    scope: entry.scope,
    ...(entry.project_id !== undefined ? { project_id: entry.project_id } : {}),
    status: "active",
    limit: 10_000
  });
}

export function usageFromActiveEntries(entries: MemoryEntry[]): BudgetUsage {
  const topic_chars: Record<string, number> = {};
  let active_chars = 0;
  let index_chars = 0;

  for (const entry of entries) {
    active_chars += entry.char_count;
    topic_chars[entry.topic] = (topic_chars[entry.topic] ?? 0) + entry.char_count;
    index_chars += estimateIndexChars(entry.title, entry.topic, entry.tags);
  }

  return {
    active_entries: entries.length,
    active_chars,
    topic_chars,
    index_chars
  };
}

/**
 * Append an audit event. Resolves the actor through
 * resolveActor so an explicit override still wins. The
 * caller is responsible for catching a missing
 * `memory_id` / `project_id` field by spreading
 * conditionally.
 */
export function appendAudit(
  store: SQLiteMemoryStore,
  defaultActor: string,
  input: Omit<MemoryAuditEvent, "id" | "created_at" | "actor"> & { actor?: string }
): void {
  const event: MemoryAuditEvent = {
    id: createAuditId(),
    scope: input.scope,
    event: input.event,
    actor: resolveActor(input.actor ?? defaultActor) as MemoryAuditEvent["actor"],
    metadata: input.metadata,
    created_at: nowIso()
  };
  if (input.memory_id !== undefined) event.memory_id = input.memory_id;
  if (input.project_id !== undefined) event.project_id = input.project_id;
  if (input.reason !== undefined) event.reason = input.reason;
  store.appendAudit(event);
}

export function rejectionMetadata(
  error: string,
  details: Record<string, unknown> | undefined
): Record<string, unknown> {
  return details === undefined ? { error } : { error, ...details };
}

/**
 * Stage 10 PR2: assert that a `scope=project` resolved
 * scope actually carries a non-empty `project_id`. Destructive
 * maintenance actions must call this on the way in so a stale
 * `project_id === undefined` (which used to silently fall
 * through to the cross-project filter) is caught before any
 * mutation.
 *
 * Throws on failure. The maintenance service catches and
 * converts to a `changed=0` result with
 * `details.error = "invalid_scope"`.
 */
export function assertProjectScope(
  scope: { scope: "global" | "project"; project_id?: string | undefined },
  action: string
): void {
  if (scope.scope === "project" && (scope.project_id === undefined || scope.project_id.length === 0)) {
    throw new Error(
      `assertProjectScope: destructive action '${action}' requires a non-empty project_id`
    );
  }
}

export function auditRejected(
  store: SQLiteMemoryStore,
  defaultActor: string,
  input: unknown,
  error: string,
  details: Record<string, unknown> | undefined
): void {
  const project_id = safeProjectIdFromInput(input);
  appendAudit(store, defaultActor, {
    scope: safeScopeFromInput(input),
    ...(project_id !== undefined ? { project_id } : {}),
    event: "write_rejected",
    actor: "system",
    reason: error,
    metadata: rejectionMetadata(error, details)
  });
}

export function auditRejectedForEntry(
  store: SQLiteMemoryStore,
  defaultActor: string,
  entry: MemoryEntry,
  error: string,
  details: Record<string, unknown> | undefined
): void {
  appendAudit(store, defaultActor, {
    memory_id: entry.id,
    scope: entry.scope,
    ...(entry.project_id !== undefined ? { project_id: entry.project_id } : {}),
    event: "write_rejected",
    actor: "system",
    reason: error,
    metadata: rejectionMetadata(error, details)
  });
}

export function auditRejectedForScope(
  store: SQLiteMemoryStore,
  defaultActor: string,
  scope: MemoryScope,
  project_id: string | undefined,
  error: string,
  details: Record<string, unknown> | undefined
): void {
  appendAudit(store, defaultActor, {
    scope,
    ...(project_id !== undefined ? { project_id } : {}),
    event: "write_rejected",
    actor: "system",
    reason: error,
    metadata: rejectionMetadata(error, details)
  });
}

/**
 * Pure function: does the old memory match the replacement's
 * scope and project_id? Used by supersede and merge.
 */
export function matchesReplacementScope(old: MemoryEntry, replacement: MemoryEntry): boolean {
  if (old.scope !== replacement.scope) return false;
  if (old.scope === "project") {
    return old.project_id === replacement.project_id;
  }
  return true;
}

/**
 * Evaluate a candidate entry against the current budget.
 * Returns the same shape MemoryService previously produced
 * internally; the warnings are enriched with the matched
 * entry's writer actor and last_accessed_by so the agent
 * can decide what to do (Stage 3 advisory).
 */
export type EvaluateEntryBudgetResult =
  | { ok: true; value: BudgetAccepted }
  | { ok: false; error: "capacity_exceeded"; message: string; details?: Record<string, unknown> };

export function evaluateEntryBudget(
  store: SQLiteMemoryStore,
  entry: MemoryEntry,
  budget: MemoryBudget,
  options: { excludedActiveMemoryIds?: ReadonlySet<string> } = {}
): EvaluateEntryBudgetResult {
  const existingEntries = activeEntriesFor(store, entry).filter(
    (existing) => !options.excludedActiveMemoryIds?.has(existing.id)
  );
  const usage = usageFromActiveEntries(existingEntries);
  const result = evaluateBudget({ budget, usage, candidate: entry, existingEntries, now: entry.updated_at });
  if (!result.ok) {
    return {
      ok: false,
      error: "capacity_exceeded",
      message: "capacity exceeded",
      ...(result.details !== undefined ? { details: result.details } : {})
    };
  }
  // Stage 3: enrich each warning with the matching memory's writer
  // actor (from the audit log) and its last_accessed_by map.
  const enrichedWarnings = result.value.warnings.map((w) => {
    const matched = existingEntries.find((e) => e.id === w.memory_id);
    if (matched === undefined) return w;
    const enriched: typeof w = { ...w };
    enriched.actor = actorForEntry(store, matched);
    if (matched.last_accessed_by !== undefined) {
      enriched.last_accessed_by = matched.last_accessed_by;
    }
    return enriched;
  });
  return { ok: true, value: { ...result.value, warnings: enrichedWarnings } };
}

/**
 * Stage 5: per-memory trust boost for recall ranking.
 *
 * Returns the strong boost (default 0.3) when the memory
 * was written by `currentActor`, the soft boost (default
 * 0.1) when the current actor appears in the memory's
 * `last_accessed_by` map, or 0 otherwise. Returns 0 when
 * `currentActor` is empty.
 *
 * Stage 7: the strong / soft weights are configurable
 * via the AGENT_RECALL_TRUST_STRONG and
 * AGENT_RECALL_TRUST_SOFT env vars.
 */
export function computeTrustBoost(
  entry: MemoryEntry,
  currentActor: string,
  actorForEntryFn: (entry: MemoryEntry) => string
): number {
  if (currentActor.length === 0) return 0;
  const strong = parseEnvFloat(ENV_TRUST_STRONG, DEFAULT_STRONG_TRUST_BOOST);
  const soft = parseEnvFloat(ENV_TRUST_SOFT, DEFAULT_SOFT_TRUST_BOOST);
  const writer = actorForEntryFn(entry);
  if (writer === currentActor) return strong;
  if (entry.last_accessed_by !== undefined && entry.last_accessed_by[currentActor] !== undefined) {
    return soft;
  }
  return 0;
}

/**
 * Construct a brand-new MemoryEntry from a validated
 * remember input. Used by the write path.
 */
export function buildEntry(
  input: ValidatedRememberInput,
  scope: MemoryScope,
  timestamp: string,
  project: { project_id?: string; project_path?: string },
  id: string
): MemoryEntry {
  return {
    id,
    scope,
    ...(project.project_id !== undefined ? { project_id: project.project_id } : {}),
    ...(project.project_path !== undefined ? { project_path: project.project_path } : {}),
    type: input.type,
    topic: input.topic,
    title: input.title,
    body: input.body,
    tags: input.tags,
    source: input.source,
    importance: input.importance,
    confidence: input.confidence,
    status: input.status,
    created_at: timestamp,
    updated_at: timestamp,
    access_count: 0,
    ...(input.expires_at !== undefined ? { expires_at: input.expires_at } : {}),
    ...(input.review_after !== undefined ? { review_after: input.review_after } : {}),
    supersedes: input.supersedes,
    token_estimate: input.token_estimate,
    char_count: input.char_count,
    // Stage 12 PR9: schema v4 defaults. A new entry
    // starts at revision 1; the write service overwrites
    // writer_actor_id with the resolved caller before
    // commit. The migration back-fills these for legacy
    // v3 rows.
    revision: 1,
    writer_actor_id: "agent:pending",
    pinned: false,
    trust_level: "agent_observed",
    sensitivity: "normal",
    metadata: {}
  };
}

/**
 * Ensure a project scope exists; create one with the
 * default budget if not. Returns the existing or
 * newly-created scope.
 */
export function ensureProjectScope(
  store: SQLiteMemoryStore,
  configureFn: (
    project_id: string,
    budget: MemoryBudget,
    canonical_path: string,
    display_name: string
  ) => ProjectScope,
  project_id: string,
  project_path: string,
  display_name: string
): ProjectScope {
  const existing = store.getProjectScope(project_id);
  return existing ?? configureFn(project_id, DEFAULT_PROJECT_BUDGET, project_path, display_name);
}

/**
 * Read-side scope helpers. Both the read and maintenance
 * sub-services use these; the maintenance code needs to
 * walk all active entries in a scope to find candidates
 * for archive / expire / dedup, and the read code needs
 * the same to build context packs.
 */

export function activeEntriesForScope(
  store: SQLiteMemoryStore,
  scope: { scope: MemoryScope; project_id?: string | undefined }
): MemoryEntry[] {
  return store.listEntries({
    scope: scope.scope,
    ...(scope.project_id !== undefined ? { project_id: scope.project_id } : {}),
    status: "active",
    limit: 10_000
  });
}

export function allEntriesForScope(
  store: SQLiteMemoryStore,
  scope: { scope: MemoryScope; project_id?: string | undefined }
): MemoryEntry[] {
  return store.listEntries({
    scope: scope.scope,
    ...(scope.project_id !== undefined ? { project_id: scope.project_id } : {}),
    limit: 10_000
  });
}

export function usageForScope(
  store: SQLiteMemoryStore,
  scope: { scope: MemoryScope; project_id?: string | undefined }
): BudgetUsage {
  return store.getBudgetUsage({
    scope: scope.scope,
    ...(scope.project_id !== undefined ? { project_id: scope.project_id } : {})
  });
}

/**
 * Re-export Result for callers that don't want to import
 * from domain directly. Convenience only.
 */
export type { Result };
