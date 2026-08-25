import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { MemoryRelations, RelatedNode } from "@agent-recall/contracts";
import { RelatedMemories } from "./RelatedMemories.js";

const mk = (id: string, topic: string): RelatedNode => ({
  id, title: id, topic, type: "fact", status: "active", importance: 3,
});

const empty: MemoryRelations = {
  supersedes: [],
  superseded_by: [],
  merge: [],
  co_topic: [],
  co_topic_total: 0,
  co_scope: [],
  co_scope_total: 0,
};

describe("RelatedMemories", () => {
  it("shows 4 section titles", () => {
    render(<RelatedMemories relations={empty} onJump={() => {}} />);
    expect(screen.getByText(/版本演进/)).toBeTruthy();
    // "合并" is also a substring of the empty-state text "无合并关系", so we
    // assert presence via getAllByText (truthy when at least one match exists).
    expect(screen.getAllByText(/合并/).length).toBeGreaterThan(0);
    expect(screen.getByText(/相关主题/)).toBeTruthy();
    expect(screen.getByText(/相关 scope/)).toBeTruthy();
  });

  it("shows empty state per section when no relations", () => {
    render(<RelatedMemories relations={empty} onJump={() => {}} />);
    // At least 3 of the 4 sections show "无..." messages
    // (merge section is "无合并关系" with "(v0.3)" appended)
    expect(screen.getByText(/无版本关系/)).toBeTruthy();
    expect(screen.getByText(/无合并关系/)).toBeTruthy();
    expect(screen.getByText(/无同主题/)).toBeTruthy();
  });

  it("co_scope is collapsed by default, shows count", () => {
    const rel: MemoryRelations = {
      ...empty,
      co_scope: [mk("s1", "x"), mk("s2", "x")],
      co_scope_total: 25,
    };
    render(<RelatedMemories relations={rel} onJump={() => {}} />);
    expect(screen.getByText(/25/)).toBeTruthy();
    // Without clicking expand, s1/s2 should not be visible
    expect(screen.queryByText("s1")).toBe(null);
    expect(screen.queryByText("s2")).toBe(null);
  });

  it("calls onJump when a row is clicked", () => {
    const onJump = vi.fn();
    const rel: MemoryRelations = {
      ...empty,
      supersedes: [mk("mem_x", "auth")],
    };
    render(<RelatedMemories relations={rel} onJump={onJump} />);
    fireEvent.click(screen.getByText("mem_x"));
    expect(onJump).toHaveBeenCalledWith("mem_x");
  });
});
