// packages/contracts/src/distillation.ts
//
// v1.2.0-alpha.2 (issue #50): typed contracts for the
// session-to-memory distillation pipeline. The wire shape
// here is what the deterministic baseline extractor (and
// any future provider-backed extractor) emits, what the
// `DistillationService` validates + persists, and what
// the CLI / MCP inspector surfaces. The on-disk row shape
// lives in `src/sqlite-store.ts` and is intentionally
// permissive (snake_case columns, JSON-blob evidence +
// action lists) while this contract is strict (camelCase
// for the wire, exhaustive enums, no nullable surprises).
//
// The split is deliberate: the SQLite store is the source
// of truth and survives schema migrations; the wire
// contract is the public API and is versioned via the
// `schema_version` literal on every payload. A future v2
// contract can add `schema_version: "2"` and live alongside
// v1.

import { z } from "zod";

export const DERIVATION_CANDIDATE_KINDS = ["memory", "episode", "skill_candidate"] as const;
export const DERIVATION_CANDIDATE_STATES = [
  "proposed",
  "accepted",
  "rejected",
  "applied",
  "stale"
] as const;
export const DERIVATION_CANDIDATE_TIERS = ["working"] as const;
export const DERIVATION_CANDIDATE_TRUST_LEVELS = ["inferred", "agent_observed"] as const;
export const DERIVATION_CANDIDATE_SENSITIVITIES = ["normal"] as const;
export const DERIVATION_CANDIDATE_RISKS = ["low", "medium", "high"] as const;
export const DERIVATION_CANDIDATE_ACTIONS = [
  "create",
  "update",
  "supersede",
  "merge",
  "skip"
] as const;
export const DERIVATION_CANDIDATE_EVIDENCE_ROLES = [
  "primary",
  "supporting",
  "context"
] as const;
export const DERIVATION_CANDIDATE_SCOPES = ["global", "project"] as const;

export const DerivationCandidateKindSchema = z.enum(DERIVATION_CANDIDATE_KINDS);
export const DerivationCandidateStateSchema = z.enum(DERIVATION_CANDIDATE_STATES);
export const DerivationCandidateTierSchema = z.enum(DERIVATION_CANDIDATE_TIERS);
export const DerivationCandidateTrustLevelSchema = z.enum(DERIVATION_CANDIDATE_TRUST_LEVELS);
export const DerivationCandidateSensitivitySchema = z.enum(DERIVATION_CANDIDATE_SENSITIVITIES);
export const DerivationCandidateRiskSchema = z.enum(DERIVATION_CANDIDATE_RISKS);
export const DerivationCandidateActionSchema = z.enum(DERIVATION_CANDIDATE_ACTIONS);
export const DerivationCandidateEvidenceRoleSchema = z.enum(DERIVATION_CANDIDATE_EVIDENCE_ROLES);
export const DerivationCandidateScopeSchema = z.enum(DERIVATION_CANDIDATE_SCOPES);

export const CandidateEvidenceSchema = z.object({
  schema_version: z.literal("1"),
  candidate_id: z.string().min(1),
  evidence_role: DerivationCandidateEvidenceRoleSchema,
  session_id: z.string().min(1).nullable().optional(),
  event_id: z.string().min(1).nullable().optional(),
  message_id: z.string().min(1).nullable().optional(),
  tool_call_id: z.string().min(1).nullable().optional(),
  file_ref: z.string().min(1).nullable().optional(),
  excerpt_digest: z.string().min(1)
});

export const CandidateActionSchema = z.object({
  schema_version: z.literal("1"),
  candidate_id: z.string().min(1),
  action: DerivationCandidateActionSchema,
  target_memory_ids: z.array(z.string().min(1)).default([]),
  expected_revisions: z.array(z.number().int().nonnegative()).default([]),
  rationale: z.string().min(1),
  conflict_signals: z.array(z.string().min(1)).default([]),
  risk: DerivationCandidateRiskSchema
});

export const DerivationCandidateSchema = z
  .object({
    schema_version: z.literal("1"),
    candidate_id: z.string().min(1),
    job_id: z.string().min(1),
    run_id: z.string().min(1),
    candidate_kind: DerivationCandidateKindSchema,
    proposed_type: z
      .enum(["preference", "procedure", "fact", "decision", "lesson", "debugging", "constraint"])
      .nullable()
      .optional(),
    proposed_topic: z.string().nullable().optional(),
    proposed_title: z.string().nullable().optional(),
    proposed_body: z.string().nullable().optional(),
    proposed_tags: z.array(z.string().min(1)).default([]),
    proposed_scope: DerivationCandidateScopeSchema,
    proposed_project_id: z.string().min(1).nullable().optional(),
    proposed_tier: DerivationCandidateTierSchema.default("working"),
    proposed_trust_level: DerivationCandidateTrustLevelSchema.default("inferred"),
    proposed_sensitivity: DerivationCandidateSensitivitySchema.default("normal"),
    confidence: z.number().min(0).max(1),
    state: DerivationCandidateStateSchema,
    extractor_id: z.string().min(1),
    extractor_version: z.string().min(1),
    content_hash: z.string().min(1),
    created_at: z.number().int().nonnegative(),
    reviewed_at: z.number().int().nonnegative().nullable().optional(),
    reviewed_by_actor_id: z.string().min(1).nullable().optional(),
    applied_at: z.number().int().nonnegative().nullable().optional(),
    expected_target_revision: z.number().int().nonnegative().nullable().optional()
  })
  .refine(
    (v) =>
      (v.proposed_scope === "project" && v.proposed_project_id !== null && v.proposed_project_id !== undefined) ||
      (v.proposed_scope === "global" && (v.proposed_project_id === null || v.proposed_project_id === undefined)),
    { message: "DerivationCandidate requires proposed_project_id when proposed_scope='project' (and vice versa)" }
  );

export const CandidateListSchema = z.object({
  schema_version: z.literal("1"),
  candidates: z.array(DerivationCandidateSchema)
});

export const CandidateInspectionSchema = z.object({
  schema_version: z.literal("1"),
  candidate: DerivationCandidateSchema,
  evidence: z.array(CandidateEvidenceSchema),
  actions: z.array(CandidateActionSchema)
});

export type DerivationCandidate = z.infer<typeof DerivationCandidateSchema>;
export type CandidateEvidence = z.infer<typeof CandidateEvidenceSchema>;
export type CandidateAction = z.infer<typeof CandidateActionSchema>;
export type CandidateList = z.infer<typeof CandidateListSchema>;
export type CandidateInspection = z.infer<typeof CandidateInspectionSchema>;
