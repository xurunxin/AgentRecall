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

  it("records the agent on getEntry reads", () => {
    const r = service.remember(baseInput());
    if (!r.ok) throw new Error("setup");
    const accessed = service.getMemory(r.value.memory_id, "agent:claude-code");
    expect(accessed?.entry.last_accessed_by?.["agent:claude-code"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("accumulates multiple agent names", () => {
    const r = service.remember(baseInput());
    if (!r.ok) throw new Error("setup");
    service.getMemory(r.value.memory_id, "agent:claude-code");
    service.getMemory(r.value.memory_id, "agent:cursor");
    const final = service.getMemory(r.value.memory_id, "agent:codex");
    const map = final?.entry.last_accessed_by ?? {};
    expect(Object.keys(map).sort()).toEqual(["agent:claude-code", "agent:codex", "agent:cursor"]);
  });

  it("does not record when accessedBy is omitted", () => {
    const r = service.remember(baseInput());
    if (!r.ok) throw new Error("setup");
    const accessed = service.getMemory(r.value.memory_id);
    expect(accessed?.entry.last_accessed_by).toBeUndefined();
  });

  it("surfaces in the doctor report (one of the checks)", () => {
    const r = service.remember(baseInput());
    if (!r.ok) throw new Error("setup");
    service.getMemory(r.value.memory_id, "agent:claude-code");
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
    service.getMemory(r1.value.memory_id, "agent:claude-code");
    service.getMemory(r2.value.memory_id, "agent:cursor");
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
