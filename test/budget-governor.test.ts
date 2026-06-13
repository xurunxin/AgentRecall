import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "../src/domain.js";
import { evaluateBudget, rankCleanupCandidates } from "../src/budget-governor.js";

function entry(id: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    scope: "project",
    project_id: "repo-123",
    type: "lesson",
    topic: "tests",
    title: `Memory ${id}`,
    body: "A memory body",
    tags: [],
    source: { kind: "agent" },
    importance: 3,
    confidence: 3,
    status: "active",
    created_at: "2026-06-13T00:00:00.000Z",
    updated_at: "2026-06-13T00:00:00.000Z",
    access_count: 0,
    supersedes: [],
    token_estimate: 4,
    char_count: 20,
    ...overrides
  };
}

describe("evaluateBudget", () => {
  it("allows writes inside budget", () => {
    const result = evaluateBudget({
      budget: { max_active_entries: 3, max_total_chars: 100, max_topic_chars: 80, max_index_chars: 200 },
      usage: { active_entries: 1, active_chars: 20, topic_chars: { tests: 20 }, index_chars: 20 },
      candidate: entry("mem_new")
    });
    expect(result.ok).toBe(true);
  });

  it("rejects writes exceeding active entry count and returns actions", () => {
    const result = evaluateBudget({
      budget: { max_active_entries: 1, max_total_chars: 100, max_topic_chars: 80, max_index_chars: 200 },
      usage: { active_entries: 1, active_chars: 20, topic_chars: { tests: 20 }, index_chars: 20 },
      candidate: entry("mem_new"),
      existingEntries: [entry("mem_old", { importance: 1, confidence: 1 })]
    });
    expect(result).toMatchObject({
      ok: false,
      error: "capacity_exceeded"
    });
    if (!result.ok) {
      expect(result.details?.candidate_actions).toEqual([
        expect.objectContaining({ action: "forget_memory", memory_id: "mem_old" })
      ]);
    }
  });

  it("warns when duplicate title and body candidates exist", () => {
    const result = evaluateBudget({
      budget: { max_active_entries: 10, max_total_chars: 1000, max_topic_chars: 500, max_index_chars: 500 },
      usage: { active_entries: 1, active_chars: 20, topic_chars: { tests: 20 }, index_chars: 20 },
      candidate: entry("mem_new", { title: "Same", body: "Same body" }),
      existingEntries: [entry("mem_old", { title: "Same", body: "Same body" })]
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.warnings).toContainEqual(expect.objectContaining({ code: "duplicate_candidate" }));
    }
  });

  it("keeps candidate topic budget accounting prototype-safe", () => {
    const result = evaluateBudget({
      budget: { max_active_entries: 10, max_total_chars: 1000, max_topic_chars: 500, max_index_chars: 500 },
      usage: { active_entries: 1, active_chars: 20, topic_chars: { tests: 20 }, index_chars: 20 },
      candidate: entry("mem_new", { topic: "__proto__" })
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.getPrototypeOf(result.value.budget_after.topic_chars)).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(result.value.budget_after.topic_chars, "__proto__")).toBe(true);
      expect(result.value.budget_after.topic_chars["__proto__"]).toBe(20);
    }
  });
});

describe("rankCleanupCandidates", () => {
  it("prefers low importance, expired, low access memories", () => {
    const ranked = rankCleanupCandidates(
      [
        entry("keep", { importance: 5, confidence: 5, access_count: 20 }),
        entry("remove", { importance: 1, confidence: 1, expires_at: "2026-01-01T00:00:00.000Z" })
      ],
      "2026-06-13T00:00:00.000Z"
    );
    expect(ranked[0]?.memory_id).toBe("remove");
  });
});
