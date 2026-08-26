// src/distillation/providers/deterministic-baseline.ts
//
// v1.2.0-alpha.2 (issue #50): the deterministic baseline
// extractor. The implementation is a pure function over
// the bundle's `decision_confirmed` events: every event
// with non-empty `content` becomes one `memory`
// candidate. Events whose `content` is empty, carries a
// `risk_injection` redaction flag, or has a
// `contains_secret` flag are skipped — the secret-bearing
// path would otherwise leak a `private` / `restricted`
// candidate through the validator, and the
// prompt-injection path would surface a hostile
// instruction as a memory entry.
//
// The baseline is deliberately network-free: it is
// replay-safe (same bundle -> same `candidate_id` set),
// has no LLM cost, and can be exercised end-to-end on
// any CI runner. A future provider-backed extractor
// (#52 OpenCode plugin rewrite) can implement the same
// `ExtractorProvider` interface and be swapped in via
// the `DerivationJobExecutor` registration.

import { createHash, randomUUID } from "node:crypto";

import type { NormalisedBundle } from "../../sessions/service.js";
import type {
  CandidateProposal,
  ExtractorProvider,
  ExtractorSignals
} from "./contract.js";

export const DETERMINISTIC_BASELINE_ID = "deterministic-baseline";
export const DETERMINISTIC_BASELINE_VERSION = "1.2.0-alpha.2/v50-baseline";

/**
 * Skip-rule helpers. The three rules are the only
 * place the baseline deviates from "every decision is
 * a candidate". They are exported so the unit test
 * can exercise them individually.
 */
export function shouldSkipDecisionContent(content: string | null | undefined): boolean {
  if (content === null || content === undefined) return true;
  if (content.trim().length === 0) return true;
  return false;
}

export function hasRiskInjectionFlag(redactionFlags: ReadonlyArray<string>): boolean {
  return redactionFlags.includes("risk_injection");
}

export function hasContainsSecretFlag(redactionFlags: ReadonlyArray<string>): boolean {
  return redactionFlags.includes("contains_secret");
}

/**
 * Project a bundle's decision_confirmed event into a
 * `CandidateProposal`. The function is exported for
 * unit testing; the baseline extractor is a thin loop
 * over the bundle's events.
 */
export function projectDecisionEventToProposal(
  bundle: NormalisedBundle,
  event: NormalisedBundle["events"][number]
): CandidateProposal | null {
  if (event.event_type !== "decision_confirmed") return null;
  if (shouldSkipDecisionContent(event.content)) return null;
  const flags = (event.metadata?.redaction_flags as string[] | undefined) ?? [];
  if (hasRiskInjectionFlag(flags)) return null;
  if (hasContainsSecretFlag(flags)) return null;
  const title = `Decision captured from session ${bundle.source_session_id}`;
  const body = event.content ?? "";
  // The `excerpt_digest` is the per-evidence identifier
  // (the v17 schema's PRIMARY KEY is
  // `(candidate_id, evidence_role, excerpt_digest)`).
  // Using the event's `content_digest` keeps the
  // evidence rows content-addressed and replay-stable.
  const excerptDigest = event.content_digest;
  return {
    candidate_kind: "memory",
    proposed_type: "decision",
    proposed_topic: "decisions",
    proposed_title: title,
    proposed_body: body,
    proposed_tags: ["decision_confirmed"],
    proposed_scope: bundle.scope,
    ...(bundle.project_id !== null ? { proposed_project_id: bundle.project_id } : {}),
    proposed_tier: "working",
    proposed_trust_level: "inferred",
    proposed_sensitivity: "normal",
    confidence: 0.9,
    evidence: [
      {
        evidence_role: "primary",
        session_id: bundle.bundle_id,
        event_id: event.event_id,
        excerpt_digest: excerptDigest
      }
    ],
    candidate_actions: [
      {
        action: "create",
        rationale: `decision_confirmed event ${event.event_id} in session ${bundle.source_session_id}`,
        risk: "low"
      }
    ]
  };
}

export class DeterministicBaselineExtractor implements ExtractorProvider {
  readonly id = DETERMINISTIC_BASELINE_ID;
  readonly version = DETERMINISTIC_BASELINE_VERSION;

  /**
   * The extract method is a pure loop over the
   * bundle's `decision_confirmed` events. The
   * `signals` argument is accepted for protocol
   * compatibility with provider-backed extractors; the
   * baseline does not consult `existing_related` and
   * therefore has no `update` / `supersede` /
   * `merge` actions in its output.
   */
  async extract(input: {
    bundle: NormalisedBundle;
    signals: ExtractorSignals;
  }): Promise<CandidateProposal[]> {
    void input.signals;
    const proposals: CandidateProposal[] = [];
    for (const event of input.bundle.events) {
      const proposal = projectDecisionEventToProposal(input.bundle, event);
      if (proposal !== null) proposals.push(proposal);
    }
    return proposals;
  }
}

/**
 * Compute a stable `candidate_id` for a proposal. The
 * id is the SHA-256 of the `(bundle_id, event_id,
 * extractor_id, extractor_version)` tuple, prefixed
 * with `cand_` so it is greppable in logs. The hash
 * makes the id replay-stable: a re-run of the
 * extractor against the same bundle produces the same
 * ids, and the service's `insertCandidate` UNIQUE
 * constraint short-circuits the re-run.
 */
export function deterministicCandidateId(
  bundle: NormalisedBundle,
  event: NormalisedBundle["events"][number]
): string {
  const canonical = JSON.stringify({
    bundle_id: bundle.bundle_id,
    event_id: event.event_id,
    extractor_id: DETERMINISTIC_BASELINE_ID,
    extractor_version: DETERMINISTIC_BASELINE_VERSION
  });
  return (
    "cand_" +
    createHash("sha256").update(canonical).digest("hex").slice(0, 24)
  );
}

/**
 * Content hash for a proposal. The hash covers the
 * `proposed_title` + `proposed_body` + the evidence's
 * `excerpt_digest`s so a re-emit with the same payload
 * produces the same hash. The service uses the hash
 * as the `derivation_candidates.content_hash` value.
 */
export function candidateContentHash(proposal: CandidateProposal): string {
  const canonical = JSON.stringify({
    title: proposal.proposed_title ?? null,
    body: proposal.proposed_body ?? null,
    evidence: proposal.evidence.map((e) => e.excerpt_digest)
  });
  return "sha256:" + createHash("sha256").update(canonical).digest("hex");
}

/**
 * The default baseline id helper, used by the
 * service's `enqueue` path to bind a job to its
 * policy version. The id + version is a stable
 * pair: bumping the version is a deliberate
 * decision (the `derivation_runs.policy_version`
 * row is the surface an admin reviews).
 */
export function baselinePolicyVersion(): string {
  return DETERMINISTIC_BASELINE_VERSION;
}

/**
 * Convenience helper for the CLI's `sessions distill
 * <id>` path: produce a UUIDv4-shaped job id and
 * `run_id` for a fresh enqueue. The function is
 * exposed because the CLI / service need a stable
 * `run_id` to attach the `derivation_outputs` row
 * to; the deterministic baseline does not need the
 * UUIDv4 uniqueness for the candidate id (its
 * candidate_id is content-addressed) but the run id
 * is used as a foreign key.
 */
export function freshRunId(): string {
  return "run_" + randomUUID();
}
