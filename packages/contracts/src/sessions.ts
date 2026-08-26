// packages/contracts/src/sessions.ts
//
// v1.2.0-alpha.1 (issue #49): typed contracts for the
// SessionTraceBundle v1 capture surface. The schema
// here is the canonical wire shape the OpenCode
// capture adapter, the JSONL bundle CLI, and the
// future Claude Code / Codex adapters all emit. The
// on-disk shape (sessions / session_events /
// session_event_blobs) is the durable mirror of
// this contract and is wired through
// `src/sessions/service.ts`.
//
// The contract is intentionally narrow: a captured
// event is a stable record, not a live RPC
// boundary. Captured events MUST NOT be returned by
// any recall path until an explicit `apply` step
// routes them through the candidate pipeline
// (issue #50, Phase 2). The contract carries
// `sensitivity` + `redaction_flags` so a downstream
// tool can decide on its own whether to surface the
// event.

import { z } from "zod";

export const SESSION_EVENT_TYPES = [
  "session_started",
  "user_message",
  "assistant_message",
  "tool_call",
  "tool_result",
  "decision_confirmed",
  "task_completed",
  "session_ended"
] as const;

export const SESSION_REDACTION_FLAGS = [
  "contains_secret",
  "risk_injection",
  "truncated",
  "high_entropy_token",
  "policy_redacted"
] as const;

export const SESSION_SCOPES = ["global", "project"] as const;

export const SessionScopeSchema = z.enum(SESSION_SCOPES);
export const SessionEventTypeSchema = z.enum(SESSION_EVENT_TYPES);
export const SessionRedactionFlagSchema = z.enum(SESSION_REDACTION_FLAGS);

/**
 * Reference to a captured content body. The `ref`
 * points at a content-addressed local file (the
 * `session_event_blobs` row keyed by digest); the
 * `digest` is the stable identity used for dedup
 * + replay verification. When `content_inline` is
 * present the body is small enough to embed
 * directly (e.g. a short user message); the inline
 * form is the source of truth and the `ref` is a
 * derived cache.
 */
export const SessionContentRefSchema = z.object({
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  media_type: z.string().min(1),
  size_bytes: z.number().int().nonnegative(),
  ref: z.string().optional(),
  content_inline: z.string().optional()
}).refine(
  (v) => v.ref !== undefined || v.content_inline !== undefined,
  { message: "SessionContentRef requires either `ref` or `content_inline`" }
);

/**
 * Source-specific metadata namespaced under the
 * adapter. The contract does not validate the
 * inner shape because each adapter is free to
 * surface its own protocol-specific fields
 * (OpenCode lifecycle hooks, Claude Code tool
 * shapes, Codex transcript format, etc.). The
 * outer wrapper keeps the namespacing honest so
 * downstream code can branch on `adapter_id`
 * without parsing the bundle.
 */
export const SessionAdapterMetadataSchema = z.record(z.string(), z.unknown());

export const SessionTraceEventV1Schema = z.object({
  schema_version: z.literal("1"),
  // Source attribution (17 fields from the plan, all required).
  source_kind: z.string().min(1),
  source_version: z.string().min(1),
  source_instance_id: z.string().min(1),
  source_session_id: z.string().min(1),
  project_id: z.string().min(1).nullable(),
  project_path: z.string().optional(),
  actor_id: z.string().min(1),
  client_name: z.string().min(1),
  client_version: z.string().min(1),
  // Event identity.
  event_id: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  turn_id: z.string().min(1),
  event_type: SessionEventTypeSchema,
  role: z.enum(["user", "assistant", "system", "tool"]).nullable().optional(),
  // Body — either an inline short string or a
  // reference to a content-addressed blob. Exactly
  // one must be present.
  content: z.string().optional(),
  content_ref: SessionContentRefSchema.optional(),
  content_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  // Tool metadata (only set on tool_call /
  // tool_result events; ignored otherwise).
  tool_name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_status: z
    .enum(["pending", "ok", "error", "timeout", "cancelled"])
    .optional(),
  // When.
  timestamp: z.string().datetime({ offset: true }),
  // Sensitivity policy.
  sensitivity: z.enum(["normal", "private", "restricted"]),
  redaction_flags: z.array(SessionRedactionFlagSchema).default([]),
  // Adapter-specific extras.
  metadata: SessionAdapterMetadataSchema.default({})
}).refine(
  (v) => v.content !== undefined || v.content_ref !== undefined,
  { message: "SessionTraceEventV1 requires `content` or `content_ref`" }
);

/**
 * The whole bundle. `events` is the ordered
 * capture stream; `metadata` is the bundle-level
 * envelope (mostly source identity + a few derived
 * facts). Adapters emit this and the ingester
 * persists it as one `sessions` row + N
 * `session_events` rows.
 */
export const SessionTraceBundleV1Schema = z.object({
  schema_version: z.literal("1"),
  bundle_id: z.string().min(1),
  // The source_session_id is the *upstream* identity
  // (e.g. OpenCode session id, Claude Code session
  // id); the agentrecall session row gets its own
  // `session_id` (UUIDv4) at ingest time. The pair
  // is unique on (source_kind, source_version,
  // source_instance_id, source_session_id) so a
  // replay is detectable.
  source_kind: z.string().min(1),
  source_version: z.string().min(1),
  source_instance_id: z.string().min(1),
  source_session_id: z.string().min(1),
  project_id: z.string().min(1).nullable(),
  actor_id: z.string().min(1),
  client_name: z.string().min(1),
  client_version: z.string().min(1),
  scope: SessionScopeSchema,
  sensitivity: z.enum(["normal", "private", "restricted"]),
  started_at: z.string().datetime({ offset: true }),
  ended_at: z.string().datetime({ offset: true }).nullable().optional(),
  adapter_id: z.string().min(1),
  adapter_version: z.string().min(1),
  // Ingestion plan is filled by the agentrecall
  // ingester, not by the adapter. The field is
  // optional in the bundle so the wire shape is
  // adapter-friendly.
  ingestion_plan: z
    .object({
      accepted: z.number().int().nonnegative(),
      redacted: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      rejected: z.number().int().nonnegative(),
      notes: z.string().optional()
    })
    .optional(),
  // A bundle header MAY carry no events when
  // the JSONL stream is the canonical wire
  // format (line 1 = header, lines 2+ = event
  // lines). The service still requires at least
  // one event overall, but the schema is
  // permissive here so the adapter can validate
  // the header without lying.
  events: z.array(SessionTraceEventV1Schema).default([])
});

/**
 * The read shape returned by `inspect`. The
 * session row is the agentrecall internal id +
 * the source identity. `ingestion_summary` is a
 * compact digest of the per-event plan.
 */
export const SessionInspectionV1Schema = z.object({
  schema_version: z.literal("1"),
  session_id: z.string().min(1),
  source_kind: z.string().min(1),
  source_version: z.string().min(1),
  source_instance_id: z.string().min(1),
  source_session_id: z.string().min(1),
  project_id: z.string().min(1).nullable(),
  actor_id: z.string().min(1),
  client_name: z.string().min(1),
  client_version: z.string().min(1),
  scope: SessionScopeSchema,
  sensitivity: z.enum(["normal", "private", "restricted"]),
  bundle_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  adapter_id: z.string().min(1),
  adapter_version: z.string().min(1),
  ingestion_plan: z.object({
    accepted: z.number().int().nonnegative(),
    redacted: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    notes: z.string().optional()
  }),
  started_at: z.string().datetime({ offset: true }),
  ended_at: z.string().datetime({ offset: true }).nullable(),
  ingested_at: z.string().datetime({ offset: true }),
  retention_until: z.string().datetime({ offset: true }).nullable(),
  event_count: z.number().int().nonnegative()
});

/**
 * The MCP / wire surface for a single session
 * event. The `content_digest` is the stable
 * identity; the body is **never** inlined in this
 * surface (the MCP / wire is for inspection /
 * lineage, not for prompt injection).
 */
export const SessionEventInspectionV1Schema = z.object({
  schema_version: z.literal("1"),
  event_id: z.string().min(1),
  session_id: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  turn_id: z.string().min(1),
  event_type: SessionEventTypeSchema,
  role: z.enum(["user", "assistant", "system", "tool"]).nullable(),
  tool_name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_status: z
    .enum(["pending", "ok", "error", "timeout", "cancelled"])
    .optional(),
  content_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  content_blob_ref: z.string().nullable(),
  timestamp: z.string().datetime({ offset: true }),
  sensitivity: z.enum(["normal", "private", "restricted"]),
  redaction_flags: z.array(SessionRedactionFlagSchema),
  metadata: SessionAdapterMetadataSchema
});

export const SessionListV1Schema = z.object({
  schema_version: z.literal("1"),
  sessions: z.array(SessionInspectionV1Schema)
});

export const SessionIngestResultV1Schema = z.object({
  schema_version: z.literal("1"),
  session_id: z.string().min(1),
  bundle_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  replayed: z.boolean(),
  ingestion_plan: z.object({
    accepted: z.number().int().nonnegative(),
    redacted: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative()
  })
});

export type SessionTraceEventV1 = z.infer<typeof SessionTraceEventV1Schema>;
export type SessionTraceBundleV1 = z.infer<typeof SessionTraceBundleV1Schema>;
export type SessionInspectionV1 = z.infer<typeof SessionInspectionV1Schema>;
export type SessionEventInspectionV1 = z.infer<typeof SessionEventInspectionV1Schema>;
export type SessionListV1 = z.infer<typeof SessionListV1Schema>;
export type SessionIngestResultV1 = z.infer<typeof SessionIngestResultV1Schema>;
export type SessionContentRef = z.infer<typeof SessionContentRefSchema>;
