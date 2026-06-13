import { z } from "zod";
import { MEMORY_SCOPES, MEMORY_STATUSES, MEMORY_TYPES, SOURCE_KINDS } from "../domain.js";

const writableStatuses = ["active", "archived"] as const;
const maintenanceActions = [
  "archive_low_value",
  "expire_due",
  "rebuild_markdown_index",
  "vacuum_fts",
  "find_duplicates"
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
    review_after: nonEmptyString.optional(),
    supersedes: stringListSchema
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
  offset: z.number().int().nonnegative().optional()
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
    memory_id: nonEmptyString.optional()
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
    ...updatePatchFields
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
    reason: nonEmptyString
  })
  .strict();

export const forgetMemoryToolSchema = z
  .object({
    id: nonEmptyString.optional(),
    memory_id: nonEmptyString.optional(),
    reason: nonEmptyString
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
    project_path: nonEmptyString.optional()
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

export const memoryToolSchemas = {
  remember: rememberToolSchema,
  search_memories: searchMemoriesToolSchema,
  get_memory: getMemoryToolSchema,
  list_memories: listMemoriesToolSchema,
  update_memory: updateMemoryToolSchema,
  supersede_memory: supersedeMemoryToolSchema,
  forget_memory: forgetMemoryToolSchema,
  get_memory_budget: getMemoryBudgetToolSchema,
  maintain_memories: maintainMemoriesToolSchema,
  export_memory_context: exportMemoryContextToolSchema
} as const;

export type MemoryToolName = keyof typeof memoryToolSchemas;
