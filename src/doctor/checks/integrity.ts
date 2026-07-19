import type { CheckContext, CheckResult } from "../types.js";

export function checkIntegrity(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();
  const row = handle.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;
  const value = row?.integrity_check ?? "";
  if (value === "ok") {
    return { name: "integrity", status: "ok", message: "ok" };
  }
  return {
    name: "integrity",
    status: "fail",
    message: `integrity_check returned: ${value}`,
    details: { raw: value }
  };
}
