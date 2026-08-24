import { z } from "zod";

export const MEMORY_TYPES = [
  "preference",
  "procedure",
  "fact",
  "decision",
  "lesson",
  "debugging",
  "constraint",
] as const;

export const MEMORY_STATUSES = [
  "active",
  "archived",
  "superseded",
  "forgotten",
] as const;

export const MEMORY_SCOPES = ["global", "project"] as const;

export const SOURCE_KINDS = [
  "user",
  "agent",
  "tool",
  "file",
  "command",
  "external",
] as const;

export const MemorySourceSchema = z.object({
  kind: z.enum(SOURCE_KINDS),
  ref: z.string().optional(),
});

export const MemorySchema = z.object({
  id: z.string().min(1),
  scope: z.enum(MEMORY_SCOPES),
  project_id: z.string().nullable(),
  type: z.enum(MEMORY_TYPES),
  topic: z.string().min(1).max(180),
  title: z.string().min(1).max(500),
  body: z.string(),
  tags: z.array(z.string()).default([]),
  importance: z.number().int().min(1).max(5),
  confidence: z.number().int().min(1).max(5),
  sensitivity: z.enum(["normal", "private", "restricted"]).default("normal"),
  status: z.enum(MEMORY_STATUSES).default("active"),
  supersedes: z.array(z.string().min(1)).default([]),
  source: MemorySourceSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  revision: z.number().int().min(0),
});
