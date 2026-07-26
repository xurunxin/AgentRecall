// src/doctor/checks/last-accessed-by.ts
//
// Surfaces a snapshot of the per-agent access map.
//
// Stage 16 v1.1.1 PR-1 (#11): the canonical access source
// of truth is `memory_accesses` (schema v4). The
// `last_accessed_by` JSON column on `memory_entries` is a
// derived cache; reads are now pure (no side effects) so
// the cache can be stale or null even when the canonical
// table has rows. This check now aggregates directly from
// `memory_accesses` (the per-actor, per-memory rows) and
// reports one entry per `memory_id` that has at least one
// access row.

import type { CheckContext, CheckResult } from "../types.js";

type AgentCount = { agent: string; last_accessed_at: string };

export function checkLastAccessedBy(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();
  // Aggregate the canonical per-actor access rows. The
  // `memory_id` count is "distinct memories with at least
  // one access row"; the per-agent `last_accessed_at` is
  // the maximum timestamp we have ever seen for that actor
  // across the whole database.
  const rows = handle
    .prepare(
      `SELECT memory_id, actor_id, MAX(last_accessed_at) AS last_accessed_at
         FROM memory_accesses
        GROUP BY memory_id, actor_id
        ORDER BY actor_id ASC`
    )
    .all() as Array<{ memory_id: string; actor_id: string; last_accessed_at: string }>;

  const agents = new Map<string, string>();
  const distinctMemoryIds = new Set<string>();
  for (const row of rows) {
    distinctMemoryIds.add(row.memory_id);
    const prev = agents.get(row.actor_id);
    if (prev === undefined || row.last_accessed_at > prev) {
      agents.set(row.actor_id, row.last_accessed_at);
    }
  }

  const distribution: AgentCount[] = Array.from(agents.entries())
    .map(([agent, last_accessed_at]) => ({ agent, last_accessed_at }))
    .sort((a, b) => (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0));

  return {
    name: "last_accessed_by",
    status: "ok",
    message: `${distinctMemoryIds.size} entries, ${distribution.length} agents seen`,
    details: { entries: distinctMemoryIds.size, agents: distribution }
  };
}
