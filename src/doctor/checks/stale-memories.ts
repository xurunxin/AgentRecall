// src/doctor/checks/stale-memories.ts
//
// Stage 6: per-agent "what's been stale lately" check. Walks
// memory_entries for rows that have not been accessed (or
// have never been accessed) in 90+ days. Reports the count
// and top-5 most-stale by id. Always `ok`; informational only.
//
// Stage 7: the 90-day threshold is now configurable via the
// AGENT_RECALL_STALE_DAYS env var. The default stays 90 for
// backward compatibility. Invalid values (non-integer or
// non-positive) fall back to 90 with a one-line stderr warning.

import type { CheckContext, CheckResult } from "../types.js";

const DEFAULT_STALE_DAYS = 90;
const ENV_STALE_DAYS = "AGENT_RECALL_STALE_DAYS";

function daysAgoIso(days: number, now: Date): string {
  const ms = now.getTime() - days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

function resolveStaleDays(): number {
  const raw = process.env[ENV_STALE_DAYS];
  if (raw === undefined) return DEFAULT_STALE_DAYS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    process.stderr.write(
      `agent-recall: invalid ${ENV_STALE_DAYS}="${raw}", using default ${DEFAULT_STALE_DAYS}\n`
    );
    return DEFAULT_STALE_DAYS;
  }
  return parsed;
}

export function checkStaleMemories(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();
  const staleDays = resolveStaleDays();
  const cutoff = daysAgoIso(staleDays, ctx.now());

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
      message: `0 memories stale (>${staleDays} days)`,
      details: { count: 0, threshold_days: staleDays, sample: [] }
    };
  }
  return {
    name: "stale_memories",
    status: "ok",
    message: `${countRow.c} memories stale (>${staleDays} days); top 5 oldest listed below`,
    details: {
      count: countRow.c,
      threshold_days: staleDays,
      sample: rows.map((r) => ({
        id: r.id,
        last_accessed_at: r.last_accessed_at,
        created_at: r.created_at
      }))
    }
  };
}
