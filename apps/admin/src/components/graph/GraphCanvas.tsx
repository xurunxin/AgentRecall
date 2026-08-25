import { ReactFlow, Background, Controls, type Node, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import dagre from "@dagrejs/dagre";
import type { GraphEdge, GraphNode } from "@agent-recall/contracts";
import MemoryNode from "./MemoryNode.js";

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  total: number;
  /** Click on a xyflow node. Receives the underlying GraphNode. */
  onNodeClick?: (node: GraphNode) => void;
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

/**
 * Run dagre layout over nodes/edges and return a copy of `nodes` with
 * positions populated. Nodes that aren't in the dagre graph (e.g. isolates)
 * keep their previous position.
 *
 * Node box dimensions are the max across the importance scale in MemoryNode
 * (importance 5 → 220x80). Dagre centers the box on its computed anchor,
 * so we subtract width/2 and height/2 to convert to xyflow's top-left
 * position convention.
 */
const NODE_WIDTH = 220;
const NODE_HEIGHT = 80;

function layoutWithDagre(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "LR",
    nodesep: 60,
    ranksep: 100,
    marginx: 20,
    marginy: 20,
  });

  nodes.forEach((n) => g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
  edges.forEach((e) => g.setEdge(e.source, e.target));

  dagre.layout(g);

  return nodes.map((n) => {
    const dn = g.node(n.id);
    if (!dn) return n;
    return {
      ...n,
      position: { x: dn.x - NODE_WIDTH / 2, y: dn.y - NODE_HEIGHT / 2 },
    };
  });
}

export default function GraphCanvas({ nodes, edges, truncated, total, onNodeClick }: Props) {
  const flowEdges: Edge[] = useMemo(
    () =>
      edges.map((e, i) => ({
        id: `e-${i}`,
        source: e.source,
        target: e.target,
        style: {
          stroke: edgeKindColor[e.kind],
          strokeDasharray: edgeKindStyle[e.kind] === "dashed" ? "4 4" : undefined,
        },
      })),
    [edges]
  );

  // Compute flowNodes with positions from dagre. Recompute when nodes or
  // edges change so the graph reflows.
  const flowNodes: Node[] = useMemo(() => {
    const base: Node[] = nodes.map((n) => ({
      id: n.id,
      type: "memory",
      position: { x: 0, y: 0 },
      data: { node: n },
    }));
    return layoutWithDagre(base, flowEdges);
    // flowEdges is derived from props.edges via useMemo; including it keeps
    // positions in sync with the latest edge set without re-laying out when
    // the only change is the parent re-rendering.
  }, [nodes, flowEdges]);

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
        节点 {nodes.length} / {total}
        {truncated && " (已截断)"} · 边 {edges.length}
      </div>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={{ memory: MemoryNode }}
        fitView
        onNodeClick={
          onNodeClick
            ? (_event, node) => onNodeClick(node.data.node as GraphNode)
            : undefined
        }
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
