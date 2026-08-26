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
  /**
   * v1.2.0-alpha.2 (issue #54): when set, the
   * runner keeps polling `listClaimable` every
   * `poll_ms` after an empty pass. The runner
   * exits when the `signal` is aborted, the
   * store throws, or `stop_after_empty_passes`
   * consecutive empty passes have been
   * observed. The CLI `--watch` mode sets
   * `stop_after_empty_passes` to a very large
   * number and relies on the abort signal
   * (SIGINT) to terminate the loop.
   *
   * When `poll_ms` is omitted, the runner
   * performs a single pass and returns the
   * `RunOnceResult` (the v1.2-alpha.0 contract).
   */
  poll_ms?: number;
  /**
   * Number of consecutive empty passes before
   * the loop exits. Defaults to `1` so a single
   * empty pass returns the same counters as the
   * non-watch path. The CLI `--watch` flag
   * sets this to `Number.POSITIVE_INFINITY`.
   */
  stop_after_empty_passes?: number;
  /**
   * Optional callback invoked after every
   * `runOnce` pass. The CLI uses it to log
   * progress and to surface the abort signal.
   */
  on_pass?: (result: RunOnceResult) => void;
};

export type RunOnceResult = {
  attempted: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  passes: number;
  loop_exit_reason?: "signal" | "stop_after_empty_passes" | "store_error";
};

/**
 * Process one or more batches of claimable jobs.
 * Returns a summary the CLI / MCP layer can
 * surface. The runner is synchronous from the
 * caller's perspective; it awaits each executor
 * and only moves on once the previous job is
 * terminal.
 *
 * v1.2.0-alpha.0 (issue #48): the basic
 * one-pass contract.
 * v1.2.0-alpha.2 (issue #54): when
 * `opts.poll_ms` is set, the runner keeps
 * polling after an empty pass. The default
 * `stop_after_empty_passes` is `1` so the
 * non-watch path retains the old single-pass
 * behaviour. The CLI `--watch` mode overrides
 * it to `Number.POSITIVE_INFINITY` and relies
 * on the abort signal (SIGINT) to terminate the
 * loop.
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
  let passes = 0;
  let consecutive_empty = 0;
  const stop_after_empty_passes = opts.stop_after_empty_passes ?? 1;
  const poll_ms = opts.poll_ms;

  while (true) {
    passes += 1;
    if (isSignalAborted(opts.signal)) {
      return {
        attempted,
        succeeded,
        failed,
        cancelled,
        passes,
        loop_exit_reason: "signal"
      };
    }
    let pass_attempted = 0;
    let pass_succeeded = 0;
    let pass_failed = 0;
    let pass_cancelled = 0;
    let pass_error: Error | null = null;

    for (let i = 0; i < cap; i += 1) {
      if (isSignalAborted(opts.signal)) break;
      let job;
      try {
        const candidates = jobStore.listClaimable(opts.kind, Date.now(), 1);
        job = candidates[0];
      } catch (error) {
        pass_error = error instanceof Error ? error : new Error(String(error));
        break;
      }
      if (job === undefined) break;
      let claim;
      try {
        claim = jobStore.claim(
          {
            job_id: job.job_id,
            lease_owner: opts.lease_owner,
            ...(opts.lease_ttl_ms !== undefined ? { lease_ttl_ms: opts.lease_ttl_ms } : {})
          },
          Date.now()
        );
      } catch (error) {
        pass_error = error instanceof Error ? error : new Error(String(error));
        break;
      }
      if (!claim.ok) {
        // The job was claimed by another worker
        // between our `listClaimable` and our
        // `claim` call, or the reap cycle reset
        // it. The next iteration will pick up the
        // new claimable row, if any.
        continue;
      }
      pass_attempted += 1;
      const executor = executorsByKind.get(job.kind);
      if (executor === undefined) {
        jobStore.fail(
          claim.job.job_id,
          "internal_error",
          `no executor registered for kind '${claim.job.kind}'`,
          null,
          Date.now()
        );
        pass_failed += 1;
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
            pass_succeeded += 1;
            break;
          case "failed":
            jobStore.fail(
              claim.job.job_id,
              outcome.error_code ?? "internal_error",
              outcome.error_message ?? null,
              outcome.next_retry_at ?? null,
              Date.now()
            );
            pass_failed += 1;
            break;
          case "cancelled":
            jobStore.markCancelled(claim.job.job_id, Date.now());
            pass_cancelled += 1;
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
        pass_failed += 1;
      }
    }

    attempted += pass_attempted;
    succeeded += pass_succeeded;
    failed += pass_failed;
    cancelled += pass_cancelled;

    const passResult: RunOnceResult = {
      attempted: pass_attempted,
      succeeded: pass_succeeded,
      failed: pass_failed,
      cancelled: pass_cancelled,
      passes: 1,
      ...(pass_error !== null ? { loop_exit_reason: "store_error" as const } : {})
    };
    opts.on_pass?.(passResult);

    if (pass_error !== null) {
      return {
        attempted,
        succeeded,
        failed,
        cancelled,
        passes,
        loop_exit_reason: "store_error"
      };
    }
    if (isSignalAborted(opts.signal)) {
      return {
        attempted,
        succeeded,
        failed,
        cancelled,
        passes,
        loop_exit_reason: "signal"
      };
    }
    if (pass_attempted === 0) {
      consecutive_empty += 1;
      if (consecutive_empty >= stop_after_empty_passes) {
        return {
          attempted,
          succeeded,
          failed,
          cancelled,
          passes,
          loop_exit_reason: "stop_after_empty_passes"
        };
      }
    } else {
      consecutive_empty = 0;
    }
    if (poll_ms === undefined) {
      return {
        attempted,
        succeeded,
        failed,
        cancelled,
        passes
      };
    }
    await sleepInterruptible(poll_ms, opts.signal);
  }
}

function sleepInterruptible(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Helper that re-evaluates `signal.aborted` on
 * every call. Pulled out so the type narrowing
 * inside the polling loop does not get cached
 * across loop iterations.
 */
function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted === true;
}

export const _internal = {
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_POLICY_VERSION
};
