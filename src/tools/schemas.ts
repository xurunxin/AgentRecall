import { z } from "zod";
import { MEMORY_SCOPES, MEMORY_STATUSES, MEMORY_TYPES, SOURCE_KINDS } from "../domain.js";

const writableStatuses = ["active", "archived"] as const;
const maintenanceActions = [
  "archive_low_value",
  "expire_due",
  "rebuild_markdown_index",
  "vacuum_fts",
  "find_duplicates",
  "merge_duplicates"
] as const;

const nonEmptyString = z.string().trim().min(1);
const ratingSchema = z.number().int().min(1).max(5);
const stringListSchema = z.array(nonEmptyString).default([]);
const sparseStringListSchema = z.array(nonEmptyString);

const sourceSchema = z
  .object({
    kind: z.enum(SOURCE_KINDS),
    ref: nonEmptyString.optional()
  })
  .strict();

const scopeSchema = z.enum(MEMORY_SCOPES);
const typeSchema = z.enum(MEMORY_TYPES);
const statusSchema = z.enum(MEMORY_STATUSES);
const writableStatusSchema = z.enum(writableStatuses);
const updateFieldNames = [
  "topic",
  "title",
  "body",
  "tags",
  "importance",
  "confidence",
  "status",
  "expires_at",
  "review_after"
] as const;

function requireProjectIdentity(
  input: { scope?: string | undefined; project_id?: string | undefined; project_path?: string | undefined },
  context: z.RefinementCtx
): void {
  if (input.scope !== "project") return;
  if (input.project_id !== undefined || input.project_path !== undefined) return;

  context.addIssue({
    code: "custom",
    path: ["project_id"],
    message: "project scope requires project_id or project_path"
  });
}

function requireProjectId(input: { scope?: string | undefined; project_id?: string | undefined }, context: z.RefinementCtx): void {
  if (input.scope !== "project") return;
  if (input.project_id !== undefined) return;

  context.addIssue({
    code: "custom",
    path: ["project_id"],
    message: "project scope requires project_id"
  });
}

function requireConsistentMemoryId(
  input: { id?: string | undefined; memory_id?: string | undefined },
  context: z.RefinementCtx
): void {
  if (input.memory_id === undefined && input.id === undefined) {
    context.addIssue({
      code: "custom",
      path: ["memory_id"],
      message: "memory_id or id is required"
    });
    return;
  }

  if (input.memory_id !== undefined && input.id !== undefined && input.memory_id !== input.id) {
    context.addIssue({
      code: "custom",
      path: ["memory_id"],
      message: "memory_id and id must match when both are provided"
    });
  }
}

export const rememberToolSchema = z
  .object({
    scope: scopeSchema,
    project_id: nonEmptyString.optional(),
    project_path: nonEmptyString.optional(),
    type: typeSchema,
    topic: nonEmptyString,
    title: nonEmptyString,
    body: nonEmptyString,
    tags: stringListSchema,
    source: sourceSchema,
    importance: ratingSchema,
    confidence: ratingSchema,
    status: writableStatusSchema.default("active"),
    expires_at: nonEmptyString.optional(),
    confirm_write: z.boolean().optional(),
    review_after: nonEmptyString.optional(),
    supersedes: stringListSchema,
    // Stage 14 PR-B2 (spec § 5.6): when the client retries a
    // remember after a network blip, the same key replays
    // the original result (idempotency_key_reuse on key
    // collision with a different request body).
    idempotency_key: nonEmptyString.optional()
  })
  .strict()
  .superRefine(requireProjectIdentity);

const entryFilterFields = {
  scope: scopeSchema.optional(),
  project_id: nonEmptyString.optional(),
  project_path: nonEmptyString.optional(),
  type: typeSchema.optional(),
  topic: nonEmptyString.optional(),
  status: statusSchema.default("active"),
  tags: stringListSchema,
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  actor: nonEmptyString.optional(),
  // Stage 6: ISO 8601 date or datetime strings. Lexicographic
  // comparison is correct for the format.
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  last_accessed_since: z.string().datetime({ offset: true }).optional(),
  // Stage 7: updated_at filters (parallel to the Stage 6 pair on
  // created_at). Useful for "what memories have I touched in the
  // last week?" queries.
  updated_since: z.string().datetime({ offset: true }).optional(),
  updated_until: z.string().datetime({ offset: true }).optional()
};

export const searchMemoriesToolSchema = z
  .object({
    ...entryFilterFields,
    query: nonEmptyString,
    include_global: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(10)
  })
  .strict()
  .superRefine(requireProjectIdentity);

export const getMemoryToolSchema = z
  .object({
    id: nonEmptyString.optional(),
    memory_id: nonEmptyString.optional(),
    // Stage 16 v1.1.1 PR-1 (#11): `accessed_by` is a
    // no-op for one release cycle so existing clients
    // keep parsing. Access identity must come from the
    // trusted `RequestContext` actor; client input can no
    // longer impersonate another actor. The field is
    // accepted here only so the schema does not reject
    // pre-v1.1.1 client payloads. The handler drops the
    // value on the floor.
    accessed_by: nonEmptyString
      .optional()
      .describe(
        "Deprecated in v1.1.1. The handler no longer uses this field; access identity comes from the trusted RequestContext actor. Pass undefined."
      )
  })
  .strict()
  .superRefine(requireConsistentMemoryId);

export const listMemoriesToolSchema = z
  .object({
    ...entryFilterFields,
    limit: z.number().int().min(1).max(1000).default(100)
  })
  .strict()
  .superRefine(requireProjectIdentity);

const updatePatchFields = {
  topic: nonEmptyString.optional(),
  title: nonEmptyString.optional(),
  body: nonEmptyString.optional(),
  tags: sparseStringListSchema.optional(),
  importance: ratingSchema.optional(),
  confidence: ratingSchema.optional(),
  status: writableStatusSchema.optional(),
  expires_at: nonEmptyString.optional(),
  review_after: nonEmptyString.optional()
};

export const updatePatchSchema = z.object(updatePatchFields).strict();

export const updateMemoryToolSchema = z
  .object({
    id: nonEmptyString.optional(),
    memory_id: nonEmptyString.optional(),
    patch: updatePatchSchema.optional(),
    ...updatePatchFields,
    // Stage 14 PR-B2 (spec § 5.6): optional idempotency
    // key. When set, retries with the same key replay the
    // original mutation; collisions with a different body
    // surface as idempotency_key_reuse.
    idempotency_key: nonEmptyString.optional(),
    // Stage 15 PR-M0-2 (issue #2, spec § 5.6): optional
    // optimistic-concurrency control on update. When set,
    // the patch is applied only if the row's current
    // `revision` matches `expected_revision`; otherwise
    // the service returns `stale_revision`. Surface this
    // through the MCP contract so a concurrent writer
    // wins the race and we don't clobber the new state.
    expected_revision: z.number().int().nonnegative().optional()
  })
  .strict()
  .superRefine((input, context) => {
    requireConsistentMemoryId(input, context);

    const topLevelFields = updateFieldNames.filter((field) => input[field] !== undefined);
    if (input.patch !== undefined && topLevelFields.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["patch"],
        message: "use either patch or top-level update fields, not both"
      });
    }

    const patchFields = input.patch === undefined ? [] : updateFieldNames.filter((field) => input.patch?.[field] !== undefined);
    const updateCount = input.patch === undefined ? topLevelFields.length : patchFields.length;
    if (updateCount === 0) {
      context.addIssue({
        code: "custom",
        path: ["patch"],
        message: "update_memory requires at least one update field"
      });
    }
  });

export const supersedeMemoryToolSchema = z
  .object({
    old_memory_ids: z.array(nonEmptyString).min(1),
    replacement: rememberToolSchema,
    reason: nonEmptyString,
    idempotency_key: nonEmptyString.optional()
  })
  .strict();

export const mergeMemoriesToolSchema = z
  .object({
    old_memory_ids: z.array(nonEmptyString).min(2),
    replacement: rememberToolSchema,
    reason: nonEmptyString,
    strategy: z.enum(["keep_first", "keep_newest"]).default("keep_first"),
    idempotency_key: nonEmptyString.optional()
  })
  .strict();

export const forgetMemoryToolSchema = z
  .object({
    id: nonEmptyString.optional(),
    memory_id: nonEmptyString.optional(),
    reason: nonEmptyString,
    // Stage 14 PR-B2 (spec § 5.6): idempotency key on the
    // forget operation as a whole; a network retry of the
    // same call replays the original `not_found` /
    // success result. A retry with a different body
    // surfaces `idempotency_mismatch`.
    idempotency_key: nonEmptyString.optional(),
    // Stage 14 PR-B2 (spec § 5.6): optimistic-concurrency
    // control. When the caller knows the entry's current
    // revision, pass it here so a concurrent writer wins
    // the race and we surface `not_found` (the row has
    // already moved) instead of clobbering the new state.
    expected_revision: z.number().int().nonnegative().optional()
  })
  .strict()
  .superRefine(requireConsistentMemoryId);

export const getMemoryBudgetToolSchema = z
  .object({
    scope: scopeSchema,
    project_id: nonEmptyString.optional()
  })
  .strict()
  .superRefine(requireProjectId);

export const maintainMemoriesToolSchema = z
  .object({
    action: z.enum(maintenanceActions),
    scope: scopeSchema,
    project_id: nonEmptyString.optional(),
    project_path: nonEmptyString.optional(),
    // Stage 7: chunk size for maintenance operations that scan
    // the whole entries table. Default 500; min 50, max 5000.
    batch_size: z.number().int().min(50).max(5000).default(500),
    // Stage 8: when true, mutating actions return the would-be
    // changes without writing. Read-only actions ignore this.
    dry_run: z.boolean().default(false),
    // Stage 8: merge_duplicates strategy.
    strategy: z.enum(["keep_first", "keep_newest"]).default("keep_first")
  })
  .strict()
  .superRefine(requireProjectIdentity);

export const exportMemoryContextToolSchema = z
  .object({
    scope: scopeSchema,
    project_id: nonEmptyString.optional(),
    project_path: nonEmptyString.optional(),
    query: nonEmptyString.optional(),
    include_global: z.boolean().default(false),
    budget_chars: z.number().int().min(100).max(50_000).default(8000),
    types: z.array(typeSchema).default([]),
    topics: stringListSchema
  })
  .strict()
  .superRefine(requireProjectIdentity);

export const recallContextToolSchema = z
  .object({
    query: nonEmptyString.optional(),
    scope: scopeSchema.default("global"),
    project_id: nonEmptyString.optional(),
    project_path: nonEmptyString.optional(),
    include_global: z.boolean().default(true),
    budget_chars: z.number().int().min(100).max(50_000).default(8000),
    types: z.array(typeSchema).default([]),
    topics: stringListSchema
  })
  .strict()
  .superRefine(requireProjectIdentity);

// Stage 12 PR9 (spec § 6.2): plan/apply maintenance.
export const planMaintenanceToolSchema = z
  .object({
    scope: scopeSchema,
    project_id: nonEmptyString.optional(),
    /** Cap on the number of merge groups returned in the plan. */
    max_groups: z.number().int().min(1).max(1000).optional()
  })
  .strict()
  .superRefine(requireProjectIdentity);

export const applyMaintenanceToolSchema = z
  .object({
    plan_id: nonEmptyString,
    confirm: z.literal(true),
    idempotency_key: nonEmptyString
  })
  .strict();

// Stage 12 PR9 (spec § 6.4): explainable recall.
export const explainRecallToolSchema = z
  .object({
    query: nonEmptyString,
    scope: scopeSchema,
    project_id: nonEmptyString.optional(),
    include_global: z.boolean().default(false),
    top_k: z.number().int().min(1).max(100).default(10)
  })
  .strict()
  .superRefine(requireProjectIdentity);

// Stage 12 PR9 (spec § 6.3, § 6.7): list backups.
export const listBackupsToolSchema = z
  .object({})
  .strict();

export const rememberSchema = rememberToolSchema;
export const searchSchema = searchMemoriesToolSchema;
export const getMemorySchema = getMemoryToolSchema;
export const listSchema = listMemoriesToolSchema;
export const updateSchema = updateMemoryToolSchema;
export const supersedeSchema = supersedeMemoryToolSchema;
export const forgetSchema = forgetMemoryToolSchema;
export const budgetSchema = getMemoryBudgetToolSchema;
export const maintainSchema = maintainMemoriesToolSchema;
export const exportContextSchema = exportMemoryContextToolSchema;
export const recallContextSchema = recallContextToolSchema;
export const planMaintenanceSchema = planMaintenanceToolSchema;
export const applyMaintenanceSchema = applyMaintenanceToolSchema;
export const explainRecallSchema = explainRecallToolSchema;
export const listBackupsSchema = listBackupsToolSchema;

export const memoryToolSchemas = {
  recall_context: recallContextToolSchema,
  remember: rememberToolSchema,
  search_memories: searchMemoriesToolSchema,
  get_memory: getMemoryToolSchema,
  list_memories: listMemoriesToolSchema,
  update_memory: updateMemoryToolSchema,
  supersede_memory: supersedeMemoryToolSchema,
  merge_memories: mergeMemoriesToolSchema,
  forget_memory: forgetMemoryToolSchema,
  get_memory_budget: getMemoryBudgetToolSchema,
  maintain_memories: maintainMemoriesToolSchema,
  export_memory_context: exportMemoryContextToolSchema,
  plan_maintenance: planMaintenanceToolSchema,
  apply_maintenance: applyMaintenanceToolSchema,
  explain_recall: explainRecallToolSchema,
  list_backups: listBackupsToolSchema
} as const;

export type MemoryToolName = keyof typeof memoryToolSchemas;
