import type { GraphEdge, GraphNode } from "@agent-recall/contracts";

type Position = { x: number; y: number };
const ROW_HEIGHT = 120;
const ROW_GAP = 30;
const STATUS_ORDER = ["active", "archived", "superseded", "forgotten"] as const;

/**
 * Lay out nodes in 4 horizontal rows in fixed order
 * (active → archived → superseded → forgotten). Within each row, nodes are
 * ordered by importance descending (highest importance leftmost).
 */
export function layoutByStatus(
  nodes: GraphNode[],
  _edges: GraphEdge[]
): Record<string, Position> {
  const byStatus = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    const list = byStatus.get(n.status) ?? [];
    list.push(n);
    byStatus.set(n.status, list);
  }
  const out: Record<string, Position> = {};
  STATUS_ORDER.forEach((status, rowIdx) => {
    const group = byStatus.get(status) ?? [];
    if (group.length === 0) return;
    // Sort by importance desc within row
    const sorted = [...group].sort((a, b) => b.importance - a.importance);
    sorted.forEach((n, colIdx) => {
      out[n.id] = {
        x: 60 + colIdx * 120,
        y: 60 + rowIdx * (ROW_HEIGHT + ROW_GAP),
      };
    });
  });
  return out;
}
