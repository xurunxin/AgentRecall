// src/doctor/checks/lock-health.ts
//
// Stage 14 PR-C (spec § 9.1): the v4 schema relies on
// `busy_timeout` + WAL for the multi-process concurrency
// promise. A persistent tail of `SQLITE_BUSY` rejections
// (i.e. retries that exhausted the bounded retry budget)
// is a sign that contention has outgrown what the
// defaults can absorb — either a process is holding the
// write lock for too long, or a query is running outside
// the busy-timeout window.
//
// The signal we have available: the audit log's
// `write_rejected` events whose `metadata.error` matches
// `SQLITE_BUSY` (the `runWithBusyRetry` helper records a
// `fail` audit when the retry budget is exhausted). A
// fail rate above the threshold means contention has
// crossed the operational red line.

import type { CheckContext, CheckResult } from "../types.js";

const WARN_THRESHOLD = 5;
const FAIL_THRESHOLD = 25;
const WINDOW_HOURS = 24;

export function checkLockHealth(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();
  const since = new Date(ctx.now().getTime() - WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const rows = handle
    .prepare(
      `SELECT id, metadata_json
       FROM audit_events
       WHERE event = 'write_rejected' AND created_at >= ?`
    )
    .all(since) as Array<{ id: string; metadata_json: string | null }>;

  let busyCount = 0;
  for (const row of rows) {
    if (typeof row.metadata_json !== "string" || row.metadata_json.length === 0) continue;
    try {
      const parsed = JSON.parse(row.metadata_json) as { error?: unknown };
      if (typeof parsed.error === "string" && /SQLITE_BUSY|database is locked/i.test(parsed.error)) {
        busyCount += 1;
      }
    } catch {
      /* unparseable metadata, skip */
    }
  }

  if (busyCount >= FAIL_THRESHOLD) {
    return {
      name: "lock_health",
      status: "fail",
      message: `${busyCount} SQLITE_BUSY in last ${WINDOW_HOURS}h`,
      details: { busy_count: busyCount, window_hours: WINDOW_HOURS }
    };
  }
  if (busyCount >= WARN_THRESHOLD) {
    return {
      name: "lock_health",
      status: "warn",
      message: `${busyCount} SQLITE_BUSY in last ${WINDOW_HOURS}h`,
      details: { busy_count: busyCount, window_hours: WINDOW_HOURS }
    };
  }
  return {
    name: "lock_health",
    status: "ok",
    message: `${busyCount} SQLITE_BUSY in last ${WINDOW_HOURS}h`,
    details: { busy_count: busyCount, window_hours: WINDOW_HOURS }
  };
}
