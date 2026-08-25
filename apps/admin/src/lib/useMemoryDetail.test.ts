import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useMemoryDetail } from "./useMemoryDetail.js";

vi.mock("./tauri.js", () => ({
  cmds: {
    getMemoryDetail: vi.fn(),
  },
}));

import { cmds } from "./tauri.js";

const fakeDetail = {
  id: "mem_alpha",
  scope: "project" as const,
  project_id: "p1",
  type: "decision" as const,
  topic: "auth",
  title: "Use JWT",
  body: "abc",
  tags: ["auth"],
  importance: 4,
  confidence: 5,
  sensitivity: "normal" as const,
  status: "active" as const,
  supersedes: [],
  source: { kind: "user" as const },
  created_at: "2026-08-25T10:00:00.000Z",
  updated_at: "2026-08-25T10:00:00.000Z",
  revision: 1,
  related: {
    supersedes: [],
    superseded_by: [],
    merge: [],
    co_topic: [],
    co_topic_total: 0,
    co_scope: [],
    co_scope_total: 0,
  },
};

describe("useMemoryDetail", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns loading state initially", () => {
    (cmds.getMemoryDetail as any).mockResolvedValue(fakeDetail);
    const { result } = renderHook(() => useMemoryDetail("mem_alpha"));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBe(null);
  });

  it("fetches and returns data", async () => {
    (cmds.getMemoryDetail as any).mockResolvedValue(fakeDetail);
    const { result } = renderHook(() => useMemoryDetail("mem_alpha"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual(fakeDetail);
  });

  it("returns null data and no loading when id is null", async () => {
    const { result } = renderHook(() => useMemoryDetail(null));
    expect(result.current.data).toBe(null);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBe(null);
    expect(cmds.getMemoryDetail).not.toHaveBeenCalled();
  });

  it("captures error when invoke rejects", async () => {
    (cmds.getMemoryDetail as any).mockRejectedValue({
      code: "DB_QUERY_FAILED",
      message: "boom",
    });
    const { result } = renderHook(() => useMemoryDetail("mem_alpha"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toBe(null);
    expect(result.current.error).toBeTruthy();
  });
});
