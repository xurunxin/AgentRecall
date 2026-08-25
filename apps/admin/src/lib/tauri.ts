import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { parseError, type AppError } from "./errors.js";

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (raw) {
    throw parseError(raw) satisfies AppError;
  }
}

// 命令映射(v0.1)
export const cmds = {
  getGraph: (filter: unknown) => invoke<unknown>("get_graph", { filter }),
  listMemories: (filter: unknown, page: number, pageSize: number) =>
    invoke<unknown>("list_memories", { filter, page, pageSize }),
  getMemory: (id: string) => invoke<unknown>("get_memory", { id }),
  getMemoryDetail: (id: string) => invoke<unknown>("get_memory", { id }),
  getMemoryStats: () => invoke<unknown>("get_memory_stats"),
  getDbStatus: () => invoke<unknown>("get_db_status"),
  openDb: () => invoke<void>("open_db"),
} as const;
