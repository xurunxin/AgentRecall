import type { AppError as ContractAppError, ErrorCode } from "@agent-recall/contracts";

export type AppError = ContractAppError;

export function parseError(raw: unknown): AppError {
  if (typeof raw === "object" && raw !== null) {
    const r = raw as Record<string, unknown>;
    if (typeof r.code === "string" && typeof r.message === "string") {
      return { code: r.code as ErrorCode, message: r.message, details: r.details as Record<string, unknown> | undefined };
    }
  }
  return { code: "UNKNOWN", message: String(raw) };
}

export function humanizeError(e: AppError): string {
  switch (e.code) {
    case "SCHEMA_VERSION_MISMATCH":
      return `数据库 schema 版本不匹配:${e.message}。请升级/降级 admin 应用。`;
    case "DB_NOT_FOUND":
      return "未找到数据库。请先运行 AgentRecall 初始化数据目录。";
    case "MCP_PROCESS_UNAVAILABLE":
      return "MCP 服务不可用,写操作被禁用(v0.1)。";
    case "DISABLED_IN_V0_1":
      return "此操作在 v0.1 中尚未实现,将在 v0.2 启用。";
    case "INVALID_FILTER":
      return "过滤参数无效,请检查后重试。";
    case "GRAPH_TOO_LARGE":
      return "图谱过大,已自动截断。请缩小过滤范围。";
    case "UNKNOWN":
    default:
      return e.message;
  }
}
