import type { GraphNode } from "@agent-recall/contracts";

interface Props {
  node: GraphNode | null;
  onClose: () => void;
}

// Map memory type → badge color. Aligned with the design intent
// (type-colored nodes / badges). Kept inline so the drawer works in
// any environment without depending on theme variables.
const TYPE_COLOR: Record<GraphNode["type"], string> = {
  preference: "#ec4899",
  procedure: "#0ea5e9",
  fact: "#64748b",
  decision: "#7c3aed",
  lesson: "#f59e0b",
  debugging: "#ef4444",
  constraint: "#dc2626",
};

const STATUS_COLOR: Record<GraphNode["status"], string> = {
  active: "var(--status-active)",
  archived: "var(--status-archived)",
  superseded: "var(--status-superseded)",
  forgotten: "var(--status-forgotten)",
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function Stars({ value }: { value: number }): React.ReactElement {
  const v = Math.max(1, Math.min(5, value));
  return (
    <span
      aria-label={`importance ${v} of 5`}
      style={{ letterSpacing: 1, color: "var(--warning)" }}
    >
      {"★".repeat(v)}
      <span style={{ color: "var(--text-dim)" }}>{"★".repeat(5 - v)}</span>
    </span>
  );
}

export default function MemoryDrawer({ node, onClose }: Props): React.ReactElement | null {
  if (!node) return null;

  return (
    <>
      {/* Click-catch overlay. z-index sits below the drawer so the drawer
          itself remains clickable. */}
      <div
        onClick={onClose}
        aria-hidden
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0, 0, 0, 0.3)",
          zIndex: 99,
        }}
      />
      <aside
        role="dialog"
        aria-label="Memory detail"
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: 380,
          background: "var(--bg)",
          color: "var(--text)",
          borderLeft: "1px solid var(--border)",
          boxShadow: "-4px 0 12px rgba(0, 0, 0, 0.15)",
          zIndex: 100,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-elev)",
          }}
        >
          <h2
            style={{
              flex: 1,
              margin: 0,
              fontSize: 15,
              lineHeight: 1.4,
              wordBreak: "break-word",
            }}
            title={node.label}
          >
            {truncate(node.label, 60)}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 4,
              width: 28,
              height: 28,
              cursor: "pointer",
              fontSize: 16,
              lineHeight: 1,
              color: "var(--text)",
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </header>
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <Field label="标题">
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>{node.label}</div>
          </Field>

          <Field label="类型">
            <span
              style={{
                display: "inline-block",
                padding: "2px 8px",
                fontSize: 11,
                fontWeight: 600,
                color: "#fff",
                background: TYPE_COLOR[node.type],
                borderRadius: 3,
              }}
            >
              {node.type}
            </span>
          </Field>

          <Field label="主题">
            <code
              style={{
                fontSize: 12,
                background: "var(--bg-elev)",
                padding: "2px 6px",
                borderRadius: 3,
              }}
            >
              {node.topic}
            </code>
          </Field>

          <Field label="范围">
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
              {node.scope}
              {node.scope === "project" && node.project_id && (
                <>
                  {" · "}
                  <code
                    style={{
                      fontSize: 11,
                      background: "var(--bg-elev)",
                      padding: "1px 4px",
                      borderRadius: 3,
                    }}
                  >
                    {node.project_id}
                  </code>
                </>
              )}
            </div>
          </Field>

          <Field label="重要性">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Stars value={node.importance} />
              <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
                {node.importance} / 5
              </span>
            </div>
          </Field>

          <Field label="状态">
            <span
              style={{
                display: "inline-block",
                padding: "2px 8px",
                fontSize: 11,
                fontWeight: 600,
                color: "#fff",
                background: STATUS_COLOR[node.status],
                borderRadius: 3,
              }}
            >
              {node.status}
            </span>
          </Field>

          <Field label="创建时间">
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
              {formatDate(node.created_at)}
            </div>
          </Field>

          <Field label="ID">
            <code
              style={{
                fontSize: 11,
                color: "var(--text-dim)",
                wordBreak: "break-all",
              }}
            >
              {node.id}
            </code>
          </Field>
        </div>
      </aside>
    </>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--text-dim)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
}
