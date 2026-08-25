import { useState, type ReactNode } from "react";
import type { MemoryRelations, RelatedNode } from "@agent-recall/contracts";

interface Props {
  relations: MemoryRelations;
  onJump: (id: string) => void;
}

// Per-type dot color for each row. Matches the convention in MemoryNode.tsx
// (type-based hue rather than topic-based): decision = purple, lesson = amber,
// everything else = slate.
const TYPE_DOT_COLOR: Record<string, string> = {
  decision: "#7c3aed",
  lesson: "#f59e0b",
};
const DEFAULT_DOT_COLOR = "#64748b";

/**
 * A section heading with optional toggle and count. When `defaultOpen` is
 * omitted (or true) the section is always open and the header is a static
 * label; when `defaultOpen={false}` the header becomes a clickable button
 * that opens/closes the body (used for `co_scope` which may have many rows).
 */
function Section({ title, count, defaultOpen = true, children }: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const toggleable = !defaultOpen;
  return (
    <div>
      <button
        type="button"
        onClick={toggleable ? () => setOpen((o) => !o) : undefined}
        aria-expanded={toggleable ? open : undefined}
        style={{
          display: "flex", alignItems: "center", gap: 4, width: "100%",
          background: "transparent", border: "none", padding: "4px 0",
          fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5,
          color: "var(--text-dim)", cursor: toggleable ? "pointer" : "default",
          textAlign: "left",
        }}
      >
        {toggleable && <span aria-hidden="true">{open ? "▾" : "▸"}</span>}
        <span>{title}</span>
        {count !== undefined && <span style={{ marginLeft: 4 }}>({count})</span>}
      </button>
      {open && <div style={{ marginBottom: 8 }}>{children}</div>}
    </div>
  );
}

/**
 * A single clickable row for one `RelatedNode`. Renders a colored dot (by
 * type), the node title (truncated), and the importance as a star count.
 * Whole row is a button so it's keyboard-clickable and a11y-friendly.
 */
function Row({ n, onJump }: { n: RelatedNode; onJump: (id: string) => void }) {
  const dot = TYPE_DOT_COLOR[n.type] ?? DEFAULT_DOT_COLOR;
  return (
    <button
      type="button"
      onClick={() => onJump(n.id)}
      style={{
        display: "flex", alignItems: "center", gap: 8, width: "100%",
        background: "var(--bg-elev)", border: "1px solid var(--border)",
        borderRadius: 3, padding: "4px 8px", marginBottom: 4, cursor: "pointer",
        textAlign: "left", color: "var(--text)",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "inline-block", width: 8, height: 8, borderRadius: "50%",
          background: dot, flexShrink: 0,
        }}
      />
      <span style={{
        fontSize: 12, flex: 1, overflow: "hidden", textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}>{n.title}</span>
      <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{n.importance}★</span>
    </button>
  );
}

/**
 * Render the 4 relation sections (supersede / merge / co_topic / co_scope).
 * The co_scope section is collapsed by default because it can contain many
 * rows. The merge section's empty state calls out the v0.3 follow-up for
 * GraphEdge persistence, since `merge` is intentionally `vec![]` in v0.2.
 */
export function RelatedMemories({ relations, onJump }: Props) {
  const hasSupersede =
    relations.supersedes.length > 0 || relations.superseded_by.length > 0;
  return (
    <div>
      <Section title="版本演进">
        {relations.supersedes.map((n) => <Row key={`s-${n.id}`} n={n} onJump={onJump} />)}
        {relations.superseded_by.map((n) => <Row key={`sb-${n.id}`} n={n} onJump={onJump} />)}
        {!hasSupersede && (
          <span style={{ color: "var(--text-dim)", fontSize: 12 }}>无版本关系</span>
        )}
      </Section>
      <Section title="合并">
        {relations.merge.map((n) => <Row key={`m-${n.id}`} n={n} onJump={onJump} />)}
        {relations.merge.length === 0 && (
          <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
            无合并关系 <span style={{ fontSize: 10 }}>(v0.3)</span>
          </span>
        )}
      </Section>
      <Section title="相关主题" count={relations.co_topic_total}>
        {relations.co_topic.map((n) => <Row key={`ct-${n.id}`} n={n} onJump={onJump} />)}
        {relations.co_topic.length === 0 && (
          <span style={{ color: "var(--text-dim)", fontSize: 12 }}>无同主题</span>
        )}
      </Section>
      <Section title="相关 scope" count={relations.co_scope_total} defaultOpen={false}>
        {relations.co_scope.map((n) => <Row key={`cs-${n.id}`} n={n} onJump={onJump} />)}
      </Section>
    </div>
  );
}
