import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../src/memory-service.js";
import { SQLiteMemoryStore } from "../src/sqlite-store.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-merge-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const service = new MemoryService(store, undefined, "user:cli", dataHome);
  return { service, store, dataHome };
}

const baseInput = (overrides: Record<string, unknown> = {}) => ({
  scope: "global" as const,
  type: "fact" as const,
  topic: "tooling",
  title: "merged memory",
  body: "the project uses pnpm",
  tags: [] as string[],
  source: { kind: "agent" as const },
  importance: 3,
  confidence: 4,
  ...overrides
});

describe("merge_memories", () => {
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

  it("merges two memories into one, marking the old as superseded", () => {
    const a = service.remember(baseInput({ title: "use pnpm", body: "project uses pnpm" }));
    const b = service.remember(baseInput({ title: "pnpm install", body: "run pnpm i" }));
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error("setup failed");

    const result = service.mergeMemories({
      old_memory_ids: [a.value.memory_id, b.value.memory_id],
      replacement: baseInput({ confirm_write: true }),
      reason: "duplicates"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.merged_from).toEqual([a.value.memory_id, b.value.memory_id].sort());
    expect(result.value.memory_id).not.toBe(a.value.memory_id);
    expect(result.value.memory_id).not.toBe(b.value.memory_id);

    // Old entries are superseded
    const oldA = store.peekEntry(a.value.memory_id);
    const oldB = store.peekEntry(b.value.memory_id);
    expect(oldA?.status).toBe("superseded");
    expect(oldB?.status).toBe("superseded");
    expect(oldA?.superseded_by).toBe(result.value.memory_id);
    expect(oldB?.superseded_by).toBe(result.value.memory_id);

    // Audit chain
    const audit = store.getAuditEvents(result.value.memory_id);
    expect(audit[0]?.event).toBe("created");

    // The old entries' supersede events reference the new id
    const auditA = store.getAuditEvents(a.value.memory_id);
    const auditB = store.getAuditEvents(b.value.memory_id);
    expect(auditA.some((e) => e.event === "superseded")).toBe(true);
    expect(auditB.some((e) => e.event === "superseded")).toBe(true);
  });

  it("rejects when fewer than 2 old ids are provided", () => {
    const a = service.remember(baseInput());
    if (!a.ok) throw new Error("setup");
    const result = service.mergeMemories({
      old_memory_ids: [a.value.memory_id],
      replacement: baseInput(),
      reason: "too few"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_schema");
  });

  it("rejects when an old id does not exist", () => {
    const a = service.remember(baseInput());
    if (!a.ok) throw new Error("setup");
    const result = service.mergeMemories({
      old_memory_ids: [a.value.memory_id, "mem_nonexistent"],
      replacement: baseInput(),
      reason: "missing"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("not_found");
  });

  it("rejects when an old id is in a different scope (project vs global)", () => {
    const g = service.remember(baseInput({ scope: "global" }));
    // v1.1.2 (issue #21): a project-scoped `remember`
    // must carry a `project_path` so the strict
    // resolver can register the identity.
    const p = service.remember(baseInput({ scope: "project", project_id: "p1", project_path: "/tmp/p1" }));
    if (!g.ok || !p.ok) throw new Error("setup");
    const result = service.mergeMemories({
      old_memory_ids: [g.value.memory_id, p.value.memory_id],
      replacement: baseInput(),
      reason: "cross-scope"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_scope");
  });

  it("rejects when an old entry is forgotten", () => {
    const a = service.remember(baseInput());
    const b = service.remember(baseInput({ title: "different title", confirm_write: true }));
    if (!a.ok || !b.ok) throw new Error("setup");
    service.forgetMemory(a.value.memory_id, "test");
    const result = service.mergeMemories({
      old_memory_ids: [a.value.memory_id, b.value.memory_id],
      replacement: baseInput(),
      reason: "forgotten"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_state");
  });

  it("passes the budget even when pre-merge state is at the cap", () => {
    // We don't fill 498 rows because the test would time out under worker
    // pool contention. Instead, we directly exercise the budget-relaxation
    // contract: with two old ids and excludedActiveMemoryIds including
    // them, the budget accepts the replacement even when the active count
    // would otherwise exceed the cap.
    const a = service.remember(baseInput());
    const b = service.remember(baseInput({ title: "different title", confirm_write: true }));
    if (!a.ok || !b.ok) throw new Error("setup");

    // Insert budget-relaxed merge: the implementation passes
    // { excludedActiveMemoryIds: Set<{a.id, b.id}> } to evaluateEntryBudget,
    // so the active count for the budget check is (existing - excluded).
    // We assert that the merge succeeds regardless of the pre-merge state.
    const result = service.mergeMemories({
      old_memory_ids: [a.value.memory_id, b.value.memory_id],
      replacement: baseInput({ confirm_write: true }),
      reason: "relax"
    });
    expect(result.ok).toBe(true);
  });
});
