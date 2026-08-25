import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
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

describe("MemoryNode", () => {
  it("renders the label as visible text and exposes the full label via the title tooltip", () => {
    render(<MemoryNode node={sampleNode} />);
    // The label is the visible text next to the node.
    expect(screen.getByText("Use JWT for auth")).toBeDefined();
    // And also reachable via the native title attribute (hover tooltip).
    expect(screen.getByTitle("Use JWT for auth")).toBeDefined();
  });

  it("exposes the topic as a data attribute for styling and tests", () => {
    render(<MemoryNode node={sampleNode} />);
    const root = screen.getByTestId(`memory-node-${sampleNode.id}`);
    expect(root.getAttribute("data-topic")).toBe("auth");
  });

  it("renders a 42px topic-color circle (UX hotfix #4: 3× the original 14px)", () => {
    render(<MemoryNode node={sampleNode} />);
    const circle = screen.getByTestId("memory-node-circle");
    // Width/height are set via inline style; assert both the literal px
    // values and the topic background color.
    expect(circle.style.width).toBe("42px");
    expect(circle.style.height).toBe("42px");
    expect(circle.style.borderRadius).toBe("50%");
    // Topic "auth" → blue per TOPIC_PALETTE.
    expect(circle.style.background).toContain("rgb(59, 130, 246)");
  });

  it("adds a glow box-shadow on the circle when importance >= 4", () => {
    const high: GraphNode = { ...sampleNode, importance: 5 };
    render(<MemoryNode node={high} />);
    const circle = screen.getByTestId("memory-node-circle");
    // Browser keeps our `0 0 0 3px ${color}55` template-literal value
    // verbatim (it does NOT normalize hex→rgb for box-shadow like it does
    // for `background`). Assert the 3px halo width + the topic color.
    expect(circle.style.boxShadow).toContain("3px");
    expect(circle.style.boxShadow).toContain("#3b82f6");
  });

  it("omits the glow box-shadow on the circle when importance < 4", () => {
    const low: GraphNode = { ...sampleNode, importance: 2 };
    render(<MemoryNode node={low} />);
    const circle = screen.getByTestId("memory-node-circle");
    expect(circle.style.boxShadow).toBe("");
  });

  it("renders long labels and relies on CSS ellipsis (no crash on overflow)", () => {
    const long: GraphNode = {
      ...sampleNode,
      label: "A very long memory label that would exceed 180px if not for CSS truncation handling",
    };
    render(<MemoryNode node={long} />);
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
