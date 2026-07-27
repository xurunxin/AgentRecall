import { err, ok, type MemoryBudget, type MemoryEntry, type Result } from "./domain.js";
import type { BudgetUsage } from "./sqlite-store.js";
import { SIMILARITY_THRESHOLD, textSimilarity } from "./text-similarity.js";

export type BudgetWarning = {
  code: "duplicate_candidate" | "near_duplicate";
  memory_id: string;
  reason: string;
  similarity?: number;
  actor?: string;
  last_accessed_by?: Record<string, string>;
};

export type CandidateAction =
  | { action: "forget_memory"; memory_id: string; reason: string }
  | { action: "archive"; memory_id: string; reason: string }
  | { action: "supersede_memory"; memory_ids: string[]; reason: string };

type CleanupActionName = "forget_memory" | "archive";

export type BudgetAccepted = {
  warnings: BudgetWarning[];
  budget_after: BudgetUsage;
};

export type BudgetInput = {
  budget: MemoryBudget;
  usage: BudgetUsage;
  candidate: Pick<MemoryEntry, "topic" | "title" | "body" | "tags" | "status" | "char_count">;
  existingEntries?: MemoryEntry[];
  now?: string;
};

function sameText(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function cloneTopicChars(topicChars: BudgetUsage["topic_chars"]): BudgetUsage["topic_chars"] {
  const result: BudgetUsage["topic_chars"] = Object.create(null) as BudgetUsage["topic_chars"];
  for (const [topic, chars] of Object.entries(topicChars)) {
    result[topic] = chars;
  }
  return result;
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isExpired(expiresAt: string | undefined, now: string): boolean {
  const expiresAtTimestamp = parseTimestamp(expiresAt);
  const nowTimestamp = parseTimestamp(now);
  return expiresAtTimestamp !== undefined && nowTimestamp !== undefined && expiresAtTimestamp <= nowTimestamp;
}

function cleanupAction(entry: MemoryEntry, now: string): CleanupActionName {
  return isExpired(entry.expires_at, now) ? "forget_memory" : "archive";
}

function cleanupDate(entry: MemoryEntry): number | undefined {
  return [parseTimestamp(entry.review_after), parseTimestamp(entry.expires_at)]
    .filter((date): date is number => date !== undefined)
    .sort((a, b) => a - b)[0];
}

function compareOptionalNumber(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a - b;
}

function codePointCount(text: string): number {
  return Array.from(text).length;
}

export function estimateIndexChars(title: string, topic: string, tags: string[]): number {
  return codePointCount(title) + codePointCount(topic) + codePointCount(tags.join(" ")) + 16;
}

/**
 * Stage 18 v1.1.2 (issue #24, task 5): a single
 * batch operation in the import preflight. The
 * preflight classifies each entry as an insert,
 * a replace (overwrites an existing id), or a
 * merge (combines tags / body with an existing
 * id). The preflight budget check needs the
 * NET impact on the live budget: inserts / merges
 * add `char_count`; replaces do too BUT the
 * existing entry's `char_count` is released
 * (the existing row is overwritten, so the
 * previous char_count disappears from the
 * `active_chars` sum).
 */
export type BatchOp = {
  kind: "insert" | "replace" | "merge";
  /** The entry that will be written on success. */
  entry: MemoryEntry;
  /**
   * The entry being overwritten / merged into
   * (for `replace` / `merge`). `undefined` for
   * `insert`. The `char_count` + index size of
   * this entry is released from the active
   * budget.
   */
  existing?: MemoryEntry;
};

/**
 * The reason a batch was rejected. The
 * preflight surfaces this code in the
 * `aggregate_budget` error so the CLI can
 * branch on the failure mode without re-parsing
 * the message.
 */
export type BatchBudgetExceededCode =
  | "max_active_entries"
  | "max_total_chars"
  | "max_topic_chars"
  | "max_index_chars";

export type BatchBudgetResult = {
  /** Live usage before the batch. */
  before: BudgetUsage;
  /** Projected usage after the batch (when all ops succeed). */
  after: BudgetUsage;
  /** Sum of `char_count` for inserts / replaces / merges (the raw insert size). */
  batch_chars: number;
  /** Sum of `char_count` released by replaces / merges. */
  releases: number;
  /** Net change to `active_chars` (`batch_chars - releases`). */
  net_chars: number;
  /** Sum of `estimateIndexChars` for inserts / replaces / merges. */
  batch_index_chars: number;
  /** Sum of index chars released by replaces / merges. */
  released_index_chars: number;
  /** Net change to `index_chars`. */
  net_index_chars: number;
  /** Count of inserts in the batch. */
  insert_count: number;
  /** Count of replacements in the batch. */
  replace_count: number;
  /** Count of merges in the batch. */
  merge_count: number;
};

export type BatchBudgetError = {
  code: BatchBudgetExceededCode;
  budget: MemoryBudget;
  usage: BudgetUsage;
  budget_after: BudgetUsage;
  /** The active_entries / active_chars / topic_chars / index_chars the batch would push past the limit. */
  observed: number;
  limit: number;
};

/**
 * Compute the projected active budget after a
 * batch. The batch is checked as a whole (not
 * per-op) so the preflight can refuse an
 * aggregate overshoot before any mutation.
 *
 * The function is pure: it does not call into
 * the store. The caller (the import preflight)
 * supplies the `before` usage from
 * `SQLiteMemoryStore.getBudgetUsage(...)` and
 * the configured `budget` from the project
 * scope / the global default.
 *
 * Replace / merge release the existing entry's
 * `char_count` and index size, so the function
 * computes the NET impact. A batch that
 * overwrites N existing rows by larger rows
 * and pushes `active_chars` past
 * `max_total_chars` is rejected; a batch that
 * overwrites N existing rows by smaller rows
 * is allowed even when the raw insert size
 * would push past the limit.
 */
export function projectBatchBudget(input: {
  budget: MemoryBudget;
  usage: BudgetUsage;
  ops: BatchOp[];
}):
  | { ok: true; result: BatchBudgetResult }
  | {
      ok: false;
      error: BatchBudgetError;
      result: BatchBudgetResult;
    } {
  const { budget, usage, ops } = input;
  // Accumulate the release AND the new size so
  // the net change is observable to the
  // operator (the `PreflightPlan` exposes
  // `batch_chars`, `releases`, `net_chars`).
  let batch_chars = 0;
  let releases = 0;
  let batch_index_chars = 0;
  let released_index_chars = 0;
  let insert_count = 0;
  let replace_count = 0;
  let merge_count = 0;
  // The per-topic shift is also a net (inserts
  // / merges add the new entry's chars; the
  // existing entry's chars are subtracted for
  // replaces / merges). Empty / forgotten
  // entries are skipped.
  const topicDelta: Record<string, number> = {};
  for (const op of ops) {
    const newIndex = estimateIndexChars(op.entry.title, op.entry.topic, op.entry.tags);
    if (op.kind === "insert") {
      batch_chars += op.entry.char_count;
      batch_index_chars += newIndex;
      insert_count += 1;
      topicDelta[op.entry.topic] = (topicDelta[op.entry.topic] ?? 0) + op.entry.char_count;
    } else {
      const existing = op.existing;
      if (existing !== undefined) {
        releases += existing.char_count;
        const existingIndex = estimateIndexChars(existing.title, existing.topic, existing.tags);
        released_index_chars += existingIndex;
        topicDelta[existing.topic] = (topicDelta[existing.topic] ?? 0) - existing.char_count;
      }
      batch_chars += op.entry.char_count;
      batch_index_chars += newIndex;
      // The new entry's topic may differ from
      // the existing entry's topic (e.g. a
      // re-categorised replace). Add the new
      // entry's char_count to the new topic.
      topicDelta[op.entry.topic] = (topicDelta[op.entry.topic] ?? 0) + op.entry.char_count;
      if (op.kind === "replace") {
        replace_count += 1;
      } else {
        merge_count += 1;
      }
    }
  }

  const topic_chars: Record<string, number> = { ...usage.topic_chars };
  for (const [topic, delta] of Object.entries(topicDelta)) {
    const next = (topic_chars[topic] ?? 0) + delta;
    if (next <= 0) {
      delete topic_chars[topic];
    } else {
      topic_chars[topic] = next;
    }
  }

  const budget_after: BudgetUsage = {
    active_entries: usage.active_entries + insert_count - releasesForCount(ops),
    active_chars: usage.active_chars + batch_chars - releases,
    topic_chars,
    index_chars: usage.index_chars + batch_index_chars - released_index_chars
  };

  // Compute the per-topic maxima so the call
  // site surfaces WHICH topic broke the limit.
  let maxTopic: { topic: string; chars: number } | undefined = undefined;
  for (const [topic, chars] of Object.entries(topic_chars)) {
    if (maxTopic === undefined || chars > maxTopic.chars) {
      maxTopic = { topic, chars };
    }
  }

  const result: BatchBudgetResult = {
    before: usage,
    after: budget_after,
    batch_chars,
    releases,
    net_chars: batch_chars - releases,
    batch_index_chars,
    released_index_chars,
    net_index_chars: batch_index_chars - released_index_chars,
    insert_count,
    replace_count,
    merge_count
  };

  // The checks are ordered most-likely to bind
  // first. The compact error codes pin the
  // failure mode so the CLI can branch on the
  // reason without re-parsing the message.
  if (budget.max_active_entries !== undefined && budget_after.active_entries > budget.max_active_entries) {
    return {
      ok: false,
      error: {
        code: "max_active_entries",
        budget,
        usage,
        budget_after,
        observed: budget_after.active_entries,
        limit: budget.max_active_entries
      },
      result
    };
  }
  if (budget.max_total_chars !== undefined && budget_after.active_chars > budget.max_total_chars) {
    return {
      ok: false,
      error: {
        code: "max_total_chars",
        budget,
        usage,
        budget_after,
        observed: budget_after.active_chars,
        limit: budget.max_total_chars
      },
      result
    };
  }
  if (budget.max_topic_chars !== undefined && maxTopic !== undefined && maxTopic.chars > budget.max_topic_chars) {
    return {
      ok: false,
      error: {
        code: "max_topic_chars",
        budget,
        usage,
        budget_after,
        observed: maxTopic.chars,
        limit: budget.max_topic_chars
      },
      result
    };
  }
  if (budget.max_index_chars !== undefined && budget_after.index_chars > budget.max_index_chars) {
    return {
      ok: false,
      error: {
        code: "max_index_chars",
        budget,
        usage,
        budget_after,
        observed: budget_after.index_chars,
        limit: budget.max_index_chars
      },
      result
    };
  }

  return { ok: true, result };
}

function releasesForCount(ops: BatchOp[]): number {
  let count = 0;
  for (const op of ops) {
    if (op.kind === "replace" || op.kind === "merge") {
      if (op.existing !== undefined) count += 1;
    }
  }
  return count;
}

function isProtectedCleanupEntry(entry: MemoryEntry): boolean {
  return entry.source.kind === "user" || entry.importance >= 5;
}

function isCleanupCandidateEntry(entry: MemoryEntry): boolean {
  return entry.status === "active" && !isProtectedCleanupEntry(entry);
}

export function rankCleanupCandidates(entries: MemoryEntry[], now: string): CandidateAction[] {
  return entries
    .filter(isCleanupCandidateEntry)
    .map((entry) => {
      let score = 0;
      score += 6 - entry.importance;
      score += 6 - entry.confidence;
      if (isExpired(entry.expires_at, now)) score += 5;
      if (isExpired(entry.review_after, now)) score += 2;
      if (entry.access_count === 0) score += 2;
      return { entry, score, cleanup_date: cleanupDate(entry) };
    })
    .sort((a, b) => {
      const scoreOrder = b.score - a.score;
      if (scoreOrder !== 0) return scoreOrder;

      const cleanupDateOrder = compareOptionalNumber(a.cleanup_date, b.cleanup_date);
      if (cleanupDateOrder !== 0) return cleanupDateOrder;

      const updatedAtOrder = a.entry.updated_at.localeCompare(b.entry.updated_at);
      if (updatedAtOrder !== 0) return updatedAtOrder;

      return a.entry.id.localeCompare(b.entry.id);
    })
    .slice(0, 5)
    .map(({ entry }) => {
      const action = cleanupAction(entry, now);
      return {
        action,
        memory_id: entry.id,
        reason: action === "forget_memory" ? "expired low-value entry" : "stale low-value entry"
      };
    });
}

export function evaluateBudget(input: BudgetInput): Result<BudgetAccepted, "capacity_exceeded"> {
  const existingEntries = input.existingEntries ?? [];
  const warnings: BudgetWarning[] = [];
  for (const entry of existingEntries) {
    if (entry.status !== "active") continue;
    if (sameText(entry.title, input.candidate.title) || sameText(entry.body, input.candidate.body)) {
      warnings.push({
        code: "duplicate_candidate",
        memory_id: entry.id,
        reason: "existing active memory has the same title or body"
      });
      continue;
    }
    // Stage 3: near-duplicate detection via token-set Jaccard. Advisory
    // only — surfaces in the success response's `warnings` array; the
    // caller decides whether to merge, rewrite, or proceed.
    const titleSim = textSimilarity(entry.title, input.candidate.title);
    const bodySim = textSimilarity(entry.body, input.candidate.body);
    const max = Math.max(titleSim, bodySim);
    if (max >= SIMILARITY_THRESHOLD) {
      warnings.push({
        code: "near_duplicate",
        memory_id: entry.id,
        reason: `near-duplicate by token-set Jaccard (${max.toFixed(3)} >= ${SIMILARITY_THRESHOLD})`,
        similarity: max
      });
    }
  }

  const countsAgainstActiveBudget = input.candidate.status === "active";
  const topicChars = cloneTopicChars(input.usage.topic_chars);
  if (countsAgainstActiveBudget) {
    topicChars[input.candidate.topic] = (topicChars[input.candidate.topic] ?? 0) + input.candidate.char_count;
  }

  const budget_after: BudgetUsage = {
    active_entries: input.usage.active_entries + (countsAgainstActiveBudget ? 1 : 0),
    active_chars: input.usage.active_chars + (countsAgainstActiveBudget ? input.candidate.char_count : 0),
    topic_chars: topicChars,
    index_chars:
      input.usage.index_chars +
      (countsAgainstActiveBudget ? estimateIndexChars(input.candidate.title, input.candidate.topic, input.candidate.tags) : 0)
  };

  const exceeds =
    budget_after.active_entries > input.budget.max_active_entries ||
    budget_after.active_chars > input.budget.max_total_chars ||
    budget_after.index_chars > input.budget.max_index_chars ||
    (input.budget.max_topic_chars !== undefined &&
      (budget_after.topic_chars[input.candidate.topic] ?? 0) > input.budget.max_topic_chars);

  if (!exceeds) {
    return ok({ warnings, budget_after });
  }

  return err("capacity_exceeded", "memory write would exceed configured budget", {
    budget: input.budget,
    usage: input.usage,
    budget_after,
    warnings,
    candidate_actions: rankCleanupCandidates(existingEntries, input.now ?? new Date().toISOString())
  });
}
