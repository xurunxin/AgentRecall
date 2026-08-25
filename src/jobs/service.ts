// src/jobs/service.ts
//
// v1.2.0-alpha.0 (issue #48): the durable derivation
// job substrate. Every provider-backed / multi-stage /
// cancellable pipeline introduced in v1.2 (session
// distillation, skill extraction, cold-start bootstrap,
// external-reference refresh) is built on top of this
// service. The contract is documented in
// `docs/adr/0009-derivation-job-lifecycle.md`; the
// short version:
//
//   1. `enqueue(...)` reserves a job. The
//      `(creator_actor_id, kind, idempotency_key)` triple
//      is replayable: a second enqueue with the same
//      triple + same `input_digest` + same `config_digest`
//      returns the original `job_id` without creating a
//      new row. A replay with a different digest throws
//      `idempotency_digest_mismatch` so a caller that
//      mutated the input between retries does not
//      silently get a different result.
//   2. `claim(...)` atomically transitions the job into
//      `running` with a short lease. Two workers calling
//      `claim` for the same job at the same time get
//      exactly one winner.
//   3. `checkpoint(...)` advances the per-stage audit
//      trail (`derivation_runs` rows + the `cursor_json`
//      column on the job). Checkpoints are the only way
//      progress is recorded; a runner that crashes between
//      checkpoints loses at most one stage's worth of
//      work and the next worker takes over after the
//      lease expires.
//   4. `complete(...)` / `fail(...)` / `cancel(...)`
//      move the job to a terminal state. The terminal
//      state is durable; a reap takeover that tries to
//      write the same `applied` derivation_outputs row
//      twice is a no-op (the unique constraint short-
//      circuits the second insert).
//   5. `reap()` is a passive helper that resets any
//      `running` job whose lease has expired. The runner
//      calls it at the start of every claim cycle; no
//      background daemon is required.
//
// The service is a thin wrapper over the new
// `SQLiteMemoryStore` methods (`getDerivationJob`,
// `insertDerivationJob`, `claimDerivationJob`, ...).
// All multi-statement transitions are wrapped in a
// single `BEGIN IMMEDIATE` transaction so the state
// machine is consistent across crash boundaries.

import { createHash, randomUUID } from "node:crypto";

import type {
  DerivationJobRow,
  DerivationJobScope,
  DerivationJobState,
  DerivationOutputKind,
  DerivationOutputRow,
  DerivationRunRow,
  DerivationRunStatus,
  SQLiteMemoryStore
} from "../sqlite-store.js";

import { redactError, truncateRationale } from "./redactor.js";

/**
 * Stable error codes the runner / CLI / MCP layer can
 * surface on the wire. Each error code is intentionally
 * machine-readable; human-readable text belongs in the
 * `redacted_error` column (already scrubbed) or on
 * stderr.
 */
export type DerivationJobErrorCode =
  | "idempotency_digest_mismatch"
  | "not_claimable"
  | "job_not_found"
  | "job_already_terminal"
  | "stage_validation_failed"
  | "provider_timeout"
  | "provider_invalid_output"
  | "policy_version_mismatch"
  | "internal_error";

/**
 * Caller-supplied input for `enqueue`. The two digests
 * are the contract that makes a replay detectable; the
 * runner never recomputes them.
 */
export type EnqueueJobInput = {
  kind: string;
  scope: DerivationJobScope;
  /** Required when `scope === 'project'`. */
  project_id?: string;
  creator_actor_id: string;
  idempotency_key: string;
  /** SHA-256 (or another stable hash) of the canonicalised input. */
  input_digest: string;
  /** SHA-256 of the canonicalised execution + provider config. */
  config_digest: string;
  /** Initial cursor JSON (defaults to `{}` when omitted). */
  initial_cursor?: Record<string, unknown>;
  /** Optional TTL override for the next-retry window on a `failed` job. */
  next_retry_at?: number;
};

/**
 * Result of `enqueue`. The `replayed` flag tells the
 * caller whether a fresh row was created or an existing
 * one was returned. Callers that depend on the
 * `idempotency_digest_mismatch` error should ignore
 * this flag and rely on the thrown error instead.
 */
export type EnqueueJobResult = {
  job: DerivationJobRow;
  replayed: boolean;
};

/**
 * Caller-supplied input for `claim`. The `lease_owner`
 * is a stable per-worker identity (e.g. the runner's PID
 * + a short random suffix); the `lease_ttl_ms` defaults
 * to 30s when omitted.
 */
export type ClaimJobInput = {
  job_id: string;
  lease_owner: string;
  lease_ttl_ms?: number;
};

export type ClaimJobResult =
  | { ok: true; job: DerivationJobRow; lease_expires_at: number }
  | { ok: false; error: "not_claimable" };

/**
 * Per-stage audit row. The `policy_version` is the
 * schema/git-tag/version of the policy that produced
 * the stage result; the `provider_id` / `model_id` are
 * only set when the stage actually called a provider.
 */
export type StartStageInput = {
  job_id: string;
  stage: string;
  input_refs: ReadonlyArray<DerivationRef>;
  policy_version: string;
  provider_id?: string;
  model_id?: string;
  prompt_template_version?: string;
  prompt_hash?: string;
};

export type FinishStageInput = {
  run_id: string;
  status: Extract<DerivationRunStatus, "succeeded" | "failed" | "cancelled">;
  output_refs?: ReadonlyArray<DerivationRef>;
  outputs?: ReadonlyArray<DerivationOutputDescriptor>;
  cursor?: Record<string, unknown>;
  result_digest?: string;
  error_code?: DerivationJobErrorCode;
  redacted_error?: string;
};

export type DerivationRef = {
  kind: "memory" | "asset" | "session_event" | "file" | "external_ref";
  id: string;
  revision?: number;
  version?: number;
};

export type DerivationOutputDescriptor = {
  output_kind: DerivationOutputKind;
  output_id: string;
  disposition: DerivationOutputRow["disposition"];
};

/**
 * Default lease TTL. Kept short so a crashed runner
 * does not strand a `running` job for more than 30s;
 * pure-local stages (which is all of v1.2's first
 * release) finish well under that window. The
 * `--lease-ttl` CLI flag overrides it.
 */
export const DEFAULT_LEASE_TTL_MS = 30_000;

/**
 * Schema/policy version stamped on every run row. The
 * value is consumed by the admin app to flag stages
 * produced by a stale policy (e.g. after a security
 * patch); bumping it is a deliberate operation.
 */
export const DEFAULT_POLICY_VERSION = "1.2.0-alpha.0/v48";

/**
 * Deterministic, stable SHA-256 helper used to digest
 * cursors + outputs for `result_digest`. We do **not**
 * use the secret-aware `canonicalJson` because the
 * input never contains secrets (it is the runner's
 * own cursor + output descriptor list).
 */
function sha256Hex(input: string): string {
  return "sha256:" + createHash("sha256").update(input).digest("hex");
}

export class DerivationJobStore {
  constructor(private readonly store: SQLiteMemoryStore) {}

  /**
   * Enqueue a derivation job. The unique
   * `(creator_actor_id, kind, idempotency_key)` constraint
   * on the underlying table is the durability surface;
   * a duplicate insert with the same triple returns the
   * original `job_id` (and a `replayed: true` flag).
   * A duplicate insert with a different
   * `input_digest` / `config_digest` throws
   * `idempotency_digest_mismatch` (issue #48 AC #3).
   */
  enqueue(input: EnqueueJobInput): EnqueueJobResult {
    if (input.scope === "project" && input.project_id === undefined) {
      throw new Error(
        "[internal_error] derivation job with scope='project' must specify project_id"
      );
    }
    const existing = this.store.getDerivationJobByIdempotency(
      input.creator_actor_id,
      input.kind,
      input.idempotency_key
    );
    if (existing !== undefined) {
      if (
        existing.input_digest !== input.input_digest ||
        existing.config_digest !== input.config_digest
      ) {
        const err: Error & { code?: string } = new Error(
          `idempotency_digest_mismatch: a derivation job with the same ` +
            `(creator_actor_id, kind, idempotency_key) already exists ` +
            `with a different input or config digest`
        );
        err.code = "idempotency_digest_mismatch";
        throw err;
      }
      return { job: existing, replayed: true };
    }
    const now = Date.now();
    const row: DerivationJobRow = {
      job_id: `job_${randomUUID()}`,
      kind: input.kind,
      state: "queued",
      scope: input.scope,
      project_id: input.project_id ?? null,
      creator_actor_id: input.creator_actor_id,
      idempotency_key: input.idempotency_key,
      input_digest: input.input_digest,
      config_digest: input.config_digest,
      cursor_json: JSON.stringify(input.initial_cursor ?? {}),
      attempt_count: 0,
      lease_owner: null,
      lease_expires_at: null,
      cancel_requested_at: null,
      next_retry_at: input.next_retry_at ?? null,
      error_code: null,
      redacted_error: null,
      created_at: now,
      started_at: null,
      updated_at: now,
      finished_at: null
    };
    this.store.insertDerivationJob(row);
    const stored = this.store.getDerivationJob(row.job_id);
    if (stored === undefined) {
      throw new Error(
        `[internal_error] derivation job ${row.job_id} disappeared immediately after insert`
      );
    }
    return { job: stored, replayed: false };
  }

  /**
   * Passively reap any `running` job whose lease has
   * expired. Returns the number of jobs reset. The
   * runner calls this at the start of every claim
   * cycle (issue #48 AC #2).
   */
  reap(now: number = Date.now()): number {
    return this.store.reapExpiredDerivationJobLeases(now);
  }

  /**
   * Claim a specific job. Returns `{ ok: true, ... }` on
   * success; `{ ok: false, error: 'not_claimable' }` if
   * another worker beat us to it or the job is in a
   * terminal state. A `reap()` call is implicit so a
   * freshly crashed worker's job is reclaimable without
   * any external scheduler.
   */
  claim(input: ClaimJobInput, now: number = Date.now()): ClaimJobResult {
    this.reap(now);
    const ttl = input.lease_ttl_ms ?? DEFAULT_LEASE_TTL_MS;
    const lease_expires_at = now + ttl;
    const job = this.store.claimDerivationJob({
      job_id: input.job_id,
      lease_owner: input.lease_owner,
      lease_expires_at,
      started_at: now,
      now
    });
    if (job === undefined) return { ok: false, error: "not_claimable" };
    return { ok: true, job, lease_expires_at };
  }

  /**
   * Find the next claimable job, optionally filtered by
   * `kind`. The runner iterates this list and calls
   * `claim()` for each one.
   */
  listClaimable(
    kind: string | undefined,
    now: number = Date.now(),
    limit: number = 32
  ): DerivationJobRow[] {
    this.reap(now);
    return this.store.listClaimableDerivationJobs(kind, now, limit);
  }

  /**
   * Begin a new stage. The returned `run_id` is the
   * `derivation_runs` row in `started` state; the
   * caller passes it to `finishStage()` to commit the
   * terminal state + outputs.
   */
  startStage(input: StartStageInput, now: number = Date.now()): DerivationRunRow {
    const job = this.store.getDerivationJob(input.job_id);
    if (job === undefined) {
      throw jobNotFoundError(input.job_id);
    }
    if (job.state !== "running") {
      throw new Error(
        `[internal_error] cannot start stage on job ${input.job_id} in state '${job.state}'`
      );
    }
    const run_id = `run_${randomUUID()}`;
    const row: DerivationRunRow = {
      run_id,
      job_id: input.job_id,
      stage: input.stage,
      status: "started",
      input_refs_json: JSON.stringify(input.input_refs),
      output_refs_json: "[]",
      provider_id: input.provider_id ?? null,
      model_id: input.model_id ?? null,
      prompt_template_version: input.prompt_template_version ?? null,
      prompt_hash: input.prompt_hash ?? null,
      policy_version: input.policy_version,
      result_digest: null,
      started_at: now,
      finished_at: null
    };
    this.store.insertDerivationRun(row);
    return row;
  }

  /**
   * Finalise a stage. This is the only place the
   * `cursor_json` is written; the change is committed
   * atomically with the run row's terminal state and
   * the optional `derivation_outputs` rows. A cancel
   * request observed between `startStage` and
   * `finishStage` produces `status: 'cancelled'`.
   */
  finishStage(input: FinishStageInput, now: number = Date.now()): DerivationRunRow {
    const output_refs_json = JSON.stringify(input.output_refs ?? []);
    const result_digest = input.result_digest ?? null;
    const ok = this.store.completeDerivationRun({
      run_id: input.run_id,
      status: input.status,
      output_refs_json,
      result_digest,
      finished_at: now
    });
    if (!ok) {
      throw new Error(
        `[internal_error] cannot finish stage: run ${input.run_id} is not in 'started' state`
      );
    }
    if (input.cursor !== undefined) {
      const cursor_json = JSON.stringify(input.cursor);
      this.store.checkpointDerivationJob(
        this.runJobId(input.run_id),
        cursor_json,
        now
      );
    }
    if (input.outputs !== undefined && input.outputs.length > 0) {
      for (const out of input.outputs) {
        this.store.insertDerivationOutput({
          job_id: this.runJobId(input.run_id),
          run_id: input.run_id,
          output_kind: out.output_kind,
          output_id: out.output_id,
          disposition: out.disposition,
          created_at: now
        });
      }
    }
    const updated = this.store.listDerivationRunsForJob(this.runJobId(input.run_id));
    const run = updated.find((r) => r.run_id === input.run_id);
    if (run === undefined) {
      throw new Error(
        `[internal_error] run ${input.run_id} disappeared after finishStage`
      );
    }
    return run;
  }

  /**
   * Mark the job as terminal `succeeded`. The caller has
   * already written any `derivation_outputs` rows it
   * wanted to expose; this method only flips the job
   * state.
   */
  complete(
    job_id: string,
    now: number = Date.now()
  ): DerivationJobRow {
    const updated = this.store.finalizeDerivationJob({
      job_id,
      terminal_state: "succeeded",
      now
    });
    if (updated === undefined) throw jobNotFoundError(job_id);
    return updated;
  }

  /**
   * Mark the job as terminal `failed` with a redacted
   * error string + an optional retry window. The
   * `error_code` is the machine-readable category
   * (see `DerivationJobErrorCode`); the `error_message`
   * is the raw, un-truncated error (it is scrubbed
   * here before persistence).
   */
  fail(
    job_id: string,
    error_code: DerivationJobErrorCode,
    error_message: string | null | undefined,
    next_retry_at: number | null | undefined,
    now: number = Date.now()
  ): DerivationJobRow {
    const updated = this.store.finalizeDerivationJob({
      job_id,
      terminal_state: "failed",
      error_code,
      redacted_error: redactError(error_message),
      next_retry_at: next_retry_at ?? null,
      now
    });
    if (updated === undefined) throw jobNotFoundError(job_id);
    return updated;
  }

  /**
   * Request cancellation. Sets `cancel_requested_at` on
   * the job; the runner observes it at the next stage
   * boundary and routes to a terminal `cancelled` state.
   * The job is *not* moved to `cancelled` here — that
   * transition is the runner's responsibility, so the
   * current stage can finish cleanly and write its
   * `derivation_outputs` rows.
   */
  requestCancel(job_id: string, now: number = Date.now()): boolean {
    return this.store.requestDerivationJobCancel(job_id, now);
  }

  /**
   * Mark the job as terminal `cancelled`. Called by the
   * runner when it observes `cancel_requested_at` and
   * decides the current stage is the terminal one.
   */
  markCancelled(job_id: string, now: number = Date.now()): DerivationJobRow {
    const updated = this.store.finalizeDerivationJob({
      job_id,
      terminal_state: "cancelled",
      now
    });
    if (updated === undefined) throw jobNotFoundError(job_id);
    return updated;
  }

  /**
   * Read a job by id, with its run + output rows. Used
   * by `jobs show <id>` and the `agentrecall://jobs/{id}`
   * MCP resource.
   */
  inspect(job_id: string): JobInspection | undefined {
    const job = this.store.getDerivationJob(job_id);
    if (job === undefined) return undefined;
    return {
      job,
      runs: this.store.listDerivationRunsForJob(job_id),
      outputs: this.store.listDerivationOutputsForJob(job_id)
    };
  }

  /**
   * List jobs for the CLI / MCP inspector.
   */
  list(filter: {
    state?: DerivationJobState;
    kind?: string;
    limit?: number;
  }): DerivationJobRow[] {
    return this.store.listDerivationJobs({
      ...(filter.state !== undefined ? { state: filter.state } : {}),
      ...(filter.kind !== undefined ? { kind: filter.kind } : {}),
      limit: filter.limit ?? 50
    });
  }

  /**
   * Stable hash for an output list. Used by the
   * deterministic baseline extractor (Phase 2 #50) to
   * verify idempotent re-runs produce the same
   * `result_digest` without persisting the raw output
   * body.
   */
  static hashOutputs(
    outputs: ReadonlyArray<DerivationOutputDescriptor>
  ): string {
    const sorted = [...outputs].sort((a, b) =>
      a.output_id < b.output_id
        ? -1
        : a.output_id > b.output_id
          ? 1
          : a.output_kind < b.output_kind
            ? -1
            : a.output_kind > b.output_kind
              ? 1
              : 0
    );
    return sha256Hex(JSON.stringify(sorted));
  }

  static hashRefs(refs: ReadonlyArray<DerivationRef>): string {
    const sorted = [...refs].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );
    return sha256Hex(JSON.stringify(sorted));
  }

  static truncateRationale = truncateRationale;

  /**
   * Resolve the `job_id` of a run. Internal — used by
   * `finishStage` to keep the public API free of
   * redundant lookups. Throws when the run is missing
   * (which would mean the store is in an inconsistent
   * state and a programmer error occurred).
   */
  private runJobId(run_id: string): string {
    const run = this.store.getDerivationRun(run_id);
    if (run === undefined) {
      throw new Error(
        `[internal_error] derivation run ${run_id} has no parent job`
      );
    }
    return run.job_id;
  }
}

export type JobInspection = {
  job: DerivationJobRow;
  runs: DerivationRunRow[];
  outputs: DerivationOutputRow[];
};

function jobNotFoundError(job_id: string): Error {
  const err: Error & { code?: string } = new Error(
    `job_not_found: no derivation job with id ${job_id}`
  );
  err.code = "job_not_found";
  return err;
}
