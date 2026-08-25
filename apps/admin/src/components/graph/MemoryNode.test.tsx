import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import MemoryNode, { colorForTopic } from "./MemoryNode.js";
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
  it("renders the label as visible text and exposes the full label via the title tooltip", () => {
    renderInFlow(<MemoryNode {...nodePropsFor({ node: sampleNode, onClick: vi.fn() })} />);
    // The label is now the visible text next to the node.
    expect(screen.getByText("Use JWT for auth")).toBeDefined();
    // And also reachable via the native title attribute (hover tooltip).
    expect(screen.getByTitle("Use JWT for auth")).toBeDefined();
  });

  it("exposes the topic as a data attribute for styling and tests", () => {
    renderInFlow(<MemoryNode {...nodePropsFor({ node: sampleNode, onClick: vi.fn() })} />);
    const root = screen.getByTestId(`memory-node-${sampleNode.id}`);
    expect(root.getAttribute("data-topic")).toBe("auth");
  });

  it("calls onClick with node id when the row is clicked", () => {
    const onClick = vi.fn();
    renderInFlow(<MemoryNode {...nodePropsFor({ node: sampleNode, onClick })} />);
    fireEvent.click(screen.getByTestId(`memory-node-${sampleNode.id}`));
    expect(onClick).toHaveBeenCalledWith(sampleNode.id);
  });

  it("renders long labels and relies on CSS ellipsis (no crash on overflow)", () => {
    const long: GraphNode = {
      ...sampleNode,
      label: "A very long memory label that would exceed 180px if not for CSS truncation handling",
    };
    renderInFlow(<MemoryNode {...nodePropsFor({ node: long, onClick: vi.fn() })} />);
    // The full text is still in the DOM; the visual crop is done by CSS.
    expect(screen.getByText(long.label)).toBeDefined();
  });
});

describe("colorForTopic", () => {
  it("returns the fixed palette entry for known topics", () => {
    expect(colorForTopic("auth")).toBe("#3b82f6");
    expect(colorForTopic("cache")).toBe("#f97316");
    expect(colorForTopic("logging")).toBe("#10b981");
  });

  it("returns a stable color from the fallback palette for unknown topics", () => {
    const a = colorForTopic("custom-topic-1");
    const b = colorForTopic("custom-topic-1");
    const c = colorForTopic("custom-topic-2");
    expect(a).toBe(b);
    // Different topics usually land on different fallback hues; if by
    // chance they collide, just assert the result is one of the known
    // fallback colors.
    expect(FALLBACK_COLORS).toContain(a);
    expect(FALLBACK_COLORS).toContain(c);
  });
});

// Mirror the FALLBACK_PALETTE from MemoryNode.tsx so the test can assert
// membership without importing the private constant.
const FALLBACK_COLORS = [
  "#ec4899",
  "#8b5cf6",
  "#14b8a6",
  "#f59e0b",
  "#0ea5e9",
  "#84cc16",
];
