import { describe, it, expect } from "vitest";
import type { GraphNode, GraphEdge } from "@agent-recall/contracts";
import { layoutByStatus } from "./layoutByStatus.js";

const n = (id: string, status: GraphNode["status"]): GraphNode => ({
  id,
  label: id,
  type: "fact",
  topic: "x",
  scope: "global",
  project_id: null,
  importance: 3,
  status,
  created_at: "2026-08-25T00:00:00.000Z",
});

describe("layoutByStatus", () => {
  it("preserves row order active < archived < superseded < forgotten (by y)", () => {
    const nodes = [
      n("a", "active"),
      n("b", "archived"),
      n("c", "superseded"),
      n("d", "forgotten"),
    ];
    const layout = layoutByStatus(nodes, [] as GraphEdge[]);
    expect(layout.a!.y).toBeLessThan(layout.b!.y);
    expect(layout.b!.y).toBeLessThan(layout.c!.y);
    expect(layout.c!.y).toBeLessThan(layout.d!.y);
  });
  it("returns position for every input node", () => {
    const nodes = [n("a", "active"), n("b", "forgotten")];
    const layout = layoutByStatus(nodes, [] as GraphEdge[]);
    expect(Object.keys(layout).sort()).toEqual(["a", "b"]);
  });
});
