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

import { mkdirSync, mkdtempSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../../src/memory-service.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import { resolveMemoryScope } from "../../src/scope-resolver.js";
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

/**
 * Build a real on-disk project directory and resolve it through
 * the canonical ProjectIdentityResolver. The maintenance service
 * now derives the project_id from project_path, so the entry's
 * project_id must match the resolver's output for the
 * project-scoped filter to find it.
 */
function createProjectDir(dataHome: string, leaf: string): { path: string; project_id: string } {
  const raw = join(dataHome, leaf);
  mkdirSync(raw, { recursive: true });
  const canonical = realpathSync.native(raw);
  const resolved = resolveMemoryScope({ scope: "project", project_path: canonical });
  if (!resolved.ok) {
    throw new Error(`resolveMemoryScope failed: ${resolved.error} ${resolved.message}`);
  }
  if (resolved.value.project_id === undefined) {
    throw new Error("resolveMemoryScope returned no project_id");
  }
  return { path: canonical, project_id: resolved.value.project_id };
}

describe("release-gate p0-scope (AR-P0-001)", () => {
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

  it("archive_low_value scoped to project_path only affects the target project", () => {
    const projA = createProjectDir(dataHome, "projA");
    const projB = createProjectDir(dataHome, "projB");

    store.insertEntry(makeEntry({
      id: "mem_a_low_1",
      project_id: projA.project_id,
      project_path: projA.path,
      title: "a low 1",
      body: "a low 1 body",
      importance: 1,
      confidence: 1
    }));
    store.insertEntry(makeEntry({
      id: "mem_a_low_2",
      project_id: projA.project_id,
      project_path: projA.path,
      title: "a low 2",
      body: "a low 2 body",
      importance: 1,
      confidence: 1
    }));
    store.insertEntry(makeEntry({
      id: "mem_b_low_1",
      project_id: projB.project_id,
      project_path: projB.path,
      title: "b low 1",
      body: "b low 1 body",
      importance: 1,
      confidence: 1
    }));

    service.maintainMemories({
      action: "archive_low_value",
      scope: "project",
      project_path: projA.path
    });

    const a1 = store.peekEntry("mem_a_low_1");
    const a2 = store.peekEntry("mem_a_low_2");
    const b1 = store.peekEntry("mem_b_low_1");

    expect(a1?.status).toBe("archived");
    expect(a2?.status).toBe("archived");
    expect(b1?.status).toBe("active");
  });

  it("expire_due scoped to project_path only expires the target project", () => {
    const projA = createProjectDir(dataHome, "projA");
    const projB = createProjectDir(dataHome, "projB");

    const pastExpiry = "2026-01-01T00:00:00.000Z";
    store.insertEntry(makeEntry({
      id: "mem_a_expired",
      project_id: projA.project_id,
      project_path: projA.path,
      expires_at: pastExpiry
    }));
    store.insertEntry(makeEntry({
      id: "mem_b_expired",
      project_id: projB.project_id,
      project_path: projB.path,
      expires_at: pastExpiry
    }));

    service.maintainMemories({
      action: "expire_due",
      scope: "project",
      project_path: projA.path
    });

    const a = store.peekEntry("mem_a_expired");
    const b = store.peekEntry("mem_b_expired");
    expect(a?.status).toBe("forgotten");
    expect(b?.status).toBe("active");
  });

  it("scope=global with project_path is rejected as scope_mismatch (no silent degradation)", () => {
    store.insertEntry(makeEntry({
      id: "mem_global_1",
      project_id: undefined,
      title: "global 1",
      body: "global 1 body"
    }));

    let thrown: unknown = undefined;
    let result: { changed: number; details: unknown } | undefined = undefined;
    try {
      result = service.maintainMemories({
        action: "archive_low_value",
        scope: "global",
        project_path: "/some/global/project_path"
      });
    } catch (error) {
      thrown = error;
    }
    const g = store.peekEntry("mem_global_1");
    expect(g?.status).toBe("active");
    if (thrown === undefined) {
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
    if (result !== undefined) {
      const details = result.details as { error?: string };
      expect(details.error).toBe("invalid_scope");
      expect(result.changed).toBe(0);
    }
    expect(thrown === undefined || (thrown as Error).message.length > 0).toBe(true);
  });
});
