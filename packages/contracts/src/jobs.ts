// packages/contracts/src/jobs.ts
//
// v1.2.0-alpha.0 (issue #48): typed contracts for the
// derivation job substrate. The schemas are the
// canonical wire shape the admin app / 3rd party
// integrations consume; the on-disk row shape lives
// in `src/sqlite-store.ts` and is intentionally
// permissive (snake_case columns, loose
// typing) while this contract is strict (camelCase
// for the wire, exhaustive enum, no nullable
// surprises).
//
// The split is deliberate: the SQLite store is the
// source of truth and survives schema migrations;
// the wire contract is the public API and is
// versioned via the `schema_version` literal on
// every payload. A future v2 contract can add
// `schema_version: "2"` and live alongside v1.

import { z } from "zod";

export const DERIVATION_JOB_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled"
] as const;

export const DERIVATION_RUN_STATUSES = [
  "started",
  "succeeded",
  "failed",
  "cancelled"
] as const;

export const DERIVATION_OUTPUT_KINDS = [
  "candidate",
  "skill_draft",
  "bootstrap_plan",
  "external_ref",
  "applied_memory",
  "applied_asset"
] as const;

export const DERIVATION_OUTPUT_DISPOSITIONS = [
  "proposed",
  "applied",
  "rejected",
  "superseded"
] as const;

export const DERIVATION_JOB_SCOPES = ["global", "project"] as const;

export const DerivationJobStateSchema = z.enum(DERIVATION_JOB_STATES);
export const DerivationRunStatusSchema = z.enum(DERIVATION_RUN_STATUSES);
export const DerivationOutputKindSchema = z.enum(DERIVATION_OUTPUT_KINDS);
export const DerivationOutputDispositionSchema = z.enum(
  DERIVATION_OUTPUT_DISPOSITIONS
);
export const DerivationJobScopeSchema = z.enum(DERIVATION_JOB_SCOPES);

export const DerivationRefSchema = z.object({
  kind: z.enum(["memory", "asset", "session_event", "file", "external_ref"]),
  id: z.string().min(1),
  revision: z.number().int().nonnegative().optional(),
  version: z.number().int().nonnegative().optional()
});

export const DerivationJobSchema = z.object({
  schema_version: z.literal("1"),
  job_id: z.string().min(1),
  kind: z.string().min(1),
  state: DerivationJobStateSchema,
  scope: DerivationJobScopeSchema,
  project_id: z.string().min(1).nullable().optional(),
  creator_actor_id: z.string().min(1),
  idempotency_key: z.string().min(1),
  input_digest: z.string().min(1),
  config_digest: z.string().min(1),
  cursor_json: z.string(),
  attempt_count: z.number().int().nonnegative(),
  lease_owner: z.string().min(1).nullable().optional(),
  lease_expires_at: z.number().int().nonnegative().nullable().optional(),
  cancel_requested_at: z.number().int().nonnegative().nullable().optional(),
  next_retry_at: z.number().int().nonnegative().nullable().optional(),
  error_code: z.string().min(1).nullable().optional(),
  redacted_error: z.string().nullable().optional(),
  created_at: z.number().int().nonnegative(),
  started_at: z.number().int().nonnegative().nullable().optional(),
  updated_at: z.number().int().nonnegative(),
  finished_at: z.number().int().nonnegative().nullable().optional()
});

export const DerivationRunSchema = z.object({
  schema_version: z.literal("1"),
  run_id: z.string().min(1),
  job_id: z.string().min(1),
  stage: z.string().min(1),
  status: DerivationRunStatusSchema,
  input_refs: z.array(DerivationRefSchema),
  output_refs: z.array(DerivationRefSchema),
  provider_id: z.string().nullable().optional(),
  model_id: z.string().nullable().optional(),
  prompt_template_version: z.string().nullable().optional(),
  prompt_hash: z.string().nullable().optional(),
  policy_version: z.string().min(1),
  result_digest: z.string().nullable().optional(),
  started_at: z.number().int().nonnegative(),
  finished_at: z.number().int().nonnegative().nullable().optional()
});

export const DerivationOutputSchema = z.object({
  schema_version: z.literal("1"),
  job_id: z.string().min(1),
  run_id: z.string().min(1),
  output_kind: DerivationOutputKindSchema,
  output_id: z.string().min(1),
  disposition: DerivationOutputDispositionSchema,
  created_at: z.number().int().nonnegative()
});

export const DerivationJobInspectionSchema = z.object({
  schema_version: z.literal("1"),
  job: DerivationJobSchema,
  runs: z.array(DerivationRunSchema),
  outputs: z.array(DerivationOutputSchema)
});

export const DerivationJobListSchema = z.object({
  schema_version: z.literal("1"),
  jobs: z.array(DerivationJobSchema)
});

export const DerivationJobCancelResultSchema = z.object({
  schema_version: z.literal("1"),
  job_id: z.string().min(1),
  cancel_requested: z.boolean()
});

export const DerivationRunOnceResultSchema = z.object({
  schema_version: z.literal("1"),
  attempted: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative()
});

export type DerivationJob = z.infer<typeof DerivationJobSchema>;
export type DerivationRun = z.infer<typeof DerivationRunSchema>;
export type DerivationOutput = z.infer<typeof DerivationOutputSchema>;
export type DerivationJobInspection = z.infer<typeof DerivationJobInspectionSchema>;
export type DerivationJobList = z.infer<typeof DerivationJobListSchema>;
export type DerivationJobCancelResult = z.infer<typeof DerivationJobCancelResultSchema>;
export type DerivationRunOnceResult = z.infer<typeof DerivationRunOnceResultSchema>;
export type DerivationRef = z.infer<typeof DerivationRefSchema>;
