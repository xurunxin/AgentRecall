import type { OrgMode } from "@agent-recall/contracts";

interface Props {
  value: OrgMode;
  onChange: (mode: OrgMode) => void;
}

const OPTIONS: { value: OrgMode; label: string }[] = [
  { value: "none", label: "无" },
  { value: "by_topic", label: "按主题" },
  { value: "by_type", label: "按类型" },
  { value: "by_scope", label: "按 scope" },
  { value: "by_status", label: "按状态" },
];

export function OrgModeSwitcher({ value, onChange }: Props) {
  return (
    <div role="radiogroup" aria-label="组织模式" style={{ display: "inline-flex", gap: 0, border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
      {OPTIONS.map((o) => {
        const selected = value === o.value;
        return (
          <label key={o.value} style={{
            padding: "4px 10px", fontSize: 12, cursor: "pointer",
            background: selected ? "var(--accent)" : "var(--bg-elev)",
            color: selected ? "#fff" : "var(--text)",
            borderRight: "1px solid var(--border)",
          }}>
            <input
              type="radio"
              name="org-mode"
              value={o.value}
              checked={selected}
              onChange={() => onChange(o.value)}
              // Visually hide the native radio but keep it in the
              // accessibility tree (the label IS the control). Plain
              // `display: none` would remove it from the a11y tree AND
              // hide it from `getByRole("radio", …)` queries in tests.
              style={{ position: "absolute", opacity: 0, width: 0, height: 0, overflow: "hidden", pointerEvents: "none" }}
            />
            {o.label}
          </label>
        );
      })}
    </div>
  );
}
