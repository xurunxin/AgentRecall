import { forwardRef, type CSSProperties } from "react";
import type { NodeProps } from "@xyflow/react";
import type { GraphNode } from "@agent-recall/contracts";

export interface MemoryNodeData {
  node: GraphNode;
  // `onClick` is intentionally NOT on the per-node data payload: drawer-open
  // is handled by xyflow's <ReactFlow onNodeClick={…}> on the parent, which
  // gives correct click-vs-drag disambiguation for free.
}

// 12-color qualitative palette for the most common topics, chosen to be
// distinguishable on both light and dark backgrounds. Topics that don't match
// an entry fall through `colorForTopic` to a hashed palette.
const TOPIC_PALETTE: Record<string, string> = {
  auth: "#3b82f6", // blue
  cache: "#f97316", // orange
  logging: "#10b981", // green
  observability: "#a855f7", // purple
  security: "#ef4444", // red
  performance: "#eab308", // yellow
  general: "#06b6d4", // cyan
};

const FALLBACK_PALETTE = [
  "#ec4899", // pink
  "#8b5cf6", // violet
  "#14b8a6", // teal
  "#f59e0b", // amber
  "#0ea5e9", // sky
  "#84cc16", // lime
];

/**
 * Pick a color for a topic. Known topics get a fixed hue so colors stay
 * stable across sessions; unknown topics get a stable hash-mapped color so
 * every topic still has *some* visual identity.
 */
export function colorForTopic(topic: string): string {
  const known = TOPIC_PALETTE[topic];
  if (known) return known;
  let h = 0;
  for (let i = 0; i < topic.length; i++) {
    h = (h * 31 + topic.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_PALETTE[h % FALLBACK_PALETTE.length]!;
}

// Uniform node circle diameter. Used for both the visible circle and the
// dagre layout box (see GraphCanvas.tsx NODE_WIDTH). 3× the original 14px so
// the topic color reads as a clear dot, not a pixel-sized speck.
const CIRCLE_BASE = 42;

/**
 * xyflow v12 passes a `ref` to the custom node component so it can attach
 * its own drag/selection handlers. Without `forwardRef`, that ref is dropped
 * and `nodesDraggable` silently does nothing — nodes are still clickable
 * (because onNodeClick uses a different code path) but cannot be dragged.
 *
 * The fix: wrap the component in `forwardRef<HTMLDivElement, NodeProps>` and
 * forward the ref to the outermost wrapper div. The wrapper is the single
 * element that owns the row layout, so attaching the ref there lets xyflow
 * capture pointer events from anywhere on the row.
 *
 * `NodeProps` is used with its default generic (the bare `Node<...>` type)
 * because `nodeTypes` in `@xyflow/react` requires components assignable to
 * `ComponentType<NodeProps & { data: any; type: any }>`. The per-node
 * `data` is widened to `any` in that signature, so we keep the existing
 * `data as unknown as MemoryNodeData` cast inside the body.
 */
const MemoryNode = forwardRef<HTMLDivElement, NodeProps>(
  function MemoryNode({ data }, ref) {
    const { node } = data as unknown as MemoryNodeData;
    const color = colorForTopic(node.topic);
    const showGlow = node.importance >= 4;

    return (
      <div
        ref={ref}
        // No `onClick` here on purpose: xyflow's own click-vs-drag detection
        // (wired through `onNodeClick` on the <ReactFlow> parent) handles
        // drawer-open, while the row remains freely draggable. Adding a
        // manual onClick would steal pointer events and break drag.
        data-testid={`memory-node-${node.id}`}
        data-topic={node.topic}
        style={
          {
            display: "flex",
            alignItems: "center",
            gap: 8,
            // `grab` cursor signals that the row is draggable. xyflow still
            // owns the actual pointer handling (so the cursor flips to
            // `grabbing` while dragging) — this is just visual feedback.
            cursor: "grab",
            userSelect: "none",
            transition: "transform 120ms ease",
          } as CSSProperties
        }
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLDivElement).style.transform = "scale(1.04)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLDivElement).style.transform = "scale(1)";
        }}
      >
        {/* Solid topic-color circle. Uniform 42px regardless of importance. */}
        <div
          data-testid="memory-node-circle"
          style={{
            width: CIRCLE_BASE,
            height: CIRCLE_BASE,
            borderRadius: "50%",
            background: color,
            flexShrink: 0,
            // Importance 4-5 gets a 3px glow ring (same color, 33% alpha) so
            // high-importance nodes stand out without changing their size.
            boxShadow: showGlow ? `0 0 0 3px ${color}55` : undefined,
          }}
        />
        {/* Label on the right; ellipsis when it overflows 180px. */}
        <div
          title={node.label}
          style={{
            fontSize: 11,
            color: "var(--text)",
            background: "var(--bg-elev)",
            padding: "2px 6px",
            borderRadius: 3,
            maxWidth: 180,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            border: "1px solid var(--border)",
          }}
        >
          {node.label}
        </div>
      </div>
    );
  }
);

export default MemoryNode;

