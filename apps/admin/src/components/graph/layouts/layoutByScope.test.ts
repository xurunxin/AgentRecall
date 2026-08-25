import { describe, it, expect } from "vitest";
import type { GraphNode, GraphEdge } from "@agent-recall/contracts";
import { layoutByScope } from "./layoutByScope.js";

const n = (id: string, scope: GraphNode["scope"]): GraphNode => ({
  id,
  label: id,
  type: "fact",
  topic: "x",
  scope,
  project_id: scope === "project" ? "p1" : null,
  importance: 3,
  status: "active",
  created_at: "2026-08-25T00:00:00.000Z",
});

describe("layoutByScope", () => {
  it("places global nodes on the left and project nodes on the right", () => {
    const nodes = [n("g1", "global"), n("g2", "global"), n("p1", "project"), n("p2", "project")];
    const layout = layoutByScope(nodes, [] as GraphEdge[]);
    const globalMaxX = Math.max(layout.g1!.x, layout.g2!.x);
    const projectMinX = Math.min(layout.p1!.x, layout.p2!.x);
    // Global band ends before project band starts.
    expect(globalMaxX).toBeLessThan(projectMinX);
  });
  it("returns position for every input node", () => {
    const nodes = [n("g1", "global"), n("p1", "project")];
    const layout = layoutByScope(nodes, [] as GraphEdge[]);
    expect(Object.keys(layout).sort()).toEqual(["g1", "p1"]);
  });
});
