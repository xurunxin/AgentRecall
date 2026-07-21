// src/tools/register-tools.ts
//
// Stage 12 PR9 (spec § 6.3): the MCP v2 contract.
//
// Every tool the server registers goes through
// `createMemoryToolHandlers` and is wrapped in
// `buildEnvelopeResult` (see `./mcp-envelope.ts`). The
// wrapper preserves the Stage 9 text payload byte-for-byte
// (so existing clients and tests still work) AND adds the
// v2 typed `structuredContent` and `isError` flag.
//
// Tools also carry:
//   - `outputSchema` (zod) — the v2 client can validate
//                            the structured payload.
//   - `annotations`        — readOnlyHint / destructiveHint /
//                            idempotentHint (spec § 6.3).
//
// Resources are registered separately via
// `registerMemoryResources` (see `./resources.ts`) — the MCP
// v2 spec lets tools and resources coexist on the same
// server.
//
// Stage 14 PR-B1 (spec § 5.2 AR-P0-002): every tool handler
// builds a `RequestContext` from the MCP `extra` envelope
// (clientInfo, sessionId, signal, progressToken, JSON-RPC
// id) and threads it through the service call. The actor
// for the audit event is the resolved `ctx.actor_id`; the
// trace fields (request_id / session_id / tool_call_id /
// client_name / client_version) are mixed into the event's
// metadata by the `appendAudit` helper.

import type { CallToolResult, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodType } from "zod";
import type { MemoryService } from "../memory-service.js";
import { CURRENT_SCHEMA_VERSION } from "../sqlite-store.js";
import { serverVersion } from "../server-version.js";
import { errorCategory, isStableErrorCode, type StableErrorCode } from "./error-codes.js";
import { memoryToolDescriptions } from "./descriptions.js";
import { buildEnvelopeResult, type ToolEnvelope } from "./mcp-envelope.js";
import { memoryToolSchemas, type MemoryToolName } from "./schemas.js";
import { makeProgressCallback, type ProgressLikeExtra } from "./progress-callback.js";
import { buildRequestContext, type RequestContext } from "../request-context.js";

export type MemoryToolHandler = (input: unknown, extra?: HandlerExtra) => Promise<CallToolResult>;
export type MemoryToolHandlers = Record<MemoryToolName, MemoryToolHandler>;

/**
 * The wire-level tool list. Order matters because some
 * clients render tools in registration order; the Stage 9
 * tools stay first, the Stage 12 PR9 additions follow. The
 * `memoryToolNames` array is the source of truth used by
 * `registerMemoryTools` and the test that asserts every
 * tool is registered.
 */
export const memoryToolNames = [
  // Stage 1-9: original twelve tools.
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
  // Stage 12 PR9: new tools (spec § 6.2, § 6.3, § 6.4).
  "plan_maintenance",
  "apply_maintenance",
  "explain_recall",
  "list_backups"
] as const satisfies readonly MemoryToolName[];

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
  if (input.memory_id !== undefined && input.id !== undefined && input.memory_id !== input.id) {
    throw new Error("memory_id and id must match when both are provided");
  }
  const memoryId = input.memory_id ?? input.id;
  if (memoryId === undefined) {
    throw new Error("memory_id or id is required");
  }
  return memoryId;
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

/**
 * Detect the `Result<T, E>` shape produced by the service
 * layer. Returns `undefined` for non-Result values (so the
 * caller treats them as success data).
 */
function asResultFailure(
  value: unknown
): { code: string; message: string; details?: Record<string, unknown> } | undefined {
  if (!isRecord(value)) return undefined;
  if (value.ok !== false) return undefined;
  if (typeof value.error !== "string" || typeof value.message !== "string") return undefined;
  const details = isRecord(value.details) ? value.details : undefined;
  return details === undefined
    ? { code: value.error, message: value.message }
    : { code: value.error, message: value.message, details };
}

/**
 * Detect a *successful* `Result<T, E>` shape. Used to
 * unwrap `.value` before publishing the inner T as the
 * v2 envelope's `data` field.
 */
function isResultSuccess(value: unknown): value is { ok: true; value: unknown } {
  if (!isRecord(value)) return false;
  if (value.ok !== true) return false;
  return "value" in value;
}

/**
 * Wrap a raw inner handler so its result becomes a
 * v2-envelope `CallToolResult`. The inner handler is
 * expected to return either:
 *   - a string (for text/markdown tools, e.g. recall_context,
 *     export_memory_context);
 *   - a `Result<T, E>` (for structured JSON tools that may
 *     fail with a typed error code);
 *   - a plain object (for read tools like list_memories).
 *
 * The function preserves the inner handler's text content
 * byte-for-byte and only adds `structuredContent` /
 * `isError` on top. The v2 client can then read either
 * `content[0].text` (legacy) or `structuredContent` (new).
 */
type HandlerExtra = {
  signal: AbortSignal;
  sendNotification: (notification: ServerNotification) => Promise<void>;
  _meta?: { progressToken?: string | number };
};

/**
 * Adapt a `ProgressCallback` (signature `(processed,
 * message?)`) into the service's `(processed, total)`
 * shape, so we can plug the MCP progress hook into the
 * long-running maintenance paths without changing the
 * existing service contracts.
 *
 * Returns `undefined` when no extra was provided, so the
 * caller can use the spread-trick without conditional
 * type gymnastics.
 */
function adaptProgress(
  extra: HandlerExtra | undefined,
  label: string
): ((processed: number, total: number) => void) | undefined {
  if (extra === undefined) return undefined;
  const callback = makeProgressCallback(extra as ProgressLikeExtra, { total: 100, label });
  return (processed, total) => {
    callback(processed, `stage ${label} ${processed}/${total}`);
  };
}

/**
 * Build a RequestContext from the MCP `extra` envelope. The
 * session id is stable for the lifetime of the MCP connection
 * (the SDK pins one `sessionId` per transport). The request id
 * is fresh per tool call so retried requests get a distinct
 * audit trail unless the client explicitly re-uses the same
 * JSON-RPC id (in which case the SDK forwards the same id and
 * `buildRequestContext` preserves it).
 */
function buildToolRequestContext(
  extra: HandlerExtra | undefined,
  override: { actor?: string; project_id?: string } = {}
): RequestContext {
  const meta = (extra?._meta ?? {}) as {
    clientName?: string;
    clientVersion?: string;
    sessionId?: string;
    progressToken?: string | number;
  };
  return buildRequestContext({
    ...(override.actor !== undefined ? { actor_override: override.actor } : {}),
    ...(meta.clientName !== undefined ? { client_name: meta.clientName } : {}),
    ...(meta.clientVersion !== undefined ? { client_version: meta.clientVersion } : {}),
    ...(meta.sessionId !== undefined ? { session_id: meta.sessionId } : {}),
    ...(extra !== undefined ? { tool_call_id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` } : {}),
    ...(override.project_id !== undefined ? { project_id: override.project_id } : {})
  });
}

function envelopeHandler<T>(
  toolName: MemoryToolName,
  schema: ZodType<T>,
  run: (input: T, extra: HandlerExtra | undefined, ctx: RequestContext) => unknown | Promise<unknown>
): (input: unknown, extra?: HandlerExtra) => Promise<CallToolResult> {
  return async (input: unknown, extra?: HandlerExtra) => {
    const started = Date.now();
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      const legacy: CallToolResult = jsonResult({
        ok: false,
        error: "invalid_schema",
        message: `Input does not match the ${toolName} tool schema.`,
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.map(String).join("."),
            message: issue.message
          }))
        }
      });
      return buildEnvelopeResult({
        legacyContent: legacy.content,
        failure: {
          code: "invalid_schema",
          message: `Input does not match the ${toolName} tool schema.`,
          details: {
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.map(String).join("."),
              message: issue.message
            }))
          }
        },
        durationMs: Date.now() - started
      });
    }

    // Stage 14 PR-B1: build a per-call RequestContext from the
    // MCP `extra` envelope. The actor is the resolved
    // `AGENT_RECALL_ACTOR` env / fallback; the trace fields
    // (request_id, session_id, tool_call_id, client_name,
    // client_version) are derived from the SDK envelope.
    const ctx = buildToolRequestContext(extra);

    try {
      const raw = await run(parsed.data, extra, ctx);
      const duration = Date.now() - started;
      const failure = asResultFailure(raw);
      if (failure !== undefined) {
        return buildEnvelopeResult({
          legacyContent: jsonResult(raw).content,
          failure,
          durationMs: duration
        });
      }
      // Unwrap a successful `Result<T, E>` so the v2
      // envelope's `data` field is the inner value, not the
      // `{ ok, value }` wrapper. Plain objects (read tools
      // like list_memories) pass through unchanged.
      const data = isResultSuccess(raw) ? raw.value : raw;
      return buildEnvelopeResult({
        legacyContent: jsonResult(raw).content,
        data,
        durationMs: duration
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof Error && error.name === "AbortError" ? "tool_error" : "tool_error";
      return buildEnvelopeResult({
        legacyContent: jsonResult({ ok: false, error: code, message }).content,
        failure: { code, message },
        durationMs: Date.now() - started
      });
    }
  };
}

/**
 * Same as `envelopeHandler` but the inner handler returns a
 * string (used by `recall_context` / `export_memory_context`
 * where the text payload IS the deliverable, not JSON).
 */
function textEnvelopeHandler<T>(
  toolName: MemoryToolName,
  schema: ZodType<T>,
  run: (input: T, extra: HandlerExtra | undefined, ctx: RequestContext) => string | Promise<string>
): (input: unknown, extra?: HandlerExtra) => Promise<CallToolResult> {
  return async (input: unknown, extra?: HandlerExtra) => {
    const started = Date.now();
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      const legacy: CallToolResult = jsonResult({
        ok: false,
        error: "invalid_schema",
        message: `Input does not match the ${toolName} tool schema.`,
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.map(String).join("."),
            message: issue.message
          }))
        }
      });
      return buildEnvelopeResult({
        legacyContent: legacy.content,
        failure: {
          code: "invalid_schema",
          message: `Input does not match the ${toolName} tool schema.`,
          details: {
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.map(String).join("."),
              message: issue.message
            }))
          }
        },
        durationMs: Date.now() - started
      });
    }
    // Stage 14 PR-B1: build a per-call RequestContext.
    const ctx = buildToolRequestContext(extra);
    try {
      const text = await run(parsed.data, extra, ctx);
      const legacy: CallToolResult = textResult(text);
      // For text tools the v2 success payload is the markdown
      // body wrapped under `data: { markdown }`. Clients that
      // already have the text payload can keep using it.
      return buildEnvelopeResult({
        legacyContent: legacy.content,
        data: { markdown: text },
        durationMs: Date.now() - started
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return buildEnvelopeResult({
        legacyContent: jsonResult({ ok: false, error: "tool_error", message }).content,
        failure: { code: "tool_error", message },
        durationMs: Date.now() - started
      });
    }
  };
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

export function createMemoryToolHandlers(service: MemoryService): MemoryToolHandlers {
  return {
    recall_context: textEnvelopeHandler("recall_context", memoryToolSchemas.recall_context, (input, _extra, ctx) =>
      service.exportMemoryContext(serviceInput<Parameters<MemoryService["exportMemoryContext"]>[0]>(input), ctx)
    ),
    remember: envelopeHandler("remember", memoryToolSchemas.remember, (input, _extra, ctx) =>
      service.remember(serviceInput<Parameters<MemoryService["remember"]>[0]>(input), ctx)
    ),
    search_memories: envelopeHandler("search_memories", memoryToolSchemas.search_memories, (input) =>
      service.searchMemories(serviceInput<Parameters<MemoryService["searchMemories"]>[0]>(input))
    ),
    get_memory: envelopeHandler("get_memory", memoryToolSchemas.get_memory, (input) => {
      const memoryId = memoryIdFromInput(input);
      const accessedBy = input.accessed_by;
      return service.getMemory(memoryId, accessedBy) ?? asNotFoundMemoryResult(memoryId);
    }),
    list_memories: envelopeHandler("list_memories", memoryToolSchemas.list_memories, (input) =>
      service.listMemories(serviceInput<Parameters<MemoryService["listMemories"]>[0]>(input))
    ),
    update_memory: envelopeHandler("update_memory", memoryToolSchemas.update_memory, (input, _extra, ctx) =>
      service.updateMemory(memoryIdFromInput(input), patchFromUpdateInput(input), ctx)
    ),
    supersede_memory: envelopeHandler("supersede_memory", memoryToolSchemas.supersede_memory, (input, _extra, ctx) =>
      service.supersedeMemory(serviceInput<Parameters<MemoryService["supersedeMemory"]>[0]>(input), ctx)
    ),
    merge_memories: envelopeHandler("merge_memories", memoryToolSchemas.merge_memories, (input, _extra, ctx) =>
      service.mergeMemories(serviceInput<Parameters<MemoryService["mergeMemories"]>[0]>(input), ctx)
    ),
    forget_memory: envelopeHandler("forget_memory", memoryToolSchemas.forget_memory, (input, _extra, ctx) =>
      service.forgetMemory(memoryIdFromInput(input), input.reason, ctx)
    ),
    get_memory_budget: envelopeHandler("get_memory_budget", memoryToolSchemas.get_memory_budget, (input) =>
      service.getMemoryBudget(serviceInput<Parameters<MemoryService["getMemoryBudget"]>[0]>(input))
    ),
    maintain_memories: envelopeHandler("maintain_memories", memoryToolSchemas.maintain_memories, (input, extra, ctx) => {
      const progress = adaptProgress(extra, "maintain_memories");
      return service.maintainMemories({
        ...serviceInput<Parameters<MemoryService["maintainMemories"]>[0]>(input),
        ...(progress !== undefined ? { onProgress: progress } : {})
      }, ctx);
    }),
    export_memory_context: textEnvelopeHandler("export_memory_context", memoryToolSchemas.export_memory_context, (input, _extra, ctx) =>
      service.exportMemoryContext(serviceInput<Parameters<MemoryService["exportMemoryContext"]>[0]>(input), ctx)
    ),
    // Stage 12 PR9: plan/apply maintenance, explain, list_backups.
    plan_maintenance: envelopeHandler("plan_maintenance", memoryToolSchemas.plan_maintenance, (input, extra) => {
      const progress = adaptProgress(extra, "plan_maintenance");
      return service.planMaintenance({
        ...serviceInput<Parameters<MemoryService["planMaintenance"]>[0]>(input),
        ...(progress !== undefined ? { onProgress: progress } : {})
      });
    }),
    apply_maintenance: envelopeHandler("apply_maintenance", memoryToolSchemas.apply_maintenance, (input) =>
      service.applyMaintenance(serviceInput<Parameters<MemoryService["applyMaintenance"]>[0]>(input))
    ),
    explain_recall: envelopeHandler("explain_recall", memoryToolSchemas.explain_recall, (input) =>
      service.explainRecall(serviceInput<Parameters<MemoryService["explainRecall"]>[0]>(input))
    ),
    list_backups: envelopeHandler("list_backups", memoryToolSchemas.list_backups, (input) =>
      service.listBackups()
    )
  };
}

// ============================================================
// Tool annotations (spec § 6.3) and output schemas.
// ============================================================

const ANNOTATIONS: Record<MemoryToolName, { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean }> = {
  recall_context: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  remember: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  search_memories: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  get_memory: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  list_memories: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  update_memory: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  supersede_memory: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  merge_memories: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  forget_memory: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  get_memory_budget: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  maintain_memories: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  export_memory_context: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  plan_maintenance: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  apply_maintenance: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  explain_recall: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  list_backups: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
};

// Output schemas. We use a permissive `z.unknown()` for the
// inner `data` because the service layer returns a
// heterogeneous set of shapes. The MCP v2 spec says the
// outputSchema is a "best effort" description; the SDK
// forwards it to clients that want to validate. The actual
// validation lives in the per-tool handler — these
// schemas are for documentation/discovery.
function makeOutputSchema<T>(dataSchema: z.ZodType<T>) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
    meta: z.object({
      request_id: z.string(),
      server_version: z.string(),
      schema_version: z.number().int(),
      duration_ms: z.number().int().nonnegative()
    })
  });
}

function makeFailureSchema() {
  return z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
      details: z.record(z.string(), z.unknown()).optional()
    }),
    meta: z.object({
      request_id: z.string(),
      server_version: z.string(),
      schema_version: z.number().int(),
      duration_ms: z.number().int().nonnegative()
    })
  });
}

function makeEnvelopeSchema<T>(dataSchema: z.ZodType<T>) {
  return z.union([makeOutputSchema(dataSchema), makeFailureSchema()]);
}

const GENERIC_OUTPUT_SCHEMA = makeEnvelopeSchema(z.unknown());

type MemoryToolServer = {
  registerTool(
    name: string,
    config: {
      description?: string;
      inputSchema?: ZodType;
      outputSchema?: ZodType;
      annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
    },
    cb: (input: unknown) => Promise<CallToolResult>
  ): unknown;
};

export function registerMemoryTools(server: MemoryToolServer, service: MemoryService): void {
  const handlers = createMemoryToolHandlers(service);

  for (const name of memoryToolNames) {
    server.registerTool(
      name,
      {
        description: memoryToolDescriptions[name],
        inputSchema: memoryToolSchemas[name],
        outputSchema: GENERIC_OUTPUT_SCHEMA,
        annotations: ANNOTATIONS[name]
      },
      async (input: unknown) => handlers[name](input)
    );
  }
}

// Re-exports kept stable so external test files keep
// working.
export { errorCategory, isStableErrorCode } from "./error-codes.js";
export type { StableErrorCode } from "./error-codes.js";
export type { ToolEnvelope, ToolSuccessEnvelope, ToolFailureEnvelope } from "./mcp-envelope.js";
