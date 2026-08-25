import type { GraphEdge, GraphNode } from "@agent-recall/contracts";
import { layoutWithDagre } from "./layoutNone.js";

type Position = { x: number; y: number };
const TOPIC_GAP = 200;

/** 同 topic 节点水平成簇,簇间用 TOPIC_GAP 隔开。 */
export function layoutByTopic(
  nodes: GraphNode[],
  edges: GraphEdge[]
): Record<string, Position> {
  const byTopic = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    const list = byTopic.get(n.topic) ?? [];
    list.push(n);
    byTopic.set(n.topic, list);
  }
  const out: Record<string, Position> = {};
  let offsetX = 0;
  for (const group of byTopic.values()) {
    const ids = new Set(group.map((g) => g.id));
    const groupEdges = edges.filter(
      (e) => ids.has(e.source) && ids.has(e.target)
    );
    const groupLayout = layoutWithDagre(group, groupEdges);
    if (Object.keys(groupLayout).length === 0) continue;
    const xs = Object.values(groupLayout).map((p) => p.x);
    const groupMin = Math.min(...xs);
    const groupMax = Math.max(...xs);
    for (const [id, pos] of Object.entries(groupLayout)) {
      out[id] = { x: pos.x - groupMin + offsetX, y: pos.y };
    }
    offsetX += groupMax - groupMin + TOPIC_GAP;
  }
  return out;
}
