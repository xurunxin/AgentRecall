import { describe, expect, it } from "vitest";
import {
  DEFAULT_GLOBAL_BUDGET,
  DEFAULT_PROJECT_BUDGET,
  computeEntrySize,
  createAuditId,
  createMemoryId,
  estimateTokens,
  isMemoryStatus,
  isMemoryType,
  nowIso
} from "../src/domain.js";

describe("domain helpers", () => {
  it("defines the default hard budgets from the design", () => {
    expect(DEFAULT_GLOBAL_BUDGET).toEqual({
      max_active_entries: 500,
      max_total_chars: 250_000,
      max_index_chars: 25_000
    });
    expect(DEFAULT_PROJECT_BUDGET).toEqual({
      max_active_entries: 300,
      max_total_chars: 150_000,
      max_topic_chars: 30_000,
      max_index_chars: 25_000
    });
  });

  it("validates memory type and status values", () => {
    expect(isMemoryType("debugging")).toBe(true);
    expect(isMemoryType("random")).toBe(false);
    expect(isMemoryStatus("forgotten")).toBe(true);
    expect(isMemoryStatus("deleted")).toBe(false);
  });

  it("creates sortable UTC timestamps and stable id shapes", () => {
    const earlier = nowIso(new Date("2026-01-01T00:00:00.000Z"));
    const later = nowIso(new Date("2026-01-01T00:00:00.001Z"));

    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(earlier).toBe("2026-01-01T00:00:00.000Z");
    expect(earlier < later).toBe(true);
    expect(createMemoryId()).toMatch(/^mem_[a-f0-9]{24}$/);
    expect(createAuditId()).toMatch(/^aud_[a-f0-9]{24}$/);
  });

  it("estimates token count from character count without external models", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(401))).toBe(101);
  });

  it("computes stored entry size from title, body, and tags", () => {
    expect(computeEntrySize("Title", "Body text", ["one", "two"])).toEqual({
      char_count: 21,
      token_estimate: 6
    });
  });
});
