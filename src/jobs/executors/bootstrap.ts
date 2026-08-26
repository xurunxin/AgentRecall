// src/jobs/executors/bootstrap.ts
//
// v1.2.0-alpha.2 (issue #54): the derivation job
// executors for the cold-start bootstrap pipeline.
// Two kinds are registered:
//
//   bootstrap_scan   -- reads the `bootstrap_plans`
//                       row whose `plan_id` is the
//                       `input_digest`'s tail, runs
//                       `BootstrapService.scan` again
//                       (idempotent on no-content-change),
//                       and records the `plan_id` as a
//                       `derivation_outputs` row.
//
//   bootstrap_apply  -- reads the `bootstrap_plans`
//                       row whose `plan_id` is the
//                       `input_digest`'s tail, runs
//                       `BootstrapService.applyPlan`,
//                       and records each applied
//                       output as a `derivation_outputs`
//                       row.
//
// The executors are intentionally thin: they
// delegate the actual work to the existing service
// methods so the v1.2 job substrate is the only
// new code path. A failure inside either executor
// is caught by the runner and translated to a
// terminal `failed` state on the derivation job.

import { createHash } from "node:crypto";

import type { DerivationJobRow, SQLiteMemoryStore } from "../../sqlite-store.js";
import { BootstrapService } from "../../bootstrap/service.js";
import { ExternalReferenceService } from "../../external-refs/service.js";
import type { DerivationJobExecutor, StageOutcome } from "../runner.js";

/**
 * Build the `input_digest` for a `bootstrap_scan`
 * job. The hash binds the plan id + the project
 * id so a re-enqueue with a different plan id
 * surfaces `idempotency_digest_mismatch`.
 */
export function bootstrapScanInputDigest(args: {
  plan_id: string;
  project_id: string;
}): string {
  return "sha256:" + createHash("sha256")
    .update(JSON.stringify({ kind: "bootstrap_scan", plan_id: args.plan_id, project_id: args.project_id }))
    .digest("hex");
}

export function bootstrapApplyInputDigest(args: {
  plan_id: string;
  project_id: string;
  actor: string;
}): string {
  return "sha256:" + createHash("sha256")
    .update(JSON.stringify({ kind: "bootstrap_apply", plan_id: args.plan_id, project_id: args.project_id, actor: args.actor }))
    .digest("hex");
}

/**
 * Stable config digest. The executor's effective
 * configuration is the project's identity row +
 * the allow list. The hash is the literal
 * `bootstrap_scan` / `bootstrap_apply` string so
 * the digests are stable across processes.
 */
export const BOOTSTRAP_SCAN_CONFIG_DIGEST =
  "sha256:" + createHash("sha256").update("bootstrap_scan").digest("hex");
export const BOOTSTRAP_APPLY_CONFIG_DIGEST =
  "sha256:" + createHash("sha256").update("bootstrap_apply").digest("hex");

/**
 * The `bootstrap_scan` executor. Reads the
 * `(plan_id, project_id)` pair from the job's
 * `cursor_json` and runs `BootstrapService.scan`
 * with the same source set. A re-scan with no
 * content change produces 0 new plan items; the
 * executor records the (potentially fresh) plan
 * id as a `derivation_outputs` row so the next
 * `bootstrap_apply` job can find it.
 */
export class BootstrapScanExecutor implements DerivationJobExecutor {
  readonly kind = "bootstrap_scan";

  execute(args: Parameters<DerivationJobExecutor["execute"]>[0]): Promise<StageOutcome> {
    return (async () => {
      const { job, store, startStage } = args;
      const cursor = JSON.parse(job.cursor_json) as { plan_id?: string; project_id?: string; actor?: string };
      const plan_id = cursor.plan_id;
      const project_id = cursor.project_id ?? job.project_id;
      if (typeof plan_id !== "string" || typeof project_id !== "string") {
        return {
          status: "failed",
          error_code: "stage_validation_failed",
          error_message: "bootstrap_scan job cursor is missing plan_id or project_id"
        };
      }
      const plan = store.getBootstrapPlan(plan_id);
      if (plan === undefined) {
        return {
          status: "failed",
          error_code: "job_not_found",
          error_message: `bootstrap_plan_not_found: ${plan_id}`
        };
      }
      const stage = startStage("scan", [{ kind: "file", id: plan_id }]);
      const bootstrap = new BootstrapService(store, new ExternalReferenceService(store));
      try {
        const result = bootstrap.scan({
          project_id,
          actor: cursor.actor ?? job.creator_actor_id
        });
        stage.finish("succeeded", result.config_digest + ":" + result.source_set_digest, [
          { output_kind: "bootstrap_plan", output_id: result.plan_id, disposition: "applied" }
        ]);
        return { status: "succeeded" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stage.finish("failed", undefined, []);
        return { status: "failed", error_code: "internal_error", error_message: message };
      }
    })();
  }
}

/**
 * The `bootstrap_apply` executor. Reads the
 * `(plan_id, project_id)` pair from the job's
 * `cursor_json` and runs `BootstrapService.applyPlan`
 * with an empty dispatch (the apply path needs a
 * configured dispatch for `propose_memory` /
 * `propose_context_pack` items; the v1.2-alpha.2
 * runner surface records the plan as
 * `bootstrap_apply:applied` and defers the actual
 * dispatch to the synchronous CLI command). The
 * apply path used by the runner is intentionally
 * conservative: it skips `propose_memory` items
 * and only persists `register_external_ref`
 * items. The `bootstrap_apply` executor is the
 * v1.2-alpha.2 foothold; richer dispatch ships
 * with the #50 / #53 follow-ups.
 */
export class BootstrapApplyExecutor implements DerivationJobExecutor {
  readonly kind = "bootstrap_apply";

  execute(args: Parameters<DerivationJobExecutor["execute"]>[0]): Promise<StageOutcome> {
    return (async () => {
      const { job, store, startStage } = args;
      const cursor = JSON.parse(job.cursor_json) as { plan_id?: string; project_id?: string; actor?: string };
      const plan_id = cursor.plan_id;
      const project_id = cursor.project_id ?? job.project_id;
      if (typeof plan_id !== "string" || typeof project_id !== "string") {
        return {
          status: "failed",
          error_code: "stage_validation_failed",
          error_message: "bootstrap_apply job cursor is missing plan_id or project_id"
        };
      }
      const plan = store.getBootstrapPlan(plan_id);
      if (plan === undefined) {
        return {
          status: "failed",
          error_code: "job_not_found",
          error_message: `bootstrap_plan_not_found: ${plan_id}`
        };
      }
      const stage = startStage("apply", [{ kind: "file", id: plan_id }]);
      const bootstrap = new BootstrapService(store, new ExternalReferenceService(store));
      try {
        const result = bootstrap.applyPlan(plan_id, cursor.actor ?? job.creator_actor_id, {});
        const digest = "sha256:" + createHash("sha256")
          .update(JSON.stringify({ plan_id, state: result.state, applied: result.applied }))
          .digest("hex");
        stage.finish(result.state === "applied" ? "succeeded" : "failed", digest, [
          { output_kind: "bootstrap_plan", output_id: plan_id, disposition: result.state === "applied" ? "applied" : "rejected" }
        ]);
        return {
          status: result.state === "applied" ? "succeeded" : "failed",
          ...(result.state === "failed" ? { error_code: "internal_error" as const, error_message: "plan state moved to failed during apply" } : {})
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stage.finish("failed", undefined, []);
        return { status: "failed", error_code: "internal_error", error_message: message };
      }
    })();
  }
}

/**
 * Convenience aggregator: the standard
 * `[bootstrapScan, bootstrapApply]` executor pair
 * the CLI / runner should register. The pair is
 * the only v1.2-alpha.2 kind registered by the
 * default CLI runner.
 */
export function defaultBootstrapExecutors(): ReadonlyArray<DerivationJobExecutor> {
  return [new BootstrapScanExecutor(), new BootstrapApplyExecutor()];
}
