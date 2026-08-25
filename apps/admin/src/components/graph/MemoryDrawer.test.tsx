import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { GraphNode, MemoryDetail } from "@agent-recall/contracts";
import MemoryDrawer from "./MemoryDrawer.js";

vi.mock("../../lib/useMemoryDetail.js", () => ({
  useMemoryDetail: vi.fn(),
}));

import { useMemoryDetail } from "../../lib/useMemoryDetail.js";

const node: GraphNode = {
  id: "mem_alpha",
  label: "Use JWT",
  type: "decision",
  topic: "auth",
  scope: "project",
  project_id: "p1",
  importance: 4,
  status: "active",
  created_at: "2026-08-25T00:00:00.000Z",
};

const detail: MemoryDetail = {
  id: "mem_alpha",
  scope: "project",
  project_id: "p1",
  type: "decision",
  topic: "auth",
  title: "Use JWT for stateless auth",
  body: "long body content here",
  tags: ["auth", "jwt"],
  importance: 4,
  confidence: 5,
  sensitivity: "normal",
  status: "active",
  supersedes: [],
  source: { kind: "user", ref: "claude" },
  created_at: "2026-08-25T00:00:00.000Z",
  updated_at: "2026-08-25T00:00:00.000Z",
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

describe("MemoryDrawer", () => {
  beforeEach(() => {
    vi.mocked(useMemoryDetail).mockReset();
  });

  it("renders nothing when node is null", () => {
    (vi.mocked(useMemoryDetail) as any).mockReturnValue({
      data: null,
      error: null,
      isLoading: false,
      refetch: vi.fn(),
    });
    const { container } = render(<MemoryDrawer node={null} onClose={() => {}} />);
    expect(container.firstChild).toBe(null);
  });

  it("shows loading state when detail is loading", () => {
    (vi.mocked(useMemoryDetail) as any).mockReturnValue({
      data: null,
      error: null,
      isLoading: true,
      refetch: vi.fn(),
    });
    const { container } = render(<MemoryDrawer node={node} onClose={() => {}} />);
    // Drawer renders but body shows loading
    expect(screen.getByText(/加载中/)).toBeTruthy();
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
  });

  it("renders body / tags / source / related sections when detail loaded", () => {
    (vi.mocked(useMemoryDetail) as any).mockReturnValue({
      data: detail,
      error: null,
      isLoading: false,
      refetch: vi.fn(),
    });
    render(<MemoryDrawer node={node} onClose={() => {}} />);
    // Body section
    expect(screen.getByText("long body content here")).toBeTruthy();
    // Tags section ("auth" also appears as data.topic, so use getAllByText)
    expect(screen.getAllByText("auth").length).toBeGreaterThan(0);
    expect(screen.getByText("jwt")).toBeTruthy();
    // Source section (collapsed by default, header visible)
    expect(screen.getByText(/来源/)).toBeTruthy();
    // Related section ("合并" also appears in "无合并关系" empty state)
    expect(screen.getByText(/版本演进/)).toBeTruthy();
    expect(screen.getAllByText(/合并/).length).toBeGreaterThan(0);
    expect(screen.getByText(/相关主题/)).toBeTruthy();
    expect(screen.getByText(/相关 scope/)).toBeTruthy();
  });

  it("shows error state with retry button when error returned", () => {
    const refetch = vi.fn();
    (vi.mocked(useMemoryDetail) as any).mockReturnValue({
      data: null,
      error: { code: "DB_QUERY_FAILED", message: "boom" },
      isLoading: false,
      refetch,
    });
    render(<MemoryDrawer node={node} onClose={() => {}} />);
    expect(screen.getByText(/boom/)).toBeTruthy();
    const retryBtn = screen.getByRole("button", { name: /重试/ });
    expect(retryBtn).toBeTruthy();
    fireEvent.click(retryBtn);
    expect(refetch).toHaveBeenCalled();
  });
});
