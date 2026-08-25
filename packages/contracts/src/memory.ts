import { z } from "zod";
import { MemorySchema, MEMORY_TYPES, MEMORY_STATUSES } from "./schema.js";

export const RelatedNodeSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  topic: z.string(),
  type: z.enum(MEMORY_TYPES),
  status: z.enum(MEMORY_STATUSES),
  importance: z.number().int().min(1).max(5),
});

export const MemoryRelationsSchema = z.object({
  supersedes: z.array(RelatedNodeSchema),
  superseded_by: z.array(RelatedNodeSchema),
  merge: z.array(RelatedNodeSchema),
  co_topic: z.array(RelatedNodeSchema),
  co_topic_total: z.number().int().min(0),
  co_scope: z.array(RelatedNodeSchema),
  co_scope_total: z.number().int().min(0),
});

export const MemoryDetailSchema = MemorySchema.extend({
  related: MemoryRelationsSchema,
});

export type RelatedNode = z.infer<typeof RelatedNodeSchema>;
export type MemoryRelations = z.infer<typeof MemoryRelationsSchema>;
export type MemoryDetail = z.infer<typeof MemoryDetailSchema>;
