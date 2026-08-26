// packages/contracts/src/bootstrap.ts
//
// v1.2.0-alpha.2 (issue #54): typed contracts for the
// cold-start bootstrap surface + the `external_reference`
// asset payload. The on-disk schema is in
// `src/sqlite-store.ts` (v20); the wire / MCP / admin
// shape is here. The two are intentionally not 1:1 — the
// SQLite shape is permissive (snake_case columns, JSON
// blobs for per-type metadata) while this contract is
// strict (camelCase, discriminated unions, versioned).
// The mapping happens in `src/bootstrap/service.ts` and
// `src/external-refs/service.ts`.

import { z } from "zod";

import { AssetScopeSchema } from "./assets.js";

export const BOOTSTRAP_SOURCE_KINDS = [
  "file",
  "directory",
  "git_metadata",
  "session_bundle",
  "memory_bundle",
  "external_provider"
] as const;

export const BOOTSTRAP_PLAN_STATES = [
  "draft",
  "scanning",
  "plan_ready",
  "applying",
  "applied",
  "expired",
  "failed",
  "cancelled"
] as const;

export const BOOTSTRAP_PLAN_ITEM_ACTIONS = [
  "propose_memory",
  "propose_context_pack",
  "propose_skill_ref",
  "register_external_ref",
  "bind_loadout",
  "skip"
] as const;

export const BOOTSTRAP_PLAN_ITEM_RISKS = ["low", "medium", "high"] as const;

export const EXTERNAL_REFERENCE_RESOURCE_KINDS = [
  "wiki",
  "code_index",
  "repository_context",
  "document_set",
  "custom"
] as const;

export const EXTERNAL_REFERENCE_CAPABILITIES = [
  "search",
  "fetch",
  "graph",
  "symbols",
  "citations"
] as const;

export const EXTERNAL_REFERENCE_REFRESH_POLICY_KINDS = [
  "manual",
  "on_session_start",
  "interval"
] as const;

export const BootstrapSourceKindSchema = z.enum(BOOTSTRAP_SOURCE_KINDS);
export const BootstrapPlanStateSchema = z.enum(BOOTSTRAP_PLAN_STATES);
export const BootstrapPlanItemActionSchema = z.enum(BOOTSTRAP_PLAN_ITEM_ACTIONS);
export const BootstrapPlanItemRiskSchema = z.enum(BOOTSTRAP_PLAN_ITEM_RISKS);
export const ExternalReferenceResourceKindSchema = z.enum(
  EXTERNAL_REFERENCE_RESOURCE_KINDS
);
export const ExternalReferenceCapabilitySchema = z.enum(
  EXTERNAL_REFERENCE_CAPABILITIES
);
export const ExternalReferenceRefreshPolicyKindSchema = z.enum(
  EXTERNAL_REFERENCE_REFRESH_POLICY_KINDS
);

// ── bootstrap source ─────────────────────────────────────────

export const BootstrapSourceV1Schema = z.object({
  schema_version: z.literal("1"),
  source_id: z.string().min(1),
  source_kind: BootstrapSourceKindSchema,
  scope: AssetScopeSchema,
  project_id: z.string().min(1).nullable(),
  canonical_ref: z.string().min(1),
  source_version: z.string().nullable(),
  content_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sensitivity: z.enum(["normal", "private", "restricted"]),
  configured_by_actor_id: z.string().min(1),
  created_at: z.string().datetime({ offset: true }),
  last_scanned_at: z.string().datetime({ offset: true }).nullable(),
  size_bytes: z.number().int().nonnegative().nullable()
}).refine(
  (v) =>
    (v.scope === "project" && v.project_id !== null) ||
    (v.scope === "global" && v.project_id === null),
  { message: "scope=project requires project_id; scope=global requires project_id=null" }
);

// ── bootstrap plan ───────────────────────────────────────────

export const BootstrapPlanV1Schema = z.object({
  schema_version: z.literal("1"),
  plan_id: z.string().min(1),
  project_id: z.string().min(1),
  creator_actor_id: z.string().min(1),
  state: BootstrapPlanStateSchema,
  config_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  source_set_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  created_at: z.string().datetime({ offset: true }),
  expires_at: z.string().datetime({ offset: true }),
  completed_at: z.string().datetime({ offset: true }).nullable(),
  job_id: z.string().min(1).nullable()
});

// ── bootstrap plan item ──────────────────────────────────────

export const BootstrapPlanItemV1Schema = z.object({
  schema_version: z.literal("1"),
  plan_id: z.string().min(1),
  source_id: z.string().min(1),
  item_seq: z.number().int().positive(),
  action: BootstrapPlanItemActionSchema,
  target_ref: z.string().nullable(),
  proposed_payload: z.record(z.string(), z.unknown()),
  evidence_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  expected_revision_or_version: z.number().int().nonnegative().nullable(),
  risk: BootstrapPlanItemRiskSchema,
  rationale: z.string().min(1)
});

// ── external reference ───────────────────────────────────────

export const ExternalReferenceRefreshPolicySchema = z
  .object({
    kind: ExternalReferenceRefreshPolicyKindSchema,
    interval_seconds: z.number().int().positive().optional()
  })
  .refine(
    (v) => v.kind !== "interval" || typeof v.interval_seconds === "number",
    { message: "refresh_policy.kind='interval' requires interval_seconds" }
  );

export const ExternalReferenceV1Schema = z.object({
  schema_version: z.literal("1"),
  asset_id: z.string().min(1),
  version: z.number().int().positive(),
  provider_kind: z.string().min(1),
  provider_instance_id: z.string().min(1),
  resource_kind: ExternalReferenceResourceKindSchema,
  resource_ref: z.string().min(1),
  uri: z.string().min(1),
  source_version: z.string().nullable(),
  source_digest: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .nullable(),
  retrieval_contract_version: z.string().min(1),
  capabilities: z.array(ExternalReferenceCapabilitySchema).default([]),
  allowed_scope: AssetScopeSchema,
  project_id: z.string().min(1).nullable(),
  sensitivity: z.enum(["normal", "private", "restricted"]),
  refresh_policy: ExternalReferenceRefreshPolicySchema.default({ kind: "manual" }),
  last_verified_at: z.string().datetime({ offset: true }).nullable(),
  metadata: z.record(z.string(), z.unknown()).default({})
}).refine(
  (v) =>
    (v.allowed_scope === "project" && v.project_id !== null) ||
    (v.allowed_scope === "global" && v.project_id === null),
  { message: "allowed_scope=project requires project_id; allowed_scope=global requires project_id=null" }
);

// ── scan result ──────────────────────────────────────────────

export const BootstrapScanResultV1Schema = z.object({
  schema_version: z.literal("1"),
  plan_id: z.string().min(1),
  state: BootstrapPlanStateSchema,
  config_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  source_set_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  item_count: z.number().int().nonnegative(),
  sources_scanned: z.number().int().nonnegative(),
  sources_skipped: z.number().int().nonnegative()
});

export type BootstrapSourceV1 = z.infer<typeof BootstrapSourceV1Schema>;
export type BootstrapPlanV1 = z.infer<typeof BootstrapPlanV1Schema>;
export type BootstrapPlanItemV1 = z.infer<typeof BootstrapPlanItemV1Schema>;
export type ExternalReferenceV1 = z.infer<typeof ExternalReferenceV1Schema>;
export type ExternalReferenceRefreshPolicyV1 = z.infer<
  typeof ExternalReferenceRefreshPolicySchema
>;
export type BootstrapScanResultV1 = z.infer<typeof BootstrapScanResultV1Schema>;
export type BootstrapSourceKindV1 = z.infer<typeof BootstrapSourceKindSchema>;
export type BootstrapPlanStateV1 = z.infer<typeof BootstrapPlanStateSchema>;
export type BootstrapPlanItemActionV1 = z.infer<typeof BootstrapPlanItemActionSchema>;
export type ExternalReferenceResourceKindV1 = z.infer<
  typeof ExternalReferenceResourceKindSchema
>;
export type ExternalReferenceCapabilityV1 = z.infer<
  typeof ExternalReferenceCapabilitySchema
>;
