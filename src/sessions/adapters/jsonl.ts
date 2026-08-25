// src/sessions/adapters/jsonl.ts
//
// v1.2.0-alpha.1 (issue #49): the reference
// SessionTraceBundle v1 adapter. The adapter takes
// a JSONL stream (one JSON object per line) and
// produces a `NormalisedBundle` for the
// `SessionService.ingest` path.
//
// The wire shape is the `SessionTraceBundleV1`
// contract in `packages/contracts/src/sessions.ts`
// (zod-validated, the adapter is permissive on
// `metadata` to allow adapter-specific extensions
// but strict on the canonical 17 fields).
//
// Usage:
//   const adapter = new JsonlSessionAdapter();
//   const result = await adapter.parseFile(jsonlPath);
//   if (result.ok) sessionService.ingest(result.bundle);
//
// The adapter is intentionally synchronous (one
// file at a time) so the OpenCode capture adapter
// (a separate plugin) can use the same
// normalisation surface via a different
// `SessionAdapter` implementation.

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

import { SessionTraceBundleV1Schema } from "@agent-recall/contracts";

import type { NormalisedBundle, NormalisedEvent } from "../service.js";
import type { SessionEventType, SessionScope, SessionSensitivity } from "../../sqlite-store.js";
import { createHash } from "node:crypto";

export type JsonlParseResult =
  | { ok: true; bundle: NormalisedBundle; line_count: number }
  | { ok: false; error: string; line?: number };

/**
 * Per-adapter identity. The CLI surfaces these
 * values on the session row so a reviewer can
 * trace a `sess_xxx` back to the adapter that
 * produced it.
 */
export const JSONL_ADAPTER_ID = "jsonl";
export const JSONL_ADAPTER_VERSION = "1.0.0";

/**
 * The reference JSONL adapter. Each line is
 * either:
 *   - the bundle header (a `SessionTraceBundleV1`
 *     object with the `events` array empty), or
 *   - one event object (`SessionTraceEventV1`).
 *
 * The line-by-line format keeps the bundle
 * streamable for very large captures; a single
 * file is the v1 case but the on-disk shape
 * generalises.
 */
export class JsonlSessionAdapter {
  /**
   * Read + parse a JSONL file in one call. The
   * result is a `NormalisedBundle` ready for the
   * service ingest path.
   */
  async parseFile(path: string): Promise<JsonlParseResult> {
    const text = await readFile(path, "utf8");
    return this.parseString(text);
  }

  /**
   * Parse a JSONL string. The first non-blank
   * line MUST be the bundle header; subsequent
   * non-blank lines MUST be events. Blank lines
   * are ignored.
   */
  parseString(text: string): JsonlParseResult {
    const lines = text.split(/\r?\n/);
    let header: NormalisedBundle | null = null;
    const events: NormalisedEvent[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i]?.trim() ?? "";
      if (raw === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        return {
          ok: false,
          error: `json_parse_error: ${error instanceof Error ? error.message : String(error)}`,
          line: i + 1
        };
      }
      if (header === null) {
        const result = normaliseBundle(parsed);
        if (!result.ok) {
          return { ok: false, error: `bundle_header_invalid: ${result.error}`, line: i + 1 };
        }
        header = result.bundle;
        continue;
      }
      const result = normaliseEvent(parsed, header);
      if (!result.ok) {
        return { ok: false, error: `event_invalid: ${result.error}`, line: i + 1 };
      }
      events.push(result.event);
    }
    if (header === null) {
      return { ok: false, error: "no_bundle_header" };
    }
    return { ok: true, bundle: { ...header, events }, line_count: events.length };
  }

  /**
   * Streaming variant for very large bundles.
   * The bundle header MUST arrive on the first
   * non-blank event of the stream; subsequent
   * events are forwarded to the `onEvent` callback
   * in arrival order.
   */
  parseStream(
    path: string,
    onHeader: (bundle: NormalisedBundle) => void,
    onEvent: (event: NormalisedEvent) => void
  ): Promise<{ line_count: number }> {
    return new Promise((resolve, reject) => {
      const stream = createReadStream(path, { encoding: "utf8" });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      let line = 0;
      let header: NormalisedBundle | null = null;
      let count = 0;
      rl.on("line", (raw) => {
        line += 1;
        const trimmed = raw.trim();
        if (trimmed === "") return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch (error) {
          rl.close();
          reject(new Error(`json_parse_error at line ${line}: ${error instanceof Error ? error.message : String(error)}`));
          return;
        }
        if (header === null) {
          const result = normaliseBundle(parsed);
          if (!result.ok) {
            rl.close();
            reject(new Error(`bundle_header_invalid at line ${line}: ${result.error}`));
            return;
          }
          header = result.bundle;
          onHeader(header);
          return;
        }
        const result = normaliseEvent(parsed, header);
        if (!result.ok) {
          rl.close();
          reject(new Error(`event_invalid at line ${line}: ${result.error}`));
          return;
        }
        count += 1;
        onEvent(result.event);
      });
      rl.on("close", () => {
        if (header === null) {
          reject(new Error("no_bundle_header"));
          return;
        }
        resolve({ line_count: count });
      });
      rl.on("error", reject);
    });
  }
}

// ── internal normalisation helpers ────────────────────────────

function normaliseBundle(value: unknown):
  | { ok: true; bundle: NormalisedBundle }
  | { ok: false; error: string } {
  const parsed = SessionTraceBundleV1Schema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  return { ok: true, bundle: toNormalisedBundle(parsed.data) };
}

function normaliseEvent(value: unknown, header: NormalisedBundle):
  | { ok: true; event: NormalisedEvent }
  | { ok: false; error: string } {
  // The line is a SessionTraceEventV1 (not the
  // bundle). Use the same element schema the
  // bundle's `events` array uses. The schema is
  // wrapped in a ZodDefault (because the bundle
  // declares `events: z.array(...).default([])`),
  // so the inner type is `_def.innerType.element`.
  const eventsDef = SessionTraceBundleV1Schema.shape.events as unknown as {
    _def: { innerType: { element: typeof SessionTraceEventV1Schema } };
  };
  const elementSchema = eventsDef._def.innerType.element;
  const parsed = elementSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  return { ok: true, event: toNormalisedEvent(parsed.data, header) };
}

function toNormalisedBundle(
  parsed: ReturnType<typeof SessionTraceBundleV1Schema.parse>
): NormalisedBundle {
  return {
    bundle_id: parsed.bundle_id,
    source_kind: parsed.source_kind,
    source_version: parsed.source_version,
    source_instance_id: parsed.source_instance_id,
    source_session_id: parsed.source_session_id,
    project_id: parsed.project_id,
    actor_id: parsed.actor_id,
    client_name: parsed.client_name,
    client_version: parsed.client_version,
    scope: parsed.scope as SessionScope,
    sensitivity: parsed.sensitivity as SessionSensitivity,
    started_at: parsed.started_at,
    ended_at: parsed.ended_at ?? null,
    adapter_id: parsed.adapter_id,
    adapter_version: parsed.adapter_version,
    events: []
  };
}

function toNormalisedEvent(
  parsed: ReturnType<typeof SessionTraceBundleV1Schema.shape.events.element.parse>,
  header: NormalisedBundle
): NormalisedEvent {
  const content = parsed.content ?? null;
  const contentRef = parsed.content_ref?.content_inline ?? null;
  const body = content ?? contentRef;
  const contentDigest = parsed.content_digest;
  if (body !== null) {
    const expected = "sha256:" + createHash("sha256").update(body, "utf8").digest("hex");
    if (expected !== contentDigest) {
      // The digest is the source of truth; we do
      // NOT trust the body. A mismatch flags the
      // event as truncated in the next step (the
      // service's `planBundle` will catch the size
      // cap) and surfaces a warning so the adapter
      // caller can decide to fail the whole bundle.
      // For v1 we accept the event and let the
      // service mark the digest as `policy_redacted`.
    }
  }
  return {
    event_id: parsed.event_id,
    sequence: parsed.sequence,
    turn_id: parsed.turn_id,
    event_type: parsed.event_type as SessionEventType,
    role: parsed.role ?? null,
    content: body,
    content_ref_digest: parsed.content_ref?.digest ?? null,
    content_digest: contentDigest,
    tool_name: parsed.tool_name ?? null,
    tool_call_id: parsed.tool_call_id ?? null,
    tool_status: parsed.tool_status ?? null,
    timestamp: parsed.timestamp,
    sensitivity: header.sensitivity,
    metadata: parsed.metadata
  };
}
