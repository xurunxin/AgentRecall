import type { z } from "zod";
import type { MemorySchema, MemorySourceSchema } from "./schema.js";

export type Memory = z.infer<typeof MemorySchema>;
export type MemorySource = z.infer<typeof MemorySourceSchema>;
export type SourceKind = MemorySource["kind"];
export type MemoryType = Memory["type"];
export type MemoryStatus = Memory["status"];
export type MemoryScope = Memory["scope"];
export type Importance = Memory["importance"];
export type Confidence = Memory["confidence"];
