import { useState, useEffect } from "react";
import type { GraphFilter, MemoryType, MemoryStatus } from "@agent-recall/contracts";

interface Props {
  filter: GraphFilter;
  onChange: (f: GraphFilter) => void;
  onRefresh: () => void;
}

const TYPES: MemoryType[] = ["preference", "procedure", "fact", "decision", "lesson", "debugging", "constraint"];
const STATUSES: MemoryStatus[] = ["active", "archived", "superseded", "forgotten"];

export default function FilterBar({ filter, onChange, onRefresh }: Props) {
  const [local, setLocal] = useState(filter);

  useEffect(() => { setLocal(filter); }, [filter]);

  useEffect(() => {
    const t = setTimeout(() => onChange(local), 300);
    return () => clearTimeout(t);
  }, [local, onChange]);

  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        padding: "8px 16px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-elev)",
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      <label>
        scope:&nbsp;
        <select
          value={local.scope}
          onChange={(e) => setLocal({ ...local, scope: e.target.value as GraphFilter["scope"] })}
        >
          <option value="all">all</option>
          <option value="project">project</option>
          <option value="global">global</option>
        </select>
      </label>
      <label>
        topic:&nbsp;
        <input
          type="text"
          placeholder="auth,cache,..."
          value={local.topic?.join(",") ?? ""}
          onChange={(e) =>
            setLocal({
              ...local,
              topic: e.target.value ? e.target.value.split(",").map((s) => s.trim()) : undefined,
            })
          }
        />
      </label>
      <fieldset style={{ display: "flex", gap: 6, border: "none", padding: 0 }}>
        {TYPES.map((t) => (
          <label key={t} style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              checked={local.type?.includes(t) ?? false}
              onChange={(e) => {
                const cur = local.type ?? [];
                setLocal({
                  ...local,
                  type: e.target.checked ? [...cur, t] : cur.filter((x) => x !== t),
                });
              }}
            />
            {t}
          </label>
        ))}
      </fieldset>
      <fieldset style={{ display: "flex", gap: 6, border: "none", padding: 0 }}>
        {STATUSES.map((s) => (
          <label key={s} style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              checked={local.status.includes(s)}
              onChange={(e) => {
                setLocal({
                  ...local,
                  status: e.target.checked
                    ? [...local.status, s]
                    : local.status.filter((x) => x !== s),
                });
              }}
            />
            {s}
          </label>
        ))}
      </fieldset>
      <label>
        min importance:&nbsp;
        <input
          type="range"
          min={1}
          max={5}
          value={local.min_importance ?? 1}
          onChange={(e) => setLocal({ ...local, min_importance: Number(e.target.value) })}
        />
        &nbsp;{local.min_importance ?? 1}
      </label>
      <label>
        max nodes:&nbsp;
        <input
          type="number"
          min={1}
          max={2000}
          value={local.max_nodes}
          onChange={(e) => setLocal({ ...local, max_nodes: Number(e.target.value) })}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={local.include_co_topic}
          onChange={(e) => setLocal({ ...local, include_co_topic: e.target.checked })}
        />
        co-topic
      </label>
      <label>
        <input
          type="checkbox"
          checked={local.include_co_scope}
          onChange={(e) => setLocal({ ...local, include_co_scope: e.target.checked })}
        />
        co-scope
      </label>
      <button onClick={onRefresh} style={{ marginLeft: "auto" }}>
        Refresh
      </button>
    </div>
  );
}
