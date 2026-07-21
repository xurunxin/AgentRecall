// src/doctor/checks/journal-mode.ts
//
// Stage 14 PR-C (spec § 9.1): the v4 schema assumes WAL
// journal mode for the multi-process concurrency promise
// (PR-B2's 8-process stress test depends on the
// `busy_timeout` + WAL handshake). When the DB is opened
// in the legacy `delete` / `truncate` mode, single-writer
// blocking kicks in and concurrent reads still work but
// concurrent writers can no longer pipeline their
// transactions, surfacing as `SQLITE_BUSY` despite the
// bounded retry. Fail this check whenever the live
// `journal_mode` is not `wal`.

import type { CheckContext, CheckResult } from "../types.js";

const EXPECTED = "wal";

export function checkJournalMode(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();
  const row = handle.prepare("PRAGMA journal_mode").get() as { journal_mode: string } | undefined;
  const actual = row?.journal_mode ?? "<unknown>";
  if (actual.toLowerCase() !== EXPECTED) {
    return {
      name: "journal_mode",
      status: "fail",
      message: `expected ${EXPECTED}, got ${actual}`,
      details: { expected: EXPECTED, actual }
    };
  }
  return {
    name: "journal_mode",
    status: "ok",
    message: `${actual}`,
    details: { expected: EXPECTED, actual }
  };
}
