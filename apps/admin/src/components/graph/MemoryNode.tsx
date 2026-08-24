import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { GraphNode } from "@agent-recall/contracts";

export interface MemoryNodeData {
  node: GraphNode;
  onClick: (id: string) => void;
}

export default function MemoryNode({ data }: NodeProps) {
  const { node, onClick } = data as unknown as MemoryNodeData;
  const statusColor = `var(--status-${node.status})`;
  return (
    <div
      onClick={() => onClick(node.id)}
      style={{
        padding: "8px 12px",
        borderRadius: 6,
        background: "var(--bg-elev)",
        border: `2px solid ${statusColor}`,
        cursor: "pointer",
        maxWidth: 220,
        fontSize: 12,
      }}
    >
      <Handle type="target" position={Position.Top} />
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{node.label}</div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <span
          style={{
            fontSize: 10,
            padding: "2px 6px",
            background: "var(--bg)",
            borderRadius: 3,
            color: "var(--text-dim)",
          }}
        >
          {node.topic}
        </span>
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
          ★{node.importance}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
