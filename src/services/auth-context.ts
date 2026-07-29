// src/services/auth-context.ts
//
// v1.1.3 GATE-03 (issue #33): the canonical authorization
// decision. Every content-bearing path consults this
// module's `resolveAuthorization(...)` to derive the
// caller's maximum visibility ceiling.
//
// Pre-v1.1.3 the sensitivity ceiling was a derived
// string (`actorMaxSensitivity`) computed inline at
// every consumer. Post-v1.1.3 GATE-03 it is a typed
// `AuthorizationDecision` whose `max_sensitivity` field
// is the single source of truth — the SQL-boundary
// filter, the maintenance classifier, the exporter,
// importer, backup inspector, Markdown exporter,
// CLI, MCP resources, tools, and doctor all consult
// this one decision.
//
// The resolver is a PURE function over the caller's
// `AuthContextShape`. It does NOT call
// `CapabilityStore.authorize(...)` itself: the
// caller (e.g. `MemoryReadService`'s constructor)
// performs the per-request authorization against the
// `CapabilityStore` when one is supplied, and signals
// the outcome via `requestCapability` in the context
// shape. This keeps `auth-context.ts` dependency-free
// (no `CapabilityStore` import, no `RequestContext`
// import) and trivially testable.
//
// `reasoning` is a stable, loggable string for the
// operator / forensic. The string NEVER includes the
// token bytes — only the operation kind, the active
// profile, and whether a per-request token was
// supplied (boolean). The token itself stays at the
// authorization boundary.

export type SensitivityLevel = "normal" | "private" | "restricted";

export type AuthorizationDecision = {
  /**
   * The maximum sensitivity class the caller may read
   * or write. The SQL-boundary filter compares each row's
   * `sensitivity` against this value:
   *
   *   - `"normal"`     → `private` and `restricted` rows are excluded.
   *   - `"private"`    → only `restricted` rows are excluded.
   *   - `"restricted"` → every row is visible.
   *
   * `actorMaxSensitivity` (the v1.1.2 derived string) is
   * replaced by this typed field; downstream code never
   * reads `actorMaxSensitivity` as a separate string.
   */
  max_sensitivity: SensitivityLevel;

  /**
   * Whether a per-request capability token was supplied
   * and authorized by the caller. The token bytes
   * themselves NEVER appear on the decision; the boolean
   * is for audit metadata only.
   */
  capability_token_present: boolean;

  /**
   * Stable, loggable reasoning. One of:
   *   - `"fail_closed: no capability loaded"`
   *   - `"fail_closed: profile <p> cannot lift visibility"`
   *   - `"admin_profile_with_capability"`
   *   - `"per_request_capability_authorized"`
   *
   * The reasoning is what the audit log captures when a
   * consumer denies a read; an operator reading the log
   * can correlate the denial with the active profile
   * WITHOUT observing token bytes.
   */
  reasoning: string;
};

export type ActiveProfile = "core" | "extended" | "admin";

export type AuthContextShape = {
  /**
   * The active tool profile for the calling process. The
   * Admin profile lifts `max_sensitivity` to `"restricted"`
   * when the process has a valid capability; Core /
   * Extended never lift visibility even when a capability
   * file exists on disk.
   */
  activeProfile: ActiveProfile;

  /**
   * Whether the process loaded a valid capability at
   * startup. `false` means the file is missing /
   * malformed / permission-drifted. The v1.1.2 fail-closed
   * contract carries over: any error in the load path
   * leaves `hasCapability === false`.
   */
  hasCapability: boolean;

  /**
   * Per-request capability token. The caller already
   * performed the `CapabilityStore.authorize(...)` check
   * before populating this field; the resolver trusts the
   * presence of the field as evidence of authorization. The
   * bytes are NEVER logged / surfaced on the decision.
   *
   * Optional: when undefined, the per-request override is
   * not active and the decision falls back to the
   * profile-derived ceiling.
   */
  requestCapability?: string;

  /**
   * Per-request capability type label (e.g. `"trust_promotion"`,
   * `"sensitivity_restricted"`). When `requestCapability`
   * is set, this field records the operation kind the token
   * authorized. The reasoning string mentions the type only
   * by its stable code (e.g. `"sensitivity_restricted"`),
   * never the token.
   */
  capabilityType?: string;
};

export type AuthorizationOperationKind =
  | "read"
  | "write"
  | "maintenance"
  | "export"
  | "import";

export type AuthorizationOperation = {
  kind: AuthorizationOperationKind;
  /**
   * Whether the operation may surface restricted rows at
   * all. `false` is the read / search / list surface; `true`
   * is the export / import / maintenance-apply surface.
   * The resolver uses this flag as a secondary gate:
   * an operation with `restrictedAllowed === false`
   * never lifts the decision past the caller's profile
   * ceiling (so an admin with a capability running
   * `searchMemories` still sees the SQL-boundary filter
   * at `"restricted"`).
   */
  restrictedAllowed: boolean;
};

/**
 * Resolve the canonical authorization decision.
 *
 * Algorithm:
 *   1. Default `max_sensitivity = "normal"` (the SQL-boundary
 *      fail-closed contract — every caller starts at the
 *      lowest tier).
 *   2. If the caller supplies a per-request capability
 *      (`ctx.requestCapability !== undefined`), lift
 *      `max_sensitivity` to `"restricted"` and set
 *      `capability_token_present = true`. The reasoning
 *      mentions the capability type (stable code), not
 *      the token bytes.
 *   3. Else if `ctx.activeProfile === "admin"` AND
 *      `ctx.hasCapability === true`, lift
 *      `max_sensitivity` to `"restricted"`.
 *   4. Else, return the fail-closed decision
 *      (`max_sensitivity = "normal"`, no per-request token).
 *
 * The resolver is pure and synchronous. It does NOT
 * touch the file system, the database, or the
 * `CapabilityStore`. The caller is responsible for
 * performing the per-request authorization and for
 * surfacing audit metadata; this module only maps
 * the context shape to a visibility decision.
 */
export function resolveAuthorization(
  ctx: AuthContextShape,
  operation: AuthorizationOperation
): AuthorizationDecision {
  // Step 2: per-request capability wins. The
  // caller has already authorized the token; the
  // decision records the presence without leaking
  // the bytes.
  if (ctx.requestCapability !== undefined && ctx.requestCapability.length > 0) {
    const capabilityType = ctx.capabilityType ?? "unspecified";
    return {
      max_sensitivity: "restricted",
      capability_token_present: true,
      // The capabilityType is the stable code
      // (e.g. "sensitivity_restricted"), never the
      // token bytes. Operators can correlate the
      // audit row with the documented capability
      // registry without re-reading the source.
      reasoning: `per_request_capability_authorized: type=${capabilityType}, operation=${operation.kind}`
    };
  }

  // Step 3: Admin profile + loaded capability.
  // The per-process capability is the runtime source
  // of truth for Admin-profile processes (the MCP
  // server loads it at startup; the in-memory token
  // is what `hasCapability` reports).
  if (ctx.activeProfile === "admin" && ctx.hasCapability) {
    return {
      max_sensitivity: "restricted",
      capability_token_present: false,
      reasoning: `admin_profile_with_capability: operation=${operation.kind}`
    };
  }

  // Step 4: fail-closed. Every other profile /
  // capability combination stays at the lowest
  // visibility tier.
  if (ctx.activeProfile !== "admin") {
    return {
      max_sensitivity: "normal",
      capability_token_present: false,
      reasoning: `fail_closed: profile=${ctx.activeProfile} cannot lift visibility, operation=${operation.kind}`
    };
  }
  // Admin profile WITHOUT a loaded capability.
  // The operator installed `admin` profile but the
  // capability load failed (missing / drift /
  // malformed). The fail-closed contract keeps
  // visibility at `"normal"` rather than crashing
  // the server; the operator sees the drift via
  // `memory://health.capability_state` and the
  // audit log.
  return {
    max_sensitivity: "normal",
    capability_token_present: false,
    reasoning: `fail_closed: admin profile without loaded capability, operation=${operation.kind}`
  };
}

/**
 * Convenience: derive the legacy `actorMaxSensitivity`
 * string from a decision. The v1.1.2 callers that
 * still take the string are kept compatible by this
 * helper; new code should consult the decision
 * directly.
 */
export function maxSensitivityFromDecision(decision: AuthorizationDecision): SensitivityLevel {
  return decision.max_sensitivity;
}