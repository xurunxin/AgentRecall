interface Props { tags: string[]; }

export function MemoryTags({ tags }: Props) {
  return (
    <div>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-dim)", marginBottom: 4 }}>标签</div>
      {tags.length === 0 ? (
        <span style={{ color: "var(--text-dim)", fontSize: 12 }}>—</span>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {tags.map((t) => (
            <span key={t} style={{
              display: "inline-block", padding: "2px 8px", fontSize: 11,
              background: "var(--bg-elev)", border: "1px solid var(--border)",
              borderRadius: 12, color: "var(--text)",
            }}>{t}</span>
          ))}
        </div>
      )}
    </div>
  );
}
