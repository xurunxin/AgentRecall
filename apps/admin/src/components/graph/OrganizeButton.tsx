interface Props {
  onOrganize: () => void;
  busy: boolean;
}

export function OrganizeButton({ onOrganize, busy }: Props) {
  return (
    <button
      type="button"
      onClick={onOrganize}
      disabled={busy}
      title="按当前组织模式重新布局"
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        padding: "4px 10px", fontSize: 12,
        background: busy ? "var(--bg-elev)" : "var(--accent)",
        color: busy ? "var(--text-dim)" : "#fff",
        border: "1px solid var(--border)", borderRadius: 4,
        cursor: busy ? "wait" : "pointer",
      }}
    >
      <span style={{ display: "inline-block", transform: busy ? "rotate(360deg)" : "none", transition: "transform 0.3s" }}>✨</span>
      <span>整理</span>
    </button>
  );
}
