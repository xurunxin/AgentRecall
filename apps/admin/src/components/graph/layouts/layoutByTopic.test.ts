import { describe, it, expect } from "vitest";
import type { GraphNode, GraphEdge } from "@agent-recall/contracts";
import { layoutByTopic } from "./layoutByTopic.js";

const n = (id: string, topic: string): GraphNode => ({
  id,
  label: id,
  type: "fact",
  topic,
  scope: "global",
  project_id: null,
  importance: 3,
  status: "active",
  created_at: "2026-08-25T00:00:00.000Z",
});

describe("layoutByTopic", () => {
  it("groups nodes by topic with horizontal offset", () => {
    const nodes = [
      n("a", "auth"),
      n("b", "auth"),
      n("c", "cache"),
      n("d", "auth"),
      n("e", "cache"),
    ];
    const layout = layoutByTopic(nodes, [] as GraphEdge[]);
    const xa = layout.a!.x;
    const xb = layout.b!.x;
    const xc = layout.c!.x;
    // The auth group (a, b, d) should all be to the left of the cache group (c, e)
    expect(Math.max(xa, xb, layout.d!.x)).toBeLessThan(Math.min(xc, layout.e!.x));
  });
  it("returns position for every input node", () => {
    const nodes = [n("a", "auth"), n("b", "cache")];
    const layout = layoutByTopic(nodes, [] as GraphEdge[]);
    expect(Object.keys(layout).sort()).toEqual(["a", "b"]);
  });
});
