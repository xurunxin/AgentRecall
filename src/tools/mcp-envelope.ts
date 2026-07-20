// src/tools/mcp-envelope.ts
//
// Stage 12 PR9 (spec § 6.3): the MCP v2 envelope. Every
// tool result becomes a `CallToolResult` with:
//
//   - `content`        — the existing text payload. Old
//                        clients that only know how to read
//                        text get a stable JSON or markdown
//                        payload (unchanged from Stage 9).
//   - `structuredContent` — the new typed payload. Always
//                        a `ToolSuccess` or `ToolFailure`
//                        shaped object (see spec § 6.3).
//   - `isError`        — `true` when the structured payload
//                        is a `ToolFailure`; `false` or
//                        `undefined` otherwise. The MCP SDK
//                        also lets protocol errors propagate
//                        through JSON-RPC; we only set
//                        `isError` for *business* failures
//                        (validation, scope, capacity, etc.)
//                        that the client should treat as a
//                        normal result, not a transport
//                        error.
//
// Backward-compat note: the text payload keeps its
// Stage 9 shape so existing clients and tests do not
// break. New clients should read `structuredContent`
// instead.

import { randomUUID } from "node:crypto";
import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { CURRENT_SCHEMA_VERSION } from "../sqlite-store.js";
import { serverVersion } from "../server-version.js";
import { errorCategory, isStableErrorCode, type StableErrorCode } from "./error-codes.js";

/**
 * Public, machine-readable error contract for the MCP v2
 * envelope. See spec § 6.3 for the canonical shape.
 */
export interface ToolSuccessEnvelope<T> {
  ok: true;
  data: T;
  meta: {
    request_id: string;
    server_version: string;
    schema_version: number;
    duration_ms: number;
  };
}

export interface ToolFailureEnvelope {
  ok: false;
  error: {
    code: StableErrorCode | string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
  meta: {
    request_id: string;
    server_version: string;
    schema_version: number;
    duration_ms: number;
  };
}

export type ToolEnvelope<T> = ToolSuccessEnvelope<T> | ToolFailureEnvelope;

interface BuildEnvelopeInput<T> {
  /** The original text/legacy payload. Preserved as-is for backward compat. */
  readonly legacyContent: ContentBlock[];
  /** The `value` from a successful service call. */
  readonly data?: T;
  /** The `error` / `message` / `details` from a service-level Result failure. */
  readonly failure?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  /** The request id, when known (e.g. from a session). */
  readonly requestId?: string;
  /** Wall-clock duration in ms. Required on success. */
  readonly durationMs: number;
}

/**
 * Build a v2-envelope `CallToolResult`. The text `content`
 * is preserved unchanged; the typed `structuredContent`
 * and `isError` flag are added.
 */
export function buildEnvelopeResult<T>(input: BuildEnvelopeInput<T>): CallToolResult {
  const requestId = input.requestId ?? randomUUID();
  const sharedMeta = {
    request_id: requestId,
    server_version: serverVersion(),
    schema_version: CURRENT_SCHEMA_VERSION,
    duration_ms: input.durationMs
  };

  if (input.failure !== undefined) {
    const code = isStableErrorCode(input.failure.code) ? input.failure.code : "tool_error";
    const structured: ToolFailureEnvelope = {
      ok: false,
      error: {
        code,
        message: input.failure.message,
        retryable: errorCategory(code) === "transient",
        ...(input.failure.details !== undefined ? { details: input.failure.details } : {})
      },
      meta: sharedMeta
    };
    return {
      content: input.legacyContent,
      structuredContent: structured as unknown as Record<string, unknown>,
      isError: true
    };
  }

  const structured: ToolSuccessEnvelope<T> = {
    ok: true,
    data: input.data as T,
    meta: sharedMeta
  };
  return {
    content: input.legacyContent,
    structuredContent: structured as unknown as Record<string, unknown>
  };
}
