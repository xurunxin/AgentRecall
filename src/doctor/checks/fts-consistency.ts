import type { CheckContext, CheckResult } from "../types.js";

export function checkFtsConsistency(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();
  const ftsRow = handle.prepare("SELECT COUNT(*) AS c FROM memory_fts").get() as { c: number };
  const memRow = handle.prepare("SELECT COUNT(*) AS c FROM memory_entries").get() as { c: number };
  if (ftsRow.c === memRow.c) {
    return {
      name: "fts_consistency",
      status: "ok",
      message: `${ftsRow.c} rows in fts == ${memRow.c} in memory_entries`,
      details: { fts: ftsRow.c, entries: memRow.c }
    };
  }
  return {
    name: "fts_consistency",
    status: "fail",
    message: `fts has ${ftsRow.c} rows but memory_entries has ${memRow.c}`,
    details: { fts: ftsRow.c, entries: memRow.c }
  };
}
