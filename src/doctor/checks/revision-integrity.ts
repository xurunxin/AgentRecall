// src/doctor/checks/revision-integrity.ts
//
// Stage 14 PR-C (spec § 9.1 / § 6.5): the
// `memory_revisions` table is the v4 audit chain. For
// every memory, the row's revisions must form a
// contiguous ascending sequence starting at 1 (the
// create row) and ending at `entry.revision` (the
// current state). Spec § 5.6 says:
//
//   "memory_revisions 保存 memory 完整 snapshot_json，
//    可用于审计回放"
//
// The check surfaces three invariant breaks:
//
//   1. A memory with no `memory_revisions` row at
//      `revision: 1` (the create baseline is missing).
//   2. A memory with a `memory_revisions` sequence
//      that has a hole (e.g. 1, 2, 4 — missing 3).
//   3. A memory whose latest `memory_revisions` row
//      is at a different revision than the row's
//      current `revision` (audit chain desync).

import type { CheckContext, CheckResult } from "../types.js";

export function checkRevisionIntegrity(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();

  const rows = handle
    .prepare(
      `SELECT m.id AS memory_id, m.revision AS current_revision,
              (
                SELECT GROUP_CONCAT(mr.revision, ',' ORDER BY mr.revision ASC)
                FROM memory_revisions mr WHERE mr.memory_id = m.id
              ) AS revisions_csv
       FROM memory_entries m`
    )
    .all() as Array<{ memory_id: string; current_revision: number; revisions_csv: string | null }>;

  const missingBaseline: string[] = [];
  const holes: string[] = [];
  const chainDesync: string[] = [];

  for (const row of rows) {
    const csv = row.revisions_csv ?? "";
    if (csv.length === 0) {
      missingBaseline.push(row.memory_id);
      continue;
    }
    const revisions = csv.split(",").map((s) => parseInt(s, 10));
    if (revisions[0] !== 1) {
      missingBaseline.push(row.memory_id);
      continue;
    }
    for (let i = 1; i < revisions.length; i += 1) {
      if (revisions[i] !== (revisions[i - 1] ?? 0) + 1) {
        holes.push(row.memory_id);
        break;
      }
    }
    if (revisions[revisions.length - 1] !== row.current_revision) {
      chainDesync.push(row.memory_id);
    }
  }

  const issues: string[] = [];
  if (missingBaseline.length > 0) issues.push(`${missingBaseline.length} entries missing revision 1 baseline`);
  if (holes.length > 0) issues.push(`${holes.length} entries with a hole in the revision sequence`);
  if (chainDesync.length > 0) issues.push(`${chainDesync.length} entries with chain desync (latest revision != current)`);

  if (issues.length > 0) {
    return {
      name: "revision_integrity",
      status: "fail",
      message: issues.join("; "),
      details: {
        total: rows.length,
        missing_baseline: missingBaseline.slice(0, 10),
        holes: holes.slice(0, 10),
        chain_desync: chainDesync.slice(0, 10)
      }
    };
  }
  return {
    name: "revision_integrity",
    status: "ok",
    message: `${rows.length} entries, all revision chains contiguous`,
    details: { total: rows.length }
  };
}
