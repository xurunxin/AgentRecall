import { useCallback, useEffect, useState } from "react";
import { cmds } from "./tauri.js";
import { humanizeError, type AppError } from "./errors.js";
import type { GraphFilter, GraphResponse } from "./types.js";

interface State {
  data: GraphResponse | null;
  error: AppError | null;
  isLoading: boolean;
}

export function useGraph(filter: GraphFilter) {
  const [state, setState] = useState<State>({ data: null, error: null, isLoading: true });
  const filterKey = JSON.stringify(filter);

  const refetch = useCallback(async () => {
    setState((s) => ({ ...s, isLoading: true }));
    try {
      const data = (await cmds.getGraph(filter)) as GraphResponse;
      setState({ data, error: null, isLoading: false });
    } catch (raw) {
      const e = raw as AppError;
      setState({ data: null, error: { ...e, message: humanizeError(e) }, isLoading: false });
    }
  }, [filterKey]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { ...state, refetch };
}
