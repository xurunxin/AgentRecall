import { useCallback, useEffect, useState } from "react";
import { cmds } from "./tauri.js";
import { humanizeError, type AppError } from "./errors.js";
import type { MemoryDetail } from "@agent-recall/contracts";

interface State {
  data: MemoryDetail | null;
  error: AppError | null;
  isLoading: boolean;
}

/**
 * 加载单条 memory 的完整详情(含 related 关联)。
 *
 * 行为:
 * - `id === null` 时短路:不调用 Tauri,返 `data: null, isLoading: false`。
 * - `id` 变化时自动 refetch(类似 useGraph 的 filterKey 模式)。
 * - 错误经 `humanizeError` 处理,匹配 useGraph 的 wire 格式。
 */
export function useMemoryDetail(id: string | null) {
  const [state, setState] = useState<State>({ data: null, error: null, isLoading: false });

  const refetch = useCallback(async () => {
    if (!id) {
      setState({ data: null, error: null, isLoading: false });
      return;
    }
    setState((s) => ({ ...s, isLoading: true }));
    try {
      const data = (await cmds.getMemoryDetail(id)) as MemoryDetail;
      setState({ data, error: null, isLoading: false });
    } catch (raw) {
      const e = raw as AppError;
      setState({ data: null, error: { ...e, message: humanizeError(e) }, isLoading: false });
    }
  }, [id]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { ...state, refetch };
}
