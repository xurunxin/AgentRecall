// src/services/safety-counters.ts
//
// v1.2.0-alpha.3 (issue #55b): the safety counter
// surface. Five counters are defined by issue #55's
// evaluation matrix; every counter must be exactly
// zero in the release-gate safety check.
//
//   - cross_project_leak_count
//   - sensitivity_leak_count
//   - secret_leak_count
//   - injection_bypass_count
//   - unauthorized_trust_escalation_count
//
// The service layer exposes a `SafetyCounters`
// interface; concrete implementations either
// accumulate the values (the eval harness path) or
// no-op (the production path, where the counters
// are passive). Services that participate in the
// safety gate accept the counter via dependency
// injection — a service constructor option with a
// `noopSafetyCounters` default. This keeps the
// counter work out of the hot read / write path
// when the gate is not active.

/**
 * The five counter kinds defined by issue #55. The
 * order of declaration matches the `expected.safety`
 * field on the eval fixture schema and the
 * `safety_counters` field on the per-fixture result;
 * changing the order would break the v0.3.x
 * corpus's report shape.
 */
export const SAFETY_COUNTER_KINDS = [
  "cross_project_leak_count",
  "sensitivity_leak_count",
  "secret_leak_count",
  "injection_bypass_count",
  "unauthorized_trust_escalation_count"
] as const;

export type SafetyCounterKind = (typeof SAFETY_COUNTER_KINDS)[number];

/**
 * The full counter snapshot. Always five fields;
 * services that have no observation to make for a
 * given counter leave its value at zero. A
 * `reset()` call on a collecting counter restores
 * every field to zero.
 */
export type SafetyCounterSnapshot = {
  [K in SafetyCounterKind]: number;
};

/**
 * The `SafetyCounters` interface. The eval harness
 * uses a collecting implementation; the production
 * code path uses the no-op default. The interface
 * is intentionally narrow (`inc` + `snapshot`) so
 * the in-process cost on the production path is one
 * virtual call per `inc`.
 */
export interface SafetyCounters {
  /**
   * Increment a counter by `by` (default 1). When
   * the counter is currently in a "leak observed"
   * state the call must always be observable on the
   * next `snapshot()`.
   */
  inc(kind: SafetyCounterKind, by?: number): void;
  /**
   * Return the current counter values. The
   * returned object is the harness's observation
   * surface; the service layer must never mutate
   * it.
   */
  snapshot(): SafetyCounterSnapshot;
  /**
   * Restore every counter to zero. The harness
   * calls this between fixtures so a passing
   * fixture's zero is not a stale observation.
   */
  reset(): void;
}

/**
 * A zero-allocation no-op implementation. Used as
 * the default `safetyCounters` argument on every
 * service constructor so the production path does
 * not allocate or mutate state for the counter
 * surface.
 */
export const noopSafetyCounters: SafetyCounters = {
  inc(): void {
    // no-op
  },
  snapshot(): SafetyCounterSnapshot {
    return {
      cross_project_leak_count: 0,
      sensitivity_leak_count: 0,
      secret_leak_count: 0,
      injection_bypass_count: 0,
      unauthorized_trust_escalation_count: 0
    };
  },
  reset(): void {
    // no-op
  }
};

/**
 * A collecting implementation backed by a plain
 * object. The harness wires one of these into the
 * fixture context; the service layer increments
 * counters as it processes events / candidates /
 * assemblies, and the runner reads `snapshot()` at
 * the end of each fixture.
 */
export class CollectingSafetyCounters implements SafetyCounters {
  private counts: SafetyCounterSnapshot = {
    cross_project_leak_count: 0,
    sensitivity_leak_count: 0,
    secret_leak_count: 0,
    injection_bypass_count: 0,
    unauthorized_trust_escalation_count: 0
  };

  inc(kind: SafetyCounterKind, by: number = 1): void {
    this.counts[kind] += by;
  }

  snapshot(): SafetyCounterSnapshot {
    return { ...this.counts };
  }

  reset(): void {
    this.counts = {
      cross_project_leak_count: 0,
      sensitivity_leak_count: 0,
      secret_leak_count: 0,
      injection_bypass_count: 0,
      unauthorized_trust_escalation_count: 0
    };
  }
}
