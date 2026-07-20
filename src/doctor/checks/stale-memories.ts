// src/doctor/checks/stale-memories.ts
//
// Stage 6: per-agent "what's been stale lately" check. Walks
// memory_entries for rows that have not been accessed (or
// have never been accessed) in 90+ days. Reports the count
// and top-5 most-stale by id. Always `ok`; informational
// only. The 90-day threshold is a constant; not configurable
// in this stage.

import type { CheckContext, CheckResult } from "../types.js";

const STALE_DAYS = 90;

function daysAgoIso(days: number, now: Date): string {
  const ms = now.getTime() - days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

export function checkStaleMemories(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();
  const cutoff = daysAgoIso(STALE_DAYS, ctx.now());

  const rows = handle
    .prepare(
      `SELECT id, last_accessed_at, created_at
       FROM memory_entries
       WHERE status = 'active'
         AND (last_accessed_at IS NULL OR last_accessed_at < ?)
       ORDER BY (CASE WHEN last_accessed_at IS NULL THEN created_at ELSE last_accessed_at END) ASC
       LIMIT 5`
    )
    .all(cutoff) as Array<{ id: string; last_accessed_at: string | null; created_at: string }>;

  const countRow = handle
    .prepare(
      `SELECT COUNT(*) AS c
       FROM memory_entries
       WHERE status = 'active'
         AND (last_accessed_at IS NULL OR last_accessed_at < ?)`
    )
    .get(cutoff) as { c: number };

  if (countRow.c === 0) {
    return {
      name: "stale_memories",
      status: "ok",
      message: `0 memories stale (>${STALE_DAYS} days)`,
      details: { count: 0, sample: [] }
    };
  }
  return {
    name: "stale_memories",
    status: "ok",
    message: `${countRow.c} memories stale (>${STALE_DAYS} days); top 5 oldest listed below`,
    details: {
      count: countRow.c,
      sample: rows.map((r) => ({
        id: r.id,
        last_accessed_at: r.last_accessed_at,
        created_at: r.created_at
      }))
    }
  };
}
