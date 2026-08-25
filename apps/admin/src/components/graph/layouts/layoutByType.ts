import dagre from "@dagrejs/dagre";
import type { GraphEdge, GraphNode } from "@agent-recall/contracts";

type Position = { x: number; y: number };
const TYPE_GAP = 150;
const NODE_WIDTH = 140;
const NODE_HEIGHT = 42;

/**
 * Group nodes by `node.type`, lay out each group with dagre TB rankdir,
 * then stack the groups vertically with a TYPE_GAP between them.
 */
export function layoutByType(
  nodes: GraphNode[],
  edges: GraphEdge[]
): Record<string, Position> {
  const byType = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    const list = byType.get(n.type) ?? [];
    list.push(n);
    byType.set(n.type, list);
  }
  const out: Record<string, Position> = {};
  let offsetY = 0;
  for (const group of byType.values()) {
    const ids = new Set(group.map((g) => g.id));
    const groupEdges = edges.filter(
      (e) => ids.has(e.source) && ids.has(e.target)
    );
    // Use dagre directly with TB rankdir for this group
    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({
      rankdir: "TB",
      nodesep: 30,
      ranksep: 50,
      marginx: 30,
      marginy: 30,
    });
    group.forEach((n) =>
      g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
    );
    groupEdges.forEach((e) => {
      if (g.hasNode(e.source) && g.hasNode(e.target))
        g.setEdge(e.source, e.target);
    });
    dagre.layout(g);
    const ys: number[] = [];
    for (const n of group) {
      const dn = g.node(n.id);
      if (dn) {
        out[n.id] = { x: dn.x, y: dn.y + offsetY };
        ys.push(dn.y);
      }
    }
    if (ys.length > 0) {
      offsetY += Math.max(...ys) - Math.min(...ys) + NODE_HEIGHT + TYPE_GAP;
    }
  }
  return out;
}
