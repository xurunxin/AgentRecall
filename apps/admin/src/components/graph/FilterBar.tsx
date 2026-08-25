import { useState, useEffect } from "react";
import type { GraphFilter, MemoryType, MemoryStatus, OrgMode } from "@agent-recall/contracts";
import { OrgModeSwitcher } from "./OrgModeSwitcher.js";
import { OrganizeButton } from "./OrganizeButton.js";

const TYPES: MemoryType[] = ["preference", "procedure", "fact", "decision", "lesson", "debugging", "constraint"];
const STATUSES: MemoryStatus[] = ["active", "archived", "superseded", "forgotten"];

interface Props {
  filter: GraphFilter;
  onChange: (f: GraphFilter) => void;
  onRefresh: () => void;
  organization: OrgMode;
  onOrganizationChange: (m: OrgMode) => void;
  onOrganize: () => void;
  organizeBusy: boolean;
}

function Pill({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 8px", fontSize: 12,
      background: "var(--bg)", border: "1px solid var(--accent)", color: "var(--text)",
      borderRadius: 12,
    }}>
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`移除 ${label}`}
        style={{
          background: "transparent", border: "none", color: "var(--text-dim)",
          cursor: "pointer", padding: 0, fontSize: 14, lineHeight: 1,
        }}
      >×</button>
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <span style={{
        fontSize: 10, color: "var(--text-dim)",
        textTransform: "uppercase", letterSpacing: 0.5, marginRight: 8,
      }}>{label}</span>
      {children}
    </div>
  );
}

export function FilterBar({
  filter, onChange, onRefresh,
  organization, onOrganizationChange, onOrganize, organizeBusy,
}: Props) {
  const [local, setLocal] = useState(filter);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => { setLocal(filter); }, [filter]);
  useEffect(() => {
    const t = setTimeout(() => onChange(local), 300);
    return () => clearTimeout(t);
  }, [local, onChange]);

  // Pill removers
  const removeTopic = (t: string) => setLocal({ ...local, topic: (local.topic ?? []).filter((x) => x !== t) });
  const removeType = (t: MemoryType) => setLocal({ ...local, type: (local.type ?? []).filter((x) => x !== t) });
  const removeStatus = (s: MemoryStatus) => setLocal({ ...local, status: local.status.filter((x) => x !== s) });
  const setScope = (s: GraphFilter["scope"]) => setLocal({ ...local, scope: s });
  // Advanced-panel mutators
  const toggleType = (t: MemoryType) => {
    const cur = local.type ?? [];
    setLocal({ ...local, type: cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t] });
  };
  const toggleStatus = (s: MemoryStatus) => {
    setLocal({ ...local, status: local.status.includes(s) ? local.status.filter((x) => x !== s) : [...local.status, s] });
  };
  const setTopicInput = (s: string) => setLocal({ ...local, topic: s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined });

  return (
    <div style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-elev)" }}>
      {/* Row 1: pills + add advanced */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "8px 16px", alignItems: "center" }}>
        <Pill label={`scope: ${local.scope}`} onRemove={() => setScope("all")} />
        {(local.topic ?? []).map((t) => (
          <Pill key={t} label={`topic: ${t}`} onRemove={() => removeTopic(t)} />
        ))}
        {(local.type ?? []).map((t) => (
          <Pill key={t} label={`type: ${t}`} onRemove={() => removeType(t)} />
        ))}
        {local.status.map((s) => (
          <Pill key={s} label={`status: ${s}`} onRemove={() => removeStatus(s)} />
        ))}
        <button
          type="button"
          onClick={() => setAdvancedOpen((o) => !o)}
          aria-label={advancedOpen ? "收起高级过滤" : "展开高级过滤"}
          style={{
            padding: "2px 8px", fontSize: 12,
            background: "var(--bg)", color: "var(--text)",
            border: "1px solid var(--border)", borderRadius: 12, cursor: "pointer",
          }}
        >{advancedOpen ? "−" : "+"}</button>
      </div>

      {/* Advanced panel */}
      {advancedOpen && (
        <div style={{ padding: "8px 16px", borderTop: "1px solid var(--border)", background: "var(--bg)" }}>
          <Field label="最小重要性">
            <input
              type="range" min={1} max={5}
              value={local.min_importance ?? 1}
              onChange={(e) => setLocal({ ...local, min_importance: Number(e.target.value) })}
            />
            <span style={{ marginLeft: 6, fontSize: 12 }}>{local.min_importance ?? 1}</span>
          </Field>
          <Field label="最大节点">
            <input
              type="number" min={1} max={2000}
              value={local.max_nodes}
              onChange={(e) => setLocal({ ...local, max_nodes: Number(e.target.value) })}
              style={{ width: 80, padding: 2, fontSize: 12 }}
            />
          </Field>
          <Field label="topic(逗号分隔)">
            <input
              type="text" placeholder="auth,cache,..."
              value={(local.topic ?? []).join(",")}
              onChange={(e) => setTopicInput(e.target.value)}
              style={{ padding: 2, fontSize: 12, width: 200 }}
            />
          </Field>
          <Field label="type(多选)">
            {TYPES.map((t) => (
              <label key={t} style={{ marginRight: 8, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={(local.type ?? []).includes(t)}
                  onChange={() => toggleType(t)}
                />{t}
              </label>
            ))}
          </Field>
          <Field label="status(多选)">
            {STATUSES.map((s) => (
              <label key={s} style={{ marginRight: 8, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={local.status.includes(s)}
                  onChange={() => toggleStatus(s)}
                />{s}
              </label>
            ))}
          </Field>
          <Field label="include co_topic">
            <input
              type="checkbox"
              checked={local.include_co_topic}
              onChange={(e) => setLocal({ ...local, include_co_topic: e.target.checked })}
            />
          </Field>
          <Field label="include co_scope">
            <input
              type="checkbox"
              checked={local.include_co_scope}
              onChange={(e) => setLocal({ ...local, include_co_scope: e.target.checked })}
            />
          </Field>
        </div>
      )}

      {/* Row 2: org switcher + organize + refresh */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "6px 16px", borderTop: "1px solid var(--border)",
      }}>
        <OrgModeSwitcher value={organization} onChange={onOrganizationChange} />
        <OrganizeButton onOrganize={onOrganize} busy={organizeBusy} />
        <button
          type="button"
          onClick={onRefresh}
          style={{
            marginLeft: "auto", padding: "4px 10px", fontSize: 12,
            background: "var(--bg)", color: "var(--text)",
            border: "1px solid var(--border)", borderRadius: 4, cursor: "pointer",
          }}
        >↻</button>
      </div>
    </div>
  );
}

export default FilterBar;
