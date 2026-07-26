import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { createMemoryToolHandlers, registerMemoryTools } from "../src/tools/register-tools.js";
import { memoryToolSchemas } from "../src/tools/schemas.js";

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (first?.type !== "text") {
    throw new Error("expected text content");
  }
  return first.text;
}

function jsonOf(result: CallToolResult): unknown {
  return JSON.parse(textOf(result));
}

function fakeService(overrides: Record<string, unknown> = {}) {
  return {
    remember: vi.fn(() => ({ ok: true, value: { memory_id: "mem_1", status: "active" } })),
    searchMemories: vi.fn(() => ({ items: [] })),
    getMemory: vi.fn(() => ({ entry: { id: "mem_1" }, audit: [] })),
    listMemories: vi.fn(() => ({ items: [] })),
    updateMemory: vi.fn(() => ({ ok: true, value: { memory_id: "mem_1" } })),
    supersedeMemory: vi.fn(() => ({ ok: true, value: { memory_id: "mem_2" } })),
    forgetMemory: vi.fn(() => ({ ok: true, value: { memory_id: "mem_1", released_chars: 12 } })),
    getMemoryBudget: vi.fn(() => ({ usage: { active_entries: 0 }, cleanup_candidates: [] })),
    maintainMemories: vi.fn(() => ({ action: "find_duplicates", changed: 0, details: { groups: [] } })),
    exportMemoryContext: vi.fn(() => "# AgentRecall Context\n"),
    ...overrides
  };
}

function isObjectLikeZodSchema(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null) return false;
  const candidate = schema as { shape?: unknown; _zod?: { def?: { type?: unknown; shape?: unknown } } };
  return candidate.shape !== undefined || candidate._zod?.def?.type === "object" || candidate._zod?.def?.shape !== undefined;
}

describe("memory tool schemas", () => {
  it("defaults remember optional fields", () => {
    const parsed = memoryToolSchemas.remember.parse({
      scope: "global",
      type: "lesson",
      topic: "tools",
      title: "Expose memory tools",
      body: "Task 9 registers the memory MCP tools.",
      source: { kind: "agent" },
      importance: 3,
      confidence: 4
    });

    expect(parsed).toMatchObject({
      tags: [],
      status: "active",
      supersedes: []
    });
  });

  it("defaults search options", () => {
    const parsed = memoryToolSchemas.search_memories.parse({ query: "sqlite" });

    expect(parsed).toMatchObject({
      limit: 10,
      include_global: false,
      status: "active"
    });
  });

  it("defaults recall context for low-friction task-start retrieval", () => {
    const parsed = memoryToolSchemas.recall_context.parse({ query: "startup failure" });

    expect(parsed).toEqual({
      query: "startup failure",
      scope: "global",
      include_global: true,
      budget_chars: 8000,
      types: [],
      topics: []
    });
  });

  it("rejects project remembers without a project identity", () => {
    expect(() =>
      memoryToolSchemas.remember.parse({
        scope: "project",
        type: "lesson",
        topic: "tools",
        title: "Missing project",
        body: "Project memories need a project_id or project_path.",
        source: { kind: "agent" },
        importance: 3,
        confidence: 4
      })
    ).toThrow();
  });

  it("rejects project-scoped reads and maintenance without required project identity", () => {
    expect(() => memoryToolSchemas.search_memories.parse({ scope: "project", query: "sqlite" })).toThrow();
    expect(() => memoryToolSchemas.list_memories.parse({ scope: "project" })).toThrow();
    expect(() => memoryToolSchemas.maintain_memories.parse({ action: "find_duplicates", scope: "project" })).toThrow();
    expect(() =>
      memoryToolSchemas.export_memory_context.parse({
        scope: "project",
        budget_chars: 1000
      })
    ).toThrow();
  });

  it("requires project_id for project memory budget reads", () => {
    expect(() => memoryToolSchemas.get_memory_budget.parse({ scope: "project" })).toThrow();
    expect(memoryToolSchemas.get_memory_budget.parse({ scope: "project", project_id: "repo-a" })).toEqual({
      scope: "project",
      project_id: "repo-a"
    });
  });

  it("rejects unknown fields in top-level and nested objects", () => {
    expect(() =>
      memoryToolSchemas.remember.parse({
        scope: "global",
        type: "lesson",
        topic: "tools",
        title: "Unknown root",
        body: "Unknown root fields should be rejected.",
        source: { kind: "agent" },
        importance: 3,
        confidence: 4,
        unexpected: true
      })
    ).toThrow();

    expect(() =>
      memoryToolSchemas.remember.parse({
        scope: "global",
        type: "lesson",
        topic: "tools",
        title: "Unknown source",
        body: "Unknown nested fields should be rejected.",
        source: { kind: "agent", unexpected: true },
        importance: 3,
        confidence: 4
      })
    ).toThrow();

    expect(() =>
      memoryToolSchemas.update_memory.parse({
        memory_id: "mem_1",
        patch: {
          title: "Updated",
          unexpected: true
        }
      })
    ).toThrow();
  });

  it("requires update_memory to include at least one update field", () => {
    expect(() => memoryToolSchemas.update_memory.parse({ memory_id: "mem_1" })).toThrow();
    expect(() => memoryToolSchemas.update_memory.parse({ memory_id: "mem_1", patch: {} })).toThrow();
    expect(() => memoryToolSchemas.update_memory.parse({ memory_id: "mem_1", typo_field: "Updated" })).toThrow();
    expect(() =>
      memoryToolSchemas.update_memory.parse({ memory_id: "mem_1", patch: { title: "Patch" }, title: "Top level" })
    ).toThrow();

    expect(memoryToolSchemas.update_memory.parse({ memory_id: "mem_1", title: "Updated" })).toMatchObject({
      memory_id: "mem_1",
      title: "Updated"
    });
    expect(memoryToolSchemas.update_memory.parse({ memory_id: "mem_1", patch: { title: "Updated" } })).toMatchObject({
      memory_id: "mem_1",
      patch: {
        title: "Updated"
      }
    });
  });

  it("allows matching id aliases and rejects conflicting id aliases", () => {
    expect(memoryToolSchemas.get_memory.parse({ id: "mem_1", memory_id: "mem_1" })).toEqual({
      id: "mem_1",
      memory_id: "mem_1"
    });
    expect(memoryToolSchemas.update_memory.parse({ id: "mem_1", memory_id: "mem_1", title: "Updated" })).toMatchObject({
      id: "mem_1",
      memory_id: "mem_1",
      title: "Updated"
    });
    expect(memoryToolSchemas.forget_memory.parse({ id: "mem_1", memory_id: "mem_1", reason: "obsolete" })).toEqual({
      id: "mem_1",
      memory_id: "mem_1",
      reason: "obsolete"
    });

    expect(() => memoryToolSchemas.get_memory.parse({ id: "mem_1", memory_id: "mem_2" })).toThrow();
    expect(() => memoryToolSchemas.update_memory.parse({ id: "mem_1", memory_id: "mem_2", title: "Updated" })).toThrow();
    expect(() => memoryToolSchemas.forget_memory.parse({ id: "mem_1", memory_id: "mem_2", reason: "obsolete" })).toThrow();
  });

  it("list_memories and search_memories accept an optional actor filter (stage 4)", async () => {
    expect(memoryToolSchemas.list_memories.parse({ scope: "global", actor: "agent:claude-code" })).toMatchObject({
      scope: "global",
      actor: "agent:claude-code"
    });
    expect(memoryToolSchemas.search_memories.parse({
      query: "postgres",
      scope: "global",
      actor: "agent:claude-code"
    })).toMatchObject({
      query: "postgres",
      scope: "global",
      actor: "agent:claude-code"
    });

    // Handlers forward the actor through to MemoryService.
    const service = fakeService();
    service.listMemories.mockReturnValue({ items: [] });
    service.searchMemories.mockReturnValue({ items: [] });
    const handlers = createMemoryToolHandlers(service);
    await handlers.list_memories({ scope: "global", actor: "agent:claude-code" });
    expect(service.listMemories).toHaveBeenCalledWith(expect.objectContaining({ actor: "agent:claude-code" }));
    await handlers.search_memories({ query: "x", scope: "global", actor: "agent:claude-code" });
    expect(service.searchMemories).toHaveBeenCalledWith(expect.objectContaining({ actor: "agent:claude-code" }));
  });

  it("list_memories and search_memories accept time-window filters (stage 6)", () => {
    // ISO 8601 datetime strings are accepted on both schemas.
    const parsed = memoryToolSchemas.list_memories.parse({
      scope: "global",
      since: "2026-07-13T00:00:00.000Z",
      until: "2026-07-20T00:00:00.000Z",
      last_accessed_since: "2026-07-15T00:00:00.000Z"
    });
    expect(parsed).toMatchObject({
      scope: "global",
      since: "2026-07-13T00:00:00.000Z",
      until: "2026-07-20T00:00:00.000Z",
      last_accessed_since: "2026-07-15T00:00:00.000Z"
    });

    // Invalid (non-ISO) values are rejected.
    expect(() => memoryToolSchemas.list_memories.parse({ scope: "global", since: "yesterday" })).toThrow();
    expect(() => memoryToolSchemas.search_memories.parse({ query: "x", scope: "global", until: "2026/07/20" })).toThrow();

    // Handlers forward the fields to the service.
    const service = fakeService();
    service.listMemories.mockReturnValue({ items: [] });
    service.searchMemories.mockReturnValue({ items: [] });
    const handlers = createMemoryToolHandlers(service);
    return handlers.list_memories({ scope: "global", since: "2026-07-13T00:00:00.000Z" }).then(() => {
      expect(service.listMemories).toHaveBeenCalledWith(expect.objectContaining({ since: "2026-07-13T00:00:00.000Z" }));
      return handlers.search_memories({ query: "x", scope: "global", last_accessed_since: "2026-07-15T00:00:00.000Z" });
    }).then(() => {
      expect(service.searchMemories).toHaveBeenCalledWith(expect.objectContaining({ last_accessed_since: "2026-07-15T00:00:00.000Z" }));
    });
  });

  it("list_memories and search_memories accept updated_at filters (stage 7)", () => {
    // ISO 8601 datetime strings are accepted on both schemas.
    const parsed = memoryToolSchemas.list_memories.parse({
      scope: "global",
      updated_since: "2026-07-13T00:00:00.000Z",
      updated_until: "2026-07-20T00:00:00.000Z"
    });
    expect(parsed).toMatchObject({
      scope: "global",
      updated_since: "2026-07-13T00:00:00.000Z",
      updated_until: "2026-07-20T00:00:00.000Z"
    });

    // Invalid (non-ISO) values are rejected.
    expect(() => memoryToolSchemas.list_memories.parse({ scope: "global", updated_since: "yesterday" })).toThrow();
    expect(() => memoryToolSchemas.search_memories.parse({ query: "x", scope: "global", updated_until: "2026/07/20" })).toThrow();

    // Handlers forward the fields to the service.
    const service = fakeService();
    service.listMemories.mockReturnValue({ items: [] });
    service.searchMemories.mockReturnValue({ items: [] });
    const handlers = createMemoryToolHandlers(service);
    return handlers.list_memories({ scope: "global", updated_since: "2026-07-13T00:00:00.000Z" }).then(() => {
      expect(service.listMemories).toHaveBeenCalledWith(
        expect.objectContaining({ updated_since: "2026-07-13T00:00:00.000Z" })
      );
      return handlers.search_memories({ query: "x", scope: "global", updated_since: "2026-07-15T00:00:00.000Z" });
    }).then(() => {
      expect(service.searchMemories).toHaveBeenCalledWith(
        expect.objectContaining({ updated_since: "2026-07-15T00:00:00.000Z" })
      );
    });
  });

  it("get_memory is a pure read and ignores client-supplied accessed_by", async () => {
    // Schema still accepts `accessed_by` for one release
    // cycle so existing clients keep parsing. Stage 16
    // v1.1.1 PR-1 (#11) marks the field deprecated and the
    // handler drops it on the floor — access identity comes
    // from the trusted `RequestContext` actor, not from
    // client input.
    expect(memoryToolSchemas.get_memory.parse({
      memory_id: "mem_1",
      accessed_by: "agent:claude-code"
    })).toEqual({
      memory_id: "mem_1",
      accessed_by: "agent:claude-code"
    });

    // Handler does NOT forward the client-supplied
    // accessed_by to the service; the service is called
    // with just the memory id.
    const service = fakeService();
    service.getMemory.mockReturnValue({ entry: { id: "mem_1" }, audit: [] });
    const handlers = createMemoryToolHandlers(service);
    await handlers.get_memory({ memory_id: "mem_1", accessed_by: "agent:claude-code" });
    expect(service.getMemory).toHaveBeenCalledWith("mem_1");

    // And still calls with just the memory id when
    // accessed_by is absent.
    await handlers.get_memory({ memory_id: "mem_2" });
    expect(service.getMemory).toHaveBeenLastCalledWith("mem_2");
  });
});

describe("createMemoryToolHandlers", () => {
  it("returns pretty JSON for remember success", async () => {
    const service = fakeService();
    const handlers = createMemoryToolHandlers(service);

    const result = await handlers.remember({
      scope: "global",
      type: "lesson",
      topic: "tools",
      title: "Expose memory tools",
      body: "Remember through MCP.",
      source: { kind: "agent" },
      importance: 4,
      confidence: 5
    });

    expect(service.remember).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Expose memory tools",
        tags: [],
        status: "active"
      }),
      expect.objectContaining({ request_id: expect.any(String) })
    );
    expect(textOf(result)).toBe(JSON.stringify({ ok: true, value: { memory_id: "mem_1", status: "active" } }, null, 2));
  });

  it("returns raw markdown for export context", async () => {
    const service = fakeService({
      exportMemoryContext: vi.fn(() => "# AgentRecall Context\n\n## Memories\n")
    });
    const handlers = createMemoryToolHandlers(service);

    const result = await handlers.export_memory_context({ scope: "global", budget_chars: 1000 });

    expect(textOf(result)).toBe("# AgentRecall Context\n\n## Memories\n");
  });

  it("recalls context through a task-start friendly tool", async () => {
    const service = fakeService({
      exportMemoryContext: vi.fn(() => "# AgentRecall Context\n\n## Memories\n")
    });
    const handlers = createMemoryToolHandlers(service);

    const result = await handlers.recall_context({
      query: "tool registration",
      scope: "project",
      project_path: "G:\\Projects\\Repo"
    });

    expect(service.exportMemoryContext).toHaveBeenCalledWith({
      query: "tool registration",
      scope: "project",
      project_path: "G:\\Projects\\Repo",
      include_global: true,
      budget_chars: 8000,
      types: [],
      topics: []
    }, expect.objectContaining({ request_id: expect.any(String) }));
    expect(textOf(result)).toContain("# AgentRecall Context");
  });

  it("wraps service error results as JSON text", async () => {
    const service = fakeService({
      searchMemories: vi.fn(() => ({ ok: false, error: "invalid_scope", message: "project scope requires project_id or project_path" }))
    });
    const handlers = createMemoryToolHandlers(service);

    const result = await handlers.search_memories({ scope: "project", project_id: "repo-a", query: "sqlite" });

    expect(jsonOf(result)).toEqual({
      ok: false,
      error: "invalid_scope",
      message: "project scope requires project_id or project_path"
    });
  });

  it("wraps direct handler zod parse errors as JSON text", async () => {
    const service = fakeService();
    const handlers = createMemoryToolHandlers(service);

    const result = await handlers.remember({ scope: "global" });

    expect(jsonOf(result)).toMatchObject({
      ok: false,
      error: "invalid_schema",
      message: "Input does not match the remember tool schema."
    });
    expect(service.remember).not.toHaveBeenCalled();
  });

  it("wraps thrown service errors as JSON text", async () => {
    const service = fakeService({
      maintainMemories: vi.fn(() => {
        throw new Error("maintenance failed");
      })
    });
    const handlers = createMemoryToolHandlers(service);

    const result = await handlers.maintain_memories({ action: "find_duplicates", scope: "global" });

    expect(jsonOf(result)).toEqual({
      ok: false,
      error: "tool_error",
      message: "maintenance failed"
    });
  });

  it("rejects conflicting id aliases before dispatch", async () => {
    const service = fakeService();
    const handlers = createMemoryToolHandlers(service);

    expect(jsonOf(await handlers.get_memory({ id: "mem_1", memory_id: "mem_2" }))).toMatchObject({
      ok: false,
      error: "invalid_schema"
    });
    expect(jsonOf(await handlers.update_memory({ id: "mem_1", memory_id: "mem_2", title: "Updated" }))).toMatchObject({
      ok: false,
      error: "invalid_schema"
    });
    expect(jsonOf(await handlers.forget_memory({ id: "mem_1", memory_id: "mem_2", reason: "obsolete" }))).toMatchObject({
      ok: false,
      error: "invalid_schema"
    });

    expect(service.getMemory).not.toHaveBeenCalled();
    expect(service.updateMemory).not.toHaveBeenCalled();
    expect(service.forgetMemory).not.toHaveBeenCalled();
  });

  it("dispatches tools to updated service methods", async () => {
    const service = fakeService();
    const handlers = createMemoryToolHandlers(service);

    await handlers.update_memory({ memory_id: "mem_1", patch: { title: "Updated" } });
    await handlers.supersede_memory({
      old_memory_ids: ["mem_1"],
      reason: "merged",
      replacement: {
        scope: "global",
        type: "lesson",
        topic: "tools",
        title: "Replacement",
        body: "Replacement body",
        source: { kind: "agent" },
        importance: 3,
        confidence: 3
      }
    });
    await handlers.forget_memory({ memory_id: "mem_1", reason: "obsolete" });
    await handlers.get_memory_budget({ scope: "global" });
    await handlers.maintain_memories({ action: "find_duplicates", scope: "global" });

    expect(service.updateMemory).toHaveBeenCalledWith("mem_1", { title: "Updated" }, expect.objectContaining({ request_id: expect.any(String) }));
    expect(service.supersedeMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        old_memory_ids: ["mem_1"],
        reason: "merged",
        replacement: expect.objectContaining({ tags: [], status: "active" })
      }),
      expect.objectContaining({ request_id: expect.any(String) })
    );
    expect(service.forgetMemory).toHaveBeenCalledWith("mem_1", "obsolete", expect.objectContaining({ request_id: expect.any(String) }));
    expect(service.getMemoryBudget).toHaveBeenCalledWith({ scope: "global" });
    expect(service.maintainMemories).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "find_duplicates",
        scope: "global",
        batch_size: 500,
        dry_run: false,
        strategy: "keep_first"
      }),
      expect.objectContaining({ request_id: expect.any(String) })
    );
  });
});

describe("registerMemoryTools", () => {
  it("registers every memory tool with the SDK registerTool shape", () => {
    const registered: Array<{ name: string; config: { description?: string; inputSchema?: unknown }; cb: unknown }> = [];
    const server = {
      registerTool: vi.fn((name: string, config: { description?: string; inputSchema?: unknown }, cb: unknown) => {
        registered.push({ name, config, cb });
      })
    };

    registerMemoryTools(server, fakeService());

    // Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4):
    // the canonical `registerMemoryTools` registers
    // every tool (the `core` / `extended` profile
    // split is the per-server decision; this test
    // verifies the all-tools path). The four new
    // memory-semantics tools are appended at the
    // end of the registration order.
    expect(registered.map((tool) => tool.name)).toEqual([
      "recall_context",
      "remember",
      "search_memories",
      "get_memory",
      "list_memories",
      "update_memory",
      "supersede_memory",
      "merge_memories",
      "forget_memory",
      "get_memory_budget",
      "maintain_memories",
      "export_memory_context",
      "plan_maintenance",
      "apply_maintenance",
      "explain_recall",
      "list_backups",
      "record_memory_feedback",
      "record_memory_provenance",
      "explain_memory_provenance",
      "confirm_memory_trust"
    ]);
    expect(registered[0]?.config.description).toContain("[TRIGGER] Call near the start of a coding task");
    for (const tool of registered) {
      expect(tool.config.description).toEqual(expect.any(String));
      expect(tool.config.inputSchema).toBe(memoryToolSchemas[tool.name as keyof typeof memoryToolSchemas]);
      expect(isObjectLikeZodSchema(tool.config.inputSchema)).toBe(true);
      expect(tool.cb).toEqual(expect.any(Function));
    }
  });
});
