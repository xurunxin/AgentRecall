import dagre from "@dagrejs/dagre";
import type { GraphEdge, GraphNode } from "@agent-recall/contracts";

type Position = { x: number; y: number };
const NODE_WIDTH = 42 + 8 + 90; // 140 — dagre box matches the visible node footprint so edge endpoints land on the actual circle boundary. 42px circle + 8px gap + ~90px avg label = 140.
const NODE_HEIGHT = 42;

/**
 * Run dagre layout over the given nodes. Returns a map of nodeId → position
 * (graph-space center coordinates). Nodes that aren't in the dagre graph
 * (isolates) are placed in a small grid so they still render.
 *
 * Extracted verbatim from v0.1 `GraphCanvas.tsx` so all other layouts can
 * reuse the same dagre configuration (LR rankdir, 40/60 spacing).
 */
export function layoutWithDagre(
  nodes: GraphNode[],
  edges: GraphEdge[]
): Record<string, Position> {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "LR",
    nodesep: 40,
    ranksep: 60,
    marginx: 40,
    marginy: 40,
  });

  nodes.forEach((n) => g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
  edges.forEach((e) => {
    // Only lay out edges whose endpoints both exist in the node set.
    if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
  });

  dagre.layout(g);

  const out: Record<string, Position> = {};
  const isolates: GraphNode[] = [];
  nodes.forEach((n) => {
    const dn = g.node(n.id);
    if (dn) {
      out[n.id] = { x: dn.x, y: dn.y };
    } else {
      isolates.push(n);
    }
  });

  // Place any isolates on a 3-column grid below the main layout so they
  // remain visible but separate. dagre returns undefined for nodes with no
  // edges, so they fall through here.
  isolates.forEach((n, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    out[n.id] = {
      x: 40 + NODE_WIDTH / 2 + col * (NODE_WIDTH + 40),
      y: 40 + NODE_HEIGHT / 2 + row * (NODE_HEIGHT + 60),
    };
  });

  return out;
}

/** "no organization" layout — identical to v0.1's flat dagre LR layout. */
export const layoutNone = layoutWithDagre;
