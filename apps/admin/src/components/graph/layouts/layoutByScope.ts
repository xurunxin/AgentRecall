import type { GraphEdge, GraphNode } from "@agent-recall/contracts";
import { layoutWithDagre } from "./layoutNone.js";

type Position = { x: number; y: number };
const SCOPE_GAP = 100;

/**
 * Lay out global nodes on the left and project nodes on the right. Each
 * half is laid out with dagre (LR rankdir, like layoutNone) so the two
 * halves stay internally consistent.
 */
export function layoutByScope(
  nodes: GraphNode[],
  edges: GraphEdge[]
): Record<string, Position> {
  const global = nodes.filter((n) => n.scope === "global");
  const project = nodes.filter((n) => n.scope === "project");
  const out: Record<string, Position> = {};
  if (global.length > 0) {
    const globalIds = new Set(global.map((g) => g.id));
    const globalEdges = edges.filter(
      (e) => globalIds.has(e.source) && globalIds.has(e.target)
    );
    const globalLayout = layoutWithDagre(global, globalEdges);
    for (const [id, pos] of Object.entries(globalLayout)) {
      out[id] = pos;
    }
  }
  if (project.length > 0) {
    const projectIds = new Set(project.map((p) => p.id));
    const projectEdges = edges.filter(
      (e) => projectIds.has(e.source) && projectIds.has(e.target)
    );
    const projectLayout = layoutWithDagre(project, projectEdges);
    // Shift project to the right of the global band.
    const xs = Object.values(out).map((p) => p.x);
    const globalMaxX = xs.length > 0 ? Math.max(...xs) : 0;
    for (const [id, pos] of Object.entries(projectLayout)) {
      out[id] = { x: pos.x + globalMaxX + SCOPE_GAP, y: pos.y };
    }
  }
  return out;
}
