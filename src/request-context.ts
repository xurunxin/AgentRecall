// src/request-context.ts
//
// Stage 14 PR-B1 (spec § 5.2 AR-P0-002): the per-call
// RequestContext that flows from the MCP transport / CLI
// dispatch into the service layer and ultimately into every
// audit event the request produces.
//
// Pre-PR-B1 the audit `actor` field was sourced from a
// process-wide `defaultActor` resolved once at MCP-server
// startup. Two different MCP clients (or two CLI invocations)
// sharing the same process were indistinguishable in the
// audit log. Post-PR-B1 every audit event carries:
//
//   - actor_id  (the calling client / user / system actor)
//   - request_id  (UUID per tool call; tie-breaks retried
//                   request batches)
//   - session_id  (UUID per MCP session; lets the audit
//                   consumer group requests by client
//                   lifecycle)
//   - tool_call_id  (the MCP `callId` from the request envelope)
//   - client_name / client_version  (from the MCP
//                   `initialize` handshake; persisted so the
//                   consumer can correlate behaviour changes
//                   across client versions)
//   - project_id  (only for project-scoped calls; used for
//                   the spec § 5.2 scope-conflict check)
//
// The `RequestContext` is **not** persisted as a single
// column. Audit events write the fields they need into the
// existing `metadata_json` blob under well-known keys
// (`request_id`, `session_id`, `tool_call_id`, `client_name`,
// `client_version`). A future PR can promote them to first-
// class columns without breaking this contract.

import { randomUUID } from "node:crypto";
import type { ActorId } from "./actor.js";
import { resolveActor } from "./actor.js";

export type RequestContext = {
  /** The structured actor (e.g. `agent:claude-code`). */
  actor_id: ActorId;
  /** MCP `clientInfo.name` from the initialize handshake. */
  client_name?: string;
  /** MCP `clientInfo.version` from the initialize handshake. */
  client_version?: string;
  /** Stable across an MCP session, fresh per process restart. */
  session_id?: string;
  /** UUID per tool call. Drives idempotency keys and audit
   *  correlation across retries. */
  request_id: string;
  /** MCP `callId` (the JSON-RPC id for this call). */
  tool_call_id?: string;
  /** Resolved project_id, when the call is project-scoped. */
  project_id?: string;
};

/**
 * Build a RequestContext from an MCP tool-call `extra` object.
 * The `extra._meta` field carries the MCP `clientInfo` and
 * the JSON-RPC `id`; the `extra.signal` is the AbortSignal.
 * Falls back to a process-wide context when fields are
 * missing.
 */
export function buildRequestContext(input: {
  actor_override?: string;
  client_name?: string;
  client_version?: string;
  session_id?: string;
  request_id?: string;
  tool_call_id?: string;
  project_id?: string;
  env?: NodeJS.ProcessEnv;
}): RequestContext {
  const ctx: RequestContext = {
    actor_id: resolveActor(input.actor_override, input.env),
    request_id: input.request_id ?? randomUUID()
  };
  if (input.client_name !== undefined) ctx.client_name = input.client_name;
  if (input.client_version !== undefined) ctx.client_version = input.client_version;
  if (input.session_id !== undefined) ctx.session_id = input.session_id;
  if (input.tool_call_id !== undefined) ctx.tool_call_id = input.tool_call_id;
  if (input.project_id !== undefined) ctx.project_id = input.project_id;
  return ctx;
}

/**
 * Mix the RequestContext's trace fields into an audit
 * `metadata_json` blob. The actor itself lives in the
 * `audit_events.actor` column; this helper only writes the
 * request-correlation fields. The returned object is meant to
 * be merged with the caller's own metadata.
 *
 * The keys are stable and documented; the audit consumer can
 * rely on them.
 */
export function traceMetadata(ctx: RequestContext): Record<string, string> {
  const out: Record<string, string> = { request_id: ctx.request_id };
  if (ctx.session_id !== undefined) out.session_id = ctx.session_id;
  if (ctx.tool_call_id !== undefined) out.tool_call_id = ctx.tool_call_id;
  if (ctx.client_name !== undefined) out.client_name = ctx.client_name;
  if (ctx.client_version !== undefined) out.client_version = ctx.client_version;
  if (ctx.project_id !== undefined) out.project_id = ctx.project_id;
  return out;
}

/**
 * Merge the trace metadata with a caller's own metadata. The
 * caller's keys win on collision so service code can override
 * the trace fields when it has a more specific value (e.g.
 * `requested_by` is the agent that triggered a system action;
 * it's already the actor and we don't need to re-emit it).
 */
export function withTrace(
  ctx: RequestContext,
  metadata: Record<string, unknown>
): Record<string, unknown> {
  return { ...traceMetadata(ctx), ...metadata };
}
