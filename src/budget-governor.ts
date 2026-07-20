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
