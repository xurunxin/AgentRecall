import { describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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
    exportMemoryContext: vi.fn(() => "# Local Memory Context\n"),
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
      })
    );
    expect(textOf(result)).toBe(JSON.stringify({ ok: true, value: { memory_id: "mem_1", status: "active" } }, null, 2));
  });

  it("returns raw markdown for export context", async () => {
    const service = fakeService({
      exportMemoryContext: vi.fn(() => "# Local Memory Context\n\n## Memories\n")
    });
    const handlers = createMemoryToolHandlers(service);

    const result = await handlers.export_memory_context({ scope: "global", budget_chars: 1000 });

    expect(textOf(result)).toBe("# Local Memory Context\n\n## Memories\n");
  });

  it("wraps service error results as JSON text", async () => {
    const service = fakeService({
      searchMemories: vi.fn(() => ({ ok: false, error: "invalid_scope", message: "project scope requires project_id or project_path" }))
    });
    const handlers = createMemoryToolHandlers(service);

    const result = await handlers.search_memories({ scope: "project", query: "sqlite" });

    expect(jsonOf(result)).toEqual({
      ok: false,
      error: "invalid_scope",
      message: "project scope requires project_id or project_path"
    });
  });

  it("wraps zod parse errors as JSON text", async () => {
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

    expect(service.updateMemory).toHaveBeenCalledWith("mem_1", { title: "Updated" });
    expect(service.supersedeMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        old_memory_ids: ["mem_1"],
        reason: "merged",
        replacement: expect.objectContaining({ tags: [], status: "active" })
      })
    );
    expect(service.forgetMemory).toHaveBeenCalledWith("mem_1", "obsolete");
    expect(service.getMemoryBudget).toHaveBeenCalledWith({ scope: "global" });
    expect(service.maintainMemories).toHaveBeenCalledWith({ action: "find_duplicates", scope: "global" });
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

    expect(registered.map((tool) => tool.name)).toEqual([
      "remember",
      "search_memories",
      "get_memory",
      "list_memories",
      "update_memory",
      "supersede_memory",
      "forget_memory",
      "get_memory_budget",
      "maintain_memories",
      "export_memory_context"
    ]);
    for (const tool of registered) {
      expect(tool.config.description).toEqual(expect.any(String));
      expect(tool.config.inputSchema).toBe(memoryToolSchemas[tool.name as keyof typeof memoryToolSchemas]);
      expect(isObjectLikeZodSchema(tool.config.inputSchema)).toBe(true);
      expect(tool.cb).toEqual(expect.any(Function));
    }
  });
});
