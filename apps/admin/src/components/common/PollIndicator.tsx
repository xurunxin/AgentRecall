interface Props {
  status: "idle" | "checking" | "changed" | "synced";
}
export default function PollIndicator({ status }: Props) {
  const label = {
    idle: "未连接",
    checking: "检查中…",
    changed: "数据已变更,同步中…",
    synced: "已同步",
  }[status];
  const color = {
    idle: "var(--text-dim)",
    checking: "var(--accent)",
    changed: "var(--warning)",
    synced: "var(--success)",
  }[status];
  return (
    <span style={{ fontSize: 11, color, padding: "0 8px" }}>● {label}</span>
  );
}
