// packages/contracts/src/loadouts.ts
//
// v1.2.0-alpha.2 (issue #52): typed contracts for the
// policy-bound agent loadouts and the shared
// context-assembly service. The loadout row is the
// durable policy object; the rule row is the per-channel
// filter; the binding row pins the loadout to an
// actor / client / project / task_mode. The
// `AssembledContextV1Schema` is the wire shape that the
// `recall_context` tool exposes (additive) and that the
// `agentrecall://context/loadout` MCP resource returns.
//
// The on-disk schema is in `src/sqlite-store.ts` (v18);
// the wire / MCP / CLI shape is here. The two are
// intentionally not 1:1 — the SQLite shape is
// permissive (snake_case columns, JSON blobs for
// filter arrays) while this contract is strict
// (camelCase, versioned, discriminated unions).

import { z } from "zod";

export const LOADOUT_LIFECYCLE_STATES = [
  "draft",
  "active",
  "deprecated",
  "archived"
] as const;

export const LOADOUT_CHANNELS = [
  "bootstrap",
  "query",
  "tool_only"
] as const;

export const LOADOUT_SCOPES = ["global", "project"] as const;

export const LOADOUT_TIERS = ["core", "working", "archival"] as const;

export const LOADOUT_ORDERING_POLICIES = [
  "rule_then_score",
  "score_only",
  "rule_only"
] as const;

export const LoadoutLifecycleStateSchema = z.enum(LOADOUT_LIFECYCLE_STATES);
export const LoadoutChannelSchema = z.enum(LOADOUT_CHANNELS);
export const LoadoutScopeSchema = z.enum(LOADOUT_SCOPES);
export const LoadoutTierSchema = z.enum(LOADOUT_TIERS);
export const LoadoutOrderingPolicySchema = z.enum(LOADOUT_ORDERING_POLICIES);

/**
 * The durable loadout row. `version` is bumped on every
 * `updateRules` call; the rules table is keyed on
 * `(loadout_id, version, channel)`. Bumping `version`
 * is what causes `bootstrap_hash` to change in the
 * context-assembly output (the upstream prompt-cache
 * key).
 */
export const LoadoutV1Schema = z
  .object({
    schema_version: z.literal("1"),
    loadout_id: z.string().min(1),
    name: z.string().min(1),
    version: z.number().int().positive(),
    lifecycle_state: LoadoutLifecycleStateSchema,
    match_actor_id: z.string().nullable(),
    match_client_name: z.string().nullable(),
    scope: LoadoutScopeSchema,
    project_id: z.string().nullable(),
    task_mode: z.string().nullable(),
    created_by_actor_id: z.string().min(1),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true })
  })
  .refine(
    (v) =>
      (v.scope === "project" && v.project_id !== null) ||
      (v.scope === "global" && v.project_id === null),
    {
      message: "scope=project requires project_id; scope=global requires project_id=null"
    }
  );

/**
 * The per-channel rule row. Filter arrays are additive
 * (`include_*` is OR-of-allow, `exclude_*` is
 * OR-of-deny); the budget caps are hard limits honoured
 * after filtering. `required_refs` is a *positive* list
 * the assembler must surface even when the budget is
 * exhausted; an unavailable `required_ref` is reported
 * in `required_refs_unavailable` rather than silently
 * dropped.
 */
export const LoadoutRuleV1Schema = z.object({
  schema_version: z.literal("1"),
  loadout_id: z.string().min(1),
  version: z.number().int().positive(),
  channel: LoadoutChannelSchema,
  include_asset_ids: z.array(z.string()).default([]),
  include_memory_ids: z.array(z.string()).default([]),
  include_types: z.array(z.string()).default([]),
  include_tiers: z.array(LoadoutTierSchema).default([]),
  include_tags: z.array(z.string()).default([]),
  include_topics: z.array(z.string()).default([]),
  exclude_asset_ids: z.array(z.string()).default([]),
  exclude_memory_ids: z.array(z.string()).default([]),
  exclude_tags: z.array(z.string()).default([]),
  required_refs: z.array(z.string()).default([]),
  max_items: z.number().int().nonnegative().default(32),
  max_chars: z.number().int().nonnegative().default(8000),
  max_tokens: z.number().int().nonnegative().nullable().default(null),
  timeout_ms: z.number().int().nonnegative().default(5000),
  ordering_policy: LoadoutOrderingPolicySchema.default("rule_then_score")
});

/**
 * The binding row. A loadout is *active* when at least
 * one binding matches the caller's `(actor_id,
 * client_name, project_id, task_mode)` tuple. The
 * resolver picks the highest-priority match. The
 * `project_id` / `task_mode` columns are nullable so a
 * binding can target a "default" (`NULL` on a column
 * means "any value"). Two bindings with the same
 * effective match quadruple and the same priority are
 * rejected as `binding_ambiguous`.
 */
export const LoadoutBindingV1Schema = z.object({
  schema_version: z.literal("1"),
  binding_id: z.string().min(1),
  loadout_id: z.string().min(1),
  loadout_version: z.number().int().positive(),
  actor_id: z.string().nullable(),
  client_name: z.string().nullable(),
  project_id: z.string().nullable(),
  task_mode: z.string().nullable(),
  priority: z.number().int().default(0),
  created_at: z.string().datetime({ offset: true })
});

/**
 * The wire shape the assembler returns for one channel.
 * `text` is the canonical byte sequence (LF, sorted
 * headers, deterministic) so the same `(loadout, query,
 * authz)` triple always produces the same bytes (and
 * therefore the same `hash`). The `selected_ids` /
 * `excluded_ids` arrays are sorted lexicographically.
 */
export const AssembledChannelV1Schema = z.object({
  schema_version: z.literal("1"),
  channel: LoadoutChannelSchema,
  text: z.string(),
  selected_ids: z.array(z.string()),
  excluded_ids: z.array(z.string()),
  required_refs_unavailable: z.array(z.string()),
  risk_injection_filtered: z.number().int().nonnegative(),
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  budget: z.object({
    used_items: z.number().int().nonnegative(),
    used_chars: z.number().int().nonnegative(),
    max_items: z.number().int().nonnegative(),
    max_chars: z.number().int().nonnegative()
  })
});

/**
 * The full assembled payload. `bootstrap_hash` is the
 * upstream prompt-cache key: it MUST change only when
 * `(loadout_id, loadout_version, policy_version,
 * actor_id, project_id, <bootstrap channel text>)`
 * changes. Memory writes that do not affect the
 * bootstrap channel MUST NOT churn it (this is the
 * `bootstrap_hash stability` guarantee in spec).
 */
export const AssembledContextV1Schema = z.object({
  schema_version: z.literal("1"),
  loadout_id: z.string(),
  loadout_version: z.number().int().positive(),
  policy_version: z.string(),
  channels: z.object({
    bootstrap: AssembledChannelV1Schema.optional(),
    query: AssembledChannelV1Schema.optional(),
    tool_only: AssembledChannelV1Schema.optional()
  }),
  bootstrap_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  explanation: z.array(z.string())
});

/**
 * The output of `LoadoutService.resolve`. Includes the
 * loadout row + the rules (one per channel) so the
 * assembler can build channels without a second
 * `getLoadout` round-trip.
 */
export const LoadoutResolutionV1Schema = z.object({
  schema_version: z.literal("1"),
  loadout: LoadoutV1Schema,
  rules: z.array(LoadoutRuleV1Schema),
  binding: LoadoutBindingV1Schema.nullable(),
  matched_rule: z.enum([
    "explicit_loadout_id",
    "actor_project_task",
    "actor_project",
    "project_default",
    "global_default",
    "built_in_legacy_fallback"
  ])
});

export type LoadoutLifecycleState = z.infer<typeof LoadoutLifecycleStateSchema>;
export type LoadoutChannel = z.infer<typeof LoadoutChannelSchema>;
export type LoadoutScope = z.infer<typeof LoadoutScopeSchema>;
export type LoadoutTier = z.infer<typeof LoadoutTierSchema>;
export type LoadoutOrderingPolicy = z.infer<typeof LoadoutOrderingPolicySchema>;
export type LoadoutV1 = z.infer<typeof LoadoutV1Schema>;
export type LoadoutRuleV1 = z.infer<typeof LoadoutRuleV1Schema>;
export type LoadoutBindingV1 = z.infer<typeof LoadoutBindingV1Schema>;
export type AssembledChannelV1 = z.infer<typeof AssembledChannelV1Schema>;
export type AssembledContextV1 = z.infer<typeof AssembledContextV1Schema>;
export type LoadoutResolutionV1 = z.infer<typeof LoadoutResolutionV1Schema>;
