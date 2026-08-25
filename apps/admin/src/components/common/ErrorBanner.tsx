import type { AppError } from "../../lib/errors.js";
import { humanizeError } from "../../lib/errors.js";

interface Props {
  error: AppError;
}
export default function ErrorBanner({ error }: Props) {
  return (
    <div
      style={{
        padding: "8px 16px",
        background: "var(--danger)",
        color: "white",
        fontSize: 13,
      }}
    >
      [{error.code}] {humanizeError(error)}
    </div>
  );
}
