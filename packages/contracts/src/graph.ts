import { z } from "zod";
import { MEMORY_TYPES, MEMORY_STATUSES, MEMORY_SCOPES } from "./schema.js";

export const EDGE_KINDS = ["supersede", "merge", "co_topic", "co_scope"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const GraphNodeSchema = z.object({
  id: z.string().min(1),
  label: z.string(),         // 截断到 ~60 字符的 title
  type: z.enum(MEMORY_TYPES),
  topic: z.string(),
  scope: z.enum(MEMORY_SCOPES),
  project_id: z.string().nullable(),
  importance: z.number().int().min(1).max(5),
  status: z.enum(MEMORY_STATUSES),
  created_at: z.string().datetime(),
});

export const GraphEdgeSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  kind: z.enum(EDGE_KINDS),
  weight: z.number().min(0).max(1),
});

export const GraphFilterSchema = z.object({
  scope: z.enum(["project", "global", "all"]).default("all"),
  project_id: z.string().optional(),
  topic: z.array(z.string()).optional(),
  type: z.array(z.enum(MEMORY_TYPES)).optional(),
  status: z.array(z.enum(MEMORY_STATUSES)).default(["active"]),
  min_importance: z.number().int().min(1).max(5).optional(),
  max_nodes: z.number().int().min(1).max(2000).default(500),
  include_co_topic: z.boolean().default(true),
  include_co_scope: z.boolean().default(false),
});

export const GraphResponseSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  total: z.number().int(),
  truncated: z.boolean(),
  generated_at: z.string().datetime(),
});

export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;
export type GraphFilter = z.infer<typeof GraphFilterSchema>;
export type GraphResponse = z.infer<typeof GraphResponseSchema>;
