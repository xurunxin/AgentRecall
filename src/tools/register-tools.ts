import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodType } from "zod";
import type { MemoryService } from "../memory-service.js";
import { memoryToolSchemas, type MemoryToolName } from "./schemas.js";

export type MemoryToolHandler = (input: unknown) => Promise<CallToolResult>;
export type MemoryToolHandlers = Record<MemoryToolName, MemoryToolHandler>;

const memoryToolNames = [
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
] as const satisfies readonly MemoryToolName[];

const memoryToolDescriptions: Record<MemoryToolName, string> = {
  remember: "Store a validated local memory entry.",
  search_memories: "Search local memories by full-text query and optional filters.",
  get_memory: "Read a memory entry and its audit history by memory id.",
  list_memories: "List local memories with optional scope and metadata filters.",
  update_memory: "Update mutable fields on an active or archived memory.",
  supersede_memory: "Create a replacement memory and mark older memories as superseded.",
  forget_memory: "Forget a memory by clearing its body and marking it forgotten.",
  get_memory_budget: "Report budget usage and cleanup candidates for a scope.",
  maintain_memories: "Run local memory maintenance actions.",
  export_memory_context: "Export selected memories as a markdown context pack."
};

const updateFieldNames = [
  "topic",
  "title",
  "body",
  "tags",
  "importance",
  "confidence",
  "status",
  "expires_at",
  "review_after"
] as const;

function textResult(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }]
  };
}

function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value ?? null, null, 2));
}

function zodErrorResult(toolName: MemoryToolName, error: z.ZodError): CallToolResult {
  return jsonResult({
    ok: false,
    error: "invalid_schema",
    message: `Input does not match the ${toolName} tool schema.`,
    details: {
      issues: error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message
      }))
    }
  });
}

function thrownErrorResult(error: unknown): CallToolResult {
  return jsonResult({
    ok: false,
    error: "tool_error",
    message: error instanceof Error ? error.message : String(error)
  });
}

function asNotFoundMemoryResult(memoryId: string): { ok: false; error: "not_found"; message: string; details: { memory_id: string } } {
  return {
    ok: false,
    error: "not_found",
    message: "memory not found",
    details: {
      memory_id: memoryId
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function omitUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(omitUndefined);
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .map(([key, entryValue]) => [key, omitUndefined(entryValue)])
  );
}

function serviceInput<T>(value: unknown): T {
  return omitUndefined(value) as T;
}

function memoryIdFromInput(input: { id?: string | undefined; memory_id?: string | undefined }): string {
  return input.memory_id ?? input.id ?? "";
}

function patchFromUpdateInput(input: {
  patch?: unknown;
  topic?: unknown;
  title?: unknown;
  body?: unknown;
  tags?: unknown;
  importance?: unknown;
  confidence?: unknown;
  status?: unknown;
  expires_at?: unknown;
  review_after?: unknown;
}): Parameters<MemoryService["updateMemory"]>[1] {
  if (input.patch !== undefined) {
    return serviceInput<Parameters<MemoryService["updateMemory"]>[1]>(input.patch);
  }

  const patch: Record<string, unknown> = {};
  for (const field of updateFieldNames) {
    const value = input[field];
    if (value !== undefined) {
      patch[field] = value;
    }
  }
  return serviceInput<Parameters<MemoryService["updateMemory"]>[1]>(patch);
}

function jsonHandler<T>(
  toolName: MemoryToolName,
  schema: ZodType<T>,
  run: (input: T) => unknown | Promise<unknown>
): MemoryToolHandler {
  return async (input: unknown) => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      return zodErrorResult(toolName, parsed.error);
    }

    try {
      return jsonResult(await run(parsed.data));
    } catch (error) {
      return thrownErrorResult(error);
    }
  };
}

function textHandler<T>(
  toolName: MemoryToolName,
  schema: ZodType<T>,
  run: (input: T) => string | Promise<string>
): MemoryToolHandler {
  return async (input: unknown) => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      return zodErrorResult(toolName, parsed.error);
    }

    try {
      return textResult(await run(parsed.data));
    } catch (error) {
      return thrownErrorResult(error);
    }
  };
}

export function createMemoryToolHandlers(service: MemoryService): MemoryToolHandlers {
  return {
    remember: jsonHandler("remember", memoryToolSchemas.remember, (input) =>
      service.remember(serviceInput<Parameters<MemoryService["remember"]>[0]>(input))
    ),
    search_memories: jsonHandler("search_memories", memoryToolSchemas.search_memories, (input) =>
      service.searchMemories(serviceInput<Parameters<MemoryService["searchMemories"]>[0]>(input))
    ),
    get_memory: jsonHandler("get_memory", memoryToolSchemas.get_memory, (input) =>
      service.getMemory(memoryIdFromInput(input)) ?? asNotFoundMemoryResult(memoryIdFromInput(input))
    ),
    list_memories: jsonHandler("list_memories", memoryToolSchemas.list_memories, (input) =>
      service.listMemories(serviceInput<Parameters<MemoryService["listMemories"]>[0]>(input))
    ),
    update_memory: jsonHandler("update_memory", memoryToolSchemas.update_memory, (input) =>
      service.updateMemory(memoryIdFromInput(input), patchFromUpdateInput(input))
    ),
    supersede_memory: jsonHandler("supersede_memory", memoryToolSchemas.supersede_memory, (input) =>
      service.supersedeMemory(serviceInput<Parameters<MemoryService["supersedeMemory"]>[0]>(input))
    ),
    forget_memory: jsonHandler("forget_memory", memoryToolSchemas.forget_memory, (input) =>
      service.forgetMemory(memoryIdFromInput(input), input.reason)
    ),
    get_memory_budget: jsonHandler("get_memory_budget", memoryToolSchemas.get_memory_budget, (input) =>
      service.getMemoryBudget(serviceInput<Parameters<MemoryService["getMemoryBudget"]>[0]>(input))
    ),
    maintain_memories: jsonHandler("maintain_memories", memoryToolSchemas.maintain_memories, (input) =>
      service.maintainMemories(serviceInput<Parameters<MemoryService["maintainMemories"]>[0]>(input))
    ),
    export_memory_context: textHandler("export_memory_context", memoryToolSchemas.export_memory_context, (input) =>
      service.exportMemoryContext(serviceInput<Parameters<MemoryService["exportMemoryContext"]>[0]>(input))
    )
  };
}

type MemoryToolServer = Pick<McpServer, "registerTool">;

export function registerMemoryTools(server: MemoryToolServer, service: MemoryService): void {
  const handlers = createMemoryToolHandlers(service);

  for (const name of memoryToolNames) {
    server.registerTool(
      name,
      {
        description: memoryToolDescriptions[name],
        inputSchema: memoryToolSchemas[name]
      },
      async (input: unknown) => handlers[name](input)
    );
  }
}
