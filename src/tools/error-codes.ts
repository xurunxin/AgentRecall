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
 *
 * Stage 14 PR-B1 (spec § 8.3): the v1.0 contract adds the
 * spec-named codes `scope_mismatch`, `project_identity_conflict`,
 * `unsafe_content`, `db_busy`, `migration_required`,
 * `backup_failed`, `maintenance_plan_stale`, and `cancelled`.
 * The pre-v1 aliases `duplicate` / `idempotency_mismatch` /
 * `plan_invalidated` / `busy` are kept in the registry so
 * existing client integrations keep working; the new names
 * are additive.
 */
export const STABLE_ERROR_CODES = [
  // Schema and validation
  "invalid_schema",
  "invalid_scope",
  "scope_mismatch",
  "project_identity_conflict",
  "invalid_state",
  "not_found",
  "secret_detected",
  "unsafe_content",
  // Capacity and lifecycle
  "capacity_exceeded",
  "duplicate",
  "duplicate_candidate",
  // Concurrency (spec § 5.6)
  "stale_revision",
  "conflict",
  "busy",
  "db_busy",
  // Idempotency (spec § 5.6)
  "idempotency_mismatch",
  "idempotency_key_reuse",
  // Plan/Apply maintenance (spec § 6.2)
  "plan_invalidated",
  "maintenance_plan_stale",
  "plan_not_found",
  // Migration (spec § 5.4)
  "migration_required",
  "backup_failed",
  // Cancellation (spec § 6.3)
  "cancelled",
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
  "db_busy",
  "io_error",
  "conflict",
  "unavailable",
  "internal_error",
  "cancelled",
  "backup_failed",
  "stale_revision"
]);

const PERMANENT_CODES: ReadonlySet<StableErrorCode> = new Set<StableErrorCode>([
  "invalid_schema",
  "invalid_scope",
  "scope_mismatch",
  "project_identity_conflict",
  "invalid_state",
  "not_found",
  "secret_detected",
  "unsafe_content",
  "capacity_exceeded",
  "duplicate",
  "duplicate_candidate",
  "idempotency_mismatch",
  "idempotency_key_reuse",
  "plan_invalidated",
  "maintenance_plan_stale",
  "plan_not_found",
  "migration_required",
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
