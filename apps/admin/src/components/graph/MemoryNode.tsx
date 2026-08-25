import type { NodeProps } from "@xyflow/react";
import type { GraphNode } from "@agent-recall/contracts";

export interface MemoryNodeData {
  node: GraphNode;
  onClick?: (id: string) => void;
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

export default function MemoryNode({ data }: NodeProps) {
  const { node, onClick } = data as unknown as MemoryNodeData;
  const color = colorForTopic(node.topic);
  const showGlow = node.importance >= 4;

  return (
    <div
      onClick={() => onClick?.(node.id)}
      role="button"
      tabIndex={0}
      data-testid={`memory-node-${node.id}`}
      data-topic={node.topic}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        cursor: "pointer",
        userSelect: "none",
        transition: "transform 120ms ease",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.transform = "scale(1.05)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.transform = "scale(1)";
      }}
    >
      {/* Small uniform solid circle on the left; color = topic. */}
      <div
        data-testid="memory-node-circle"
        style={{
          width: 14,
          height: 14,
          borderRadius: "50%",
          background: color,
          flexShrink: 0,
          // Importance 4-5 gets a glow ring to keep high-importance nodes
          // visually distinguishable without changing their size.
          boxShadow: showGlow ? `0 0 0 2px ${color}55` : undefined,
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
