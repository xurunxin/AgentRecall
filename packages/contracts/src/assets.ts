// packages/contracts/src/assets.ts
//
// v1.2.0-alpha.1 (issue #51) + v1.2.0-alpha.2
// (issue #53): typed contracts for the additive
// asset registry. The asset table is a thin
// envelope over four type-specific payloads
// (memory_ref / skill / context_pack /
// external_reference); `memory_entries` remains
// the source of truth for memory content —
// `memory_ref` is a *reference*, never a copy.
//
// The on-disk schema is in `src/sqlite-store.ts`
// (v16 envelope + v19 skill type table); the wire /
// MCP / admin shape is here. The two are
// intentionally not 1:1 — the SQLite shape is
// permissive (snake_case columns, JSON blobs for
// per-type metadata) while this contract is strict
// (camelCase, discriminated unions, versioned).
// The mapping happens in `src/assets/service.ts`
// (envelope) and `src/skills/service.ts`
// (skill type-specific).

import { z } from "zod";

export const ASSET_TYPES = [
  "memory_ref",
  "skill",
  "context_pack",
  "external_reference"
] as const;

export const ASSET_LIFECYCLE_STATES = [
  "draft",
  "active",
  "deprecated",
  "archived"
] as const;

export const ASSET_TRUST_LEVELS = [
  "user_confirmed",
  "agent_observed",
  "inferred"
] as const;

export const ASSET_SCOPES = ["global", "project"] as const;

export const AssetTypeSchema = z.enum(ASSET_TYPES);
export const AssetLifecycleStateSchema = z.enum(ASSET_LIFECYCLE_STATES);
export const AssetTrustLevelSchema = z.enum(ASSET_TRUST_LEVELS);
export const AssetScopeSchema = z.enum(ASSET_SCOPES);

/**
 * Common envelope. Each `asset_id` is stable; the
 * `current_version` field is the head. `manifest_json`
 * in the SQLite shape is the type-specific payload
 * (or, for `memory_ref` and `external_reference`, the
 * payload is split between the envelope and a
 * type-specific child row).
 */
export const AssetV1Schema = z.object({
  schema_version: z.literal("1"),
  asset_id: z.string().min(1),
  asset_type: AssetTypeSchema,
  scope: AssetScopeSchema,
  project_id: z.string().min(1).nullable(),
  owner_actor_id: z.string().min(1),
  lifecycle_state: AssetLifecycleStateSchema,
  current_version: z.number().int().nonnegative(),
  trust_level: AssetTrustLevelSchema,
  sensitivity: z.enum(["normal", "private", "restricted"]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
  archived_at: z.string().datetime({ offset: true }).nullable()
}).refine(
  (v) =>
    (v.scope === "project" && v.project_id !== null) ||
    (v.scope === "global" && v.project_id === null),
  {
    message: "scope=project requires project_id; scope=global requires project_id=null"
  }
).refine(
  (v) =>
    v.lifecycle_state !== "archived" ||
    v.archived_at !== null,
  {
    message: "lifecycle_state='archived' requires archived_at"
  }
);

/**
 * Immutable version. Versions monotonically
 * increase; `content_hash` is the SHA-256 over
 * the canonicalised payload (per-type).
 */
export const AssetVersionV1Schema = z.object({
  schema_version: z.literal("1"),
  asset_id: z.string().min(1),
  version: z.number().int().positive(),
  asset_schema_version: z.string().min(1),
  content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  created_by_actor_id: z.string().min(1),
  provenance_ref: z
    .object({
      kind: z.enum(["derivation_run", "import_batch", "manual", "external"]),
      ref: z.string().min(1)
    })
    .nullable(),
  created_at: z.string().datetime({ offset: true })
});

export const AssetRelationV1Schema = z.object({
  schema_version: z.literal("1"),
  from_asset_id: z.string().min(1),
  relation_type: z.string().min(1),
  to_asset_id: z.string().min(1).nullable(),
  external_target_ref: z.string().min(1).nullable(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  created_at: z.string().datetime({ offset: true })
}).refine(
  (v) =>
    (v.to_asset_id !== null) !== (v.external_target_ref !== null),
  {
    message:
      "AssetRelationV1 requires exactly one of to_asset_id or external_target_ref"
  }
);

// ── type-specific payloads ────────────────────────────────────

/**
 * `memory_ref` payload: a pointer to one
 * `(memory_id, revision)` in the authoritative
 * `memory_entries` table. The asset never holds
 * the body; the body stays in `memory_entries`.
 */
export const MemoryRefAssetV1Schema = z.object({
  asset_id: z.string().min(1),
  version: z.number().int().positive(),
  memory_id: z.string().min(1),
  memory_revision: z.number().int().positive(),
  binding_rule: z.string().optional(),
  note: z.string().optional()
});

/**
 * `skill` payload. The Skill contract itself
 * (SKILL.md frontmatter / body / resources) is
 * its own issue (#53) — this is the asset
 * envelope around the Skill manifest.
 *
 * v1.2.0-alpha.2 (issue #53) tightens the v1
 * schema:
 *  - `name` MUST be kebab-case
 *    (`/^[a-z][a-z0-9-]*$/`). The same rule is
 *    enforced in `parseSkillMd`; the contract
 *    pin is the fail-closed gate.
 *  - `source` is a strict 3-value enum (no
 *    `unknown` survives).
 *  - `resources[].type` is restricted to
 *    `text` | `reference`; `binary` and other
 *    values are rejected here so a malformed
 *    payload can never reach the store.
 */
const KEBAB_CASE_NAME = /^[a-z][a-z0-9-]*$/;

export const SkillAssetV1Schema = z.object({
  asset_id: z.string().min(1),
  version: z.number().int().positive(),
  name: z.string().min(1).regex(
    KEBAB_CASE_NAME,
    "skill name must be kebab-case (/^[a-z][a-z0-9-]*$/)"
  ),
  description: z.string(),
  schema_version: z.literal("1"),
  category: z.string().optional(),
  triggers: z.array(z.string()).default([]),
  when_to_use: z.string().optional(),
  when_not_to_use: z.string().optional(),
  compatibility: z.record(z.string(), z.unknown()).default({}),
  source: z.enum(["manual", "derived", "imported"]),
  skill_md_canonical: z.string(),
  body_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  resources: z
    .array(
      z.object({
        path: z.string().min(1),
        type: z.enum(["text", "reference"]),
        media_type: z.string().min(1),
        sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/)
      })
    )
    .default([])
});

/**
 * `context_pack` payload: a manifest of references
 * + rules. The manifest is intentionally
 * reference-only (it points at memory / skill /
 * external assets, never copies bodies).
 */
export const ContextPackAssetV1Schema = z.object({
  asset_id: z.string().min(1),
  version: z.number().int().positive(),
  manifest: z.object({
    include_asset_ids: z.array(z.string()).default([]),
    include_memory_ids: z.array(z.string()).default([]),
    include_types: z.array(z.string()).default([]),
    include_topics: z.array(z.string()).default([]),
    rules: z.array(z.string()).default([]),
    max_items: z.number().int().nonnegative().default(32),
    max_chars: z.number().int().nonnegative().default(8000)
  })
});

/**
 * `external_reference` payload: a typed pointer to a
 * provider's resource (FastContext, Agentic-RAG,
 * wiki, code index, ...). The reference is
 * metadata; the actual retrieval is a separate
 * explicit step the caller drives through a
 * configured adapter.
 */
export const ExternalReferenceAssetV1Schema = z.object({
  asset_id: z.string().min(1),
  version: z.number().int().positive(),
  provider_kind: z.string().min(1),
  provider_instance_id: z.string().min(1),
  resource_kind: z.enum([
    "wiki",
    "code_index",
    "repository_context",
    "document_set",
    "custom"
  ]),
  resource_ref: z.string().min(1),
  uri: z.string().min(1),
  source_version: z.string().optional(),
  source_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  retrieval_contract_version: z.string().min(1),
  capabilities: z
    .array(z.enum(["search", "fetch", "graph", "symbols", "citations"]))
    .default([]),
  allowed_scope: AssetScopeSchema,
  project_id: z.string().min(1).nullable(),
  sensitivity: z.enum(["normal", "private", "restricted"]),
  refresh_policy: z
    .object({
      kind: z.enum(["manual", "on_session_start", "interval"]),
      interval_seconds: z.number().int().positive().optional()
    })
    .default({ kind: "manual" }),
  last_verified_at: z.string().datetime({ offset: true }).nullable(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const AssetTypePayloadV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("memory_ref"), payload: MemoryRefAssetV1Schema }),
  z.object({ kind: z.literal("skill"), payload: SkillAssetV1Schema }),
  z.object({ kind: z.literal("context_pack"), payload: ContextPackAssetV1Schema }),
  z.object({ kind: z.literal("external_reference"), payload: ExternalReferenceAssetV1Schema })
]);

export const AssetInspectionV1Schema = z.object({
  schema_version: z.literal("1"),
  asset: AssetV1Schema,
  current_version: AssetVersionV1Schema.nullable(),
  payload: AssetTypePayloadV1Schema.optional()
});

export const AssetListV1Schema = z.object({
  schema_version: z.literal("1"),
  assets: z.array(AssetV1Schema)
});

export const AssetHistoryV1Schema = z.object({
  schema_version: z.literal("1"),
  asset_id: z.string().min(1),
  versions: z.array(AssetVersionV1Schema)
});

export const AssetLifecycleResultV1Schema = z.object({
  schema_version: z.literal("1"),
  asset_id: z.string().min(1),
  lifecycle_state: AssetLifecycleStateSchema,
  archived_at: z.string().datetime({ offset: true }).nullable()
});

export type AssetV1 = z.infer<typeof AssetV1Schema>;
export type AssetVersionV1 = z.infer<typeof AssetVersionV1Schema>;
export type AssetRelationV1 = z.infer<typeof AssetRelationV1Schema>;
export type MemoryRefAssetV1 = z.infer<typeof MemoryRefAssetV1Schema>;
export type SkillAssetV1 = z.infer<typeof SkillAssetV1Schema>;
export type ContextPackAssetV1 = z.infer<typeof ContextPackAssetV1Schema>;
export type ExternalReferenceAssetV1 = z.infer<typeof ExternalReferenceAssetV1Schema>;
export type AssetTypePayloadV1 = z.infer<typeof AssetTypePayloadV1Schema>;
export type AssetInspectionV1 = z.infer<typeof AssetInspectionV1Schema>;
export type AssetListV1 = z.infer<typeof AssetListV1Schema>;
export type AssetHistoryV1 = z.infer<typeof AssetHistoryV1Schema>;
export type AssetLifecycleResultV1 = z.infer<typeof AssetLifecycleResultV1Schema>;
