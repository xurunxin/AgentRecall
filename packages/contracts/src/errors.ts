import { z } from "zod";

export const ERROR_CODES = [
  "SCHEMA_VERSION_MISMATCH",
  "DB_NOT_FOUND",
  "MCP_PROCESS_UNAVAILABLE",
  "MCP_TOOL_CALL_FAILED",
  "INVALID_FILTER",
  "GRAPH_TOO_LARGE",
  "CAPABILITY_DENIED",
  "SENSITIVITY_DENIED",
  "IDEMPOTENCY_CONFLICT",
  "DISABLED_IN_V0_1",        // v0.1 写操作被禁用
  "UNKNOWN",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorCodeSchema = z.enum(ERROR_CODES);

export interface AppError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export const AppErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
