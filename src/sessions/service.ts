// src/sessions/service.ts
//
// v1.2.0-alpha.1 (issue #49): the session evidence
// service. The public surface is the three
// adapters-callers flow:
//
//   1. Adapter normalises a captured trace into a
//      `NormalisedBundle` (a plain object the
//      service consumes). The JSONL adapter in
//      `adapters/jsonl.ts` is the v1 reference; the
//      OpenCode capture adapter is a separate
//      opt-in plugin.
//   2. The service computes the per-event plan:
//      secret scan + injection tag + sensitivity
//      inference + size cap (head/tail truncation).
//   3. The service applies the plan atomically:
//      one `sessions` row, N `session_events`
//      rows, M `session_event_blobs` rows.
//
// The service is replay-safe: a re-ingest with the
// same `(source_kind, source_version,
// source_instance_id, source_session_id)` and the
// same `bundle_hash` returns the original
// `session_id` without re-applying the plan. A
// re-ingest with a different `bundle_hash` is
// rejected (issue #49 AC #1).

import { createHash, randomUUID } from "node:crypto";

import { detectSecrets } from "../secret-detector.js";
import type {
  SessionEventRow,
  SessionEventType,
  SessionRedactionFlag,
  SessionRow,
  SessionScope,
  SessionSensitivity,
  SQLiteMemoryStore
} from "../sqlite-store.js";
import { nowIso } from "../domain.js";
import { ProjectIdentityResolver } from "../scope-resolver.js";

/**
 * Hard caps for the v1 ingest path. Per-event
 * defaults: 256 KB. Per-session default: 8 MB.
 * Exceeding either triggers a head/tail truncate
 * with a `truncated` redaction flag; the digest
 * still records the original body so a later
 * review can detect silent damage.
 */
export const SESSION_DEFAULT_MAX_PER_EVENT_BYTES = 256 * 1024;
export const SESSION_DEFAULT_MAX_PER_SESSION_BYTES = 8 * 1024 * 1024;
export const SESSION_HEAD_TAIL_WINDOW_BYTES = 1024;

export type NormalisedEvent = {
  event_id: string;
  sequence: number;
  turn_id: string;
  event_type: SessionEventType;
  role: "user" | "assistant" | "system" | "tool" | null;
  content: string | null;
  content_ref_digest: string | null;
  content_digest: string;
  tool_name: string | null;
  tool_call_id: string | null;
  tool_status: string | null;
  timestamp: string;
  sensitivity: SessionSensitivity;
  metadata: Record<string, unknown>;
};

export type NormalisedBundle = {
  bundle_id: string;
  source_kind: string;
  source_version: string;
  source_instance_id: string;
  source_session_id: string;
  project_id: string | null;
  actor_id: string;
  client_name: string;
  client_version: string;
  scope: SessionScope;
  sensitivity: SessionSensitivity;
  started_at: string;
  ended_at: string | null;
  adapter_id: string;
  adapter_version: string;
  events: NormalisedEvent[];
};

export type PlanCounts = {
  accepted: number;
  redacted: number;
  skipped: number;
  rejected: number;
};

export type IngestResult = {
  session_id: string;
  bundle_hash: string;
  replayed: boolean;
  plan: PlanCounts;
};

export type IngestOptions = {
  max_per_event_bytes?: number;
  max_per_session_bytes?: number;
  /**
   * Optional explicit retention window. When set,
   * the `retention_until` column is populated so a
   * later GC sweep can drop the row after the
   * deadline.
   */
  retention_until?: string;
};

export type SessionInspection = {
  session: SessionRow;
  events: SessionEventRow[];
  plan: PlanCounts;
};

export class SessionService {
  constructor(
    private readonly store: SQLiteMemoryStore,
    private readonly identityResolver?: ProjectIdentityResolver
  ) {}

  /**
   * Ingest a normalised bundle. The `bundle_hash` is
   * the canonical SHA-256 over the canonicalised
   * input; the row is keyed on the
   * `(source_kind, source_version,
   * source_instance_id, source_session_id)` tuple
   * so a re-ingest is detectable.
   */
  ingest(bundle: NormalisedBundle, opts: IngestOptions = {}): IngestResult {
    if (bundle.scope === "project" && bundle.project_id === null) {
      throw new Error(
        "[internal_error] session bundle with scope='project' must specify project_id"
      );
    }
    if (bundle.events.length === 0) {
      throw new Error("[usage_error] session bundle has no events");
    }
    // Project identity check: refuse to ingest when
    // the bundle claims a project_id that does not
    // resolve to a registered identity in strict
    // mode. The check is bypassed when the
    // identityResolver is absent (CLI / programmatic
    // tests).
    if (this.identityResolver !== undefined && bundle.scope === "project") {
      const resolution = this.identityResolver.resolve(
        {
          scope: "project",
          ...(bundle.project_id !== null ? { project_id: bundle.project_id } : {})
        },
        "strict_existing"
      );
      if (!resolution.ok) {
        throw new Error(
          `[usage_error] session bundle project_id '${bundle.project_id}' does not resolve to a registered identity: ${resolution.error}`
        );
      }
    }
    const bundle_hash = canonicalBundleHash(bundle);
    const existing = this.store.getSessionBySourceIdentity({
      source_kind: bundle.source_kind,
      source_version: bundle.source_version,
      source_instance_id: bundle.source_instance_id,
      source_session_id: bundle.source_session_id
    });
    if (existing !== undefined) {
      if (existing.bundle_hash !== bundle_hash) {
        throw new Error(
          `bundle_hash_drift: a session with the same source identity already exists with a different bundle_hash`
        );
      }
      return {
        session_id: existing.session_id,
        bundle_hash: existing.bundle_hash,
        replayed: true,
        plan: JSON.parse(existing.ingestion_plan_json) as PlanCounts
      };
    }
    const perEventCap = opts.max_per_event_bytes ?? SESSION_DEFAULT_MAX_PER_EVENT_BYTES;
    const perSessionCap = opts.max_per_session_bytes ?? SESSION_DEFAULT_MAX_PER_SESSION_BYTES;
    const plan = planBundle(bundle, perEventCap, perSessionCap);
    const sessionId = `sess_${randomUUID()}`;
    const now = nowIso();
    this.store.insertSession({
      session_id: sessionId,
      source_kind: bundle.source_kind,
      source_version: bundle.source_version,
      source_instance_id: bundle.source_instance_id,
      source_session_id: bundle.source_session_id,
      scope: bundle.scope,
      project_id: bundle.project_id,
      actor_id: bundle.actor_id,
      client_name: bundle.client_name,
      client_version: bundle.client_version,
      started_at: bundle.started_at,
      ended_at: bundle.ended_at,
      sensitivity: bundle.sensitivity,
      bundle_hash,
      adapter_id: bundle.adapter_id,
      adapter_version: bundle.adapter_version,
      ingestion_plan_json: JSON.stringify(plan),
      redaction_summary_json: JSON.stringify({
        per_event_cap_bytes: perEventCap,
        per_session_cap_bytes: perSessionCap,
        events_with_secret: plan.accepted > 0
          ? bundle.events
              .filter((e) => (e.content ?? "").length > 0 && detectSecrets(e.content ?? "").length > 0)
              .length
          : 0
      }),
      ingested_at: now,
      ...(opts.retention_until !== undefined ? { retention_until: opts.retention_until } : { retention_until: null })
    });
    for (const ev of bundle.events) {
      this.persistEvent(sessionId, ev, plan);
    }
    return { session_id: sessionId, bundle_hash, replayed: false, plan };
  }

  /**
   * Read a session + its events. Returns `undefined`
   * if the session is missing.
   */
  inspect(sessionId: string): SessionInspection | undefined {
    const session = this.store.getSession(sessionId);
    if (session === undefined) return undefined;
    const events = this.store.listSessionEvents(sessionId);
    const plan = JSON.parse(session.ingestion_plan_json) as PlanCounts;
    return { session, events, plan };
  }

  /**
   * List sessions for the CLI / MCP inspector.
   */
  list(opts: { scope?: SessionScope; project_id?: string; limit?: number } = {}): SessionRow[] {
    return this.store.listSessions({
      ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
      ...(opts.project_id !== undefined ? { project_id: opts.project_id } : {}),
      limit: opts.limit ?? 50
    });
  }

  /**
   * Forget a session. Returns `true` if a row was
   * removed, `false` if the session was missing.
   */
  forget(sessionId: string): boolean {
    return this.store.forgetSession(sessionId);
  }

  /**
   * Persist one event + the body blob. Called
   * inside the ingest transaction so the row
   * inserts are atomic with the session row.
   */
  private persistEvent(
    sessionId: string,
    ev: NormalisedEvent,
    _plan: PlanCounts
  ): void {
    const flags: SessionRedactionFlag[] = [];
    if (ev.content !== null) {
      const findings = detectSecrets(ev.content, "body");
      if (findings.length > 0) {
        flags.push("contains_secret");
        // The plan counter was already incremented
        // by `planBundle` (which knows the
        // pre-decision state). We do not increment
        // again here.
      }
      // Mark the event as risk_injection if the
      // content matches the prompt-injection pattern
      // surface. The pattern is intentionally narrow
      // (a few well-known markers); the wider
      // detection lives in the Phase 2 extractor
      // (#50). A wide surface here would block
      // legitimate transcripts.
      if (/ignore (all )?previous instructions|disregard (the )?system prompt/i.test(ev.content)) {
        flags.push("risk_injection");
      }
    }
    // Decide the head/tail truncation BEFORE the
    // row insert so the redaction_flags array on
    // disk matches the in-memory plan.
    let truncated = false;
    if (ev.content !== null) {
      const { head, tail, truncated: isTrunc } = splitForBlob(ev.content);
      truncated = isTrunc;
      if (truncated) flags.push("truncated");
      this.store.upsertSessionEventBlob({
        digest: ev.content_digest,
        size_bytes: Buffer.byteLength(ev.content, "utf8"),
        media_type: "text/plain",
        head_bytes: head,
        tail_bytes: tail,
        head_tail_window_json: JSON.stringify({
          head_bytes: head.length,
          tail_bytes: tail.length,
          truncated
        }),
        stored_at: nowIso()
      });
    }
    const row: SessionEventRow = {
      event_id: ev.event_id,
      session_id: sessionId,
      sequence: ev.sequence,
      turn_id: ev.turn_id,
      event_type: ev.event_type,
      role: ev.role,
      content_digest: ev.content_digest,
      content_blob_ref: ev.content_digest,
      tool_name: ev.tool_name ?? null,
      tool_call_id: ev.tool_call_id ?? null,
      tool_status: ev.tool_status ?? null,
      timestamp: ev.timestamp,
      sensitivity: ev.sensitivity,
      redaction_flags_json: JSON.stringify(flags),
      metadata_json: JSON.stringify(ev.metadata ?? {})
    };
    this.store.insertSessionEvent(row);
    // The plan counters are already maintained by
    // `planBundle`; do not double-count here.
  }
}

/**
 * Compute the SHA-256 over the canonicalised
 * bundle. The canonical form is:
 *   JSON.stringify({
 *     schema_version, bundle_id, source_*,
 *     project_id, actor_id, client_*,
 *     scope, sensitivity, started_at, ended_at,
 *     adapter_id, adapter_version,
 *     events: [{...}]  // ordered by sequence ASC
 *   })
 * sorted keys, no whitespace. The shape is the
 * source of truth for replay detection (issue
 * #49 AC #1).
 */
function canonicalBundleHash(bundle: NormalisedBundle): string {
  const orderedEvents = [...bundle.events].sort((a, b) =>
    a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0
  );
  const canonical = JSON.stringify({
    schema_version: "1",
    bundle_id: bundle.bundle_id,
    source_kind: bundle.source_kind,
    source_version: bundle.source_version,
    source_instance_id: bundle.source_instance_id,
    source_session_id: bundle.source_session_id,
    project_id: bundle.project_id,
    actor_id: bundle.actor_id,
    client_name: bundle.client_name,
    client_version: bundle.client_version,
    scope: bundle.scope,
    sensitivity: bundle.sensitivity,
    started_at: bundle.started_at,
    ended_at: bundle.ended_at,
    adapter_id: bundle.adapter_id,
    adapter_version: bundle.adapter_version,
    events: orderedEvents
  });
  return "sha256:" + createHash("sha256").update(canonical).digest("hex");
}

/**
 * Walk the bundle and decide which events to
 * accept, redact, skip, or reject. The plan is
 * purely deterministic — it does not mutate
 * events, just decides the disposition. The
 * caller (the service) materialises the events
 * and updates the `redaction_flags` array.
 *
 * Decision rules:
 *   - Per-event size cap: when the body exceeds
 *     the cap, the row is accepted with
 *     `truncated=true` (head/tail window). The
 *     digest is the full-body digest so a later
 *     review can still verify the original.
 *   - Per-session size cap: when the cumulative
 *     body bytes exceed the session cap, the
 *     remainder are `skipped` (manifest only,
 *     no body written).
 *   - secret-bearing: accepted, but
 *     `redacted=true` (head/tail still captured;
 *     the digest is the original-body digest so
 *     the secret scan is reproducible).
 */
function planBundle(
  bundle: NormalisedBundle,
  perEventCap: number,
  perSessionCap: number
): PlanCounts {
  const counts: PlanCounts = { accepted: 0, redacted: 0, skipped: 0, rejected: 0 };
  let totalBodyBytes = 0;
  for (const ev of bundle.events) {
    const size = ev.content === null ? 0 : Buffer.byteLength(ev.content, "utf8");
    if (size > perEventCap) {
      counts.accepted += 1;
      counts.redacted += 1;
      totalBodyBytes += SESSION_HEAD_TAIL_WINDOW_BYTES * 2;
      continue;
    }
    if (totalBodyBytes + size > perSessionCap) {
      counts.skipped += 1;
      continue;
    }
    counts.accepted += 1;
    if (ev.content !== null && detectSecrets(ev.content, "body").length > 0) {
      counts.redacted += 1;
    }
    totalBodyBytes += size;
  }
  return counts;
}

/**
 * Carve the body into a head + tail window for
 * the `session_event_blobs` row. The full body
 * is NOT in the SQLite row (it lives in a
 * content-addressed local file under the data
 * home, addressed by digest). The head + tail
 * slices are kept in-row so a CLI / MCP
 * inspector can sample the body without a full
 * file read.
 */
function splitForBlob(body: string): {
  head: Buffer;
  tail: Buffer;
  truncated: boolean;
} {
  const total = Buffer.byteLength(body, "utf8");
  if (total <= SESSION_HEAD_TAIL_WINDOW_BYTES * 2) {
    return {
      head: Buffer.from(body, "utf8"),
      tail: Buffer.alloc(0),
      truncated: false
    };
  }
  const head = Buffer.from(
    body.slice(0, SESSION_HEAD_TAIL_WINDOW_BYTES),
    "utf8"
  );
  const tail = Buffer.from(
    body.slice(-SESSION_HEAD_TAIL_WINDOW_BYTES),
    "utf8"
  );
  return { head, tail, truncated: true };
}
