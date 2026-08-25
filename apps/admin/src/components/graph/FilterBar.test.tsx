import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { GraphFilter } from "@agent-recall/contracts";
import { FilterBar } from "./FilterBar.js";

const baseFilter: GraphFilter = {
  scope: "all",
  status: ["active"],
  max_nodes: 500,
  include_co_topic: true,
  include_co_scope: false,
  organization: "none",
};

describe("FilterBar v0.2", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows scope/topic/type/status as removable pill chips", () => {
    const filter: GraphFilter = {
      ...baseFilter,
      topic: ["auth", "cache"],
      type: ["decision"],
    };
    const onChange = vi.fn();
    render(
      <FilterBar
        filter={filter}
        onChange={onChange}
        onRefresh={() => {}}
        organization="none"
        onOrganizationChange={() => {}}
        onOrganize={() => {}}
        organizeBusy={false}
      />
    );
    expect(screen.getByText("scope: all")).toBeTruthy();
    expect(screen.getByText("topic: auth")).toBeTruthy();
    expect(screen.getByText("topic: cache")).toBeTruthy();
    expect(screen.getByText("type: decision")).toBeTruthy();
  });

  it("clicking pill's × removes that filter value", () => {
    const filter: GraphFilter = { ...baseFilter, topic: ["auth", "cache"] };
    const onChange = vi.fn();
    render(
      <FilterBar
        filter={filter}
        onChange={onChange}
        onRefresh={() => {}}
        organization="none"
        onOrganizationChange={() => {}}
        onOrganize={() => {}}
        organizeBusy={false}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /移除.*auth/i }));
    // FilterBar debounces onChange by 300ms — advance fake timers to flush.
    act(() => { vi.advanceTimersByTime(300); });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ topic: ["cache"] }));
  });

  it("clicking + opens the advanced filter panel", () => {
    render(
      <FilterBar
        filter={baseFilter}
        onChange={() => {}}
        onRefresh={() => {}}
        organization="none"
        onOrganizationChange={() => {}}
        onOrganize={() => {}}
        organizeBusy={false}
      />
    );
    // 高级 panel 默认收起
    expect(screen.queryByText(/最小重要性/)).toBe(null);
    fireEvent.click(screen.getByRole("button", { name: /^\+$|高级/ }));
    expect(screen.getByText(/最小重要性/)).toBeTruthy();
    expect(screen.getByText(/最大节点/)).toBeTruthy();
  });

  it("renders OrgModeSwitcher and OrganizeButton in the second row", () => {
    render(
      <FilterBar
        filter={baseFilter}
        onChange={() => {}}
        onRefresh={() => {}}
        organization="by_topic"
        onOrganizationChange={() => {}}
        onOrganize={() => {}}
        organizeBusy={false}
      />
    );
    expect(screen.getByRole("radiogroup", { name: /组织模式/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /整理/ })).toBeTruthy();
  });
});
