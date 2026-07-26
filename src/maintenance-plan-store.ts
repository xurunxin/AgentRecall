// src/maintenance-plan-store.ts
//
// Stage 15 PR-M0-4 (issue #3, spec § 6.2): the durable
// plan/apply split for maintenance. Pre-PR-M0-4 this
// module kept a process-local `Map<string, MaintenancePlan>`
// so the plan died on every server restart. Post-PR-M0-4
// the plan lives in the `maintenance_plans` +
// `maintenance_plan_items` tables and the module is a
// thin wrapper over `SQLiteMemoryStore`.
//
// `plan_maintenance` returns a plan_id plus per-item
// `(target_memory_id, expected_revision)` pairs. The
// `plan_hash` is SHA-256 over the canonical JSON of the
// items array, so a tampered plan is rejected on apply.
// `apply_maintenance` requires the plan_id, a
// confirmation flag, and an idempotency key. Apply
// refuses if:
//   - the plan is missing (plan_not_found)
//   - the plan is expired (state='expired' or expires_at <= now)
//   - the plan is already completed (state='completed')
//   - the plan_hash drifts between read and re-read
//   - any item's `expected_revision` does not match the
//     entry's current revision
//
// The `risk` is no longer always "low" — destructive
// actions (supersede / merge / forget) are tagged "high".

import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "./services/idempotency.js";
import type {
  MaintenancePlanActionType,
  MaintenancePlanItemRow,
  MaintenancePlanRisk,
  MaintenancePlanRow,
  MaintenancePlanState
} from "./sqlite-store.js";
import type { SQLiteMemoryStore } from "./sqlite-store.js";
import { nowIso } from "./domain.js";

export type MaintenancePlanAction = {
  kind: MaintenancePlanActionType;
  target_memory_id: string;
  expected_revision: number;
  /** Optional free-form evidence; serialised into `evidence_json`. */
  evidence: Record<string, unknown>;
  risk: MaintenancePlanRisk;
};

export interface MaintenancePlan {
  plan_id: string;
  scope: "global" | "project";
  project_id?: string;
  risk: MaintenancePlanRisk;
  created_at: string;
  expires_at: string;
  /**
   * Map of memory_id -> revision captured at plan time.
   * Mirrors the per-item expected_revision for legacy
   * callers that read the plan as a flat map.
   */
  expected_revisions: Record<string, number>;
  /**
   * The actions the apply step will execute, in
   * deterministic order (target_memory_id ascending).
   * Each action carries its expected_revision so apply
   * can verify before mutating (spec § 6.2 "apply 前检查
   * 所有 expected revisions；任一变化即计划失效").
   */
  proposed_actions: MaintenancePlanAction[];
  /**
   * Short human-readable summary, one line per item.
   * Used by the agent to confirm before calling apply.
   */
  summary: string[];
  plan_hash: string;
}

export type PlanApplyResult =
  | {
      ok: true;
      plan_id: string;
      applied: number;
      rejected: number;
      idempotency_key: string;
    }
  | {
      ok: false;
      plan_id: string;
      error:
        | "plan_not_found"
        | "plan_expired"
        | "plan_completed"
        | "plan_hash_drift"
        | "stale_revision"
        | "idempotency_mismatch"
        | "unplanned_target";
      details?: Record<string, unknown>;
    };

export interface CreatePlanInput {
  scope: "global" | "project";
  project_id?: string;
  risk: MaintenancePlanRisk;
  creator_actor_id: string;
  /** Lifetime in seconds; the plan expires after this window. */
  ttl_seconds?: number;
  expected_revisions: Record<string, number>;
  proposed_actions: MaintenancePlanAction[];
  summary: string[];
}

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export class MaintenancePlanStore {
  constructor(private readonly store: SQLiteMemoryStore) {}

  /**
   * Stage 15 PR-M0-4: plan expiry sweep. Called from the
   * `maintain_memories` entrypoint so expired plans do not
   * accumulate; an expired plan can never be applied.
   */
  expireOldPlans(): number {
    return this.store.expireOldMaintenancePlans(nowIso());
  }

  create(input: CreatePlanInput): MaintenancePlan {
    this.expireOldPlans();
    const plan_id = `plan_${randomUUID()}`;
    const created_at = nowIso();
    const ttl = input.ttl_seconds ?? DEFAULT_TTL_SECONDS;
    const expires_at = new Date(Date.parse(created_at) + ttl * 1000).toISOString();
    // Sort the items by target_memory_id so the plan_hash
    // is independent of insertion order. The on-disk
    // table has PRIMARY KEY (plan_id, target_memory_id) so
    // the sort order also keeps the on-disk rows unique.
    const sortedItems = [...input.proposed_actions].sort((a, b) =>
      a.target_memory_id < b.target_memory_id ? -1 : a.target_memory_id > b.target_memory_id ? 1 : 0
    );
    const plan_hash = computePlanHash(
      sortedItems.map((a) => ({
        target_memory_id: a.target_memory_id,
        expected_revision: a.expected_revision,
        action_type: a.kind,
        risk: a.risk
      }))
    );
    const row: MaintenancePlanRow = {
      plan_id,
      plan_hash,
      creator_actor_id: input.creator_actor_id,
      created_at,
      expires_at,
      state: "pending",
      summary_json: JSON.stringify(input.summary),
      scope: input.scope,
      ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
      risk: input.risk,
      items: sortedItems.map((a) => ({
        target_memory_id: a.target_memory_id,
        expected_revision: a.expected_revision,
        action_type: a.kind,
        evidence_json: JSON.stringify(a.evidence),
        risk: a.risk
      }))
    };
    this.store.createMaintenancePlan(row);
    return {
      plan_id,
      scope: input.scope,
      ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
      risk: input.risk,
      created_at,
      expires_at,
      expected_revisions: { ...input.expected_revisions },
      proposed_actions: sortedItems.map((a) => ({
        kind: a.kind,
        target_memory_id: a.target_memory_id,
        expected_revision: a.expected_revision,
        evidence: { ...a.evidence },
        risk: a.risk
      })),
      summary: [...input.summary],
      plan_hash
    };
  }

  get(plan_id: string): MaintenancePlan | undefined {
    const row = this.store.getMaintenancePlan(plan_id);
    if (row === undefined) return undefined;
    return planFromRow(row);
  }

  /**
   * Stage 15 PR-M0-4: validate a plan before apply. The
   * caller passes in a snapshot of `revision` for each
   * target the plan touches plus the `idempotency_key`
   * it intends to use. If any check fails, return a
   * structured error; the apply step then refuses to
   * mutate the store and writes a `rejected_plan` audit.
   */
  validate(
    plan_id: string,
    currentRevisions: Record<string, number>,
    idempotency_key: string
  ): { ok: true; plan: MaintenancePlan; replay?: { applied: number; rejected: number } } | Extract<PlanApplyResult, { ok: false }> {
    const row = this.store.getMaintenancePlan(plan_id);
    if (row === undefined) {
      return { ok: false, plan_id, error: "plan_not_found" };
    }
    if (row.state === "expired" || row.expires_at <= nowIso()) {
      // Make the transition visible on disk so a retry
      // does not see a stale "pending" plan.
      if (row.state === "pending") {
        this.store.setMaintenancePlanState(plan_id, "expired");
      }
      return { ok: false, plan_id, error: "plan_expired", details: { expires_at: row.expires_at } };
    }
    if (row.state === "completed") {
      // Stage 16 v1.1.1 PR-5 (issue #12): the
      // completed-plan replay / mismatch contract
      // is now symmetric on the `idempotency_key`.
      // Same key + same plan -> replay the original
      // success result (the caller sees the same
      // `ok: true, applied, rejected, plan_id`
      // shape it saw on the first apply). Different
      // key -> `idempotency_mismatch` as before.
      const stored = this.store.getMaintenancePlanAppliedResult(plan_id, idempotency_key);
      if (stored !== undefined) {
        return {
          ok: true,
          plan: planFromRow(row),
          replay: stored.result as { applied: number; rejected: number }
        };
      }
      const appliedKeys = this.store.getAppliedMaintenanceKeys(plan_id);
      return {
        ok: false,
        plan_id,
        error: "idempotency_mismatch",
        details: { reason: "plan_already_completed_with_different_key", applied_keys: appliedKeys }
      };
    }
    if (row.state === "applying") {
      // Stage 16 v1.1.1 PR-5 (issue #12): a plan
      // stuck in `applying` is an interrupted
      // apply. Refuse with a dedicated error so the
      // caller can wait or mark the plan expired.
      return {
        ok: false,
        plan_id,
        error: "plan_expired",
        details: { reason: "plan_in_applying_state", current_state: "applying" }
      };
    }
    if (row.state === "rejected") {
      return { ok: false, plan_id, error: "plan_hash_drift", details: { reason: "plan_in_rejected_state" } };
    }
    // Re-hash the items on disk and compare with the
    // stored plan_hash. The on-disk items may have been
    // tampered with (or corrupted) between plan and
    // apply; the hash check catches it.
    const expectedHash = computePlanHash(row.items);
    if (expectedHash !== row.plan_hash) {
      this.store.setMaintenancePlanState(plan_id, "rejected");
      return { ok: false, plan_id, error: "plan_hash_drift" };
    }
    const drifted: string[] = [];
    const unplanned: string[] = [];
    for (const item of row.items) {
      const current = currentRevisions[item.target_memory_id];
      if (current === undefined) {
        // The caller didn't pass a revision for this
        // target — refuse; we never want apply to
        // mutate a memory that wasn't part of the plan
        // snapshot.
        unplanned.push(item.target_memory_id);
        continue;
      }
      if (current !== item.expected_revision) {
        drifted.push(item.target_memory_id);
      }
    }
    if (unplanned.length > 0) {
      return {
        ok: false,
        plan_id,
        error: "unplanned_target",
        details: { unplanned_memory_ids: unplanned }
      };
    }
    if (drifted.length > 0) {
      return {
        ok: false,
        plan_id,
        error: "stale_revision",
        details: { drifted_memory_ids: drifted }
      };
    }
    const appliedKeys = this.store.getAppliedMaintenanceKeys(plan_id);
    if (appliedKeys.length > 0 && !appliedKeys.includes(idempotency_key)) {
      return {
        ok: false,
        plan_id,
        error: "idempotency_mismatch",
        details: { applied_keys: appliedKeys, provided_key: idempotency_key }
      };
    }
    return { ok: true, plan: planFromRow(row) };
  }

  markCompleted(plan_id: string, idempotency_key: string, appliedResult: { applied: number; rejected: number }): void {
    this.store.markMaintenancePlanCompleted(
      plan_id,
      idempotency_key,
      JSON.stringify(appliedResult),
      nowIso()
    );
  }

  /**
   * Stage 16 v1.1.1 PR-5 (issue #12): flip a plan
   * from `pending` to `applying`. Returns `true` if
   * the transition succeeded. The apply phase
   * calls this BEFORE any mutation runs; the
   * `markCompleted` call later transitions to
   * `completed` and persists the canonical result.
   */
  markApplying(plan_id: string): boolean {
    return this.store.markMaintenancePlanApplying(plan_id);
  }

  markRejected(plan_id: string): void {
    this.store.setMaintenancePlanState(plan_id, "rejected");
  }

  /**
   * Stage 15 PR-M0-4: the set of memory_ids the apply
   * step is allowed to mutate. Returns the union of
   * `target_memory_id` across all items so the apply
   * step can refuse mutations outside the plan.
   */
  plannedTargets(plan: MaintenancePlan): Set<string> {
    const targets = new Set<string>();
    for (const action of plan.proposed_actions) {
      targets.add(action.target_memory_id);
    }
    return targets;
  }
}

function planFromRow(row: MaintenancePlanRow): MaintenancePlan {
  return {
    plan_id: row.plan_id,
    scope: row.scope,
    ...(row.project_id !== undefined ? { project_id: row.project_id } : {}),
    risk: row.risk,
    created_at: row.created_at,
    expires_at: row.expires_at,
    expected_revisions: Object.fromEntries(
      row.items.map((i) => [i.target_memory_id, i.expected_revision])
    ),
    proposed_actions: row.items.map((i) => ({
      kind: i.action_type,
      target_memory_id: i.target_memory_id,
      expected_revision: i.expected_revision,
      evidence: parseEvidence(i.evidence_json),
      risk: i.risk
    })),
    summary: parseSummary(row.summary_json),
    plan_hash: row.plan_hash
  };
}

function parseEvidence(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

function parseSummary(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed.filter((s): s is string => typeof s === "string");
    }
  } catch {
    // fall through
  }
  return [];
}

function computePlanHash(items: ReadonlyArray<{
  target_memory_id: string;
  expected_revision: number;
  action_type: string;
  risk: string;
}>): string {
  // Hash the sorted, canonicalised items so the hash is
  // independent of insertion order. We deliberately
  // exclude `evidence` from the hash so a benign
  // evidence re-shape (e.g. adding optional fields)
  // does not invalidate the plan.
  const payload = items.map((i) => ({
    target_memory_id: i.target_memory_id,
    expected_revision: i.expected_revision,
    action_type: i.action_type,
    risk: i.risk
  }));
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

// Stage 15 PR-M0-4: the legacy in-memory plan API is
// removed. Callers must go through the SQLite-backed
// store. We re-export the row types so existing
// consumers (memory-service.ts) can keep their imports.
export type { MaintenancePlanItemRow, MaintenancePlanRow, MaintenancePlanState };
