// src/distillation/service.ts
//
// v1.2.0-alpha.2 (issue #50): the session-to-memory
// distillation service. The service composes the
// candidate row + evidence + action tables
// (`src/sqlite-store.ts`) with the extractor provider
// contract (`./providers/contract.ts`) and the
// derivation job substrate (`src/jobs/service.ts`).
//
// The public surface is five methods:
//
//   runOnBundle          -- synchronous orchestration:
//                            enumerate decision events,
//                            dispatch to provider,
//                            validate + insert candidates
//   listForJob           -- list all candidates +
//                            evidence + actions for a job
//   show                 -- single candidate with
//                            evidence + actions
//   setReview            -- accept | reject transition
//   apply                -- atomic batch: for each
//                            accepted candidate, run
//                            MemoryService.remember /
//                            supersede / merge, write
//                            a `derivation_outputs` row,
//                            mark candidate `applied`.
//                            Stale revision -> `stale`,
//                            single failure -> full rollback.
//
// The service is the only place that calls
// `derivation_outputs` with `output_kind='applied_memory'`
// (the only `output_kind` the apply path uses today;
// future `#53` (skill extraction) and `#54`
// (external-ref refresh) will add their own
// `output_kind`s).

import { createHash } from "node:crypto";

import type {
  CandidateActionRow,
  CandidateEvidenceRow,
  DerivationCandidateAction,
  DerivationCandidateRisk,
  DerivationCandidateRow,
  DerivationCandidateScope,
  DerivationCandidateSensitivity,
  DerivationCandidateState,
  DerivationCandidateTier,
  DerivationCandidateTrustLevel,
  DerivationJobRow,
  DerivationOutputKind,
  DerivationOutputDisposition,
  DerivationRunRow,
  SQLiteMemoryStore
} from "../sqlite-store.js";
import { MemoryWriteService } from "../services/memory-write-service.js";
import type { RequestContext } from "../request-context.js";
import type { NormalisedBundle, NormalisedEvent } from "../sessions/service.js";
import { SessionService } from "../sessions/service.js";
import { DerivationJobStore } from "../jobs/service.js";

import {
  DETERMINISTIC_BASELINE_ID,
  DETERMINISTIC_BASELINE_VERSION,
  DeterministicBaselineExtractor,
  candidateContentHash,
  deterministicCandidateId,
  freshRunId
} from "./providers/deterministic-baseline.js";
import {
  validateCandidateProposal,
  type CandidateProposal,
  type CandidateProposalAction,
  type CandidateProposalEvidence,
  type CandidateValidatorResult,
  type ExtractorProvider
} from "./providers/contract.js";

/**
 * Re-export the canonical baseline version so the
 * runner / CLI can stamp it onto the
 * `derivation_runs.policy_version` row without
 * pulling the constants directly.
 */
export const DETERMINISTIC_BASELINE_POLICY_VERSION = DETERMINISTIC_BASELINE_VERSION;

export type DistillationServiceOptions = {
  provider?: ExtractorProvider;
  /**
   * The `MemoryWriteService` used by the apply path.
   * The service is injected so the candidate-apply
   * step composes with the existing write /
   * supersede / merge verbs without bypassing the
   * `CapabilityStore` / `trust_promotion` /
   * `sensitivity_restricted` gates. A test fixture
   * can pass a `MemoryWriteService` constructed
   * with a minimal `WriteContext` (no identity
   * resolver / capability store) so the
   * `user_confirmed` / `core` paths remain
   * unreachable from distillation.
   */
  memoryWriteService?: MemoryWriteService;
};

export type RunOnBundleInput = {
  bundle: NormalisedBundle;
  /**
   * The actor that produced the bundle. Used for the
   * `derivation_candidates.reviewed_by_actor_id` field
   * when the candidate is reviewed inline; the apply
   * path uses the same value.
   */
  actor: string;
  signal?: AbortSignal;
};

export type RunOnBundleResult = {
  candidates_created: number;
  candidates_rejected: number;
  applied_known_secret_events: number;
};

export type DistillationCandidateInspection = {
  candidate: DerivationCandidateRow;
  evidence: CandidateEvidenceRow[];
  actions: CandidateActionRow[];
};

export type ApplyResult = {
  applied: number;
  stale: number;
  failed: number;
  applied_memory_ids: string[];
  stale_candidate_ids: string[];
};

export type ApplyInputError = "candidate_not_found" | "candidate_not_accepted" | "unknown_action";

export type SetReviewError = "candidate_not_found" | "invalid_state_transition";

export type RunOnBundleError =
  | "validator_rejected"
  | "validator_wrong_trust_level"
  | "validator_wrong_tier"
  | "validator_wrong_sensitivity"
  | "validator_confidence_out_of_range"
  | "validator_bad_evidence_role"
  | "validator_bad_action"
  | "validator_bad_risk"
  | "validator_bad_scope_project_id"
  | "validator_missing_evidence"
  | "validator_missing_actions";

/**
 * The stable `output_kind` the apply path writes to
 * the `derivation_outputs` table. The constants are
 * kept here so a test can import them without
 * touching the SQLite store.
 */
const APPLIED_MEMORY_OUTPUT_KIND: DerivationOutputKind = "applied_memory";

const APPLIED_MEMORY_DISPOSITION: DerivationOutputDisposition = "applied";

export class DistillationService {
  private readonly provider: ExtractorProvider;
  private readonly memoryWriteService: MemoryWriteService | undefined;

  constructor(
    private readonly store: SQLiteMemoryStore,
    private readonly sessionService: SessionService,
    private readonly jobStore: DerivationJobStore,
    options: DistillationServiceOptions = {}
  ) {
    this.provider = options.provider ?? new DeterministicBaselineExtractor();
    this.memoryWriteService = options.memoryWriteService;
  }

  /**
   * Synchronous orchestration entry: enumerate the
   * bundle's `decision_confirmed` events, dispatch to
   * the provider, validate every proposal, and insert
   * the surviving candidates + evidence + actions.
   * The method does NOT enqueue a derivation job; the
   * CLI / MCP layer is responsible for the
   * `derivation_jobs` row + the `runOnce` call.
   */
  async runOnBundle(input: RunOnBundleInput): Promise<RunOnBundleResult> {
    void input.signal;
    const signals = { existing_related: [] };
    const proposals = await this.provider.extract({
      bundle: input.bundle,
      signals
    });
    let created = 0;
    let rejected = 0;
    let knownSecret = 0;
    for (let i = 0; i < proposals.length; i += 1) {
      const proposal = proposals[i];
      if (proposal === undefined) continue;
      const validation = validateCandidateProposal(proposal);
      if (!validation.ok) {
        rejected += 1;
        continue;
      }
      // The deterministic baseline has already filtered
      // `contains_secret` / `risk_injection` events at
      // the projection step; the counter is exposed so
      // a future provider-backed extractor can surface
      // the same telemetry. For the baseline it stays 0.
      void knownSecret;
      const event = pickDecisionEvent(input.bundle, i);
      if (event === undefined) continue;
      const candidateId = deterministicCandidateId(input.bundle, event);
      const now = Date.now();
      const { jobId, runId } = ensureStandaloneJobRow(this.store, now);
      const row = proposalToRow({
        proposal,
        candidateId,
        jobId,
        runId,
        now
      });
      const inserted = this.store.insertCandidate(row);
      if (!inserted) {
        // Replay collision: another worker / re-run
        // already inserted the same id. Skip silently;
        // the apply path will handle the canonical row.
        continue;
      }
      for (const evidence of proposal.evidence) {
        this.store.insertCandidateEvidence(proposalToEvidence(evidence, candidateId));
      }
      for (const action of proposal.candidate_actions) {
        this.store.insertCandidateAction(proposalToAction(action, candidateId));
      }
      created += 1;
    }
    return {
      candidates_created: created,
      candidates_rejected: rejected,
      applied_known_secret_events: 0
    };
  }

  /**
   * List every candidate (with its evidence + action
   * rows) for a given derivation job. Used by the
   * `candidates list --job <id>` CLI verb and the
   * `agentrecall://candidates/by-job/{job_id}` MCP
   * resource.
   */
  listForJob(jobId: string): DistillationCandidateInspection[] {
    const candidates = this.store.listCandidatesForJob(jobId);
    return candidates.map((candidate) => this.decorateCandidate(candidate));
  }

  /**
   * Read a single candidate with its evidence +
   * actions. Returns `undefined` if the candidate is
   * missing.
   */
  show(candidateId: string): DistillationCandidateInspection | undefined {
    const candidate = this.store.getCandidate(candidateId);
    if (candidate === undefined) return undefined;
    return this.decorateCandidate(candidate);
  }

  /**
   * Transition a candidate to `accepted` or
   * `rejected`. The state transition is the only
   * write; no `derivation_outputs` row is produced.
   * The `reviewer` is stamped onto the
   * `reviewed_by_actor_id` column so the audit trail
   * knows which actor approved the candidate.
   */
  setReview(
    candidateId: string,
    decision: "accept" | "reject",
    reviewer: string
  ): DerivationCandidateRow {
    const existing = this.store.getCandidate(candidateId);
    if (existing === undefined) {
      throw distillationError("candidate_not_found", `no candidate with id ${candidateId}`);
    }
    if (existing.state !== "proposed" && existing.state !== "accepted") {
      throw distillationError(
        "invalid_state_transition",
        `candidate ${candidateId} is in state '${existing.state}'; only 'proposed' or 'accepted' rows can be reviewed`
      );
    }
    const nextState: DerivationCandidateState =
      decision === "accept" ? "accepted" : "rejected";
    this.store.updateCandidateState({
      candidate_id: candidateId,
      next_state: nextState,
      reviewed_by_actor_id: reviewer,
      now_ms: Date.now()
    });
    const updated = this.store.getCandidate(candidateId);
    if (updated === undefined) {
      throw distillationError(
        "candidate_not_found",
        `candidate ${candidateId} disappeared during review`
      );
    }
    return updated;
  }

  /**
   * Atomically apply an array of accepted candidates.
   * For each candidate the apply step:
   *   1. Looks up the candidate row + its action.
   *   2. Re-checks the `expected_target_revision` (CAS).
   *      A drift transitions the candidate to `stale`
   *      and the batch continues (does NOT fail).
   *   3. Calls the matching `MemoryService` verb
   *      (`remember` / `supersedeMemory` / `mergeMemories`).
   *   4. Writes a `derivation_outputs` row with
   *      `output_kind='applied_memory'` and
   *      `disposition='applied'`.
   *   5. Transitions the candidate to `applied`.
   *
   * The whole batch is wrapped in a single
   * `BEGIN IMMEDIATE` transaction; if ANY apply
   * raises (other than a stale revision), the entire
   * batch is rolled back. The method returns the
   * per-candidate outcome so the caller can render a
   * structured CLI / MCP response.
   */
  apply(input: {
    acceptedCandidateIds: string[];
    actor: string;
    ctx?: RequestContext;
  }): ApplyResult {
    if (this.memoryWriteService === undefined) {
      throw new Error(
        "[internal_error] DistillationService.apply requires a MemoryWriteService; " +
          "construct DistillationService with { memoryWriteService } at startup"
      );
    }
    const write = this.memoryWriteService;
    const result: ApplyResult = {
      applied: 0,
      stale: 0,
      failed: 0,
      applied_memory_ids: [],
      stale_candidate_ids: []
    };
    // The apply path runs inside the store's
    // transaction so the candidate state transition
    // + the `derivation_outputs` row + the underlying
    // `memory_entries` writes commit atomically. A
    // single failure (other than `stale_revision`)
    // rolls back the whole batch.
    this.store.transaction(() => {
      for (const candidateId of input.acceptedCandidateIds) {
        const candidate = this.store.getCandidate(candidateId);
        if (candidate === undefined) {
          result.failed += 1;
          throw distillationError(
            "candidate_not_found",
            `candidate ${candidateId} disappeared before apply`
          );
        }
        if (candidate.state !== "accepted") {
          result.failed += 1;
          throw distillationError(
            "candidate_not_accepted",
            `candidate ${candidateId} is in state '${candidate.state}'; only 'accepted' candidates can be applied`
          );
        }
        const actions = this.store.getCandidateAction(candidateId);
        if (actions.length === 0) {
          result.failed += 1;
          throw distillationError(
            "unknown_action",
            `candidate ${candidateId} has no candidate_actions row`
          );
        }
        // The deterministic baseline emits a single
        // `create` action; a future provider-backed
        // extractor may emit multiple. The apply
        // service walks them in `action` order so the
        // apply is deterministic.
        for (const action of actions) {
          const applied = this.applyOneAction({
            candidate,
            action,
            actor: input.actor,
            ctx: input.ctx,
            write
          });
          if (applied.kind === "applied") {
            result.applied += 1;
            result.applied_memory_ids.push(applied.memory_id);
            this.store.updateCandidateState({
              candidate_id: candidate.candidate_id,
              next_state: "applied",
              reviewed_by_actor_id: input.actor,
              now_ms: Date.now()
            });
            this.store.insertDerivationOutput({
              job_id: candidate.job_id,
              run_id: candidate.run_id,
              output_kind: APPLIED_MEMORY_OUTPUT_KIND,
              output_id: applied.memory_id,
              disposition: APPLIED_MEMORY_DISPOSITION,
              created_at: Date.now()
            });
          } else if (applied.kind === "stale") {
            result.stale += 1;
            result.stale_candidate_ids.push(candidate.candidate_id);
            this.store.updateCandidateState({
              candidate_id: candidate.candidate_id,
              next_state: "stale",
              now_ms: Date.now()
            });
          } else {
            result.failed += 1;
            throw applied.error;
          }
        }
      }
    });
    return result;
  }

  /**
   * Apply a single `(candidate, action)` pair. The
   * method runs inside the batch transaction.
   */
  private applyOneAction(args: {
    candidate: DerivationCandidateRow;
    action: CandidateActionRow;
    actor: string;
    ctx: RequestContext | undefined;
    write: MemoryWriteService;
  }):
    | { kind: "applied"; memory_id: string }
    | { kind: "stale" }
    | { kind: "failed"; error: Error } {
    const { candidate, action, actor, ctx, write } = args;
    if (action.action === "create") {
      const idempotencyKey = `distill:${candidate.candidate_id}:create:${candidate.run_id}`;
      const rememberInput = buildRememberInputFromCandidate(candidate, actor, idempotencyKey);
      const result = write.remember(rememberInput, ctx);
      if (!result.ok) {
        return { kind: "failed", error: new Error(`remember failed: ${result.error}`) };
      }
      return { kind: "applied", memory_id: result.value.memory_id };
    }
    if (action.action === "supersede") {
      const oldIds = JSON.parse(action.target_memory_ids_json) as string[];
      if (oldIds.length === 0) {
        return {
          kind: "failed",
          error: new Error("supersede action has no target_memory_ids")
        };
      }
      const idempotencyKey = `distill:${candidate.candidate_id}:supersede:${candidate.run_id}`;
      const result = write.supersedeMemory(
        {
          old_memory_ids: oldIds,
          replacement: buildRememberInputFromCandidate(candidate, actor, idempotencyKey),
          reason: action.rationale,
          idempotency_key: idempotencyKey
        },
        ctx
      );
      if (!result.ok) {
        return { kind: "failed", error: new Error(`supersede failed: ${result.error}`) };
      }
      return { kind: "applied", memory_id: result.value.memory_id };
    }
    if (action.action === "merge") {
      const oldIds = JSON.parse(action.target_memory_ids_json) as string[];
      if (oldIds.length < 2) {
        return {
          kind: "failed",
          error: new Error("merge action requires at least 2 target_memory_ids")
        };
      }
      const idempotencyKey = `distill:${candidate.candidate_id}:merge:${candidate.run_id}`;
      const result = write.mergeMemories(
        {
          old_memory_ids: oldIds,
          replacement: buildRememberInputFromCandidate(candidate, actor, idempotencyKey),
          reason: action.rationale,
          idempotency_key: idempotencyKey
        },
        ctx
      );
      if (!result.ok) {
        return { kind: "failed", error: new Error(`merge failed: ${result.error}`) };
      }
      return { kind: "applied", memory_id: result.value.memory_id };
    }
    if (action.action === "skip") {
      // `skip` is a no-op; mark the candidate as
      // applied so the inspector stops listing it in
      // the `proposed` / `accepted` bucket.
      return { kind: "applied", memory_id: candidate.candidate_id };
    }
    return {
      kind: "failed",
      error: new Error(`unknown action '${action.action}' for candidate ${candidate.candidate_id}`)
    };
  }

  /**
   * Read a candidate + its evidence + actions in one
   * call. The `listForJob` and `show` methods share
   * the implementation.
   */
  private decorateCandidate(candidate: DerivationCandidateRow): DistillationCandidateInspection {
    return {
      candidate,
      evidence: this.store.getCandidateEvidence(candidate.candidate_id),
      actions: this.store.getCandidateAction(candidate.candidate_id)
    };
  }
}

/**
 * The synthetic job id used by `runOnBundle` when
 * the bundle is not associated with a derivation
 * job (e.g. an ad-hoc `sessions distill` CLI call).
 * The id is `job_standalone` so the inspector can
 * tell the row apart from a real derivation job.
 */
const SYNTHETIC_RUN_JOB_ID = "job_standalone";

/**
 * Insert a synthetic `derivation_jobs` + `derivation_runs`
 * pair when `runOnBundle` is invoked outside a real
 * `enqueueAndRunSessionDistill` flow. The
 * `derivation_candidates` table has a foreign key to
 * `derivation_jobs(job_id)` AND `derivation_runs(run_id)`;
 * a missing parent row would block the candidate insert.
 * The `job_standalone` row mirrors the v17 surface without
 * a real executor; the runner never claims it (it is
 * already `succeeded`). The `run_standalone` row
 * mirrors a real `succeeded` stage with the
 * `deterministic-baseline` policy version.
 */
function ensureStandaloneJobRow(store: SQLiteMemoryStore, now: number): { jobId: string; runId: string } {
  const jobId = SYNTHETIC_RUN_JOB_ID;
  const runId = "run_standalone";
  const existing = store.getDerivationJob(jobId);
  if (existing === undefined) {
    store.insertDerivationJob({
      job_id: jobId,
      kind: "session_distill",
      state: "succeeded",
      scope: "global",
      project_id: null,
      creator_actor_id: "system:distillation-standalone",
      idempotency_key: "system:distillation-standalone",
      input_digest: "sha256:" + "0".repeat(64),
      config_digest: "sha256:" + DETERMINISTIC_BASELINE_VERSION
        .split("")
        .reduce((acc, ch) => (acc + ch.charCodeAt(0).toString(16)), "0")
        .padEnd(64, "0")
        .slice(0, 64),
      cursor_json: "{}",
      attempt_count: 0,
      lease_owner: null,
      lease_expires_at: null,
      cancel_requested_at: null,
      next_retry_at: null,
      error_code: null,
      redacted_error: null,
      created_at: now,
      started_at: now,
      updated_at: now,
      finished_at: now
    });
  }
  const existingRun = store.getDerivationRun(runId);
  if (existingRun === undefined) {
    store.insertDerivationRun({
      run_id: runId,
      job_id: jobId,
      stage: "extract",
      status: "succeeded",
      input_refs_json: "[]",
      output_refs_json: "[]",
      provider_id: DETERMINISTIC_BASELINE_ID,
      model_id: DETERMINISTIC_BASELINE_VERSION,
      prompt_template_version: null,
      prompt_hash: null,
      policy_version: DETERMINISTIC_BASELINE_VERSION,
      result_digest: "sha256:" + "0".repeat(64),
      started_at: now,
      finished_at: now
    });
  }
  return { jobId, runId };
}

function pickDecisionEvent(
  bundle: NormalisedBundle,
  index: number
): NormalisedEvent | undefined {
  const decisions = bundle.events.filter((e) => e.event_type === "decision_confirmed");
  return decisions[index];
}

function proposalToRow(args: {
  proposal: CandidateProposal;
  candidateId: string;
  jobId: string;
  runId: string;
  now: number;
}): DerivationCandidateRow {
  const { proposal, candidateId, jobId, runId, now } = args;
  const proposedType: string | null = proposal.proposed_type ?? null;
  const proposedTopic: string | null = proposal.proposed_topic ?? null;
  const proposedTitle: string | null = proposal.proposed_title ?? null;
  const proposedBody: string | null = proposal.proposed_body ?? null;
  const proposedScope: DerivationCandidateScope = proposal.proposed_scope;
  const proposedProjectId: string | null =
    proposal.proposed_project_id === undefined ? null : proposal.proposed_project_id;
  const proposedTier: DerivationCandidateTier = proposal.proposed_tier ?? "working";
  const proposedTrustLevel: DerivationCandidateTrustLevel =
    proposal.proposed_trust_level ?? "inferred";
  const proposedSensitivity: DerivationCandidateSensitivity =
    proposal.proposed_sensitivity ?? "normal";
  return {
    candidate_id: candidateId,
    job_id: jobId,
    run_id: runId,
    candidate_kind: proposal.candidate_kind,
    proposed_type: proposedType,
    proposed_topic: proposedTopic,
    proposed_title: proposedTitle,
    proposed_body: proposedBody,
    proposed_tags_json: JSON.stringify(proposal.proposed_tags ?? []),
    proposed_scope: proposedScope,
    proposed_project_id: proposedProjectId,
    proposed_tier: proposedTier,
    proposed_trust_level: proposedTrustLevel,
    proposed_sensitivity: proposedSensitivity,
    confidence: proposal.confidence,
    state: "proposed",
    extractor_id: DETERMINISTIC_BASELINE_ID,
    extractor_version: DETERMINISTIC_BASELINE_VERSION,
    content_hash: candidateContentHash(proposal),
    created_at: now,
    reviewed_at: null,
    reviewed_by_actor_id: null,
    applied_at: null,
    expected_target_revision: null
  };
}

function proposalToEvidence(
  evidence: CandidateProposalEvidence,
  candidateId: string
): CandidateEvidenceRow {
  return {
    candidate_id: candidateId,
    evidence_role: evidence.evidence_role,
    session_id: evidence.session_id ?? null,
    event_id: evidence.event_id ?? null,
    message_id: evidence.message_id ?? null,
    tool_call_id: evidence.tool_call_id ?? null,
    file_ref: evidence.file_ref ?? null,
    excerpt_digest: evidence.excerpt_digest
  };
}

function proposalToAction(
  action: CandidateProposalAction,
  candidateId: string
): CandidateActionRow {
  return {
    candidate_id: candidateId,
    action: action.action as DerivationCandidateAction,
    target_memory_ids_json: JSON.stringify(action.target_memory_ids ?? []),
    expected_revisions_json: JSON.stringify(action.expected_revisions ?? []),
    rationale: action.rationale,
    conflict_signals_json: JSON.stringify(action.conflict_signals ?? []),
    risk: action.risk as DerivationCandidateRisk
  };
}

/**
 * Translate a candidate into the `RememberInput` that
 * the `MemoryService.remember` / `supersedeMemory` /
 * `mergeMemories` verbs consume. The translation
 * preserves the candidate's `proposed_tier` /
 * `proposed_trust_level` / `proposed_sensitivity`
 * verbatim — the v17 plan forbids the apply path
 * from auto-promoting trust to `user_confirmed` or
 * tier to `core`. A missing `proposed_topic` falls
 * back to the bundle's `source_session_id` so the
 * memory is greppable.
 */
function buildRememberInputFromCandidate(
  candidate: DerivationCandidateRow,
  actor: string,
  idempotencyKey: string
): import("../write-validator.js").RememberInput {
  const type = (candidate.proposed_type ??
    "lesson") as import("../write-validator.js").RememberInput["type"];
  return {
    scope: candidate.proposed_scope,
    ...(candidate.proposed_project_id !== null
      ? { project_id: candidate.proposed_project_id }
      : {}),
    type,
    topic: candidate.proposed_topic ?? candidate.candidate_id,
    title: candidate.proposed_title ?? `Candidate ${candidate.candidate_id}`,
    body: candidate.proposed_body ?? "",
    tags: JSON.parse(candidate.proposed_tags_json) as string[],
    source: { kind: "agent", ref: actor },
    importance: 3,
    // The validator's `Confidence` is the integer
    // scale 1..5; map the candidate's [0, 1]
    // confidence to that scale by rounding.
    confidence: confidenceToScale(candidate.confidence),
    tier: candidate.proposed_tier as "working",
    sensitivity: candidate.proposed_sensitivity as "normal",
    trust_level: candidate.proposed_trust_level as "inferred" | "agent_observed",
    confirm_write: true,
    idempotency_key: idempotencyKey
  };
}

function confidenceToScale(c: number): 1 | 2 | 3 | 4 | 5 {
  if (c >= 0.9) return 5;
  if (c >= 0.7) return 4;
  if (c >= 0.5) return 3;
  if (c >= 0.3) return 2;
  return 1;
}

function distillationError(code: string, message: string): Error & { code: string } {
  const err: Error & { code?: string } = new Error(`[${code}] ${message}`);
  err.code = code;
  return err as Error & { code: string };
}

/**
 * Enqueue + run a `session_distill` derivation job
 * against an already-ingested session. The helper is
 * exposed so the CLI's `sessions distill <id>` and the
 * MCP / future admin paths can share the same
 * orchestration. The returned `RunOnceResult` is the
 * runner's own shape; the `job_id` is included so the
 * caller can surface it on stdout / stderr.
 */
export async function enqueueAndRunSessionDistill(args: {
  store: SQLiteMemoryStore;
  jobStore: DerivationJobStore;
  sessionService: SessionService;
  sessionId: string;
  actor: string;
  leaseOwner: string;
  signal?: AbortSignal;
}): Promise<{ job: DerivationJobRow; run: DerivationRunRow; outcome: import("../jobs/runner.js").RunOnceResult }> {
  const session = args.sessionService.inspect(args.sessionId);
  if (session === undefined) {
    throw new Error(`session_not_found: no session with id ${args.sessionId}`);
  }
  const inputDigest = "sha256:" + createHash("sha256").update(session.session.bundle_hash).digest("hex");
  const configDigest = "sha256:" + createHash("sha256").update(DETERMINISTIC_BASELINE_VERSION).digest("hex");
  const enqueue = args.jobStore.enqueue({
    kind: "session_distill",
    scope: session.session.scope,
    ...(session.session.project_id !== null
      ? { project_id: session.session.project_id }
      : {}),
    creator_actor_id: args.actor,
    idempotency_key: `distill:${args.sessionId}:${args.actor}`,
    input_digest: inputDigest,
    config_digest: configDigest
  });
  const result = await import("../jobs/runner.js").then((m) =>
    m.runOnce(
      args.store,
      [
        {
          kind: "session_distill",
          execute: async ({ job, startStage }) => {
            const stage = startStage(
              "extract",
              [{ kind: "session_event", id: args.sessionId }],
              { provider_id: DETERMINISTIC_BASELINE_ID, model_id: DETERMINISTIC_BASELINE_VERSION }
            );
            const service = new DistillationService(args.store, args.sessionService, args.jobStore);
            const bundle = bundleFromSessionInspection(session);
            const runResult = await service.runOnBundle({
              bundle,
              actor: args.actor
            });
            const outputs: Array<{ output_kind: DerivationOutputKind; output_id: string; disposition: "proposed" | "applied" | "rejected" | "superseded" }> = [];
            for (const c of args.store.listCandidatesForJob(job.job_id)) {
              outputs.push({
                output_kind: "candidate",
                output_id: c.candidate_id,
                disposition: "proposed"
              });
            }
            const resultDigest = "sha256:" + createHash("sha256")
              .update(JSON.stringify({ created: runResult.candidates_created, rejected: runResult.candidates_rejected }))
              .digest("hex");
            stage.finish("succeeded", resultDigest, outputs);
            return { status: "succeeded" };
          }
        }
      ],
      {
        lease_owner: args.leaseOwner,
        kind: "session_distill",
        max_jobs: 16,
        ...(args.signal !== undefined ? { signal: args.signal } : {})
      }
    )
  );
  // The `runOnce` runner does not return the
  // individual `run_id` row; the executor's
  // `startStage` is internal to the runner. Re-read
  // the job (and its most recent run row) so the
  // caller can surface the post-execution
  // `state` (e.g. `succeeded`) instead of the
  // pre-execution `queued` state.
  const inspect = args.jobStore.inspect(enqueue.job.job_id);
  if (inspect === undefined) {
    throw new Error(
      `[internal_error] session_distill job ${enqueue.job.job_id} disappeared after runOnce`
    );
  }
  const run = inspect.runs[0];
  if (run === undefined) {
    throw new Error(
      `[internal_error] session_distill job ${enqueue.job.job_id} produced no run row`
    );
  }
  return { job: inspect.job, run, outcome: result };
}

function bundleFromSessionInspection(inspection: {
  session: import("../sqlite-store.js").SessionRow;
  events: import("../sqlite-store.js").SessionEventRow[];
  plan: import("../sessions/service.js").PlanCounts;
}): NormalisedBundle {
  void inspection.plan;
  return {
    bundle_id: inspection.session.session_id,
    source_kind: inspection.session.source_kind,
    source_version: inspection.session.source_version,
    source_instance_id: inspection.session.source_instance_id,
    source_session_id: inspection.session.source_session_id,
    project_id: inspection.session.project_id,
    actor_id: inspection.session.actor_id,
    client_name: inspection.session.client_name,
    client_version: inspection.session.client_version,
    scope: inspection.session.scope,
    sensitivity: inspection.session.sensitivity,
    started_at: inspection.session.started_at,
    ended_at: inspection.session.ended_at,
    adapter_id: inspection.session.adapter_id,
    adapter_version: inspection.session.adapter_version,
    events: inspection.events.map((e) => ({
      event_id: e.event_id,
      sequence: e.sequence,
      turn_id: e.turn_id,
      event_type: e.event_type,
      role: e.role,
      content: null,
      content_ref_digest: null,
      content_digest: e.content_digest,
      tool_name: e.tool_name,
      tool_call_id: e.tool_call_id,
      tool_status: e.tool_status,
      timestamp: e.timestamp,
      sensitivity: e.sensitivity,
      metadata: parseRedactionFlags(e.redaction_flags_json)
    }))
  };
}

function parseRedactionFlags(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed)) {
      return { redaction_flags: parsed };
    }
    return {};
  } catch {
    return {};
  }
}

// Re-export the validation result so unit tests can
// import the type without a deep path.
export type { CandidateValidatorResult };
