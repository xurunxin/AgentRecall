interface Props { body: string; }

export function MemoryBody({ body }: Props) {
  const handleCopy = async () => {
    try { await navigator.clipboard.writeText(body); } catch { /* ignore */ }
  };
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-dim)" }}>全文</span>
        <button type="button" onClick={handleCopy} style={{ fontSize: 11, padding: "2px 6px", background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 3, cursor: "pointer" }}>
          复制
        </button>
      </div>
      <pre style={{
        fontSize: 12, lineHeight: 1.5, fontFamily: "monospace",
        background: "var(--bg-elev)", padding: 8, borderRadius: 4,
        border: "1px solid var(--border)",
        maxHeight: 240, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word",
        margin: 0,
      }}>{body}</pre>
    </div>
  );
}
