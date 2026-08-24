import { ReactFlow, Background, Controls, type Node, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import type { GraphEdge, GraphNode } from "@agent-recall/contracts";
import MemoryNode from "./MemoryNode.js";

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  total: number;
  onNodeClick?: (id: string) => void;
}

const edgeKindColor: Record<GraphEdge["kind"], string> = {
  supersede: "var(--edge-supersede)",
  merge: "var(--edge-merge)",
  co_topic: "var(--edge-co-topic)",
  co_scope: "var(--edge-co-scope)",
};

const edgeKindStyle: Record<GraphEdge["kind"], "solid" | "dashed"> = {
  supersede: "solid",
  merge: "solid",
  co_topic: "dashed",
  co_scope: "dashed",
};

export default function GraphCanvas({ nodes, edges, truncated, total, onNodeClick }: Props) {
  const flowNodes: Node[] = useMemo(
    () =>
      nodes.map((n) => ({
        id: n.id,
        type: "memory",
        position: { x: 0, y: 0 }, // 让 xyflow 自动布局(dagre)
        data: { node: n, onClick: onNodeClick ?? (() => {}) },
      })),
    [nodes, onNodeClick]
  );

  const flowEdges: Edge[] = useMemo(
    () =>
      edges.map((e, i) => ({
        id: `e-${i}`,
        source: e.source,
        target: e.target,
        style: { stroke: edgeKindColor[e.kind], strokeDasharray: edgeKindStyle[e.kind] === "dashed" ? "4 4" : undefined },
      })),
    [edges]
  );

  return (
    <div style={{ flex: 1, position: "relative" }}>
      <div
        style={{
          position: "absolute",
          top: 8,
          left: 8,
          zIndex: 10,
          padding: "4px 8px",
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: 4,
          fontSize: 12,
        }}
      >
        节点 {nodes.length} / {total}{truncated && " (已截断)"} · 边 {edges.length}
      </div>
      <ReactFlow nodes={flowNodes} edges={flowEdges} nodeTypes={{ memory: MemoryNode }} fitView>
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
