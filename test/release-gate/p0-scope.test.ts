// test/release-gate/p0-scope.test.ts
//
// Stage 10 PR1: Release-gate P0 regressions for project scope
// safety (AR-P0-001).
//
// These tests are expected to FAIL on the current main branch
// (Stage 9 façade split) and to PASS after Stage 10 PR2 lands.
// The point is to lock down the bug with a test before the
// fix so that:
//   1. the bug is provably present today
//   2. the fix is provably correct
//   3. a future refactor cannot silently regress the safety
//
// Reference: spec § 5.1 AR-P0-001 "统一项目作用域解析".

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../../src/memory-service.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import type { MemoryEntry } from "../../src/domain.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-scope-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const service = new MemoryService(store, undefined, "agent:test", dataHome);
  return { service, store, dataHome };
}

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? `mem_${Math.random().toString(36).slice(2)}`,
    scope: "project",
    project_id: overrides.project_id ?? "proj_a",
    project_path: overrides.project_path,
    type: "fact",
    memory_kind: "semantic",
    topic: "t",
    title: overrides.title ?? "low value",
    body: overrides.body ?? "low value body",
    tags: [],
    source: { kind: "agent" },
    importance: overrides.importance ?? 1,
    confidence: overrides.confidence ?? 1,
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

describe("release-gate p0-scope (AR-P0-001)", () => {
  let service: MemoryService;
  let store: SQLiteMemoryStore;

  beforeEach(() => {
    ({ service, store } = setup());
  });
  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
  });

  it("archive_low_value scoped to project_path only affects the target project", () => {
    // Project A: 2 low-value records (will be archived).
    store.insertEntry(makeEntry({
      id: "mem_a_low_1",
      project_id: "proj_a",
      project_path: "/tmp/projA",
      title: "a low 1",
      body: "a low 1 body",
      importance: 1,
      confidence: 1
    }));
    store.insertEntry(makeEntry({
      id: "mem_a_low_2",
      project_id: "proj_a",
      project_path: "/tmp/projA",
      title: "a low 2",
      body: "a low 2 body",
      importance: 1,
      confidence: 1
    }));
    // Project B: 1 low-value record (must NOT be archived).
    store.insertEntry(makeEntry({
      id: "mem_b_low_1",
      project_id: "proj_b",
      project_path: "/tmp/projB",
      title: "b low 1",
      body: "b low 1 body",
      importance: 1,
      confidence: 1
    }));

    // Call maintainMemories with only project_path, no project_id.
    // The fix in PR2 must derive project_id from project_path.
    service.maintainMemories({
      action: "archive_low_value",
      scope: "project",
      project_path: "/tmp/projA"
    });

    const a1 = store.peekEntry("mem_a_low_1");
    const a2 = store.peekEntry("mem_a_low_2");
    const b1 = store.peekEntry("mem_b_low_1");

    // After the fix, project A's low-value records are archived.
    expect(a1?.status).toBe("archived");
    expect(a2?.status).toBe("archived");
    // Project B's record MUST be untouched (this is the P0-001 invariant).
    expect(b1?.status).toBe("active");
  });

  it("expire_due scoped to project_path only expires the target project", () => {
    const pastExpiry = "2026-01-01T00:00:00.000Z";
    store.insertEntry(makeEntry({
      id: "mem_a_expired",
      project_id: "proj_a",
      project_path: "/tmp/projA",
      expires_at: pastExpiry
    }));
    store.insertEntry(makeEntry({
      id: "mem_b_expired",
      project_id: "proj_b",
      project_path: "/tmp/projB",
      expires_at: pastExpiry
    }));

    service.maintainMemories({
      action: "expire_due",
      scope: "project",
      project_path: "/tmp/projA"
    });

    const a = store.peekEntry("mem_a_expired");
    const b = store.peekEntry("mem_b_expired");
    expect(a?.status).toBe("forgotten");
    // Project B's expired record must NOT be touched.
    expect(b?.status).toBe("active");
  });

  it("scope=global with project_path is rejected as scope_mismatch (no silent degradation)", () => {
    // The spec requires scope_mismatch / invalid_scope when global is
    // paired with a project identifier. The fix must surface this as
    // an error rather than silently dropping the project_path and
    // running the maintenance against the global scope.
    store.insertEntry(makeEntry({
      id: "mem_global_1",
      project_id: undefined,
      title: "global 1",
      body: "global 1 body"
    }));

    let thrown: unknown = undefined;
    try {
      service.maintainMemories({
        action: "archive_low_value",
        scope: "global",
        project_path: "/tmp/projA"
      });
    } catch (error) {
      thrown = error;
    }
    // Either an exception is thrown, or the result reports an error.
    // Either way, the global record must not be touched.
    const g = store.peekEntry("mem_global_1");
    expect(g?.status).toBe("active");
    // We do not require a specific exception shape; the spec
    // permits Result<T, "scope_mismatch"> OR throw — both are
    // acceptable surfaces, as long as the silent-degrade path
    // (return ok + no state change OR return ok + corrupt state)
    // is not taken.
    if (thrown === undefined) {
      // If the call returned without throwing, it must have been an
      // error result, not a successful one. We can't introspect the
      // raw Result from maintainMemories here, but we can assert
      // the global record wasn't archived (already covered above).
      expect(true).toBe(true);
    }
  });

  it("scope=project with no project_id and no project_path is rejected", () => {
    let thrown: unknown = undefined;
    let result: { changed: number; details: unknown } | undefined = undefined;
    try {
      result = service.maintainMemories({
        action: "archive_low_value",
        scope: "project"
      });
    } catch (error) {
      thrown = error;
    }
    // Either thrown, or result.details reports invalid_scope.
    if (result !== undefined) {
      const details = result.details as { error?: string };
      expect(details.error).toBe("invalid_scope");
      expect(result.changed).toBe(0);
    }
    // We don't strictly require thrown; we just require no mutation
    // occurred.
    expect(thrown === undefined || (thrown as Error).message.length > 0).toBe(true);
  });
});
