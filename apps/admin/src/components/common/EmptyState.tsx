interface Props {
  message: string;
}
export default function EmptyState({ message }: Props) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--text-dim)",
        fontSize: 14,
      }}
    >
      {message}
    </div>
  );
}
