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

// MemoryNode uses xyflow's <Handle />, which requires a ReactFlowProvider
// (Handle reads from HandleConfigContext via useHandleConfig; without the
// provider it throws "useHandleConfig must be used within a
// HandleConfigProvider"). Render custom nodes inside a provider in tests.
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
  it("renders label and topic", () => {
    renderInFlow(<MemoryNode {...nodePropsFor({ node: sampleNode, onClick: vi.fn() })} />);
    expect(screen.getByText("Use JWT for auth")).toBeDefined();
    expect(screen.getByText("auth")).toBeDefined();
  });

  it("calls onClick with node id when clicked", () => {
    const onClick = vi.fn();
    renderInFlow(<MemoryNode {...nodePropsFor({ node: sampleNode, onClick })} />);
    fireEvent.click(screen.getByText("Use JWT for auth"));
    expect(onClick).toHaveBeenCalledWith(sampleNode.id);
  });
});
