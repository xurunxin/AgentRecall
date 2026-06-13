import { err, ok, type MemoryBudget, type MemoryEntry, type Result } from "./domain.js";
import type { BudgetUsage } from "./sqlite-store.js";

export type BudgetWarning = {
  code: "duplicate_candidate";
  memory_id: string;
  reason: string;
};

export type CandidateAction = {
  action: "forget_memory" | "supersede_memory" | "archive";
  memory_id?: string;
  memory_ids?: string[];
  reason: string;
};

export type BudgetAccepted = {
  warnings: BudgetWarning[];
  budget_after: BudgetUsage;
};

export type BudgetInput = {
  budget: MemoryBudget;
  usage: BudgetUsage;
  candidate: Pick<MemoryEntry, "topic" | "title" | "body" | "tags" | "char_count">;
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

function cleanupAction(entry: MemoryEntry, now: string): CandidateAction["action"] {
  if (entry.expires_at && entry.expires_at <= now) return "forget_memory";
  return "archive";
}

function cleanupDate(entry: MemoryEntry): string | undefined {
  return [entry.review_after, entry.expires_at].filter((date): date is string => date !== undefined).sort()[0];
}

function compareOptionalIso(a: string | undefined, b: string | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a.localeCompare(b);
}

function candidateIndexChars(candidate: BudgetInput["candidate"]): number {
  return candidate.title.length + candidate.topic.length + candidate.tags.join(" ").length + 16;
}

function isProtectedCleanupEntry(entry: MemoryEntry): boolean {
  return entry.source.kind === "user" || entry.importance >= 5;
}

export function rankCleanupCandidates(entries: MemoryEntry[], now: string): CandidateAction[] {
  return entries
    .filter((entry) => !isProtectedCleanupEntry(entry))
    .map((entry) => {
      let score = 0;
      score += 6 - entry.importance;
      score += 6 - entry.confidence;
      if (entry.expires_at && entry.expires_at <= now) score += 5;
      if (entry.review_after && entry.review_after <= now) score += 2;
      if (entry.access_count === 0) score += 2;
      return { entry, score, cleanup_date: cleanupDate(entry) };
    })
    .sort((a, b) => {
      const scoreOrder = b.score - a.score;
      if (scoreOrder !== 0) return scoreOrder;

      const cleanupDateOrder = compareOptionalIso(a.cleanup_date, b.cleanup_date);
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
  const warnings: BudgetWarning[] = existingEntries
    .filter((entry) => sameText(entry.title, input.candidate.title) || sameText(entry.body, input.candidate.body))
    .map((entry) => ({
      code: "duplicate_candidate",
      memory_id: entry.id,
      reason: "existing active memory has the same title or body"
    }));

  const topicChars = cloneTopicChars(input.usage.topic_chars);
  topicChars[input.candidate.topic] = (topicChars[input.candidate.topic] ?? 0) + input.candidate.char_count;

  const budget_after: BudgetUsage = {
    active_entries: input.usage.active_entries + 1,
    active_chars: input.usage.active_chars + input.candidate.char_count,
    topic_chars: topicChars,
    index_chars: input.usage.index_chars + candidateIndexChars(input.candidate)
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
    candidate_actions: rankCleanupCandidates(existingEntries, input.now ?? new Date().toISOString())
  });
}
