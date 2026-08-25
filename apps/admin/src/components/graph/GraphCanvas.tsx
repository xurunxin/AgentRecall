import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
} from "@xyflow/react";
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
 * Map an importance value (1..5) to the matching circle diameter that
 * MemoryNode renders. Kept in sync with `SIZE_BY_IMPORTANCE` in
 * MemoryNode.tsx so dagre can lay out using the real per-node size. Unknown
 * importance falls back to importance 3 (80px) which is the median scale.
 */
function diameterForImportance(imp: number): number {
  const clamped = Math.max(1, Math.min(5, Math.round(imp)));
  return [56, 68, 80, 96, 112][clamped - 1]!;
}

/**
 * Run dagre layout over nodes/edges and return a copy of `nodes` with
 * positions populated. Nodes that aren't in the dagre graph (e.g. isolates)
 * keep their previous position.
 *
 * We pass **per-node** width/height derived from the node's importance
 * rather than a single max-size box, so the layout reflects the actual
 * circle diameter (56..112) instead of a 220×80 rectangle. Dagre centers
 * each box on its computed anchor, so we subtract width/2 and height/2 to
 * convert to xyflow's top-left position convention.
 */
function layoutWithDagre(
  nodes: Node<{ node: GraphNode }>[],
  edges: Edge[]
): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "LR",
    nodesep: 25,
    ranksep: 40,
    marginx: 30,
    marginy: 30,
  });

  const sizeById = new Map<string, { width: number; height: number }>();
  nodes.forEach((n) => {
    const d = diameterForImportance(n.data?.node?.importance ?? 3);
    sizeById.set(n.id, { width: d, height: d });
    g.setNode(n.id, { width: d, height: d });
  });
  edges.forEach((e) => g.setEdge(e.source, e.target));

  dagre.layout(g);

  return nodes.map((n) => {
    const dn = g.node(n.id);
    const size = sizeById.get(n.id) ?? { width: 80, height: 80 };
    if (!dn) return n;
    return {
      ...n,
      position: { x: dn.x - size.width / 2, y: dn.y - size.height / 2 },
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
    const base: Node<{ node: GraphNode }>[] = nodes.map((n) => ({
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
        fitViewOptions={{ padding: 0.25 }}
        onNodeClick={
          onNodeClick
            ? (_event, node) => onNodeClick(node.data.node as GraphNode)
            : undefined
        }
      >
        <Background />
        <Controls />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => {
            const status = (n.data as { node?: GraphNode })?.node?.status;
            return status ? `var(--status-${status})` : "var(--text-dim)";
          }}
          maskColor="rgba(0, 0, 0, 0.05)"
        />
      </ReactFlow>
    </div>
  );
}
