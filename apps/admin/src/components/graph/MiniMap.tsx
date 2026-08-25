// Bottom-right mini overview for the hand-rolled graph view.
//
// Shows a scaled-down version of every node + edge so the user can see the
// overall topology at a glance. We don't (yet) support click-to-pan on the
// minimap — that's a v0.2 nicety; for v0.1 the minimap is read-only.
//
// Coordinate system: node positions arrive in graph space. We compute the
// bounding box, then fit the box into a fixed 180×130 panel with 8px padding.
// Lines are drawn between connected nodes; nodes are 2.5px-radius circles
// colored by topic (same palette as the main canvas via colorForTopic).

import { useMemo } from "react";
import type { GraphEdge, GraphNode } from "@agent-recall/contracts";
import { colorForTopic } from "./MemoryNode.js";

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Current nodeId → graph-space position. Must include every node in `nodes`. */
  positions: Map<string, { x: number; y: number }>;
}

const WIDTH = 180;
const HEIGHT = 130;
const PADDING = 8;

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function computeBounds(positions: Map<string, { x: number; y: number }>): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { x, y } of positions.values()) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) {
    // Empty / single-point graph: center a default square.
    return { minX: -50, minY: -50, maxX: 50, maxY: 50 };
  }
  return { minX, minY, maxX, maxY };
}

export default function MiniMap({ nodes, edges, positions }: Props) {
  // Compute the scale & offset that maps graph-space → minimap pixel space.
  // Memoized so the SVG doesn't re-layout on every parent render.
  const { scale, offsetX, offsetY } = useMemo(() => {
    const b = computeBounds(positions);
    const bw = Math.max(1, b.maxX - b.minX);
    const bh = Math.max(1, b.maxY - b.minY);
    const s = Math.min((WIDTH - 2 * PADDING) / bw, (HEIGHT - 2 * PADDING) / bh);
    // Center within the panel.
    const ox = (WIDTH - bw * s) / 2 - b.minX * s;
    const oy = (HEIGHT - bh * s) / 2 - b.minY * s;
    return { scale: s, offsetX: ox, offsetY: oy };
  }, [positions]);

  return (
    <div
      data-testid="graph-minimap"
      style={{
        position: "absolute",
        right: 16,
        bottom: 16,
        zIndex: 20,
        width: WIDTH,
        height: HEIGHT,
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
        overflow: "hidden",
        pointerEvents: "none",
      }}
    >
      <svg
        width={WIDTH}
        height={HEIGHT}
        style={{ display: "block" }}
        // role/aria-label so screen readers can announce "minimap".
        role="img"
        aria-label={`Mini overview: ${nodes.length} nodes, ${edges.length} edges`}
      >
        {/* Edges first (so node circles sit on top). */}
        {edges.map((e, i) => {
          const src = positions.get(e.source);
          const tgt = positions.get(e.target);
          if (!src || !tgt) return null;
          return (
            <line
              key={`me-${i}`}
              x1={src.x * scale + offsetX}
              y1={src.y * scale + offsetY}
              x2={tgt.x * scale + offsetX}
              y2={tgt.y * scale + offsetY}
              stroke="var(--text-dim)"
              strokeWidth={0.4}
              opacity={0.6}
            />
          );
        })}
        {/* Nodes. */}
        {nodes.map((n) => {
          const p = positions.get(n.id);
          if (!p) return null;
          return (
            <circle
              key={`mn-${n.id}`}
              cx={p.x * scale + offsetX}
              cy={p.y * scale + offsetY}
              r={2.5}
              fill={colorForTopic(n.topic)}
            />
          );
        })}
      </svg>
    </div>
  );
}
