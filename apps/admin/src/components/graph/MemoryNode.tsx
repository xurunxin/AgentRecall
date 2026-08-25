import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { GraphNode } from "@agent-recall/contracts";

export interface MemoryNodeData {
  node: GraphNode;
  onClick?: (id: string) => void;
}

// Importance (1..5) → visual size scales. These are inline-style based, not
// React props, per design. Tuple indexed by (importance - 1) keeps the
// lookup safe even with `noUncheckedIndexedAccess`.
const SIZE_BY_IMPORTANCE: ReadonlyArray<{ width: number; fontSize: number; padding: number; borderWidth: number }> = [
  { width: 140, fontSize: 10, padding: 6, borderWidth: 1 }, // 1
  { width: 160, fontSize: 11, padding: 7, borderWidth: 1.5 }, // 2
  { width: 180, fontSize: 12, padding: 8, borderWidth: 2 }, // 3
  { width: 200, fontSize: 13, padding: 9, borderWidth: 2.5 }, // 4
  { width: 220, fontSize: 14, padding: 10, borderWidth: 3 }, // 5
];

function sizeForImportance(imp: number) {
  const clamped = Math.max(1, Math.min(5, Math.round(imp)));
  return SIZE_BY_IMPORTANCE[clamped - 1]!;
}

export default function MemoryNode({ data }: NodeProps) {
  const { node, onClick } = data as unknown as MemoryNodeData;
  const statusColor = `var(--status-${node.status})`;
  const { width, fontSize, padding, borderWidth } = sizeForImportance(node.importance);

  return (
    <div
      onClick={() => onClick?.(node.id)}
      style={{
        width,
        padding,
        borderRadius: 6,
        background: "var(--bg-elev)",
        border: `${borderWidth}px solid ${statusColor}`,
        cursor: "pointer",
        fontSize,
        // Subtle hover affordance. xyflow wraps custom nodes in its own
        // container; the transition lives here so it stays scoped.
        transition: "transform 120ms ease, box-shadow 120ms ease",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.transform = "scale(1.02)";
        (e.currentTarget as HTMLDivElement).style.boxShadow =
          "0 2px 8px rgba(0, 0, 0, 0.15)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.transform = "scale(1)";
        (e.currentTarget as HTMLDivElement).style.boxShadow = "none";
      }}
    >
      <Handle type="target" position={Position.Top} />
      <div
        style={{
          fontWeight: 600,
          marginBottom: 4,
          // Truncate very long labels rather than wrap (xyflow nodes are
          // single-line by default; a multi-line wrap would push the box
          // taller than the dagre layout budget and overlap neighbors).
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
        title={node.label}
      >
        {node.label}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <span
          style={{
            fontSize: Math.max(9, fontSize - 2),
            padding: "2px 6px",
            background: "var(--bg)",
            borderRadius: 3,
            color: "var(--text-dim)",
            maxWidth: width * 0.6,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={node.topic}
        >
          {node.topic}
        </span>
        <span style={{ fontSize: Math.max(9, fontSize - 2), color: "var(--text-dim)" }}>
          ★{node.importance}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
