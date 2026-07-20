// test/stale-memories-config.test.ts
//
// Stage 7: the staleness threshold in checkStaleMemories is
// configurable via the AGENT_RECALL_STALE_DAYS env var. The
// default stays 90 for backward compatibility; invalid values
// fall back to 90 with a one-line stderr warning.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkStaleMemories } from "../src/doctor/checks/stale-memories.js";
import { SQLiteMemoryStore } from "../src/sqlite-store.js";
import type { CheckContext } from "../src/doctor/types.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-stale-cfg-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  return { store };
}

function ctxWith(store: SQLiteMemoryStore, now: Date): CheckContext {
  return { dataHome: "/tmp", store, now: () => now };
}

function makeStaleEntry(
  store: SQLiteMemoryStore,
  id: string,
  lastAccessedAt: string | null
): void {
  store.insertEntry({
    id,
    scope: "global",
    type: "fact",
    memory_kind: "semantic",
    topic: "t",
    title: id,
    body: "b",
    tags: [],
    source: { kind: "agent" },
    importance: 3,
    confidence: 3,
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    access_count: 0,
    supersedes: [],
    token_estimate: 1,
    char_count: 1
  });
  store.appendAudit({
    id: `aud_${id}`,
    memory_id: id,
    scope: "global",
    event: "created",
    actor: "agent:test",
    metadata: {},
    created_at: "2026-01-01T00:00:00.000Z"
  });
  if (lastAccessedAt !== null) {
    // Set last_accessed_at directly via raw SQL; the read path
    // bumps it via store.getEntry, but here we want full control.
    store.backupHandle()
      .prepare("UPDATE memory_entries SET last_accessed_at = ? WHERE id = ?")
      .run(lastAccessedAt, id);
  }
}

describe("checkStaleMemories config (stage 7)", () => {
  let store: SQLiteMemoryStore;
  const ENV_KEY = "AGENT_RECALL_STALE_DAYS";
  const originalEnv = process.env[ENV_KEY];

  beforeEach(() => {
    ({ store } = setup());
    delete process.env[ENV_KEY];
  });
  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
    if (originalEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalEnv;
    }
  });

  it("uses 90 days by default", () => {
    // 91 days ago: stale. 89 days ago: fresh.
    const now = new Date("2026-07-20T00:00:00.000Z");
    const ninetyOneDaysAgo = new Date(now.getTime() - 91 * 86400000).toISOString();
    const eightyNineDaysAgo = new Date(now.getTime() - 89 * 86400000).toISOString();
    makeStaleEntry(store, "mem_old", ninetyOneDaysAgo);
    makeStaleEntry(store, "mem_fresh", eightyNineDaysAgo);

    const result = checkStaleMemories(ctxWith(store, now));
    expect(result.status).toBe("ok");
    expect(result.details?.count).toBe(1);
    expect(result.details?.threshold_days).toBe(90);
    const sample = result.details?.sample as Array<{ id: string }>;
    expect(sample.map((s) => s.id)).toEqual(["mem_old"]);
  });

  it("reads AGENT_RECALL_STALE_DAYS from env", () => {
    process.env[ENV_KEY] = "30";
    const now = new Date("2026-07-20T00:00:00.000Z");
    const thirtyOneDaysAgo = new Date(now.getTime() - 31 * 86400000).toISOString();
    const twentyNineDaysAgo = new Date(now.getTime() - 29 * 86400000).toISOString();
    makeStaleEntry(store, "mem_old", thirtyOneDaysAgo);
    makeStaleEntry(store, "mem_fresh", twentyNineDaysAgo);

    const result = checkStaleMemories(ctxWith(store, now));
    expect(result.status).toBe("ok");
    expect(result.details?.count).toBe(1);
    expect(result.details?.threshold_days).toBe(30);
    const sample = result.details?.sample as Array<{ id: string }>;
    expect(sample.map((s) => s.id)).toEqual(["mem_old"]);
  });

  it("falls back to 90 with a stderr warning on invalid input", () => {
    process.env[ENV_KEY] = "not-a-number";
    const stderrWrites: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrWrites.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const now = new Date("2026-07-20T00:00:00.000Z");
      makeStaleEntry(store, "mem_old", new Date(now.getTime() - 91 * 86400000).toISOString());

      const result = checkStaleMemories(ctxWith(store, now));
      expect(result.details?.threshold_days).toBe(90);
      expect(result.details?.count).toBe(1);
      const combined = stderrWrites.join("");
      expect(combined).toContain("AGENT_RECALL_STALE_DAYS");
      expect(combined).toContain("not-a-number");
      expect(combined).toContain("90");
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});
