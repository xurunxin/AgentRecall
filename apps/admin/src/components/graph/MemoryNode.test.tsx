import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import MemoryNode from "./MemoryNode.js";
import type { GraphNode } from "@agent-recall/contracts";

const sampleNode: GraphNode = {
  id: "11111111-1111-1111-1111-111111111111",
  label: "Use JWT for auth",
  type: "decision",
  topic: "auth",
  scope: "project",
  project_id: "p1",
  importance: 4,
  status: "active",
  created_at: "2026-08-24T10:00:00.000Z",
};

function renderInFlow(ui: ReactElement): ReturnType<typeof render> {
  return render(<ReactFlowProvider>{ui}</ReactFlowProvider>);
}

// NodeProps<default Node> has many required fields (type, dragging, zIndex,
// selectable, deletable, selected, draggable) that are populated by the
// surrounding <ReactFlow> at runtime. Unit tests only check the
// component's own rendering, so cast the minimal { id, data } shape.
function nodePropsFor(data: { node: GraphNode; onClick: (id: string) => void }): NodeProps {
  return { id: "n1", data } as unknown as NodeProps;
}

describe("MemoryNode", () => {
  it("renders the topic's first-letter glyph and exposes the topic via title", () => {
    renderInFlow(<MemoryNode {...nodePropsFor({ node: sampleNode, onClick: vi.fn() })} />);
    // topic = "auth" → first 2 chars rendered as the circle glyph.
    expect(screen.getByText("au")).toBeDefined();
    // Full topic is still discoverable via the native title attribute.
    const node = screen.getByTitle("auth");
    expect(node).toBeDefined();
  });

  it("calls onClick with node id when the circle is clicked", () => {
    const onClick = vi.fn();
    renderInFlow(<MemoryNode {...nodePropsFor({ node: sampleNode, onClick })} />);
    fireEvent.click(screen.getByTitle("auth"));
    expect(onClick).toHaveBeenCalledWith(sampleNode.id);
  });

  it("uses a single-character glyph for single-letter topics", () => {
    const singleLetter: GraphNode = { ...sampleNode, topic: "x" };
    renderInFlow(<MemoryNode {...nodePropsFor({ node: singleLetter, onClick: vi.fn() })} />);
    expect(screen.getByText("x")).toBeDefined();
    expect(screen.getByTitle("x")).toBeDefined();
  });

  it("falls back to a question mark for empty topics", () => {
    const empty: GraphNode = { ...sampleNode, topic: "" };
    renderInFlow(<MemoryNode {...nodePropsFor({ node: empty, onClick: vi.fn() })} />);
    expect(screen.getByText("?")).toBeDefined();
  });
});
