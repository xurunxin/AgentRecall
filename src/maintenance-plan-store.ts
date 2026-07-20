// src/maintenance-plan-store.ts
//
// Stage 12 PR9 (spec § 6.2): the plan/apply split for
// maintenance. `plan_maintenance` returns a plan_id plus
// the expected revisions of every entry the plan touches.
// `apply_maintenance` requires the plan_id, a confirmation
// flag, and an idempotency key, and refuses to run if any
// expected revision has drifted (spec § 6.2 "apply 前检查
// 所有 expected revisions；任一变化即计划失效").
//
// We keep the plan store in process memory. Plans are
// short-lived (a coding agent calls plan_maintenance and
// apply_maintenance seconds apart), and persisting them
// would force us to track a serialised representation of
// "proposed action" which is fragile across versions. The
// process-local store is reset on every server restart;
// agents are expected to call plan_maintenance again after
// a restart.

import { randomUUID } from "node:crypto";
import type { MemoryEntry } from "./domain.js";

export type ProposedAction =
  | {
      kind: "merge_duplicates";
      old_memory_ids: string[];
      reason: string;
    }
  | {
      kind: "archive_low_value";
      memory_ids: string[];
    }
  | {
      kind: "expire_due";
      memory_ids: string[];
    };

export interface MaintenancePlan {
  plan_id: string;
  scope: "global" | "project";
  project_id?: string;
  risk: "low" | "high";
  created_at: string;
  /**
   * Map of memory_id -> revision captured at plan time. The
   * apply step verifies each entry's current revision still
   * matches; if any drift, the plan is invalidated.
   */
  expected_revisions: Record<string, number>;
  /**
   * The actions the apply step will execute, in order. We
   * store a structural plan, not raw service calls, so the
   * apply step can re-resolve references.
   */
  proposed_actions: ProposedAction[];
  /**
   * Short human-readable summary, one line per action. Used
   * by the agent to confirm before calling apply.
   */
  summary: string[];
}

export type PlanApplyResult =
  | { ok: true; plan_id: string; applied: number; idempotency_key: string }
  | { ok: false; plan_id: string; error: "plan_invalidated" | "idempotency_mismatch"; details?: Record<string, unknown> };

interface CreatePlanInput {
  scope: "global" | "project";
  project_id?: string;
  risk: "low" | "high";
  expected_revisions: Record<string, number>;
  proposed_actions: ProposedAction[];
  summary: string[];
}

export class MaintenancePlanStore {
  private readonly plans = new Map<string, MaintenancePlan>();
  /** plan_id -> idempotency_key that already ran apply. */
  private readonly appliedKeys = new Map<string, string>();

  create(input: CreatePlanInput): MaintenancePlan {
    const plan_id = `plan_${randomUUID()}`;
    const plan: MaintenancePlan = {
      plan_id,
      scope: input.scope,
      ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
      risk: input.risk,
      created_at: new Date().toISOString(),
      expected_revisions: { ...input.expected_revisions },
      proposed_actions: input.proposed_actions.map((action) => deepCloneAction(action)),
      summary: [...input.summary]
    };
    this.plans.set(plan_id, plan);
    return plan;
  }

  get(plan_id: string): MaintenancePlan | undefined {
    return this.plans.get(plan_id);
  }

  /**
   * Drop a plan from the store. We keep plans for a short
   * window so a retried apply with the same idempotency_key
   * can be detected. After the window they are gone.
   */
  forget(plan_id: string): void {
    this.plans.delete(plan_id);
    this.appliedKeys.delete(plan_id);
  }

  /**
   * Verify the plan against the current store state. The
   * caller passes in a snapshot of `revision` for each
   * memory_id in the plan. If any mismatch, return
   * `plan_invalidated` with the drifted ids. If the plan
   * was already applied with the same idempotency key,
   * return `idempotency_mismatch` with the prior key.
   */
  validate(plan_id: string, currentRevisions: Record<string, number>, idempotency_key: string): PlanApplyResult {
    const plan = this.plans.get(plan_id);
    if (plan === undefined) {
      return { ok: false, plan_id, error: "plan_invalidated", details: { reason: "plan_not_found" } };
    }
    const priorKey = this.appliedKeys.get(plan_id);
    if (priorKey !== undefined) {
      if (priorKey === idempotency_key) {
        // Idempotent retry: same plan + same key = no-op success.
        return { ok: true, plan_id, applied: 0, idempotency_key };
      }
      return { ok: false, plan_id, error: "idempotency_mismatch", details: { expected_key: priorKey, provided_key: idempotency_key } };
    }
    const drifted: string[] = [];
    for (const [memoryId, expected] of Object.entries(plan.expected_revisions)) {
      const current = currentRevisions[memoryId];
      if (current === undefined || current !== expected) {
        drifted.push(memoryId);
      }
    }
    if (drifted.length > 0) {
      return { ok: false, plan_id, error: "plan_invalidated", details: { drifted_memory_ids: drifted } };
    }
    return { ok: true, plan_id, applied: plan.proposed_actions.length, idempotency_key };
  }

  /** Mark a plan as applied. The apply step uses this after the
   * service successfully executes the proposed actions. */
  markApplied(plan_id: string, idempotency_key: string): void {
    this.appliedKeys.set(plan_id, idempotency_key);
  }
}

function deepCloneAction(action: ProposedAction): ProposedAction {
  if (action.kind === "merge_duplicates") {
    return {
      kind: "merge_duplicates",
      old_memory_ids: [...action.old_memory_ids],
      reason: action.reason
    };
  }
  if (action.kind === "archive_low_value") {
    return { kind: "archive_low_value", memory_ids: [...action.memory_ids] };
  }
  return { kind: "expire_due", memory_ids: [...action.memory_ids] };
}
