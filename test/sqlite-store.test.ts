import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_BUDGET, type MemoryEntry } from "../src/domain.js";
import { SQLiteMemoryStore, type EntryPatch } from "../src/sqlite-store.js";

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? "mem_test_001",
    scope: overrides.scope ?? "project",
    project_id: overrides.project_id ?? "repo-123",
    project_path: overrides.project_path ?? "G:\\Projects\\Example",
    type: overrides.type ?? "debugging",
    topic: overrides.topic ?? "tests",
    title: overrides.title ?? "SQLite FTS test",
    body: overrides.body ?? "Use SQLite FTS to find debugging memories about postgres failures.",
    tags: overrides.tags ?? ["sqlite", "debugging"],
    source: overrides.source ?? { kind: "agent", ref: "test" },
    importance: overrides.importance ?? 4,
    confidence: overrides.confidence ?? 5,
    status: overrides.status ?? "active",
    created_at: overrides.created_at ?? "2026-06-13T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-06-13T00:00:00.000Z",
    access_count: overrides.access_count ?? 0,
    expires_at: overrides.expires_at,
    review_after: overrides.review_after,
    supersedes: overrides.supersedes ?? [],
    superseded_by: overrides.superseded_by,
    token_estimate: overrides.token_estimate ?? 20,
    char_count: overrides.char_count ?? 80
  };
}

describe("SQLiteMemoryStore", () => {
  it("migrates schema and persists a project scope", () => {
    const store = new SQLiteMemoryStore(join(mkdtempSync(join(tmpdir(), "lm-store-")), "memory.sqlite"));
    store.upsertProjectScope({
      project_id: "repo-123",
      canonical_path: "G:\\Projects\\Example",
      display_name: "Example",
      budget: DEFAULT_PROJECT_BUDGET,
      created_at: "2026-06-13T00:00:00.000Z",
      updated_at: "2026-06-13T00:00:00.000Z"
    });
    expect(store.getProjectScope("repo-123")).toMatchObject({
      project_id: "repo-123",
      canonical_path: "G:\\Projects\\Example"
    });
    store.close();
  });

  it("inserts, reads, lists, and FTS-searches memory entries", () => {
    const store = new SQLiteMemoryStore(join(mkdtempSync(join(tmpdir(), "lm-store-")), "memory.sqlite"));
    store.insertEntry(makeEntry());
    expect(store.getEntry("mem_test_001")).toMatchObject({
      id: "mem_test_001",
      title: "SQLite FTS test"
    });
    expect(store.listEntries({ scope: "project", project_id: "repo-123" })).toHaveLength(1);
    expect(store.searchEntries({ query: "postgres", scope: "project", project_id: "repo-123", limit: 5 })).toHaveLength(1);
    store.close();
  });

  it("updates entries, appends audit events, and reports budget usage", () => {
    const store = new SQLiteMemoryStore(join(mkdtempSync(join(tmpdir(), "lm-store-")), "memory.sqlite"));
    store.insertEntry(makeEntry());
    store.updateEntry("mem_test_001", {
      title: "Updated title",
      body: "Updated body for postgres debugging",
      tags: ["postgres"],
      updated_at: "2026-06-13T00:01:00.000Z",
      char_count: 42,
      token_estimate: 11
    });
    store.appendAudit({
      id: "aud_001",
      memory_id: "mem_test_001",
      scope: "project",
      project_id: "repo-123",
      event: "updated",
      actor: "agent",
      metadata: { fields: ["title"] },
      created_at: "2026-06-13T00:01:00.000Z"
    });
    expect(store.getEntry("mem_test_001")).toMatchObject({ title: "Updated title" });
    expect(store.getAuditEvents("mem_test_001")).toHaveLength(1);
    expect(store.getBudgetUsage({ scope: "project", project_id: "repo-123" })).toMatchObject({
      active_entries: 1,
      active_chars: 42
    });
    store.close();
  });

  it("ignores attempted id changes during update and keeps FTS tied to the stored entry id", () => {
    const store = new SQLiteMemoryStore(join(mkdtempSync(join(tmpdir(), "lm-store-")), "memory.sqlite"));
    store.insertEntry(makeEntry());
    store.updateEntry("mem_test_001", {
      id: "mem_bad",
      title: "Updated SQLite title",
      body: "Updated body with sqlite only",
      tags: ["sqlite"],
      updated_at: "2026-06-13T00:02:00.000Z",
      char_count: 31,
      token_estimate: 8
    } as unknown as EntryPatch);

    expect(store.getEntry("mem_test_001")).toMatchObject({
      id: "mem_test_001",
      title: "Updated SQLite title"
    });
    expect(store.getEntry("mem_bad")).toBeUndefined();
    expect(store.searchEntries({ query: "postgres", scope: "project", project_id: "repo-123", limit: 5 })).toEqual([]);
    expect(store.searchEntries({ query: "sqlite", scope: "project", project_id: "repo-123", limit: 5 }).map((entry) => entry.id)).toEqual([
      "mem_test_001"
    ]);
    store.close();
  });

  it("removes old FTS terms when an entry is updated", () => {
    const store = new SQLiteMemoryStore(join(mkdtempSync(join(tmpdir(), "lm-store-")), "memory.sqlite"));
    store.insertEntry(makeEntry());
    store.updateEntry("mem_test_001", {
      body: "Updated body with sqlite only",
      tags: ["sqlite"],
      updated_at: "2026-06-13T00:03:00.000Z",
      char_count: 29,
      token_estimate: 8
    });

    expect(store.searchEntries({ query: "postgres", scope: "project", project_id: "repo-123", limit: 5 })).toEqual([]);
    expect(store.searchEntries({ query: "sqlite", scope: "project", project_id: "repo-123", limit: 5 }).map((entry) => entry.id)).toEqual([
      "mem_test_001"
    ]);
    store.close();
  });

  it("returns no search results for punctuation-only FTS queries", () => {
    const store = new SQLiteMemoryStore(join(mkdtempSync(join(tmpdir(), "lm-store-")), "memory.sqlite"));
    store.insertEntry(makeEntry());
    expect(store.searchEntries({ query: "!!! ??? ...", scope: "project", project_id: "repo-123", limit: 5 })).toEqual([]);
    store.close();
  });

  it("treats punctuation in FTS queries as token separators", () => {
    const store = new SQLiteMemoryStore(join(mkdtempSync(join(tmpdir(), "lm-store-")), "memory.sqlite"));
    store.insertEntry(makeEntry());
    expect(store.searchEntries({ query: "postgres/failures", scope: "project", project_id: "repo-123", limit: 5 }).map((entry) => entry.id)).toEqual([
      "mem_test_001"
    ]);
    store.close();
  });

  it("reports topic budget usage for prototype-shaped topic names", () => {
    const store = new SQLiteMemoryStore(join(mkdtempSync(join(tmpdir(), "lm-store-")), "memory.sqlite"));
    store.insertEntry(
      makeEntry({
        topic: "__proto__",
        char_count: 77,
        token_estimate: 20
      })
    );

    const usage = store.getBudgetUsage({ scope: "project", project_id: "repo-123" });
    expect(Object.prototype.hasOwnProperty.call(usage.topic_chars, "__proto__")).toBe(true);
    expect(usage.topic_chars["__proto__"]).toBe(77);
    store.close();
  });

  it("reports exact active budget usage across all entries and excludes inactive statuses", () => {
    const store = new SQLiteMemoryStore(":memory:");
    let expectedIndexChars = 0;
    for (let index = 0; index < 10_001; index += 1) {
      const topic = index % 2 === 0 ? "alpha" : "beta";
      const title = `Active ${index}`;
      expectedIndexChars += title.length + topic.length + 16;
      store.insertEntry(
        makeEntry({
          id: `mem_active_${String(index).padStart(5, "0")}`,
          topic,
          title,
          body: `Active exact budget row ${index}`,
          tags: [],
          char_count: 1,
          token_estimate: 1
        })
      );
    }
    for (const status of ["archived", "superseded", "forgotten"] as const) {
      store.insertEntry(
        makeEntry({
          id: `mem_${status}`,
          status,
          topic: "alpha",
          title: `Inactive ${status}`,
          body: `Inactive ${status} entry`,
          tags: [],
          char_count: 999,
          token_estimate: 250
        })
      );
    }

    expect(store.getBudgetUsage({ scope: "project", project_id: "repo-123" })).toEqual({
      active_entries: 10_001,
      active_chars: 10_001,
      topic_chars: {
        alpha: 5001,
        beta: 5000
      },
      index_chars: expectedIndexChars
    });
    store.close();
  }, 30_000);
});
