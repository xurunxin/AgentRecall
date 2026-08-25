import { describe, it, expect } from "vitest";
import type { GraphNode, GraphEdge } from "@agent-recall/contracts";
import { layoutByType } from "./layoutByType.js";

const n = (id: string, type: GraphNode["type"]): GraphNode => ({
  id,
  label: id,
  type,
  topic: "x",
  scope: "global",
  project_id: null,
  importance: 3,
  status: "active",
  created_at: "2026-08-25T00:00:00.000Z",
});

describe("layoutByType", () => {
  it("stacks groups vertically (different y-bands for different types)", () => {
    const nodes = [
      n("a", "fact"),
      n("b", "fact"),
      n("c", "preference"),
      n("d", "preference"),
    ];
    const layout = layoutByType(nodes, [] as GraphEdge[]);
    // fact group (a, b) sits above preference group (c, d) — their y-bands don't overlap.
    const yA = layout.a!.y;
    const yB = layout.b!.y;
    const yC = layout.c!.y;
    const yD = layout.d!.y;
    const factMaxY = Math.max(yA, yB);
    const prefMinY = Math.min(yC, yD);
    expect(factMaxY).toBeLessThan(prefMinY);
  });
  it("returns position for every input node", () => {
    const nodes = [n("a", "fact"), n("b", "preference")];
    const layout = layoutByType(nodes, [] as GraphEdge[]);
    expect(Object.keys(layout).sort()).toEqual(["a", "b"]);
  });
});
