import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_BUDGET, type MemoryAuditEvent } from "../src/domain.js";
import { MarkdownExporter } from "../src/markdown-exporter.js";
import { MemoryService } from "../src/memory-service.js";
import { SQLiteMemoryStore } from "../src/sqlite-store.js";

function service(exportRoot?: string) {
  const store = new SQLiteMemoryStore(join(mkdtempSync(join(tmpdir(), "lm-service-")), "memory.sqlite"));
  const exporter = exportRoot === undefined ? undefined : new MarkdownExporter(exportRoot);
  return { store, memory: new MemoryService(store, exporter) };
}

class FailingAuditStore extends SQLiteMemoryStore {
  failAudit = false;

  override appendAudit(event: MemoryAuditEvent): void {
    if (this.failAudit) {
      throw new Error("audit append failed");
    }
    super.appendAudit(event);
  }
}

class FailingStageExporter extends MarkdownExporter {
  override stageScope(input: Parameters<MarkdownExporter["stageScope"]>[0]): ReturnType<MarkdownExporter["stageScope"]> {
    const staged = super.stageScope(input);
    rmSync(staged.stagingRoot, { recursive: true, force: true });
    throw new Error("stage write failed");
  }
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

  it("rejects supersede with empty old ids without creating a replacement", () => {
    const { store, memory } = service();
    const rejected = memory.supersedeMemory({
      old_memory_ids: [],
      replacement: {
        scope: "global",
        type: "lesson",
        topic: "supersede",
        title: "replacement-empty-old-ids",
        body: "This replacement must not be created.",
        tags: [],
        source: { kind: "agent" },
        importance: 3,
        confidence: 3
      },
      reason: "missing old id"
    });

    expect(rejected).toMatchObject({ ok: false, error: "invalid_schema" });
    expect(memory.searchMemories({ scope: "global", query: "replacement-empty-old-ids" }).items).toEqual([]);
    expect(store.listAuditEvents({ event: "write_rejected" })).toEqual([
      expect.objectContaining({
        event: "write_rejected",
        scope: "global",
        reason: "invalid_schema",
        metadata: expect.objectContaining({
          error: "invalid_schema",
          old_memory_ids_count: 0
        })
      })
    ]);
    store.close();
  });

  it("rejects supersede with missing old id without creating a replacement", () => {
    const { store, memory } = service();
    const rejected = memory.supersedeMemory({
      old_memory_ids: ["mem_missing"],
      replacement: {
        scope: "global",
        type: "lesson",
        topic: "supersede",
        title: "replacement-missing-old-id",
        body: "This replacement must not be created.",
        tags: [],
        source: { kind: "agent" },
        importance: 3,
        confidence: 3
      },
      reason: "missing old id"
    });

    expect(rejected).toMatchObject({ ok: false, error: "not_found" });
    expect(memory.searchMemories({ scope: "global", query: "replacement-missing-old-id" }).items).toEqual([]);
    expect(store.listAuditEvents({ event: "write_rejected" })).toEqual([
      expect.objectContaining({
        event: "write_rejected",
        scope: "global",
        reason: "not_found",
        metadata: expect.objectContaining({
          error: "not_found",
          memory_id: "mem_missing"
        })
      })
    ]);
    store.close();
  });

  it("rejects supersede with forgotten old entry without creating a replacement", () => {
    const { store, memory } = service();
    const old = memory.remember({
      scope: "global",
      type: "lesson",
      topic: "supersede",
      title: "Forgotten old entry",
      body: "Old body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    expect(old.ok).toBe(true);
    if (!old.ok) throw new Error("expected old memory");
    expect(memory.forgetMemory(old.value.memory_id, "test forgotten old").ok).toBe(true);

    const rejected = memory.supersedeMemory({
      old_memory_ids: [old.value.memory_id],
      replacement: {
        scope: "global",
        type: "lesson",
        topic: "supersede",
        title: "replacement-forgotten-old-entry",
        body: "This replacement must not be created.",
        tags: [],
        source: { kind: "agent" },
        importance: 3,
        confidence: 3
      },
      reason: "forgotten old entry"
    });

    expect(rejected).toMatchObject({ ok: false, error: "invalid_state" });
    expect(memory.searchMemories({ scope: "global", query: "replacement-forgotten-old-entry" }).items).toEqual([]);
    expect(store.listAuditEvents({ memory_id: old.value.memory_id, event: "write_rejected" })).toEqual([
      expect.objectContaining({
        event: "write_rejected",
        scope: "global",
        reason: "invalid_state",
        metadata: expect.objectContaining({
          error: "invalid_state",
          memory_id: old.value.memory_id,
          status: "forgotten"
        })
      })
    ]);
    store.close();
  });

  it("rejects supersede with superseded old entry without creating a replacement", () => {
    const { store, memory } = service();
    const old = memory.remember({
      scope: "global",
      type: "lesson",
      topic: "supersede",
      title: "Superseded old entry",
      body: "Old body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    expect(old.ok).toBe(true);
    if (!old.ok) throw new Error("expected old memory");
    const firstReplacement = memory.supersedeMemory({
      old_memory_ids: [old.value.memory_id],
      replacement: {
        scope: "global",
        type: "lesson",
        topic: "supersede",
        title: "First replacement",
        body: "First replacement body",
        tags: [],
        source: { kind: "agent" },
        importance: 3,
        confidence: 3
      },
      reason: "first replacement"
    });
    expect(firstReplacement.ok).toBe(true);

    const rejected = memory.supersedeMemory({
      old_memory_ids: [old.value.memory_id],
      replacement: {
        scope: "global",
        type: "lesson",
        topic: "supersede",
        title: "replacement-superseded-old-entry",
        body: "This replacement must not be created.",
        tags: [],
        source: { kind: "agent" },
        importance: 3,
        confidence: 3
      },
      reason: "superseded old entry"
    });

    expect(rejected).toMatchObject({ ok: false, error: "invalid_state" });
    expect(memory.listMemories({ scope: "global" }).items.map((entry) => entry.title)).not.toContain(
      "replacement-superseded-old-entry"
    );
    expect(store.listAuditEvents({ memory_id: old.value.memory_id, event: "write_rejected" })).toEqual([
      expect.objectContaining({
        event: "write_rejected",
        scope: "global",
        reason: "invalid_state",
        metadata: expect.objectContaining({
          error: "invalid_state",
          memory_id: old.value.memory_id,
          status: "superseded"
        })
      })
    ]);
    store.close();
  });

  it("rejects supersede across scopes and projects without creating a replacement", () => {
    const { store, memory } = service();
    const globalOld = memory.remember({
      scope: "global",
      type: "lesson",
      topic: "supersede",
      title: "Global old entry",
      body: "Old body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    const projectOld = memory.remember({
      scope: "project",
      project_id: "repo-a",
      type: "lesson",
      topic: "supersede",
      title: "Project old entry",
      body: "Old body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    expect(globalOld.ok).toBe(true);
    expect(projectOld.ok).toBe(true);
    if (!globalOld.ok || !projectOld.ok) throw new Error("expected old memories");

    const crossScope = memory.supersedeMemory({
      old_memory_ids: [globalOld.value.memory_id],
      replacement: {
        scope: "project",
        project_id: "repo-a",
        type: "lesson",
        topic: "supersede",
        title: "replacement-cross-scope",
        body: "This replacement must not be created.",
        tags: [],
        source: { kind: "agent" },
        importance: 3,
        confidence: 3
      },
      reason: "cross scope"
    });
    const crossProject = memory.supersedeMemory({
      old_memory_ids: [projectOld.value.memory_id],
      replacement: {
        scope: "project",
        project_id: "repo-b",
        type: "lesson",
        topic: "supersede",
        title: "replacement-cross-project",
        body: "This replacement must not be created.",
        tags: [],
        source: { kind: "agent" },
        importance: 3,
        confidence: 3
      },
      reason: "cross project"
    });

    expect(crossScope).toMatchObject({ ok: false, error: "invalid_scope" });
    expect(crossProject).toMatchObject({ ok: false, error: "invalid_scope" });
    expect(memory.searchMemories({ scope: "project", project_id: "repo-a", query: "replacement-cross-scope" }).items).toEqual([]);
    expect(memory.searchMemories({ scope: "project", project_id: "repo-b", query: "replacement-cross-project" }).items).toEqual([]);
    // listAuditEvents orders by (created_at, id); the two rejections
    // share a millisecond so the tiebreak on the random id is
    // order-dependent. Use an order-insensitive assertion: each
    // expected event must appear, in any position.
    expect(store.listAuditEvents({ event: "write_rejected" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memory_id: globalOld.value.memory_id,
          scope: "global",
          reason: "invalid_scope",
          metadata: expect.objectContaining({
            error: "invalid_scope",
            memory_id: globalOld.value.memory_id,
            replacement_scope: "project",
            replacement_project_id: "repo-a"
          })
        }),
        expect.objectContaining({
          memory_id: projectOld.value.memory_id,
          scope: "project",
          project_id: "repo-a",
          reason: "invalid_scope",
          metadata: expect.objectContaining({
            error: "invalid_scope",
            memory_id: projectOld.value.memory_id,
            replacement_scope: "project",
            replacement_project_id: "repo-b"
          })
        })
      ])
    );
    store.close();
  });

  it("rejects cross-scope supersede without creating replacement project scope", () => {
    const { store, memory } = service();
    const old = memory.remember({
      scope: "global",
      type: "lesson",
      topic: "supersede",
      title: "Global old for side effect test",
      body: "Old body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    expect(old.ok).toBe(true);
    if (!old.ok) throw new Error("expected old memory");

    const rejected = memory.supersedeMemory({
      old_memory_ids: [old.value.memory_id],
      replacement: {
        scope: "project",
        project_id: "repo-created-by-preflight",
        type: "lesson",
        topic: "supersede",
        title: "replacement-should-not-create-scope",
        body: "This replacement must not create project scope.",
        tags: [],
        source: { kind: "agent" },
        importance: 3,
        confidence: 3
      },
      reason: "cross scope"
    });

    expect(rejected).toMatchObject({ ok: false, error: "invalid_scope" });
    expect(store.getProjectScope("repo-created-by-preflight")).toBeUndefined();
    expect(memory.searchMemories({ scope: "project", project_id: "repo-created-by-preflight", query: "replacement-should-not-create-scope" }).items).toEqual([]);
    expect(store.listAuditEvents({ event: "write_rejected" })).toEqual([
      expect.objectContaining({
        memory_id: old.value.memory_id,
        scope: "global",
        reason: "invalid_scope",
        metadata: expect.objectContaining({
          error: "invalid_scope",
          memory_id: old.value.memory_id,
          replacement_scope: "project",
          replacement_project_id: "repo-created-by-preflight"
        })
      })
    ]);
    store.close();
  });

  it("rejects cross-project supersede before replacement budget checks", () => {
    const { store, memory } = service();
    memory.configureProjectBudget(
      "repo-b",
      { max_active_entries: 1, max_total_chars: 1000, max_topic_chars: 1000, max_index_chars: 1000 },
      "G:\\Projects\\RepoB",
      "RepoB"
    );
    const old = memory.remember({
      scope: "project",
      project_id: "repo-a",
      type: "lesson",
      topic: "supersede",
      title: "Repo A old memory",
      body: "Old body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    const existing = memory.remember({
      scope: "project",
      project_id: "repo-b",
      type: "lesson",
      topic: "supersede",
      title: "Repo B fills budget",
      body: "Existing body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    expect(old.ok).toBe(true);
    expect(existing.ok).toBe(true);
    if (!old.ok) throw new Error("expected old memory");

    const rejected = memory.supersedeMemory({
      old_memory_ids: [old.value.memory_id],
      replacement: {
        scope: "project",
        project_id: "repo-b",
        type: "lesson",
        topic: "supersede",
        title: "replacement-full-budget-cross-project",
        body: "This replacement would overflow repo-b if budget ran first.",
        tags: [],
        source: { kind: "agent" },
        importance: 3,
        confidence: 3
      },
      reason: "cross project"
    });

    expect(rejected).toMatchObject({ ok: false, error: "invalid_scope" });
    expect(memory.listMemories({ scope: "project", project_id: "repo-b" }).items.map((entry) => entry.title)).not.toContain(
      "replacement-full-budget-cross-project"
    );
    expect(store.listAuditEvents({ event: "write_rejected" }).map((event) => event.reason)).toEqual(["invalid_scope"]);
    expect(store.listAuditEvents({ event: "write_rejected" })[0]).toEqual(
      expect.objectContaining({
        memory_id: old.value.memory_id,
        scope: "project",
        project_id: "repo-a",
        reason: "invalid_scope",
        metadata: expect.objectContaining({
          error: "invalid_scope",
          memory_id: old.value.memory_id,
          replacement_scope: "project",
          replacement_project_id: "repo-b"
        })
      })
    );
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

  it("rejects updates to superseded entries without modifying replacement linkage", () => {
    const { store, memory } = service();
    const old = memory.remember({
      scope: "global",
      type: "lesson",
      topic: "updates",
      title: "Original superseded title",
      body: "Original superseded body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    expect(old.ok).toBe(true);
    if (!old.ok) throw new Error("expected old memory");
    const replacement = memory.supersedeMemory({
      old_memory_ids: [old.value.memory_id],
      replacement: {
        scope: "global",
        type: "lesson",
        topic: "updates",
        title: "Replacement title",
        body: "Replacement body",
        tags: [],
        source: { kind: "agent" },
        importance: 3,
        confidence: 3
      },
      reason: "replace old"
    });
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) throw new Error("expected replacement");

    const rejected = memory.updateMemory(old.value.memory_id, { title: "Reactivated title", status: "active" });

    expect(rejected).toMatchObject({ ok: false, error: "invalid_state" });
    expect(store.peekEntry(old.value.memory_id)).toMatchObject({
      title: "Original superseded title",
      body: "Original superseded body",
      status: "superseded",
      superseded_by: replacement.value.memory_id
    });
    expect(store.listAuditEvents({ memory_id: old.value.memory_id, event: "write_rejected" })).toEqual([
      expect.objectContaining({
        scope: "global",
        reason: "invalid_state",
        metadata: expect.objectContaining({
          error: "invalid_state",
          status: "superseded"
        })
      })
    ]);
    store.close();
  });

  it("rejects active update expansion that would exceed budget", () => {
    const { store, memory } = service();
    memory.configureProjectBudget(
      "repo-123",
      { max_active_entries: 5, max_total_chars: 20, max_topic_chars: 1000, max_index_chars: 1000 },
      "G:\\Projects\\Repo",
      "Repo"
    );
    const first = memory.remember({
      scope: "project",
      project_id: "repo-123",
      type: "lesson",
      topic: "updates",
      title: "Tiny",
      body: "Small",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected memory");

    const rejected = memory.updateMemory(first.value.memory_id, { body: "This body is far too large for the budget" });

    expect(rejected).toMatchObject({ ok: false, error: "capacity_exceeded" });
    expect(store.peekEntry(first.value.memory_id)).toMatchObject({
      title: "Tiny",
      body: "Small",
      status: "active"
    });
    expect(store.listAuditEvents({ memory_id: first.value.memory_id, event: "write_rejected" })).toEqual([
      expect.objectContaining({
        reason: "capacity_exceeded",
        metadata: expect.objectContaining({ error: "capacity_exceeded" })
      })
    ]);
    store.close();
  });

  it("rejects archived to active update that would exceed active entry budget", () => {
    const { store, memory } = service();
    memory.configureProjectBudget(
      "repo-123",
      { max_active_entries: 1, max_total_chars: 1000, max_topic_chars: 1000, max_index_chars: 1000 },
      "G:\\Projects\\Repo",
      "Repo"
    );
    const active = memory.remember({
      scope: "project",
      project_id: "repo-123",
      type: "lesson",
      topic: "updates",
      title: "Active memory",
      body: "Active body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    const archived = memory.remember({
      scope: "project",
      project_id: "repo-123",
      type: "lesson",
      topic: "updates",
      title: "Archived memory",
      body: "Archived body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      status: "archived"
    });
    expect(active.ok).toBe(true);
    expect(archived.ok).toBe(true);
    if (!archived.ok) throw new Error("expected archived memory");

    const rejected = memory.updateMemory(archived.value.memory_id, { status: "active" });

    expect(rejected).toMatchObject({ ok: false, error: "capacity_exceeded" });
    expect(store.peekEntry(archived.value.memory_id)).toMatchObject({
      title: "Archived memory",
      status: "archived"
    });
    store.close();
  });

  it("accepts full-budget one-for-one supersede replacements", () => {
    const { store, memory } = service();
    memory.configureProjectBudget(
      "repo-123",
      { max_active_entries: 1, max_total_chars: 1000, max_topic_chars: 1000, max_index_chars: 1000 },
      "G:\\Projects\\Repo",
      "Repo"
    );
    const old = memory.remember({
      scope: "project",
      project_id: "repo-123",
      type: "lesson",
      topic: "supersede",
      title: "Old active memory",
      body: "Old active body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    expect(old.ok).toBe(true);
    if (!old.ok) throw new Error("expected old memory");

    const replacement = memory.supersedeMemory({
      old_memory_ids: [old.value.memory_id],
      replacement: {
        scope: "project",
        project_id: "repo-123",
        type: "lesson",
        topic: "supersede",
        title: "Replacement active memory",
        body: "Replacement active body",
        tags: [],
        source: { kind: "agent" },
        importance: 3,
        confidence: 3
      },
      reason: "one for one"
    });

    expect(replacement.ok).toBe(true);
    if (!replacement.ok) throw new Error("expected replacement");
    expect(store.peekEntry(old.value.memory_id)?.status).toBe("superseded");
    expect(memory.listMemories({ scope: "project", project_id: "repo-123" }).items.map((entry) => entry.id)).toEqual([
      replacement.value.memory_id
    ]);
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

  it("rolls back entry updates when audit append fails", () => {
    const store = new FailingAuditStore(join(mkdtempSync(join(tmpdir(), "lm-service-")), "memory.sqlite"));
    const memory = new MemoryService(store);
    const first = memory.remember({
      scope: "global",
      type: "lesson",
      topic: "transactions",
      title: "Original title",
      body: "Original body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected memory");

    store.failAudit = true;
    expect(() => memory.updateMemory(first.value.memory_id, { title: "Updated title" })).toThrow("audit append failed");
    expect(store.peekEntry(first.value.memory_id)).toMatchObject({
      title: "Original title",
      body: "Original body"
    });
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

  it("rejects project budget reads without project_id instead of aggregating projects", () => {
    const { store, memory } = service();
    expect(memory.remember({
      scope: "project",
      project_id: "repo-a",
      type: "lesson",
      topic: "budget",
      title: "Repo A",
      body: "Repo A body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    }).ok).toBe(true);
    expect(memory.remember({
      scope: "project",
      project_id: "repo-b",
      type: "lesson",
      topic: "budget",
      title: "Repo B",
      body: "Repo B body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    }).ok).toBe(true);

    expect(memory.getMemoryBudget({ scope: "project" })).toMatchObject({
      ok: false,
      error: "invalid_scope"
    });
    expect(memory.listMemories({ scope: "project" })).toMatchObject({
      ok: false,
      error: "invalid_scope"
    });
    expect(memory.searchMemories({ scope: "project", query: "Repo" })).toMatchObject({
      ok: false,
      error: "invalid_scope"
    });
    expect(memory.listMemories({ scope: "global" }).items.map((entry) => entry.title)).toEqual([]);
    store.close();
  });

  it("exports project context without global leakage or access-count pollution", () => {
    const { store, memory } = service();
    const global = memory.remember({
      scope: "global",
      type: "preference",
      topic: "shell",
      title: "Global rtk preference",
      body: "Use rtk for shell commands in every repository.",
      tags: ["rtk"],
      source: { kind: "user" },
      importance: 5,
      confidence: 5
    });
    const project = memory.remember({
      scope: "project",
      project_id: "repo-a",
      type: "debugging",
      topic: "shell",
      title: "Repo A rtk wrapper",
      body: "Repo A commands should keep the rtk wrapper.",
      tags: ["rtk"],
      source: { kind: "agent" },
      importance: 4,
      confidence: 5
    });
    const otherProject = memory.remember({
      scope: "project",
      project_id: "repo-b",
      type: "debugging",
      topic: "shell",
      title: "Repo B rtk wrapper",
      body: "Repo B context must not leak into Repo A exports.",
      tags: ["rtk"],
      source: { kind: "agent" },
      importance: 4,
      confidence: 5
    });
    const forgotten = memory.remember({
      scope: "project",
      project_id: "repo-a",
      type: "lesson",
      topic: "shell",
      title: "Forgotten rtk note",
      body: "forgotten body must never appear",
      tags: ["rtk"],
      source: { kind: "agent" },
      importance: 5,
      confidence: 5
    });
    expect(global.ok).toBe(true);
    expect(project.ok).toBe(true);
    expect(otherProject.ok).toBe(true);
    expect(forgotten.ok).toBe(true);
    if (!global.ok || !project.ok || !forgotten.ok) throw new Error("expected memories");
    expect(memory.forgetMemory(forgotten.value.memory_id, "test forget").ok).toBe(true);

    const projectOnly = memory.exportMemoryContext({
      scope: "project",
      project_id: "repo-a",
      query: "rtk",
      budget_chars: 2000
    });
    const withGlobal = memory.exportMemoryContext({
      scope: "project",
      project_id: "repo-a",
      query: "rtk",
      include_global: true,
      budget_chars: 2000
    });

    expect(projectOnly).toContain("Repo A rtk wrapper");
    expect(projectOnly).not.toContain("Global rtk preference");
    expect(projectOnly).not.toContain("Repo B rtk wrapper");
    expect(projectOnly).not.toContain("forgotten body must never appear");
    expect(withGlobal).toContain("Repo A rtk wrapper");
    expect(withGlobal).toContain("Global rtk preference");
    expect(store.peekEntry(project.value.memory_id)?.access_count).toBe(0);
    expect(store.peekEntry(global.value.memory_id)?.access_count).toBe(0);
    store.close();
  });

  it("prefers high-importance high-confidence context and applies type and topic filters", () => {
    const { store, memory } = service();
    const low = memory.remember({
      scope: "global",
      type: "lesson",
      topic: "shell",
      title: "Low rtk note",
      body: "Low priority rtk context.",
      tags: ["rtk"],
      source: { kind: "agent" },
      importance: 1,
      confidence: 1
    });
    const high = memory.remember({
      scope: "global",
      type: "preference",
      topic: "shell",
      title: "High rtk note",
      body: "High priority rtk context.",
      tags: ["rtk"],
      source: { kind: "user" },
      importance: 5,
      confidence: 5
    });
    expect(low.ok).toBe(true);
    expect(high.ok).toBe(true);

    const all = memory.exportMemoryContext({ scope: "global", query: "rtk", budget_chars: 2000 });
    const filtered = memory.exportMemoryContext({
      scope: "global",
      query: "rtk",
      budget_chars: 2000,
      types: ["preference"],
      topics: ["shell"]
    });

    expect(all.indexOf("High rtk note")).toBeLessThan(all.indexOf("Low rtk note"));
    expect(filtered).toContain("High rtk note");
    expect(filtered).not.toContain("Low rtk note");
    store.close();
  });

  it("finds deterministic duplicate groups without mutating memories", () => {
    const { store, memory } = service();
    const first = memory.remember({
      scope: "global",
      type: "lesson",
      topic: "duplicates",
      title: "Same title",
      body: "Same body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    const second = memory.remember({
      scope: "global",
      type: "lesson",
      topic: "duplicates",
      title: " same   title ",
      body: " same body ",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      confirm_write: true
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("expected duplicate memories");
    const duplicateIds = [first.value.memory_id, second.value.memory_id].sort();

    const result = memory.maintainMemories({ action: "find_duplicates", scope: "global" });

    expect(result).toMatchObject({ action: "find_duplicates", changed: 0 });
    expect(result.details).toEqual({
      groups: [
        expect.objectContaining({
          reason: "same_title_and_body",
          memory_ids: duplicateIds
        }),
        expect.objectContaining({
          reason: "same_title",
          memory_ids: duplicateIds
        }),
        expect.objectContaining({
          reason: "same_body",
          memory_ids: duplicateIds
        })
      ]
    });
    expect(store.peekEntry(first.value.memory_id)?.status).toBe("active");
    expect(store.listAuditEvents({ event: "maintenance_run" })).toEqual([]);
    store.close();
  });

  it("finds similar (rephrased) duplicate groups via Jaccard", () => {
    const { store, memory } = service();
    // two memories with different titles and moderately different bodies
    // that nonetheless share most content tokens (Jaccard 0.75).
    const first = memory.remember({
      scope: "global",
      type: "lesson",
      topic: "stack",
      title: "p1",
      body: "primary datastore is postgres",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    const second = memory.remember({
      scope: "global",
      type: "lesson",
      topic: "stack",
      title: "p2",
      body: "primary datastore is postgres for the api",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      confirm_write: true
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("expected similar memories");
    const pairIds = [first.value.memory_id, second.value.memory_id].sort();

    const result = memory.maintainMemories({ action: "find_duplicates", scope: "global" });
    const details = result.details as { groups: Array<{ reason: string; memory_ids: string[]; details?: { similarity?: number } }> };
    const simGroup = details.groups.find((g) => g.reason === "similar_title_and_body");
    expect(simGroup).toBeDefined();
    expect(simGroup?.memory_ids).toEqual(pairIds);
    expect(simGroup?.details?.similarity).toBeGreaterThanOrEqual(0.7);
    store.close();
  });

  it("does not flag similar_title_and_body for genuinely different memories", () => {
    const { store, memory } = service();
    memory.remember({
      scope: "global", type: "lesson", topic: "stack",
      title: "p1", body: "primary datastore is postgres",
      tags: [], source: { kind: "agent" }, importance: 3, confidence: 3
    });
    memory.remember({
      scope: "global", type: "lesson", topic: "ui",
      title: "p2", body: "user prefers tabs over spaces",
      tags: [], source: { kind: "agent" }, importance: 3, confidence: 3
    });
    const result = memory.maintainMemories({ action: "find_duplicates", scope: "global" });
    const details = result.details as { groups: Array<{ reason: string }> };
    const simGroup = details.groups.find((g) => g.reason === "similar_title_and_body");
    expect(simGroup).toBeUndefined();
    store.close();
  });

  it("rebuilds markdown index and audits the export", () => {
    const exportRoot = join(mkdtempSync(join(tmpdir(), "lm-service-export-")), "exports");
    const { store, memory } = service(exportRoot);
    const remembered = memory.remember({
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
    expect(remembered.ok).toBe(true);

    const result = memory.maintainMemories({ action: "rebuild_markdown_index", scope: "global" });

    expect(result).toMatchObject({ action: "rebuild_markdown_index", changed: 2 });
    expect(result.details).toEqual(
      expect.objectContaining({
        indexPath: join(exportRoot, "global", "MEMORY.md"),
        topicPaths: [join(exportRoot, "global", "topics", "shell.md")]
      })
    );
    expect(existsSync(join(exportRoot, "global", "MEMORY.md"))).toBe(true);
    expect(readFileSync(join(exportRoot, "global", "MEMORY.md"), "utf8")).toContain("SQLite is authoritative");
    expect(readFileSync(join(exportRoot, "global", "topics", "shell.md"), "utf8")).toContain("mem_");
    expect(store.listAuditEvents({ event: "markdown_exported" })).toEqual([
      expect.objectContaining({
        scope: "global",
        event: "markdown_exported",
        metadata: expect.objectContaining({
          indexPath: join(exportRoot, "global", "MEMORY.md")
        })
      })
    ]);
    store.close();
  });

  it("does not change live markdown when staged export generation fails", () => {
    const exportRoot = join(mkdtempSync(join(tmpdir(), "lm-service-export-")), "exports");
    const store = new SQLiteMemoryStore(join(mkdtempSync(join(tmpdir(), "lm-service-")), "memory.sqlite"));
    const memory = new MemoryService(store, new MarkdownExporter(exportRoot));
    const old = memory.remember({
      scope: "global",
      type: "preference",
      topic: "shell",
      title: "Old export",
      body: "Old export body.",
      tags: ["shell"],
      source: { kind: "agent" },
      importance: 4,
      confidence: 4
    });
    expect(old.ok).toBe(true);
    expect(memory.maintainMemories({ action: "rebuild_markdown_index", scope: "global" })).toMatchObject({
      changed: 2
    });
    const indexPath = join(exportRoot, "global", "MEMORY.md");
    const oldIndex = readFileSync(indexPath, "utf8");

    const next = memory.remember({
      scope: "global",
      type: "preference",
      topic: "new-topic",
      title: "New export",
      body: "New export body.",
      tags: ["new"],
      source: { kind: "agent" },
      importance: 4,
      confidence: 4
    });
    expect(next.ok).toBe(true);
    const failingMemory = new MemoryService(store, new FailingStageExporter(exportRoot));

    expect(() => failingMemory.maintainMemories({ action: "rebuild_markdown_index", scope: "global" })).toThrow(
      "stage write failed"
    );
    expect(readFileSync(indexPath, "utf8")).toBe(oldIndex);
    expect(readFileSync(indexPath, "utf8")).not.toContain("New export");
    expect(existsSync(join(exportRoot, "global", "topics", "new-topic.md"))).toBe(false);
    expect(store.listAuditEvents({ event: "markdown_exported" })).toHaveLength(1);
    store.close();
  });

  it("rolls back live markdown when rebuild audit append fails", () => {
    const exportRoot = join(mkdtempSync(join(tmpdir(), "lm-service-export-")), "exports");
    const store = new FailingAuditStore(join(mkdtempSync(join(tmpdir(), "lm-service-")), "memory.sqlite"));
    const memory = new MemoryService(store, new MarkdownExporter(exportRoot));
    const old = memory.remember({
      scope: "global",
      type: "preference",
      topic: "shell",
      title: "Old audited export",
      body: "Old audited export body.",
      tags: ["shell"],
      source: { kind: "agent" },
      importance: 4,
      confidence: 4
    });
    expect(old.ok).toBe(true);
    expect(memory.maintainMemories({ action: "rebuild_markdown_index", scope: "global" })).toMatchObject({
      changed: 2
    });
    const indexPath = join(exportRoot, "global", "MEMORY.md");
    const oldIndex = readFileSync(indexPath, "utf8");

    const next = memory.remember({
      scope: "global",
      type: "preference",
      topic: "new-topic",
      title: "New audited export",
      body: "New audited export body.",
      tags: ["new"],
      source: { kind: "agent" },
      importance: 4,
      confidence: 4
    });
    expect(next.ok).toBe(true);

    store.failAudit = true;
    expect(() => memory.maintainMemories({ action: "rebuild_markdown_index", scope: "global" })).toThrow(
      "audit append failed"
    );
    store.failAudit = false;
    expect(readFileSync(indexPath, "utf8")).toBe(oldIndex);
    expect(readFileSync(indexPath, "utf8")).not.toContain("New audited export");
    expect(existsSync(join(exportRoot, "global", "topics", "new-topic.md"))).toBe(false);
    expect(store.listAuditEvents({ event: "markdown_exported" })).toHaveLength(1);
    store.close();
  });

  it("expires due active memories by forgetting bodies and recording maintenance", () => {
    const { store, memory } = service();
    const expired = memory.remember({
      scope: "global",
      type: "lesson",
      topic: "expiry",
      title: "Expired memory",
      body: "expired body should be removed",
      tags: ["old"],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      expires_at: "2000-01-01T00:00:00.000Z"
    });
    const future = memory.remember({
      scope: "global",
      type: "lesson",
      topic: "expiry",
      title: "Future memory",
      body: "future body should remain",
      tags: ["new"],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      expires_at: "2999-01-01T00:00:00.000Z"
    });
    expect(expired.ok).toBe(true);
    expect(future.ok).toBe(true);
    if (!expired.ok || !future.ok) throw new Error("expected expiry memories");

    const result = memory.maintainMemories({ action: "expire_due", scope: "global" });

    expect(result).toMatchObject({
      action: "expire_due",
      changed: 1,
      details: { expired: [{ memory_id: expired.value.memory_id, expires_at: "2000-01-01T00:00:00.000Z" }] }
    });
    expect(store.peekEntry(expired.value.memory_id)).toMatchObject({
      status: "forgotten",
      body: "",
      tags: []
    });
    expect(store.peekEntry(future.value.memory_id)).toMatchObject({
      status: "active",
      body: "future body should remain"
    });
    expect(store.listAuditEvents({ event: "maintenance_run" })).toEqual([
      expect.objectContaining({
        scope: "global",
        reason: "expire_due",
        metadata: expect.objectContaining({ changed: 1 })
      })
    ]);
    store.close();
  });

  it("archives low-value active memories and leaves protected entries active", () => {
    const { store, memory } = service();
    const low = memory.remember({
      scope: "project",
      project_id: "repo-a",
      type: "lesson",
      topic: "cleanup",
      title: "Low value cleanup note",
      body: "Low confidence and unaccessed.",
      tags: [],
      source: { kind: "agent" },
      importance: 1,
      confidence: 1
    });
    const protectedEntry = memory.remember({
      scope: "project",
      project_id: "repo-a",
      type: "lesson",
      topic: "cleanup",
      title: "User cleanup note",
      body: "User-authored memories should not be archived as low value.",
      tags: [],
      source: { kind: "user" },
      importance: 1,
      confidence: 1
    });
    expect(low.ok).toBe(true);
    expect(protectedEntry.ok).toBe(true);
    if (!low.ok || !protectedEntry.ok) throw new Error("expected cleanup memories");

    const result = memory.maintainMemories({ action: "archive_low_value", scope: "project", project_id: "repo-a" });

    expect(result).toMatchObject({
      action: "archive_low_value",
      changed: 1,
      details: { archived: [{ memory_id: low.value.memory_id, reason: "low importance, low confidence, never accessed" }] }
    });
    expect(store.peekEntry(low.value.memory_id)?.status).toBe("archived");
    expect(store.peekEntry(protectedEntry.value.memory_id)?.status).toBe("active");
    expect(store.listAuditEvents({ event: "maintenance_run" })).toEqual([
      expect.objectContaining({
        scope: "project",
        project_id: "repo-a",
        reason: "archive_low_value",
        metadata: expect.objectContaining({ changed: 1 })
      })
    ]);
    store.close();
  });

  it("reports vacuum_fts as a clear no-op when the store has no vacuum support", () => {
    const { store, memory } = service();

    const result = memory.maintainMemories({ action: "vacuum_fts", scope: "global" });

    expect(result).toEqual({
      action: "vacuum_fts",
      changed: 0,
      details: {
        status: "noop",
        reason: "SQLiteMemoryStore does not expose FTS vacuum support"
      }
    });
    expect(store.listAuditEvents({ event: "maintenance_run" })).toEqual([
      expect.objectContaining({
        scope: "global",
        reason: "vacuum_fts",
        metadata: expect.objectContaining({ changed: 0 })
      })
    ]);
    store.close();
  });
});
