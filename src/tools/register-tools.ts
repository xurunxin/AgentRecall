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
  "list_backups",
  // Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4):
  // memory semantics MCP tools. By default these
  // are in the `extended` profile (PR-7 also
  // adds a `core` / `extended` profile split);
  // the public `registerMemoryTools(server, ...)`
  // helper still registers every tool so the
  // `p3-mcp-tool-annotations.test.ts` assertion
  // continues to pass. The profile split is
  // applied at the per-server `registerCoreTools`
  // / `registerExtendedTools` boundary.
  "record_memory_feedback",
  "record_memory_provenance",
  "explain_memory_provenance",
  "confirm_memory_trust"
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
  /**
   * The MCP transport session id (stable across the
   * connection). The SDK pins one per transport.
   */
  sessionId?: string;
  /**
   * The JSON-RPC id of the request. Stage 16 v1.1.1 PR-1
   * (#11) reads this as the trusted `tool_call_id` in the
   * resulting `RequestContext` so audit metadata is
   * correlatable to the original request.
   */
  requestId?: string | number;
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
 *
 * Stage 16 v1.1.1 PR-1 (#11): prefer the SDK's real
 * `extra.requestId` (the JSON-RPC id) as the `tool_call_id`
 * whenever the SDK exposes it. The pre-PR-1 implementation
 * synthesised a fake `${Date.now()}-${Math.random()...}` id,
 * which made audit trails unlinkable to the original MCP
 * request. Falls back to the existing `randomUUID()` default
 * in `buildRequestContext` when the SDK exposes no id (direct
 * handler tests, in-process unit tests).
 *
 * Stage 16 v1.1.1 PR-1 (#11): the legacy `_meta.clientName` /
 * `_meta.clientVersion` extraction is removed — `clientInfo`
 * arrives once at the `initialize` handshake and is not part
 * of the per-call `extra` envelope (it is server-session
 * state, not request metadata). Callers that need the
 * client name / version should resolve them at the server
 * level (`server.getClientVersion()`) before forwarding the
 * per-call context.
 */
function buildToolRequestContext(
  extra: HandlerExtra | undefined,
  override: { actor?: string; project_id?: string; client_name?: string; client_version?: string } = {}
): RequestContext {
  return buildRequestContext({
    ...(override.actor !== undefined ? { actor_override: override.actor } : {}),
    ...(override.client_name !== undefined ? { client_name: override.client_name } : {}),
    ...(override.client_version !== undefined ? { client_version: override.client_version } : {}),
    ...(extra?.sessionId !== undefined ? { session_id: extra.sessionId } : {}),
    ...(extra?.requestId !== undefined ? { tool_call_id: String(extra.requestId) } : {}),
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
    // Stage 16 v1.1.1 PR-1 (#11): if the client has
    // already aborted the request before we even started
    // parsing, surface a stable `cancelled` error code
    // instead of running the work and risking a partial
    // mutation. The MCP SDK forwards the
    // `AbortSignal` via `extra.signal`; clients cancel
    // by flipping it to aborted.
    if (Boolean(extra?.signal?.aborted)) {
      return buildEnvelopeResult({
        legacyContent: jsonResult({
          ok: false,
          error: "cancelled",
          message: `Request for ${toolName} was cancelled before it started.`
        }).content,
        failure: {
          code: "cancelled",
          message: `Request for ${toolName} was cancelled before it started.`
        },
        durationMs: Date.now() - started
      });
    }
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
      // Stage 16 v1.1.1 PR-1 (#11): an `AbortError` (or any
      // error raised while the AbortSignal is already
      // aborted) is a stable `cancelled` failure, not a
      // generic `tool_error`. Clients key off the code to
      // distinguish "user cancelled" from "server
      // exploded".
      const wasAborted =
        (error instanceof Error && error.name === "AbortError") ||
        Boolean(extra?.signal?.aborted);
      const code = wasAborted ? "cancelled" : "tool_error";
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
    // Stage 16 v1.1.1 PR-1 (#11): early-exit on already-
    // aborted signals so we never run the work and risk a
    // partial mutation. The SDK forwards the AbortSignal
    // via `extra.signal`.
    if (Boolean(extra?.signal?.aborted)) {
      return buildEnvelopeResult({
        legacyContent: jsonResult({
          ok: false,
          error: "cancelled",
          message: `Request for ${toolName} was cancelled before it started.`
        }).content,
        failure: {
          code: "cancelled",
          message: `Request for ${toolName} was cancelled before it started.`
        },
        durationMs: Date.now() - started
      });
    }
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
      // Stage 16 v1.1.1 PR-1 (#11): stable `cancelled`
      // failure for `AbortError` or any error raised while
      // the signal is already aborted.
      const wasAborted =
        (error instanceof Error && error.name === "AbortError") ||
        Boolean(extra?.signal?.aborted);
      const code = wasAborted ? "cancelled" : "tool_error";
      return buildEnvelopeResult({
        legacyContent: jsonResult({ ok: false, error: code, message }).content,
        failure: { code, message },
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
    remember: envelopeHandler("remember", memoryToolSchemas.remember, (input, _extra, ctx) => {
      const result = service.remember(serviceInput<Parameters<MemoryService["remember"]>[0]>(input), ctx);
      // Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4):
      // auto-capture provenance. Every successful
      // `remember` writes a `tool_call` link so the
      // `explain_memory_provenance` tool can show the
      // full chain back to the MCP call. The link
      // uses the SDK's `requestId` (per PR-1 #11);
      // a repeat call with the same `requestId` is a
      // no-op (the table's PRIMARY KEY is
      // `(memory_id, source_kind, source_ref)`).
      if (result.ok && ctx?.tool_call_id !== undefined) {
        service.recordProvenance({
          memory_id: result.value.memory_id,
          source_kind: "tool_call",
          source_ref: ctx.tool_call_id,
          actor_id: ctx.actor_id
        });
      }
      return result;
    }),
    search_memories: envelopeHandler("search_memories", memoryToolSchemas.search_memories, (input) =>
      service.searchMemories(serviceInput<Parameters<MemoryService["searchMemories"]>[0]>(input))
    ),
    get_memory: envelopeHandler("get_memory", memoryToolSchemas.get_memory, (input) => {
      const memoryId = memoryIdFromInput(input);
      // Stage 16 v1.1.1 PR-1 (#11): `get_memory` is now a
      // pure read. Client-supplied `accessed_by` is ignored;
      // access identity comes from the trusted
      // `RequestContext` actor. If a caller wants to record
      // access (e.g. `recall_context` selection), they must
      // do it explicitly through the `record_memory_feedback`
      // tool (PR-7) or the `recordAccess` store API. The
      // schema keeps `accessed_by` as a deprecated alias for
      // one release cycle so existing clients keep parsing
      // without errors; the value is dropped here.
      void input.accessed_by;
      return service.getMemory(memoryId) ?? asNotFoundMemoryResult(memoryId);
    }),
    list_memories: envelopeHandler("list_memories", memoryToolSchemas.list_memories, (input) =>
      service.listMemories(serviceInput<Parameters<MemoryService["listMemories"]>[0]>(input))
    ),
    update_memory: envelopeHandler("update_memory", memoryToolSchemas.update_memory, (input, _extra, ctx) => {
      // Stage 15 PR-M0-2 (issue #2, spec § 5.6): forward
      // `idempotency_key` and `expected_revision` through
      // the adapter. `patchFromUpdateInput` only extracts
      // the patchable fields; the CAS / idempotency fields
      // must be merged in here so the service's
      // `checkIdempotency` and CAS guards see them.
      const patch = patchFromUpdateInput(input);
      const casFields: { idempotency_key?: string; expected_revision?: number } = {};
      if (input.idempotency_key !== undefined) casFields.idempotency_key = input.idempotency_key;
      if (input.expected_revision !== undefined) casFields.expected_revision = input.expected_revision;
      return service.updateMemory(
        memoryIdFromInput(input),
        Object.keys(casFields).length === 0 ? patch : { ...patch, ...casFields },
        ctx
      );
    }),
    supersede_memory: envelopeHandler("supersede_memory", memoryToolSchemas.supersede_memory, (input, _extra, ctx) =>
      service.supersedeMemory(serviceInput<Parameters<MemoryService["supersedeMemory"]>[0]>(input), ctx)
    ),
    merge_memories: envelopeHandler("merge_memories", memoryToolSchemas.merge_memories, (input, _extra, ctx) =>
      service.mergeMemories(serviceInput<Parameters<MemoryService["mergeMemories"]>[0]>(input), ctx)
    ),
    forget_memory: envelopeHandler("forget_memory", memoryToolSchemas.forget_memory, (input, _extra, ctx) => {
      // Stage 15 PR-M0-2 (issue #2, spec § 5.6): the
      // `forget_memory` schema accepts `idempotency_key`
      // and `expected_revision` (Stage 14 PR-B2), but
      // the v1 adapter dropped both fields. Forward
      // them to the service so CAS + idempotency are
      // usable through MCP, matching the direct service
      // test behaviour. Only pass the `options` arg
      // when at least one CAS / idempotency field is
      // set — the service's signature is
      // `forgetMemory(id, reason, ctx, options?)` and
      // a missing-options call must remain 3-arg for
      // the existing test contract (vi.fn's
      // `toHaveBeenCalledWith` checks arg count).
      const casFields: { idempotency_key?: string; expected_revision?: number } = {};
      if (input.idempotency_key !== undefined) casFields.idempotency_key = input.idempotency_key;
      if (input.expected_revision !== undefined) casFields.expected_revision = input.expected_revision;
      if (Object.keys(casFields).length === 0) {
        return service.forgetMemory(
          memoryIdFromInput(input),
          input.reason,
          ctx
        );
      }
      return service.forgetMemory(
        memoryIdFromInput(input),
        input.reason,
        ctx,
        casFields
      );
    }),
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
    ),
    // Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4):
    // the four memory-semantics tools. Each one
    // delegates to a service helper and forwards the
    // `RequestContext.actor_id` (not a client-supplied
    // identity) so a tool caller cannot impersonate
    // another actor.
    record_memory_feedback: envelopeHandler(
      "record_memory_feedback",
      memoryToolSchemas.record_memory_feedback,
      (input, _extra, ctx) => {
        const memoryId = memoryIdFromInput(input);
        // Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4):
        // the actor identity comes from the trusted
        // `RequestContext` (PR-1 #11). A client cannot
        // override it through tool input.
        return service.recordFeedback({
          memory_id: memoryId,
          kind: input.kind,
          actor_id: ctx?.actor_id
        });
      }
    ),
    record_memory_provenance: envelopeHandler(
      "record_memory_provenance",
      memoryToolSchemas.record_memory_provenance,
      (input, _extra, ctx) =>
        service.recordProvenance({
          memory_id: memoryIdFromInput(input),
          source_kind: input.source_kind,
          source_ref: input.source_ref,
          actor_id: ctx?.actor_id
        })
    ),
    explain_memory_provenance: envelopeHandler(
      "explain_memory_provenance",
      memoryToolSchemas.explain_memory_provenance,
      (input) => {
        const memoryId = memoryIdFromInput(input);
        const explanation = service.explainProvenance(memoryId);
        if ("ok" in explanation) {
          return explanation;
        }
        // Successful path: render the summary as the
        // tool payload so an MCP client can show it
        // verbatim.
        return { ok: true, value: explanation };
      }
    ),
    confirm_memory_trust: envelopeHandler(
      "confirm_memory_trust",
      memoryToolSchemas.confirm_memory_trust,
      (input, _extra, ctx) =>
        service.confirmMemoryTrust({
          memory_id: memoryIdFromInput(input),
          trust_level: input.trust_level,
          user_confirmed: true,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          actor_id: ctx?.actor_id
        })
    )
  };
}

// ============================================================
// Tool annotations (spec § 6.3) and output schemas.
// ============================================================

/**
 * Stage 16 v1.1.1 PR-1 (#11) — annotation truth table.
 *
 * The pre-PR-1 matrix marked every mutating tool as
 * `idempotentHint: true`, but that is only true when the
 * caller supplies an `idempotency_key`. Without the key,
 * two `remember` calls with the same body create two
 * memories; two `forget_memory` calls with the same id
 * return the second one as a no-op only because the entry
 * is already gone (not because the call is genuinely
 * idempotent at the protocol level).
 *
 * The honest static annotation is therefore
 * `idempotentHint: false` for every tool that mutates
 * unless it is the call site that has to opt in. The
 * exception is `get_memory` (now genuinely read-only
 * post-PR-1) and the read-only helpers
 * (`search_memories`, `list_memories`, `get_memory_budget`,
 * `explain_recall`, `list_backups`, `recall_context`,
 * `export_memory_context`, `plan_maintenance`).
 *
 * Clients that want true idempotency pass an
 * `idempotency_key`; the v2 reservation in PR-3 enforces
 * the no-side-effect replay for those calls.
 */
const ANNOTATIONS: Record<MemoryToolName, { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean }> = {
  recall_context: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  remember: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  search_memories: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  get_memory: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  list_memories: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  update_memory: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  supersede_memory: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  merge_memories: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  forget_memory: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  get_memory_budget: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  maintain_memories: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  export_memory_context: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  plan_maintenance: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  apply_maintenance: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  explain_recall: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  list_backups: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  // Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4):
  // the four new memory-semantics tools. None are
  // idempotent (a repeat `record_memory_feedback`
  // is a new row, not a replay) and none are
  // destructive (they don't touch the memory
  // body). `record_memory_provenance` and
  // `record_memory_feedback` are non-destructive
  // writes; `confirm_memory_trust` mutates the
  // `trust_level` column; `explain_memory_provenance`
  // is a pure read.
  record_memory_feedback: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  record_memory_provenance: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  explain_memory_provenance: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  confirm_memory_trust: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
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
  // Stage 16 v1.1.1 PR-8 (issue #16, spec § 11.2):
  // the v1.1.0 envelope used `z.union([ok, fail])`
  // which tripped an MCP SDK / Zod v4 compatibility
  // bug (`Cannot read properties of undefined
  // (reading '_zod')`) on tool dispatch. The MCP
  // SDK's `validateToolOutput` calls
  // `normalizeObjectSchema` on the registered
  // `outputSchema`; the union is not an object and
  // returns `undefined`, so the SDK then attempts
  // to call `safeParseAsync(undefined, ...)` which
  // throws. PR-8 flattens to a single `ok: boolean`
  // schema with the success `data` field made
  // optional; the SDK treats it as an object
  // schema and the validation succeeds for every
  // tool. The actual error / success discrimination
  // is the responsibility of the handler envelope
  // (`buildEnvelopeResult`); the `outputSchema` is
  // documentation only.
  return z.object({
    ok: z.boolean(),
    data: dataSchema.optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        retryable: z.boolean().optional(),
        details: z.record(z.string(), z.unknown()).optional()
      })
      .optional(),
    meta: z.object({
      request_id: z.string(),
      server_version: z.string(),
      schema_version: z.number().int(),
      duration_ms: z.number().int().nonnegative()
    })
  });
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
    // Stage 16 v1.1.1 PR-1 (#11): the SDK's `registerTool`
    // callback receives `(input, extra)`. The `extra` is
    // forwarded to the inner handler so the trusted
    // `RequestContext` (session id, JSON-RPC request id,
    // cancellation signal) survives the registration hop.
    // Pre-PR-1 the wrapper dropped `extra` here, which forced
    // the inner handler to rely on process-wide defaults.
    cb: (input: unknown, extra: unknown) => Promise<CallToolResult>
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
      // Stage 16 v1.1.1 PR-1 (#11): forward the SDK `extra`
      // argument end-to-end so the registered callback receives
      // the real client / session / cancellation / progress
      // context that the inner handler can use to build a
      // trusted `RequestContext`. Pre-PR-1 the wrapper dropped
      // `extra` here, which made the inner handler rely on
      // process-wide defaults and forced the
      // `buildToolRequestContext` to fabricate a `tool_call_id`
      // from `Date.now()` + `Math.random()`.
      async (input: unknown, extra: unknown) => handlers[name](input, extra as HandlerExtra | undefined)
    );
  }
}

/**
 * Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4):
 * tool profile split. A `core` profile is what
 * the default packaged server registers; an
 * `extended` profile adds the four memory-semantics
 * tools (record_memory_feedback,
 * record_memory_provenance,
 * explain_memory_provenance, confirm_memory_trust)
 * plus the administrative tools (maintain_memories,
 * plan_maintenance, apply_maintenance, merge_memories,
 * supersede_memory, export_memory_context).
 *
 * The split exists so a normal coding agent isn't
 * overloaded with administrative tools it should not
 * call. The MCP server starts in the `core` profile
 * by default; the `extended` profile is enabled via
 * the `AGENT_RECALL_PROFILE=extended` env var (or a
 * `--profile=extended` CLI flag, wired at the
 * `bin/agent-recall.ts` entry point).
 */
export const CORE_TOOL_NAMES: readonly MemoryToolName[] = [
  "recall_context",
  "remember",
  "search_memories",
  "get_memory",
  "list_memories",
  "update_memory",
  "forget_memory",
  "get_memory_budget",
  "explain_recall",
  "list_backups"
];

export const EXTENDED_TOOL_NAMES: readonly MemoryToolName[] = memoryToolNames.filter(
  (name) => !CORE_TOOL_NAMES.includes(name)
);

export function registerCoreTools(server: MemoryToolServer, service: MemoryService): void {
  const handlers = createMemoryToolHandlers(service);
  for (const name of CORE_TOOL_NAMES) {
    server.registerTool(
      name,
      {
        description: memoryToolDescriptions[name],
        inputSchema: memoryToolSchemas[name],
        outputSchema: GENERIC_OUTPUT_SCHEMA,
        annotations: ANNOTATIONS[name]
      },
      async (input: unknown, extra: unknown) => handlers[name](input, extra as HandlerExtra | undefined)
    );
  }
}

export function registerExtendedTools(server: MemoryToolServer, service: MemoryService): void {
  const handlers = createMemoryToolHandlers(service);
  for (const name of EXTENDED_TOOL_NAMES) {
    server.registerTool(
      name,
      {
        description: memoryToolDescriptions[name],
        inputSchema: memoryToolSchemas[name],
        outputSchema: GENERIC_OUTPUT_SCHEMA,
        annotations: ANNOTATIONS[name]
      },
      async (input: unknown, extra: unknown) => handlers[name](input, extra as HandlerExtra | undefined)
    );
  }
}

// Re-exports kept stable so external test files keep
// working.
export { errorCategory, isStableErrorCode } from "./error-codes.js";
export type { StableErrorCode } from "./error-codes.js";
export type { ToolEnvelope, ToolSuccessEnvelope, ToolFailureEnvelope } from "./mcp-envelope.js";
