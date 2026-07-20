// src/doctor/checks/actor-ownership.ts
//
// Stage 4: per-actor memory entry count. Walks the audit log for
// "created" events and reports how many distinct memories each
// actor has written. The check is always `ok`; it's informational
// only. Pairs with the existing `actor_distribution` check, which
// counts all audit events (created, updated, deleted, etc.) rather
// than the entries themselves.

import type { CheckContext, CheckResult } from "../types.js";

export function checkActorOwnership(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();
  const rows = handle
    .prepare(
      `SELECT actor, COUNT(DISTINCT memory_id) AS c
       FROM audit_events
       WHERE event = 'created' AND actor IS NOT NULL AND actor != ''
       GROUP BY actor
       ORDER BY c DESC`
    )
    .all() as Array<{ actor: string; c: number }>;

  if (rows.length === 0) {
    return {
      name: "actor_ownership",
      status: "ok",
      message: "no memories with a created event",
      details: { distribution: [] }
    };
  }
  const total = rows.reduce((acc, r) => acc + r.c, 0);
  return {
    name: "actor_ownership",
    status: "ok",
    message: `${total} entries across ${rows.length} writers`,
    details: { distribution: rows }
  };
}
