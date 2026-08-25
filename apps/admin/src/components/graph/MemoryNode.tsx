import type { NodeProps } from "@xyflow/react";
import type { GraphNode } from "@agent-recall/contracts";

export interface MemoryNodeData {
  node: GraphNode;
  onClick?: (id: string) => void;
}

// Importance (1..5) → visual size. Tuple indexed by (importance - 1) keeps the
// lookup safe even with `noUncheckedIndexedAccess`. The same scale is shared
// with GraphCanvas so dagre lays out nodes using the real per-node size
// instead of one max-size box.
const SIZE_BY_IMPORTANCE: ReadonlyArray<{ diameter: number; fontSize: number; borderWidth: number }> = [
  { diameter: 56, fontSize: 18, borderWidth: 1 }, // 1
  { diameter: 68, fontSize: 20, borderWidth: 1.5 }, // 2
  { diameter: 80, fontSize: 24, borderWidth: 2 }, // 3
  { diameter: 96, fontSize: 28, borderWidth: 2.5 }, // 4
  { diameter: 112, fontSize: 32, borderWidth: 3 }, // 5
];

function sizeForImportance(imp: number) {
  const clamped = Math.max(1, Math.min(5, Math.round(imp)));
  return SIZE_BY_IMPORTANCE[clamped - 1]!;
}

/**
 * Pick a 1- or 2-character label that fits inside the circle. We use the
 * first letter of the topic; if the topic is a single character we keep it,
 * otherwise we fall back to the first two characters. The full topic is
 * always available via the native `title` attribute on hover.
 */
function glyphForTopic(topic: string): string {
  const trimmed = topic.trim();
  if (trimmed.length === 0) return "?";
  return trimmed.length === 1 ? trimmed : trimmed.slice(0, 2);
}

export default function MemoryNode({ data }: NodeProps) {
  const { node, onClick } = data as unknown as MemoryNodeData;
  const statusColor = `var(--status-${node.status})`;
  const { diameter, fontSize, borderWidth } = sizeForImportance(node.importance);
  const glyph = glyphForTopic(node.topic);

  return (
    <div
      onClick={() => onClick?.(node.id)}
      title={node.topic}
      role="button"
      tabIndex={0}
      style={{
        width: diameter,
        height: diameter,
        // 50% keeps the box a true circle (width === height).
        borderRadius: "50%",
        background: "var(--bg-elev)",
        border: `${borderWidth}px solid ${statusColor}`,
        cursor: "pointer",
        // Center the glyph both axes; flex is the cheapest cross-browser way
        // to do it without an extra wrapper.
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 700,
        fontSize,
        color: "var(--text)",
        // Subtle hover affordance. xyflow wraps custom nodes in its own
        // container; the transition lives here so it stays scoped.
        transition: "transform 120ms ease, box-shadow 120ms ease",
        // Topic filter is shown via the title attribute; the only visible
        // glyph is 1-2 chars, so overflow can't happen.
        userSelect: "none",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.transform = "scale(1.06)";
        (e.currentTarget as HTMLDivElement).style.boxShadow =
          "0 2px 8px rgba(0, 0, 0, 0.18)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.transform = "scale(1)";
        (e.currentTarget as HTMLDivElement).style.boxShadow = "none";
      }}
    >
      {glyph}
    </div>
  );
}
