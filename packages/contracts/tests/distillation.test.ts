// packages/contracts/tests/distillation.test.ts
//
// v1.2.0-alpha.2 (issue #50): schema tests for the
// session-to-memory distillation contracts.

import { describe, it, expect } from "vitest";

import {
  DerivationCandidateSchema,
  CandidateEvidenceSchema,
  CandidateActionSchema,
  CandidateListSchema,
  CandidateInspectionSchema,
  DerivationCandidateTrustLevelSchema,
  DerivationCandidateTierSchema,
  DerivationCandidateSensitivitySchema,
  DerivationCandidateRiskSchema,
  DerivationCandidateEvidenceRoleSchema
} from "../src/distillation.js";

const baseCandidate = {
  schema_version: "1" as const,
  candidate_id: "cand_1",
  job_id: "job_1",
  run_id: "run_1",
  candidate_kind: "memory" as const,
  proposed_type: "lesson" as const,
  proposed_topic: "tools",
  proposed_title: "Run candidate extractors inside `runOnce`",
  proposed_body: "Always pass the deterministic baseline policy_version to the executor.",
  proposed_tags: ["candidate-pipeline", "deterministic-baseline"],
  proposed_scope: "global" as const,
  proposed_project_id: null,
  proposed_tier: "working" as const,
  proposed_trust_level: "inferred" as const,
  proposed_sensitivity: "normal" as const,
  confidence: 0.85,
  state: "proposed" as const,
  extractor_id: "deterministic-baseline",
  extractor_version: "1.2.0-alpha.2/v50-baseline",
  content_hash: "sha256:" + "a".repeat(64),
  created_at: 1_700_000_000_000,
  reviewed_at: null,
  reviewed_by_actor_id: null,
  applied_at: null,
  expected_target_revision: null
};

const baseEvidence = {
  schema_version: "1" as const,
  candidate_id: "cand_1",
  evidence_role: "primary" as const,
  session_id: "sess_1",
  event_id: "evt_1",
  message_id: null,
  tool_call_id: null,
  file_ref: null,
  excerpt_digest: "sha256:" + "b".repeat(64)
};

const baseAction = {
  schema_version: "1" as const,
  candidate_id: "cand_1",
  action: "create" as const,
  target_memory_ids: [],
  expected_revisions: [],
  rationale: "No existing memory targets this candidate",
  conflict_signals: [],
  risk: "low" as const
};

describe("Distillation contracts (v1.2.0-alpha.2, issue #50)", () => {
  it("accepts a happy-path candidate", () => {
    const parsed = DerivationCandidateSchema.parse(baseCandidate);
    expect(parsed.candidate_kind).toBe("memory");
    expect(parsed.proposed_tier).toBe("working");
  });

  it("rejects an unknown candidate_kind", () => {
    const result = DerivationCandidateSchema.safeParse({
      ...baseCandidate,
      candidate_kind: "thought"
    });
    expect(result.success).toBe(false);
  });

  it("rejects proposed_trust_level='user_confirmed' (extractor is never allowed to self-promote)", () => {
    const result = DerivationCandidateSchema.safeParse({
      ...baseCandidate,
      proposed_trust_level: "user_confirmed"
    });
    expect(result.success).toBe(false);
  });

  it("rejects proposed_tier='core' (extractor is never allowed to self-promote tier)", () => {
    const result = DerivationCandidateSchema.safeParse({
      ...baseCandidate,
      proposed_tier: "core"
    });
    expect(result.success).toBe(false);
  });

  it("rejects proposed_sensitivity='private' (extractor can only emit 'normal')", () => {
    const result = DerivationCandidateSchema.safeParse({
      ...baseCandidate,
      proposed_sensitivity: "private"
    });
    expect(result.success).toBe(false);
  });

  it("rejects confidence out of [0, 1]", () => {
    const high = DerivationCandidateSchema.safeParse({ ...baseCandidate, confidence: 1.5 });
    const low = DerivationCandidateSchema.safeParse({ ...baseCandidate, confidence: -0.1 });
    expect(high.success).toBe(false);
    expect(low.success).toBe(false);
  });

  it("rejects scope=project without a proposed_project_id", () => {
    const result = DerivationCandidateSchema.safeParse({
      ...baseCandidate,
      proposed_scope: "project",
      proposed_project_id: null
    });
    expect(result.success).toBe(false);
  });

  it("accepts a project-scope candidate with proposed_project_id", () => {
    const result = DerivationCandidateSchema.parse({
      ...baseCandidate,
      proposed_scope: "project",
      proposed_project_id: "repo-a"
    });
    expect(result.proposed_project_id).toBe("repo-a");
  });

  it("rejects an unknown evidence_role", () => {
    const result = CandidateEvidenceSchema.safeParse({
      ...baseEvidence,
      evidence_role: "supportive"
    });
    expect(result.success).toBe(false);
  });

  it("accepts the canonical evidence + action shapes", () => {
    const e = CandidateEvidenceSchema.parse(baseEvidence);
    const a = CandidateActionSchema.parse(baseAction);
    expect(e.evidence_role).toBe("primary");
    expect(a.risk).toBe("low");
  });

  it("rejects risk outside the {low, medium, high} enum", () => {
    const result = CandidateActionSchema.safeParse({ ...baseAction, risk: "critical" });
    expect(result.success).toBe(false);
  });

  it("accepts a CandidateList with one candidate", () => {
    const parsed = CandidateListSchema.parse({
      schema_version: "1",
      candidates: [baseCandidate]
    });
    expect(parsed.candidates).toHaveLength(1);
  });

  it("accepts a CandidateInspection with evidence + actions", () => {
    const parsed = CandidateInspectionSchema.parse({
      schema_version: "1",
      candidate: baseCandidate,
      evidence: [baseEvidence],
      actions: [baseAction]
    });
    expect(parsed.evidence).toHaveLength(1);
    expect(parsed.actions).toHaveLength(1);
  });

  it("narrows the trust-level enum", () => {
    expect(DerivationCandidateTrustLevelSchema.parse("inferred")).toBe("inferred");
    expect(DerivationCandidateTrustLevelSchema.parse("agent_observed")).toBe("agent_observed");
    expect(DerivationCandidateTrustLevelSchema.safeParse("user_confirmed").success).toBe(false);
  });

  it("narrows the tier enum to 'working' only", () => {
    expect(DerivationCandidateTierSchema.parse("working")).toBe("working");
    expect(DerivationCandidateTierSchema.safeParse("core").success).toBe(false);
    expect(DerivationCandidateTierSchema.safeParse("archival").success).toBe(false);
  });

  it("narrows the sensitivity enum to 'normal' only", () => {
    expect(DerivationCandidateSensitivitySchema.parse("normal")).toBe("normal");
    expect(DerivationCandidateSensitivitySchema.safeParse("private").success).toBe(false);
    expect(DerivationCandidateSensitivitySchema.safeParse("restricted").success).toBe(false);
  });

  it("narrows the risk enum to {low, medium, high}", () => {
    expect(DerivationCandidateRiskSchema.parse("low")).toBe("low");
    expect(DerivationCandidateRiskSchema.parse("medium")).toBe("medium");
    expect(DerivationCandidateRiskSchema.parse("high")).toBe("high");
    expect(DerivationCandidateRiskSchema.safeParse("critical").success).toBe(false);
  });

  it("narrows the evidence_role enum to {primary, supporting, context}", () => {
    expect(DerivationCandidateEvidenceRoleSchema.parse("primary")).toBe("primary");
    expect(DerivationCandidateEvidenceRoleSchema.parse("supporting")).toBe("supporting");
    expect(DerivationCandidateEvidenceRoleSchema.parse("context")).toBe("context");
    expect(DerivationCandidateEvidenceRoleSchema.safeParse("background").success).toBe(false);
  });
});
