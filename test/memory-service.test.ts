import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_BUDGET } from "../src/domain.js";
import { MemoryService } from "../src/memory-service.js";
import { SQLiteMemoryStore } from "../src/sqlite-store.js";

function service() {
  const store = new SQLiteMemoryStore(join(mkdtempSync(join(tmpdir(), "lm-service-")), "memory.sqlite"));
  return { store, memory: new MemoryService(store) };
}

describe("MemoryService", () => {
  it("remembers, searches, and reads project memory", () => {
    const { store, memory } = service();
    const result = memory.remember({
      scope: "project",
      project_id: "repo-123",
      type: "debugging",
      topic: "database",
      title: "Postgres tests need local database",
      body: "Start the local database before running integration tests.",
      tags: ["postgres", "tests"],
      source: { kind: "agent", ref: "test" },
      importance: 4,
      confidence: 5
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(memory.searchMemories({ scope: "project", project_id: "repo-123", query: "postgres", limit: 5 }).items).toHaveLength(1);
      expect(memory.getMemory(result.value.memory_id)?.entry.title).toBe("Postgres tests need local database");
    }
    store.close();
  });

  it("rejects over-budget writes without mutating state", () => {
    const { store, memory } = service();
    memory.configureProjectBudget("repo-123", DEFAULT_PROJECT_BUDGET, "G:\\Projects\\Repo", "Repo");
    memory.configureProjectBudget("repo-123", { max_active_entries: 1, max_total_chars: 1000, max_topic_chars: 1000, max_index_chars: 1000 }, "G:\\Projects\\Repo", "Repo");
    expect(memory.remember({
      scope: "project",
      project_id: "repo-123",
      type: "lesson",
      topic: "tests",
      title: "First",
      body: "First memory",
      tags: [],
      source: { kind: "agent" },
      importance: 2,
      confidence: 2
    }).ok).toBe(true);
    const rejected = memory.remember({
      scope: "project",
      project_id: "repo-123",
      type: "lesson",
      topic: "tests",
      title: "Second",
      body: "Second memory",
      tags: [],
      source: { kind: "agent" },
      importance: 2,
      confidence: 2
    });
    expect(rejected).toMatchObject({ ok: false, error: "capacity_exceeded" });
    expect(memory.listMemories({ scope: "project", project_id: "repo-123" }).items).toHaveLength(1);
    store.close();
  });

  it("updates, supersedes, forgets, and preserves audit history", () => {
    const { store, memory } = service();
    const first = memory.remember({
      scope: "global",
      type: "preference",
      topic: "shell",
      title: "Use rtk",
      body: "Prefix shell commands with rtk.",
      tags: ["shell"],
      source: { kind: "user" },
      importance: 5,
      confidence: 5
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected first memory");
    expect(memory.updateMemory(first.value.memory_id, { title: "Use rtk wrapper" }).ok).toBe(true);
    const replacement = memory.supersedeMemory({
      old_memory_ids: [first.value.memory_id],
      replacement: {
        scope: "global",
        type: "preference",
        topic: "shell",
        title: "Use rtk wrapper for shell commands",
        body: "Always prefix shell commands with rtk in this environment.",
        tags: ["shell"],
        source: { kind: "user" },
        importance: 5,
        confidence: 5
      },
      reason: "clarified wording"
    });
    expect(replacement.ok).toBe(true);
    expect(memory.getMemory(first.value.memory_id)?.entry.status).toBe("superseded");
    expect(memory.forgetMemory(first.value.memory_id, "old wording no longer needed").ok).toBe(true);
    const forgotten = memory.getMemory(first.value.memory_id);
    expect(forgotten?.entry.status).toBe("forgotten");
    expect(forgotten?.entry.body).toBe("");
    expect(forgotten?.audit.length).toBeGreaterThanOrEqual(3);
    store.close();
  });

  it("audits rejected secret writes without storing secret text", () => {
    const { store, memory } = service();
    const rejected = memory.remember({
      scope: "global",
      type: "debugging",
      topic: "secrets",
      title: "Do not store",
      body: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz1234567890",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });

    expect(rejected).toMatchObject({ ok: false, error: "secret_detected" });
    expect(memory.listMemories({ scope: "global" }).items).toEqual([]);
    expect(JSON.stringify(store.listAuditEvents({ event: "write_rejected" }))).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
    expect(store.listAuditEvents({ event: "write_rejected" })).toEqual([
      expect.objectContaining({
        event: "write_rejected",
        metadata: expect.objectContaining({ error: "secret_detected" })
      })
    ]);
    store.close();
  });

  it("defaults list and search to active memories and can include global results in project search", () => {
    const { store, memory } = service();
    const global = memory.remember({
      scope: "global",
      type: "procedure",
      topic: "database",
      title: "Use shared postgres setup",
      body: "The postgres setup applies across repos.",
      tags: ["postgres"],
      source: { kind: "agent" },
      importance: 3,
      confidence: 4
    });
    const project = memory.remember({
      scope: "project",
      project_id: "repo-123",
      type: "debugging",
      topic: "database",
      title: "Repo postgres setup",
      body: "The repo needs a local postgres service.",
      tags: ["postgres"],
      source: { kind: "agent" },
      importance: 3,
      confidence: 4
    });
    expect(global.ok).toBe(true);
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error("expected project memory");
    expect(memory.updateMemory(project.value.memory_id, { status: "archived" }).ok).toBe(true);

    expect(memory.listMemories({ scope: "project", project_id: "repo-123" }).items).toEqual([]);
    expect(memory.listMemories({ scope: "project", project_id: "repo-123", status: "archived" }).items).toHaveLength(1);
    expect(memory.searchMemories({ scope: "project", project_id: "repo-123", query: "postgres", include_global: true }).items.map((item) => item.scope)).toEqual([
      "global"
    ]);
    store.close();
  });

  it("does not record access while preflighting lifecycle operations", () => {
    const { store, memory } = service();
    const first = memory.remember({
      scope: "global",
      type: "preference",
      topic: "shell",
      title: "Use wrapper",
      body: "Use the shell wrapper.",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected memory");

    expect(memory.updateMemory(first.value.memory_id, { title: "Use rtk wrapper" }).ok).toBe(true);
    expect(memory.forgetMemory(first.value.memory_id, "test cleanup").ok).toBe(true);
    expect(store.peekEntry(first.value.memory_id)?.access_count).toBe(0);
    store.close();
  });

  it("audits rejected invalid update status without modifying memory", () => {
    const { store, memory } = service();
    const first = memory.remember({
      scope: "project",
      project_id: "repo-123",
      type: "lesson",
      topic: "updates",
      title: "Original title",
      body: "Original body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected memory");

    const rejected = memory.updateMemory(
      first.value.memory_id,
      { status: "forgotten" } as unknown as Parameters<MemoryService["updateMemory"]>[1]
    );

    expect(rejected).toMatchObject({ ok: false, error: "invalid_schema" });
    expect(store.peekEntry(first.value.memory_id)).toMatchObject({
      title: "Original title",
      body: "Original body",
      status: "active"
    });
    expect(store.listAuditEvents({ memory_id: first.value.memory_id, event: "write_rejected" })).toEqual([
      expect.objectContaining({
        memory_id: first.value.memory_id,
        scope: "project",
        project_id: "repo-123",
        reason: "invalid_schema",
        metadata: expect.objectContaining({ error: "invalid_schema" })
      })
    ]);
    store.close();
  });

  it("audits rejected secret updates without storing secret text or modifying memory", () => {
    const { store, memory } = service();
    const first = memory.remember({
      scope: "global",
      type: "debugging",
      topic: "updates",
      title: "Safe title",
      body: "Safe body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected memory");

    const rejected = memory.updateMemory(first.value.memory_id, {
      body: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz1234567890"
    });

    expect(rejected).toMatchObject({ ok: false, error: "secret_detected" });
    expect(store.peekEntry(first.value.memory_id)).toMatchObject({
      title: "Safe title",
      body: "Safe body"
    });
    const rejectionAudit = store.listAuditEvents({ memory_id: first.value.memory_id, event: "write_rejected" });
    expect(JSON.stringify(rejectionAudit)).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
    expect(rejectionAudit).toEqual([
      expect.objectContaining({
        memory_id: first.value.memory_id,
        scope: "global",
        reason: "secret_detected",
        metadata: expect.objectContaining({ error: "secret_detected" })
      })
    ]);
    store.close();
  });

  it("reports budget usage and cleanup candidates", () => {
    const { store, memory } = service();
    memory.configureProjectBudget("repo-123", { max_active_entries: 1, max_total_chars: 1000, max_topic_chars: 1000, max_index_chars: 1000 }, "G:\\Projects\\Repo", "Repo");
    const first = memory.remember({
      scope: "project",
      project_id: "repo-123",
      type: "lesson",
      topic: "tests",
      title: "Low value",
      body: "Low value body",
      tags: [],
      source: { kind: "agent" },
      importance: 1,
      confidence: 1
    });
    expect(first.ok).toBe(true);

    const budget = memory.getMemoryBudget({ scope: "project", project_id: "repo-123" });
    expect(budget.usage.active_entries).toBe(1);
    expect(budget.cleanup_candidates).toEqual([
      expect.objectContaining({
        memory_id: expect.any(String)
      })
    ]);
    store.close();
  });
});
