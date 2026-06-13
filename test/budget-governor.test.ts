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

  it("allows writes exactly at budget maximums", () => {
    const result = evaluateBudget({
      budget: { max_active_entries: 1, max_total_chars: 20, max_topic_chars: 20, max_index_chars: 33 },
      usage: { active_entries: 0, active_chars: 0, topic_chars: { tests: 0 }, index_chars: 0 },
      candidate: entry("mem_new", { title: "Exact", tags: ["alpha", "b"], char_count: 20 })
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.budget_after).toMatchObject({
        active_entries: 1,
        active_chars: 20,
        index_chars: 33
      });
    }
  });

  it("rejects writes exceeding total character budget", () => {
    const result = evaluateBudget({
      budget: { max_active_entries: 3, max_total_chars: 20, max_topic_chars: 80, max_index_chars: 200 },
      usage: { active_entries: 0, active_chars: 0, topic_chars: { tests: 0 }, index_chars: 0 },
      candidate: entry("mem_new", { char_count: 21 })
    });
    expect(result).toMatchObject({
      ok: false,
      error: "capacity_exceeded"
    });
  });

  it("rejects writes exceeding topic character budget", () => {
    const result = evaluateBudget({
      budget: { max_active_entries: 3, max_total_chars: 100, max_topic_chars: 20, max_index_chars: 200 },
      usage: { active_entries: 0, active_chars: 19, topic_chars: { tests: 19 }, index_chars: 0 },
      candidate: entry("mem_new", { char_count: 2 })
    });
    expect(result).toMatchObject({
      ok: false,
      error: "capacity_exceeded"
    });
  });

  it("rejects writes when tags push index budget over max", () => {
    const result = evaluateBudget({
      budget: { max_active_entries: 3, max_total_chars: 100, max_topic_chars: 80, max_index_chars: 32 },
      usage: { active_entries: 0, active_chars: 0, topic_chars: { tests: 0 }, index_chars: 0 },
      candidate: entry("mem_new", { title: "Exact", tags: ["alpha", "b"], char_count: 20 })
    });
    expect(result).toMatchObject({
      ok: false,
      error: "capacity_exceeded"
    });
    if (!result.ok) {
      expect(result.details?.budget_after).toMatchObject({ index_chars: 33 });
    }
  });

  it("rejects writes exceeding active entry count and suggests archiving non-expired entries", () => {
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
        expect.objectContaining({ action: "archive", memory_id: "mem_old" })
      ]);
    }
  });

  it("suggests forgetting expired entries when capacity is exceeded", () => {
    const result = evaluateBudget({
      budget: { max_active_entries: 1, max_total_chars: 100, max_topic_chars: 80, max_index_chars: 200 },
      usage: { active_entries: 1, active_chars: 20, topic_chars: { tests: 20 }, index_chars: 20 },
      candidate: entry("mem_new"),
      existingEntries: [
        entry("mem_old", {
          importance: 1,
          confidence: 1,
          expires_at: "2026-01-01T00:00:00.000Z"
        })
      ],
      now: "2026-06-13T00:00:00.000Z"
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
    expect(ranked[0]?.action).toBe("forget_memory");
  });

  it("orders same-score cleanup candidates by id regardless of input order", () => {
    const entries = [
      entry("mem_c", { updated_at: "2026-06-12T00:00:00.000Z" }),
      entry("mem_a", { updated_at: "2026-06-12T00:00:00.000Z" }),
      entry("mem_b", { updated_at: "2026-06-12T00:00:00.000Z" })
    ];
    const reversed = [...entries].reverse();

    expect(rankCleanupCandidates(entries, "2026-06-13T00:00:00.000Z").map((action) => action.memory_id)).toEqual([
      "mem_a",
      "mem_b",
      "mem_c"
    ]);
    expect(rankCleanupCandidates(reversed, "2026-06-13T00:00:00.000Z").map((action) => action.memory_id)).toEqual([
      "mem_a",
      "mem_b",
      "mem_c"
    ]);
  });
});
