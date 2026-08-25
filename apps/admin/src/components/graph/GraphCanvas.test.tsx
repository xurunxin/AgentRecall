import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { GraphNode } from "@agent-recall/contracts";
import GraphCanvas from "./GraphCanvas.js";

vi.mock("./layouts/layoutNone.js", () => ({
  layoutNone: vi.fn(() => ({ a: { x: 100, y: 50 } })),
  layoutWithDagre: vi.fn(() => ({ a: { x: 100, y: 50 } })),
}));
vi.mock("./layouts/layoutByTopic.js", () => ({
  layoutByTopic: vi.fn(() => ({ a: { x: 200, y: 50 } })),
}));
vi.mock("./layouts/layoutByType.js", () => ({
  layoutByType: vi.fn(() => ({ a: { x: 300, y: 50 } })),
}));
vi.mock("./layouts/layoutByScope.js", () => ({
  layoutByScope: vi.fn(() => ({ a: { x: 400, y: 50 } })),
}));
vi.mock("./layouts/layoutByStatus.js", () => ({
  layoutByStatus: vi.fn(() => ({ a: { x: 500, y: 50 } })),
}));

import { layoutNone } from "./layouts/layoutNone.js";
import { layoutByTopic } from "./layouts/layoutByTopic.js";

const node: GraphNode = {
  id: "a",
  label: "a",
  type: "fact",
  topic: "x",
  scope: "global",
  project_id: null,
  importance: 3,
  status: "active",
  created_at: "2026-08-25T00:00:00.000Z",
};

describe("GraphCanvas organization dispatch", () => {
  beforeEach(() => {
    vi.mocked(layoutNone).mockClear();
    vi.mocked(layoutByTopic).mockClear();
  });

  it("uses layoutNone when organization is 'none'", () => {
    render(
      <GraphCanvas
        nodes={[node]}
        edges={[]}
        truncated={false}
        total={1}
        organization="none"
        onNodeClick={() => {}}
      />
    );
    expect(layoutNone).toHaveBeenCalled();
    expect(layoutByTopic).not.toHaveBeenCalled();
  });

  it("uses layoutByTopic when organization is 'by_topic'", () => {
    render(
      <GraphCanvas
        nodes={[node]}
        edges={[]}
        truncated={false}
        total={1}
        organization="by_topic"
        onNodeClick={() => {}}
      />
    );
    expect(layoutByTopic).toHaveBeenCalled();
  });
});
