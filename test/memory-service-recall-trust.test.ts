// test/memory-service-recall-trust.test.ts
//
// Stage 5: computeTrustBoost and the recall ranking boost.
// Pure-function unit tests for the helper, then integration
// tests for the order in collectContextEntries / exportMemoryContext.

import { describe, expect, it } from "vitest";
import { computeTrustBoost } from "../src/memory-service.js";
import type { MemoryEntry } from "../src/domain.js";

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "mem_test",
    scope: "global",
    type: "fact",
    memory_kind: "semantic",
    topic: "t",
    title: "t",
    body: "b",
    tags: [],
    source: { kind: "agent" },
    importance: 3,
    confidence: 3,
    status: "active",
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
    access_count: 0,
    supersedes: [],
    token_estimate: 1,
    char_count: 1,
    ...overrides
  } as MemoryEntry;
}

describe("computeTrustBoost", () => {
  it("returns strong boost (0.3) when the writer matches the current actor", () => {
    const entry = makeEntry();
    const result = computeTrustBoost(entry, "agent:claude-code", () => "agent:claude-code");
    expect(result).toBe(0.3);
  });

  it("returns soft boost (0.1) when the current actor appears in last_accessed_by", () => {
    const entry = makeEntry({
      last_accessed_by: { "agent:claude-code": "2026-07-20T00:00:00.000Z" }
    });
    const result = computeTrustBoost(entry, "agent:claude-code", () => "agent:other");
    expect(result).toBe(0.1);
  });

  it("returns 0 when there is no relationship", () => {
    const entry = makeEntry({
      last_accessed_by: { "agent:other": "2026-07-20T00:00:00.000Z" }
    });
    const result = computeTrustBoost(entry, "agent:claude-code", () => "agent:other");
    expect(result).toBe(0);
  });

  it("returns 0 when the current actor is empty (legacy callers)", () => {
    const entry = makeEntry({
      last_accessed_by: { "agent:claude-code": "2026-07-20T00:00:00.000Z" }
    });
    const result = computeTrustBoost(entry, "", () => "agent:claude-code");
    expect(result).toBe(0);
  });

  it("strong boost takes precedence over soft boost when both apply", () => {
    const entry = makeEntry({
      last_accessed_by: { "agent:claude-code": "2026-07-20T00:00:00.000Z" }
    });
    const result = computeTrustBoost(entry, "agent:claude-code", () => "agent:claude-code");
    expect(result).toBe(0.3);
  });

  it("soft boost does not fire for an empty last_accessed_by map", () => {
    const entry = makeEntry();
    const result = computeTrustBoost(entry, "agent:claude-code", () => "agent:other");
    expect(result).toBe(0);
  });
});
