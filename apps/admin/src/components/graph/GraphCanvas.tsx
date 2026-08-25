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
import MemoryNode, { colorForTopic } from "./MemoryNode.js";

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  total: number;
  /** Click on a xyflow node. Receives the underlying GraphNode. */
  onNodeClick?: (node: GraphNode) => void;
}

// Actual hex values (NOT CSS vars — SVG `stroke` attribute does not resolve
// `var(--…)`, so we duplicate the same colors that live in `theme.css` as
// `--edge-supersede/merge/co-topic/co-scope`. Keep these in sync if the theme
// palette ever changes.
const edgeKindColor: Record<GraphEdge["kind"], string> = {
  supersede: "#2563eb", // blue
  merge: "#7c3aed", // purple
  co_topic: "#f59e0b", // amber
  co_scope: "#9ca3af", // gray
};

const edgeKindStyle: Record<GraphEdge["kind"], "solid" | "dashed"> = {
  supersede: "solid",
  merge: "solid",
  co_topic: "dashed",
  co_scope: "dashed",
};

/**
 * All MemoryNode instances now render the same row: a 42px circle + 8px gap +
 * up to 180px label. Using a single fixed box for dagre is correct (importance
 * no longer changes size) and keeps the layout predictable.
 */
const NODE_WIDTH = 42 + 8 + 180; // 230
const NODE_HEIGHT = 48;

/**
 * Run dagre layout over nodes/edges and return a copy of `nodes` with
 * positions populated. Nodes that aren't in the dagre graph (e.g. isolates)
 * keep their previous position.
 *
 * Each box is the uniform 230×48 row; dagre centers each box on its computed
 * anchor, so we subtract width/2 and height/2 to convert to xyflow's
 * top-left position convention.
 */
function layoutWithDagre(
  nodes: Node<{ node: GraphNode }>[],
  edges: Edge[]
): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "LR",
    nodesep: 20,
    ranksep: 30,
    marginx: 30,
    marginy: 30,
  });

  nodes.forEach((n) => {
    g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  });
  edges.forEach((e) => g.setEdge(e.source, e.target));

  dagre.layout(g);

  return nodes.map((n) => {
    const dn = g.node(n.id);
    if (!dn) return n;
    return {
      ...n,
      position: {
        x: dn.x - NODE_WIDTH / 2,
        y: dn.y - NODE_HEIGHT / 2,
      },
    };
  });
}

export default function GraphCanvas({ nodes, edges, truncated, total, onNodeClick }: Props) {
  const flowEdges: Edge[] = useMemo(
    () =>
      edges.map((e, i) => {
        // co_topic / co_scope are ambient similarity edges — keep them visible
        // but de-emphasized so the eye lands on supersede/merge first.
        const isAmbient = e.kind === "co_topic" || e.kind === "co_scope";
        return {
          id: `e-${i}`,
          source: e.source,
          target: e.target,
          type: "default",
          // zIndex:1 keeps edges above the dot/line background (<0) but
          // below xyflow's default node zIndex of 5, so nodes always win
          // when they overlap an edge.
          zIndex: 1,
          style: {
            stroke: edgeKindColor[e.kind],
            strokeWidth: isAmbient ? 1 : 1.5,
            strokeDasharray: edgeKindStyle[e.kind] === "dashed" ? "4 4" : undefined,
            opacity: isAmbient ? 0.5 : 0.9,
          },
        };
      }),
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
        <Controls
          // xyflow's Controls ship with a white background that looks like a
          // white block on dark mode. Force a dark wrapper via inline style
          // — the inner buttons inherit the button color tokens.
          style={{
            backgroundColor: "#1a1a1a",
            border: "1px solid #2a2a2a",
            borderRadius: 4,
          }}
        />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => {
            const topic = (n.data as { node?: GraphNode })?.node?.topic;
            // Reuse the same palette as MemoryNode so the minimap is a
            // faithful thumbnail of the main canvas.
            return topic ? colorForTopic(topic) : "#6b7280";
          }}
          // Darker mask + dark background so the minimap doesn't render as
          // a white block in dark mode.
          maskColor="rgba(0, 0, 0, 0.6)"
          style={{
            backgroundColor: "#1a1a1a",
            border: "1px solid #2a2a2a",
          }}
          ariaLabel="Graph minimap"
        />
      </ReactFlow>
    </div>
  );
}
