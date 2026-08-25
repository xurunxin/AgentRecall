import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useGraph } from "./useGraph.js";
import type { GraphFilter } from "./types.js";

vi.mock("./tauri.js", () => ({
  cmds: {
    getGraph: vi.fn(),
  },
}));

import { cmds } from "./tauri.js";

describe("useGraph", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads graph on mount", async () => {
    (cmds.getGraph as any).mockResolvedValue({
      nodes: [{ id: "n1", label: "test" }],
      edges: [],
      total: 1,
      truncated: false,
      generated_at: "2026-08-24T10:00:00.000Z",
    });
    const { result } = renderHook(() => useGraph({} as GraphFilter));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data?.total).toBe(1);
    expect(result.current.error).toBeNull();
  });

  it("captures error from invoke", async () => {
    (cmds.getGraph as any).mockRejectedValue({
      code: "SCHEMA_VERSION_MISMATCH",
      message: "expected 1, actual 2",
    });
    const { result } = renderHook(() => useGraph({} as GraphFilter));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error?.code).toBe("SCHEMA_VERSION_MISMATCH");
  });
});
