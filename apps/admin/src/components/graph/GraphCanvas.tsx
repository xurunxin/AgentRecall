// Task 15 placeholder stub. Real GraphCanvas lands in Task 18.
// See: .superpowers/sdd/2026-08-24-agent-recall-admin-v0.1/task-18-brief.md
import type { GraphEdge, GraphNode } from "@agent-recall/contracts";

export interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  total: number;
}

export default function GraphCanvas(_props: GraphCanvasProps): null {
  return null;
}
