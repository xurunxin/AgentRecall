// src/doctor/checks/sqlite-runtime.ts
//
// Stage 14 PR-C (spec § 9.1): the SQLite runtime that
// powers the v4 schema must meet two preconditions:
//
//   1. The bundled SQLite version is >= 3.45.0 (the
//      cutoff for the `STRICT` tables and the
//      `json_each` improvements the v4 schema relies
//      on).
//   2. The connection's `busy_timeout` is at least
//      5,000 ms (the value the `runWithBusyRetry` helper
//      assumes on the way in). A smaller timeout means
//      the helper's extra retry layer is doing more work
//      than it should, which is a sign that the runtime
//      has been re-opened with a non-default config
//      (e.g. an old test fixture that re-opens the
//      connection in the legacy `delete` journal mode).

import type { CheckContext, CheckResult } from "../types.js";

const MIN_SQLITE_VERSION = "3.45.0";
const MIN_BUSY_TIMEOUT_MS = 5_000;

function compareSemver(a: string, b: string): number {
  const av = a.split(".").map((n) => parseInt(n, 10) || 0);
  const bv = b.split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function checkSqliteRuntime(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();
  const versionRow = handle.prepare("SELECT sqlite_version() AS v").get() as { v: string } | undefined;
  // node:sqlite returns the PRAGMA busy_timeout column as
  // `timeout` (the better-sqlite3 name is `busy_timeout`).
  // Read both, prefer the node:sqlite form.
  const timeoutRow = handle.prepare("PRAGMA busy_timeout").get() as { busy_timeout?: number; timeout?: number } | undefined;
  const version = versionRow?.v ?? "<unknown>";
  const busyTimeout = timeoutRow?.timeout ?? timeoutRow?.busy_timeout ?? 0;

  const issues: string[] = [];
  if (compareSemver(version, MIN_SQLITE_VERSION) < 0) {
    issues.push(`sqlite_version ${version} < ${MIN_SQLITE_VERSION}`);
  }
  if (busyTimeout < MIN_BUSY_TIMEOUT_MS) {
    issues.push(`busy_timeout ${busyTimeout} < ${MIN_BUSY_TIMEOUT_MS}`);
  }
  if (issues.length > 0) {
    return {
      name: "sqlite_runtime",
      status: "fail",
      message: issues.join("; "),
      details: { version, busy_timeout_ms: busyTimeout, min_version: MIN_SQLITE_VERSION, min_busy_timeout_ms: MIN_BUSY_TIMEOUT_MS }
    };
  }
  return {
    name: "sqlite_runtime",
    status: "ok",
    message: `sqlite ${version}, busy_timeout ${busyTimeout}ms`,
    details: { version, busy_timeout_ms: busyTimeout }
  };
}
