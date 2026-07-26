import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../src/memory-service.js";
import { SQLiteMemoryStore } from "../src/sqlite-store.js";
import { runDoctor } from "../src/doctor/index.js";
import type { CheckContext } from "../src/doctor/types.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-lab-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const service = new MemoryService(store, undefined, "user:cli", dataHome);
  return { service, store, dataHome };
}

const baseInput = (overrides: Record<string, unknown> = {}) => ({
  scope: "global" as const,
  type: "fact" as const,
  topic: "t",
  title: "title",
  body: "body",
  tags: [] as string[],
  source: { kind: "agent" as const },
  importance: 3,
  confidence: 4,
  ...overrides
});

describe("last_accessed_by", () => {
  let service: MemoryService;
  let store: SQLiteMemoryStore;
  let dataHome: string;

  beforeEach(() => {
    ({ service, store, dataHome } = setup());
  });
  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
  });

  it("getMemory is a pure read and does not record access", () => {
    // Stage 16 v1.1.1 PR-1 (#11): `getMemory` is now
    // read-only. The pre-PR-1 `getMemory(id, accessedBy)`
    // signature was a side-effecting read; the new path
    // calls `store.peekEntry` and never touches
    // `memory_accesses` or `memory_entries.access_count`.
    const r = service.remember(baseInput());
    if (!r.ok) throw new Error("setup");
    // Calling getMemory with an actor (or without) must not
    // populate `last_accessed_by`. The legacy `accessedBy`
    // parameter is accepted but ignored (deprecated).
    service.getMemory(r.value.memory_id, "agent:claude-code");
    const after = service.getMemory(r.value.memory_id);
    expect(after?.entry.last_accessed_by).toBeUndefined();
  });

  it("explicit store.recordAccess still updates last_accessed_by", () => {
    // Stage 16 v1.1.1 PR-1 (#11): callers that legitimately
    // need to record access (e.g. `recall_context`
    // selection) call `store.recordAccess` explicitly
    // instead of relying on the read side effect.
    const r = service.remember(baseInput());
    if (!r.ok) throw new Error("setup");
    store.recordAccess(r.value.memory_id, "agent:claude-code", new Date().toISOString());
    const accessed = service.getMemory(r.value.memory_id);
    expect(accessed?.entry.last_accessed_by?.["agent:claude-code"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("accumulates multiple agent names via explicit recordAccess", () => {
    const r = service.remember(baseInput());
    if (!r.ok) throw new Error("setup");
    const iso = new Date().toISOString();
    store.recordAccess(r.value.memory_id, "agent:claude-code", iso);
    store.recordAccess(r.value.memory_id, "agent:cursor", iso);
    store.recordAccess(r.value.memory_id, "agent:codex", iso);
    const final = service.getMemory(r.value.memory_id);
    const map = final?.entry.last_accessed_by ?? {};
    expect(Object.keys(map).sort()).toEqual(["agent:claude-code", "agent:codex", "agent:cursor"]);
  });

  it("does not record when no actor is ever recorded", () => {
    const r = service.remember(baseInput());
    if (!r.ok) throw new Error("setup");
    const accessed = service.getMemory(r.value.memory_id);
    expect(accessed?.entry.last_accessed_by).toBeUndefined();
  });

  it("surfaces in the doctor report (one of the checks)", () => {
    const r = service.remember(baseInput());
    if (!r.ok) throw new Error("setup");
    store.recordAccess(r.value.memory_id, "agent:claude-code", new Date().toISOString());
    const ctx: CheckContext = {
      dataHome,
      store,
      now: () => new Date("2026-07-19T20:00:00.000Z")
    };
    const report = runDoctor(ctx);
    // Stage 4 added actor_ownership as the 11th check; we don't pin
    // the exact count here, only that last_accessed_by is present.
    expect(report.results.length).toBeGreaterThanOrEqual(10);
    const labCheck = report.results.find((r) => r.name === "last_accessed_by");
    expect(labCheck?.status).toBe("ok");
    expect(labCheck?.message).toContain("1 entries");
    expect(labCheck?.message).toContain("1 agents");
  });

  it("surfaces multiple agents in doctor distribution", () => {
    const r1 = service.remember(baseInput({ title: "first", body: "first body" }));
    if (!r1.ok) throw new Error("setup");
    const r2 = service.remember(baseInput({ title: "second", body: "second body", confirm_write: true }));
    if (!r2.ok) throw new Error("setup");
    store.recordAccess(r1.value.memory_id, "agent:claude-code", new Date().toISOString());
    store.recordAccess(r2.value.memory_id, "agent:cursor", new Date().toISOString());
    const ctx: CheckContext = {
      dataHome,
      store,
      now: () => new Date("2026-07-19T20:00:00.000Z")
    };
    const report = runDoctor(ctx);
    const labCheck = report.results.find((r) => r.name === "last_accessed_by");
    expect(labCheck?.message).toContain("2 entries");
    expect(labCheck?.message).toContain("2 agents");
  });

  it("returns ok for the last_accessed_by check even on a fresh database", () => {
    const ctx: CheckContext = {
      dataHome,
      store,
      now: () => new Date("2026-07-19T20:00:00.000Z")
    };
    const report = runDoctor(ctx);
    const labCheck = report.results.find((r) => r.name === "last_accessed_by");
    expect(labCheck?.status).toBe("ok");
    expect(labCheck?.message).toContain("0 entries");
  });
});
