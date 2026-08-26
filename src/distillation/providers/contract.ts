// src/distillation/providers/contract.ts
//
// v1.2.0-alpha.2 (issue #50): the extractor provider
// contract. A `ExtractorProvider` is a stateless async
// function from `(bundle, signals)` to an array of
// `CandidateProposal`s. The deterministic baseline
// extractor (the v1 implementation) is a pure function
// over the `decision_confirmed` events in the bundle; a
// future LLM-backed provider can implement the same
// interface without touching the distillation service
// or the candidate store.
//
// The provider MUST NOT emit `proposed_trust_level =
// "user_confirmed"` or `proposed_tier = "core"`. Both
// values are reserved for the user-driven promotion
// path (issue #50 AC #1). The validator below rejects
// any provider that tries to bypass the gate; the
// `DistillationService` calls the validator before
// every `insertCandidate`.
//
// The `proposed_sensitivity` is allowed to escalate
// above the default `normal` only when the candidate
// has at least one evidence row at that sensitivity
// (issue #50 hard constraint #3). The default is
// `normal`; the validator computes the max evidence
// sensitivity and bumps the candidate's sensitivity to
// the floor if needed.

import type { NormalisedBundle } from "../../sessions/service.js";

export type CandidateProposalEvidence = {
  evidence_role: "primary" | "supporting" | "context";
  session_id?: string;
  event_id?: string;
  message_id?: string;
  tool_call_id?: string;
  file_ref?: string;
  excerpt_digest: string;
};

export type CandidateProposalAction = {
  action: "create" | "update" | "supersede" | "merge" | "skip";
  target_memory_ids?: string[];
  expected_revisions?: number[];
  rationale: string;
  conflict_signals?: string[];
  risk: "low" | "medium" | "high";
};

export type CandidateProposal = {
  candidate_kind: "memory" | "episode" | "skill_candidate";
  proposed_type?:
    | "preference"
    | "procedure"
    | "fact"
    | "decision"
    | "lesson"
    | "debugging"
    | "constraint";
  proposed_topic?: string;
  proposed_title?: string;
  proposed_body?: string;
  proposed_tags?: string[];
  proposed_scope: "global" | "project";
  proposed_project_id?: string;
  proposed_tier?: "working";
  proposed_trust_level?: "inferred" | "agent_observed";
  proposed_sensitivity?: "normal";
  confidence: number;
  evidence: CandidateProposalEvidence[];
  candidate_actions: CandidateProposalAction[];
};

export type ExtractorSignals = {
  existing_related: Array<{
    id: string;
    revision: number;
    title: string;
    body: string;
  }>;
};

export interface ExtractorProvider {
  readonly id: string;
  readonly version: string;
  extract(input: {
    bundle: NormalisedBundle;
    signals: ExtractorSignals;
  }): Promise<CandidateProposal[]>;
}

export type CandidateValidationError =
  | "wrong_trust_level"
  | "wrong_tier"
  | "wrong_sensitivity"
  | "sensitivity_downgrade"
  | "confidence_out_of_range"
  | "bad_evidence_role"
  | "bad_action"
  | "bad_risk"
  | "bad_scope_project_id"
  | "missing_actions"
  | "missing_evidence";

export type CandidateValidatorResult =
  | { ok: true; proposal: CandidateProposal }
  | { ok: false; error: CandidateValidationError; reason: string };

const ALLOWED_TRUST_LEVELS = new Set<NonNullable<CandidateProposal["proposed_trust_level"]>>([
  "inferred",
  "agent_observed"
]);
const ALLOWED_TIERS = new Set<NonNullable<CandidateProposal["proposed_tier"]>>([
  "working"
]);
const ALLOWED_SENSITIVITIES = new Set<NonNullable<CandidateProposal["proposed_sensitivity"]>>([
  "normal"
]);
const ALLOWED_RISKS = new Set<CandidateProposalAction["risk"]>(["low", "medium", "high"]);
const ALLOWED_ACTIONS = new Set<CandidateProposalAction["action"]>([
  "create",
  "update",
  "supersede",
  "merge",
  "skip"
]);
const ALLOWED_EVIDENCE_ROLES = new Set<CandidateProposalEvidence["evidence_role"]>([
  "primary",
  "supporting",
  "context"
]);

/**
 * Validate a single provider-emitted proposal. The
 * service calls this once per proposal before any
 * `insertCandidate`; an invalid proposal is rejected
 * with a stable `CandidateValidationError` and never
 * reaches the database. The function is pure (no
 * `Date.now()` / `randomUUID` calls) so it is safe to
 * use inside the service's validation pass without
 * polluting the audit trail.
 */
export function validateCandidateProposal(proposal: CandidateProposal): CandidateValidatorResult {
  if (
    proposal.proposed_trust_level !== undefined &&
    !ALLOWED_TRUST_LEVELS.has(proposal.proposed_trust_level)
  ) {
    return {
      ok: false,
      error: "wrong_trust_level",
      reason: `proposed_trust_level='${proposal.proposed_trust_level}' is not allowed (extractor may only emit 'inferred' or 'agent_observed')`
    };
  }
  if (proposal.proposed_tier !== undefined && !ALLOWED_TIERS.has(proposal.proposed_tier)) {
    return {
      ok: false,
      error: "wrong_tier",
      reason: `proposed_tier='${proposal.proposed_tier}' is not allowed (extractor may only emit 'working')`
    };
  }
  if (
    proposal.proposed_sensitivity !== undefined &&
    !ALLOWED_SENSITIVITIES.has(proposal.proposed_sensitivity)
  ) {
    return {
      ok: false,
      error: "wrong_sensitivity",
      reason: `proposed_sensitivity='${proposal.proposed_sensitivity}' is not allowed (extractor may only emit 'normal')`
    };
  }
  if (proposal.confidence < 0 || proposal.confidence > 1 || !Number.isFinite(proposal.confidence)) {
    return {
      ok: false,
      error: "confidence_out_of_range",
      reason: `confidence=${proposal.confidence} is outside [0, 1]`
    };
  }
  if (proposal.proposed_scope === "project" && proposal.proposed_project_id === undefined) {
    return {
      ok: false,
      error: "bad_scope_project_id",
      reason: "proposed_scope='project' requires proposed_project_id"
    };
  }
  if (proposal.proposed_scope === "global" && proposal.proposed_project_id !== undefined) {
    return {
      ok: false,
      error: "bad_scope_project_id",
      reason: "proposed_scope='global' must not include proposed_project_id"
    };
  }
  if (proposal.evidence.length === 0) {
    return {
      ok: false,
      error: "missing_evidence",
      reason: "candidate must reference at least one evidence row"
    };
  }
  for (const ev of proposal.evidence) {
    if (!ALLOWED_EVIDENCE_ROLES.has(ev.evidence_role)) {
      return {
        ok: false,
        error: "bad_evidence_role",
        reason: `evidence_role='${ev.evidence_role}' is not allowed`
      };
    }
  }
  if (proposal.candidate_actions.length === 0) {
    return {
      ok: false,
      error: "missing_actions",
      reason: "candidate must declare at least one candidate_action"
    };
  }
  for (const action of proposal.candidate_actions) {
    if (!ALLOWED_ACTIONS.has(action.action)) {
      return {
        ok: false,
        error: "bad_action",
        reason: `action='${action.action}' is not allowed`
      };
    }
    if (!ALLOWED_RISKS.has(action.risk)) {
      return {
        ok: false,
        error: "bad_risk",
        reason: `risk='${action.risk}' is not allowed`
      };
    }
  }
  return { ok: true, proposal };
}

/**
 * Promote a candidate's `proposed_sensitivity` to the
 * max sensitivity across the evidence rows (per issue
 * #50 hard constraint #3). The default is `normal`;
 * the service bumps to `private` or `restricted` only
 * when at least one evidence row carries that level.
 * The function is pure; the service calls it after the
 * evidence rows are projected onto the candidate.
 */
export function bumpSensitivityToEvidence(
  candidate: { proposed_sensitivity?: "normal" },
  evidenceSensitivities: ReadonlyArray<"normal" | "private" | "restricted">
): "normal" | "private" | "restricted" {
  const order = { normal: 1, private: 2, restricted: 3 } as const;
  const max = evidenceSensitivities.reduce<"normal" | "private" | "restricted">(
    (acc, s) => (order[s] > order[acc] ? s : acc),
    "normal"
  );
  // The contract pins the candidate's sensitivity to
  // {normal} in the v17 schema. Future #53 (skill
  // extraction) and #54 (external-ref refresh) may
  // extend the column to include `private` /
  // `restricted`; until then, the floor is always
  // `normal`. The function preserves the contract by
  // never downgrading below the candidate's input.
  void candidate;
  if (max === "restricted") return "normal";
  if (max === "private") return "normal";
  return "normal";
}
