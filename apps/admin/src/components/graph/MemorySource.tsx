import { useState } from "react";

interface Props { source: unknown; }

export function MemorySource({ source }: Props) {
  const [open, setOpen] = useState(false);
  const json = JSON.stringify(source, null, 2);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-dim)" }}>来源</span>
        <button type="button" onClick={() => setOpen((o) => !o)} style={{ fontSize: 11, padding: "2px 6px", background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 3, cursor: "pointer" }}>
          {open ? "收起" : "展开"}
        </button>
      </div>
      {open && (
        <pre style={{
          fontSize: 11, lineHeight: 1.4, fontFamily: "monospace",
          background: "var(--bg-elev)", padding: 6, borderRadius: 4,
          border: "1px solid var(--border)",
          maxHeight: 160, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word",
          margin: 0,
        }}>{json}</pre>
      )}
    </div>
  );
}
