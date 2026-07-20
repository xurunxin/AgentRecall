// test/trust-boost-config.test.ts
//
// Stage 7: the strong / soft trust_boost weights in
// computeTrustBoost are configurable via the
// AGENT_RECALL_TRUST_STRONG and AGENT_RECALL_TRUST_SOFT env
// vars. Defaults 0.3 / 0.1; invalid values fall back to
// defaults with a one-line stderr warning.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    created_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z",
    access_count: 0,
    supersedes: [],
    token_estimate: 1,
    char_count: 1,
    ...overrides
  } as MemoryEntry;
}

describe("computeTrustBoost config (stage 7)", () => {
  const ENV_STRONG = "AGENT_RECALL_TRUST_STRONG";
  const ENV_SOFT = "AGENT_RECALL_TRUST_SOFT";
  const originalStrong = process.env[ENV_STRONG];
  const originalSoft = process.env[ENV_SOFT];

  beforeEach(() => {
    delete process.env[ENV_STRONG];
    delete process.env[ENV_SOFT];
  });
  afterEach(() => {
    if (originalStrong === undefined) delete process.env[ENV_STRONG];
    else process.env[ENV_STRONG] = originalStrong;
    if (originalSoft === undefined) delete process.env[ENV_SOFT];
    else process.env[ENV_SOFT] = originalSoft;
  });

  it("uses 0.3 / 0.1 by default", () => {
    const entry = makeEntry();
    expect(computeTrustBoost(entry, "agent:test", () => "agent:test")).toBe(0.3);
    expect(computeTrustBoost(entry, "agent:test", () => "agent:other")).toBe(0);
    expect(computeTrustBoost(
      makeEntry({ last_accessed_by: { "agent:test": "2026-07-15T00:00:00.000Z" } }),
      "agent:test",
      () => "agent:other"
    )).toBe(0.1);
  });

  it("reads AGENT_RECALL_TRUST_STRONG and AGENT_RECALL_TRUST_SOFT from env", () => {
    process.env[ENV_STRONG] = "0.5";
    process.env[ENV_SOFT] = "0.2";
    const entry = makeEntry();
    expect(computeTrustBoost(entry, "agent:test", () => "agent:test")).toBe(0.5);
    expect(computeTrustBoost(
      makeEntry({ last_accessed_by: { "agent:test": "2026-07-15T00:00:00.000Z" } }),
      "agent:test",
      () => "agent:other"
    )).toBe(0.2);
  });

  it("falls back to 0.3 / 0.1 with a stderr warning on invalid input", () => {
    process.env[ENV_STRONG] = "not-a-number";
    process.env[ENV_SOFT] = "-1";
    const stderrWrites: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrWrites.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const entry = makeEntry();
      expect(computeTrustBoost(entry, "agent:test", () => "agent:test")).toBe(0.3);
      expect(computeTrustBoost(
        makeEntry({ last_accessed_by: { "agent:test": "2026-07-15T00:00:00.000Z" } }),
        "agent:test",
        () => "agent:other"
      )).toBe(0.1);
      const combined = stderrWrites.join("");
      expect(combined).toContain("AGENT_RECALL_TRUST_STRONG");
      expect(combined).toContain("not-a-number");
      expect(combined).toContain("AGENT_RECALL_TRUST_SOFT");
      expect(combined).toContain("-1");
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});
