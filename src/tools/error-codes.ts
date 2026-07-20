// src/tools/error-codes.ts
//
// Stage 12 PR9 (spec § 6.3, § 5.6): stable, machine-readable
// error codes for the MCP v2 envelope. Two layers:
//
//   1. StableCode — the public contract. Never rename, never
//      repurpose. Add new codes, do not mutate existing ones.
//      Agent clients key off these strings to drive retry,
//      recovery, and user-facing messaging.
//
//   2. ErrorCategory — coarse bucket for the SDK caller.
//      `retryable: true` means the same call may succeed later
//      (transient I/O, lock contention, revision drift);
//      `false` means the call will not succeed without input
//      changes (validation, scope, schema).
//
// The error code returned in `ToolFailure.error.code` is the
// `StableCode` value. The category is exposed as
// `ToolFailure.error.retryable` per spec § 6.3.

/**
 * Stable, public error codes for the AgentRecall MCP contract.
 *
 * Append new codes when introducing new failure modes; do not
 * rename or repurpose existing entries. Clients pin to these
 * strings, so any change is a breaking API change.
 */
export const STABLE_ERROR_CODES = [
  // Schema and validation
  "invalid_schema",
  "invalid_scope",
  "invalid_state",
  "not_found",
  "secret_detected",
  // Capacity and lifecycle
  "capacity_exceeded",
  "duplicate",
  // Concurrency (Stage 12 PR9 — spec § 5.6)
  "stale_revision",
  "conflict",
  "busy",
  // Plan/Apply maintenance (Stage 12 PR9 — spec § 6.2)
  "plan_invalidated",
  "plan_not_found",
  "idempotency_mismatch",
  // Filesystem / I/O
  "io_error",
  "not_writable",
  "not_readable",
  // Internal
  "internal_error",
  "tool_error",
  "unavailable"
] as const;

export type StableErrorCode = (typeof STABLE_ERROR_CODES)[number];

/**
 * Coarse retryability flag. `true` = transient, same call may
 * succeed later. `false` = permanent until inputs change.
 */
export type ErrorCategory = "transient" | "permanent";

const TRANSIENT_CODES: ReadonlySet<StableErrorCode> = new Set<StableErrorCode>([
  "busy",
  "io_error",
  "conflict",
  "unavailable",
  "internal_error"
]);

const PERMANENT_CODES: ReadonlySet<StableErrorCode> = new Set<StableErrorCode>([
  "invalid_schema",
  "invalid_scope",
  "invalid_state",
  "not_found",
  "secret_detected",
  "capacity_exceeded",
  "duplicate",
  "stale_revision",
  "plan_invalidated",
  "plan_not_found",
  "idempotency_mismatch",
  "not_writable",
  "not_readable",
  "tool_error"
]);

/**
 * Map a stable code to a coarse category. Unknown codes
 * default to `permanent` (safer: don't loop on something we
 * do not recognise).
 */
export function errorCategory(code: string): ErrorCategory {
  if (TRANSIENT_CODES.has(code as StableErrorCode)) return "transient";
  if (PERMANENT_CODES.has(code as StableErrorCode)) return "permanent";
  return "permanent";
}

/**
 * Convenience: assert that a string is a recognised code.
 * Used by service layers to fail loudly when a new code is
 * added to a service but not registered here.
 */
export function isStableErrorCode(value: string): value is StableErrorCode {
  return (STABLE_ERROR_CODES as readonly string[]).includes(value);
}
