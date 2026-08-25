import type { GraphEdge } from "@agent-recall/contracts";

const items: Array<{ kind: GraphEdge["kind"]; label: string; color: string; dashed: boolean }> = [
  { kind: "supersede", label: "supersede(版本演进)", color: "var(--edge-supersede)", dashed: false },
  { kind: "merge", label: "merge(合并)", color: "var(--edge-merge)", dashed: false },
  { kind: "co_topic", label: "co-topic(同主题)", color: "var(--edge-co-topic)", dashed: true },
  { kind: "co_scope", label: "co-scope(同项目)", color: "var(--edge-co-scope)", dashed: true },
];

export default function EdgeLegend() {
  return (
    <div style={{ display: "flex", gap: 12, fontSize: 11, padding: "4px 16px" }}>
      {items.map((it) => (
        <div key={it.kind} style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span
            style={{
              display: "inline-block",
              width: 20,
              height: 0,
              borderTop: `2px ${it.dashed ? "dashed" : "solid"} ${it.color}`,
            }}
          />
          {it.label}
        </div>
      ))}
    </div>
  );
}
