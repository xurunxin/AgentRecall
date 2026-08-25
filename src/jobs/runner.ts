// src/jobs/runner.ts
//
// v1.2.0-alpha.0 (issue #48): the synchronous job
// runner. Each `kind` of derivation job is implemented
// as a `DerivationJobExecutor` (one per kind); the
// runner iterates `DerivationJobStore.listClaimable`,
// claims one job at a time, and dispatches to the
// matching executor.
//
// The runner is intentionally minimal:
//
//   - One pass per call. The CLI `jobs run --once` uses
//     this so a synchronous enqueue + run command exits
//     after the next batch.
//   - A `--watch` flag in the CLI wraps the one-pass
//     runner in a polling loop that sleeps for
//     `poll_ms` between empty iterations.
//   - The runner catches *all* errors thrown by the
//     executor, records them via
//     `DerivationJobStore.fail`, and moves on to the
//     next job. A buggy executor for one kind cannot
//     strand the runner for unrelated kinds.
//
// Cancellation and reap are handled inside the
// `DerivationJobStore` (passive reap-on-claim,
// `cancel_requested_at` polled at stage boundaries).
// The runner itself is single-threaded; concurrent
// workers on the same data home coordinate through
// the `claimDerivationJob` lease.

import { randomUUID } from "node:crypto";

import type { SQLiteMemoryStore } from "../sqlite-store.js";

import {
  DerivationJobStore,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_POLICY_VERSION,
  type DerivationJobErrorCode,
  type DerivationRef,
  type DerivationOutputDescriptor
} from "./service.js";

/**
 * A single derivation kind's executor. The runner
 * constructs one executor per kind; the executor is
 * responsible for the multi-stage work *outside* the
 * SQLite write transaction (issue #48 "Work outside
 * txn"). The runner reads the immutable inputs, then
 * calls `execute`, then writes the outputs.
 *
 * `execute` returns a `StageOutcome` that describes the
 * terminal state of the job (`succeeded` / `failed` /
 * `cancelled`) plus any lineage rows to persist. The
 * runner translates the outcome into a
 * `derivation_runs` row + `derivation_outputs` rows
 * + (if terminal) a `derivation_jobs` state transition.
 */
export type DerivationJobExecutor = {
  readonly kind: string;
  execute(args: {
    job: import("../sqlite-store.js").DerivationJobRow;
    store: SQLiteMemoryStore;
    startStage: (
      stage: string,
      input_refs: ReadonlyArray<DerivationRef>,
      provider?: {
        provider_id?: string;
        model_id?: string;
        prompt_template_version?: string;
        prompt_hash?: string;
      }
    ) => {
      finish: (
        status: "succeeded" | "failed" | "cancelled",
        result_digest?: string,
        outputs?: ReadonlyArray<DerivationOutputDescriptor>
      ) => void;
    };
    signal?: AbortSignal;
  }): Promise<StageOutcome>;
};

export type StageOutcome = {
  /**
   * The terminal status of the *job*. A multi-stage
   * pipeline whose first stage fails returns
   * `status: 'failed'` here so the runner marks the
   * job terminal immediately; later stages are not
   * attempted.
   */
  status: "succeeded" | "failed" | "cancelled";
  /**
   * When `status === 'failed'`, the machine-readable
   * error code. Defaults to `'internal_error'`. The
   * human-readable message is the `error_message`
   * field; the runner passes it through the
   * `DerivationJobStore.fail` redaction.
   */
  error_code?: DerivationJobErrorCode;
  error_message?: string;
  /**
   * Optional next-retry window for `failed` jobs. When
   * set, the runner writes it into the job's
   * `next_retry_at` column so the next claim cycle
   * surfaces the job again after the deadline.
   */
  next_retry_at?: number;
};

/**
 * Per-worker stable identity. The runner uses
 * `pid + randomUUID()` so a `--watch` loop restarts get
 * a fresh identity (no stale leases).
 */
export function makeLeaseOwner(): string {
  return `runner-${process.pid}-${randomUUID().slice(0, 8)}`;
}

export type RunOnceOptions = {
  kind?: string;
  lease_owner: string;
  lease_ttl_ms?: number;
  policy_version?: string;
  signal?: AbortSignal;
  /** Cap on the number of jobs processed in a single pass. */
  max_jobs?: number;
};

export type RunOnceResult = {
  attempted: number;
  succeeded: number;
  failed: number;
  cancelled: number;
};

/**
 * Process a single batch of claimable jobs. Returns a
 * summary the CLI / MCP layer can surface. The runner
 * is synchronous from the caller's perspective; it
 * awaits each executor and only moves on once the
 * previous job is terminal.
 */
export async function runOnce(
  store: SQLiteMemoryStore,
  executors: ReadonlyArray<DerivationJobExecutor>,
  opts: RunOnceOptions
): Promise<RunOnceResult> {
  const jobStore = new DerivationJobStore(store);
  const executorsByKind = new Map<string, DerivationJobExecutor>();
  for (const ex of executors) {
    executorsByKind.set(ex.kind, ex);
  }
  const cap = opts.max_jobs ?? 16;
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let cancelled = 0;

  for (let i = 0; i < cap; i += 1) {
    if (opts.signal?.aborted === true) break;
    const candidates = jobStore.listClaimable(opts.kind, Date.now(), 1);
    const job = candidates[0];
    if (job === undefined) break;
    const claim = jobStore.claim(
      {
        job_id: job.job_id,
        lease_owner: opts.lease_owner,
        ...(opts.lease_ttl_ms !== undefined ? { lease_ttl_ms: opts.lease_ttl_ms } : {})
      },
      Date.now()
    );
    if (!claim.ok) {
      // The job was claimed by another worker between
      // our `listClaimable` and our `claim` call, or
      // the reap cycle reset it. The next iteration
      // will pick up the new claimable row, if any.
      continue;
    }
    attempted += 1;
    const executor = executorsByKind.get(job.kind);
    if (executor === undefined) {
      // The kind has no registered executor. Mark the
      // claimed job as `failed` with the canonical
      // `internal_error` code. The runner is allowed
      // to fail-fast on a misconfigured kind because
      // the next `listClaimable` will exclude the
      // terminal row.
      jobStore.fail(
        claim.job.job_id,
        "internal_error",
        `no executor registered for kind '${claim.job.kind}'`,
        null,
        Date.now()
      );
      failed += 1;
      continue;
    }
    try {
      const outcome = await executor.execute({
        job: claim.job,
        store,
        startStage: (stage, input_refs, provider) => {
          const run = jobStore.startStage(
            {
              job_id: claim.job.job_id,
              stage,
              input_refs,
              policy_version: opts.policy_version ?? DEFAULT_POLICY_VERSION,
              ...(provider?.provider_id !== undefined ? { provider_id: provider.provider_id } : {}),
              ...(provider?.model_id !== undefined ? { model_id: provider.model_id } : {}),
              ...(provider?.prompt_template_version !== undefined
                ? { prompt_template_version: provider.prompt_template_version }
                : {}),
              ...(provider?.prompt_hash !== undefined ? { prompt_hash: provider.prompt_hash } : {})
            },
            Date.now()
          );
          return {
            finish: (status, result_digest, outputs) => {
              jobStore.finishStage(
                {
                  run_id: run.run_id,
                  status,
                  ...(result_digest !== undefined ? { result_digest } : {}),
                  ...(outputs !== undefined ? { outputs } : {})
                },
                Date.now()
              );
            }
          };
        },
        ...(opts.signal !== undefined ? { signal: opts.signal } : {})
      });
      switch (outcome.status) {
        case "succeeded":
          jobStore.complete(claim.job.job_id, Date.now());
          succeeded += 1;
          break;
        case "failed":
          jobStore.fail(
            claim.job.job_id,
            outcome.error_code ?? "internal_error",
            outcome.error_message ?? null,
            outcome.next_retry_at ?? null,
            Date.now()
          );
          failed += 1;
          break;
        case "cancelled":
          jobStore.markCancelled(claim.job.job_id, Date.now());
          cancelled += 1;
          break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      jobStore.fail(
        claim.job.job_id,
        "internal_error",
        `executor threw: ${message}`,
        null,
        Date.now()
      );
      failed += 1;
    }
  }

  return { attempted, succeeded, failed, cancelled };
}

export const _internal = {
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_POLICY_VERSION
};
