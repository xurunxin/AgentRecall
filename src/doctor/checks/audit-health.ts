import type { CheckContext, CheckResult } from "../types.js";

const WARN_THRESHOLD = 10;
const FAIL_THRESHOLD = 100;

export function checkAuditHealth(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();
  const since = new Date(ctx.now().getTime() - 24 * 60 * 60 * 1000).toISOString();
  const row = handle
    .prepare("SELECT COUNT(*) AS c FROM audit_events WHERE event = 'write_rejected' AND created_at >= ?")
    .get(since) as { c: number };
  if (row.c >= FAIL_THRESHOLD) {
    return {
      name: "audit_health",
      status: "fail",
      message: `${row.c} write_rejected in last 24h`,
      details: { count: row.c, window_hours: 24 }
    };
  }
  if (row.c >= WARN_THRESHOLD) {
    return {
      name: "audit_health",
      status: "warn",
      message: `${row.c} write_rejected in last 24h`,
      details: { count: row.c, window_hours: 24 }
    };
  }
  return {
    name: "audit_health",
    status: "ok",
    message: `${row.c} write_rejected in last 24h`,
    details: { count: row.c, window_hours: 24 }
  };
}
