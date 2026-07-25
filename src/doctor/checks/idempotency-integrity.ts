// src/doctor/checks/idempotency-integrity.ts
//
// Stage 14 PR-C (spec § 9.1) + Stage 15 PR-M0-1
// (issue #1, spec § 5.6): the `mutation_requests_v2`
// table is the v5 source of truth for the per-actor /
// per-tool idempotency replay. Spec § 5.6 promises:
//
//   "以 (actor, tool, idempotency_key) 为键的请求去重，
//    request_hash 与 body 不一致时返回
//    idempotency_key_reuse"
//
// This check walks the table and surfaces six
// invariant breaks:
//
//   1. A row with an empty / null `actor_id`,
//      `tool_name`, or `idempotency_key` (would
//      silently shadow any future retry).
//   2. A `state='completed'` row with an empty /
//      unparseable `result_json`.
//   3. A `created_at` in the future (clock drift
//      between the agent and the server).
//   4. A row stuck in `state='pending'` for longer
//      than the stale-reservation threshold — a
//      previous attempt reserved but never completed,
//      typically because the process crashed between
//      `tryReserveMutationRequest` and
//      `completeMutationRequest`.
//
// The PRIMARY KEY
// `(actor_id, tool_name, idempotency_key)` is
// enforced by the schema; this check is a *logical*
// integrity pass, not a duplicate-key pass.

import type { CheckContext, CheckResult } from "../types.js";

const MAX_FUTURE_SKEW_MS = 60_000;
// A `state='pending'` row older than this is flagged
// as a stuck reservation. 5 minutes is well past any
// legitimate single mutation duration; a row that
// old almost certainly came from a crashed process.
const PENDING_STALE_MS = 5 * 60_000;

export function checkIdempotencyIntegrity(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();
  // Stage 15 PR-M0-1: the v2 source of truth is
  // `mutation_requests_v2`. The v1 `mutation_requests`
  // table is preserved for one release cycle so v1
  // callers keep working. We UNION both so a leftover
  // v1 row that never had a v2 counterpart (e.g. a
  // process that wrote v1 and then was upgraded to v5
  // but never ran a mutation that would re-write the
  // row to v2) still surfaces its integrity issues.
  const rows = handle
    .prepare(
      `SELECT actor_id, tool_name, idempotency_key, request_hash, result_json, state, created_at
         FROM mutation_requests_v2
       UNION ALL
       SELECT actor_id, 'legacy' AS tool_name, idempotency_key, request_hash, result_json, 'completed' AS state, created_at
         FROM mutation_requests`
    )
    .all() as Array<{
      actor_id: string;
      tool_name: string;
      idempotency_key: string;
      request_hash: string;
      result_json: string | null;
      state: "pending" | "completed";
      created_at: string;
    }>;

  const issues: string[] = [];
  let emptyActor = 0;
  let emptyTool = 0;
  let emptyKey = 0;
  let badJson = 0;
  let futureCreated = 0;
  let stuckPending = 0;
  const now = ctx.now().getTime();

  for (const row of rows) {
    if (typeof row.actor_id !== "string" || row.actor_id.length === 0) {
      emptyActor += 1;
      continue;
    }
    if (typeof row.tool_name !== "string" || row.tool_name.length === 0) {
      emptyTool += 1;
      continue;
    }
    if (typeof row.idempotency_key !== "string" || row.idempotency_key.length === 0) {
      emptyKey += 1;
      continue;
    }
    if (row.state === "completed") {
      if (typeof row.result_json !== "string" || row.result_json.length === 0) {
        badJson += 1;
        continue;
      }
      try {
        JSON.parse(row.result_json);
      } catch {
        badJson += 1;
        continue;
      }
    }
    const created = Date.parse(row.created_at);
    if (Number.isFinite(created)) {
      if (created - now > MAX_FUTURE_SKEW_MS) {
        futureCreated += 1;
      } else if (row.state === "pending" && now - created > PENDING_STALE_MS) {
        stuckPending += 1;
      }
    }
  }

  if (emptyActor > 0) issues.push(`${emptyActor} rows with empty actor_id`);
  if (emptyTool > 0) issues.push(`${emptyTool} rows with empty tool_name`);
  if (emptyKey > 0) issues.push(`${emptyKey} rows with empty idempotency_key`);
  if (badJson > 0) issues.push(`${badJson} rows with empty / unparseable result_json`);
  if (futureCreated > 0) issues.push(`${futureCreated} rows with future created_at`);
  if (stuckPending > 0) issues.push(`${stuckPending} rows stuck in state='pending' past stale threshold`);

  if (issues.length > 0) {
    return {
      name: "idempotency_integrity",
      status: "fail",
      message: issues.join("; "),
      details: {
        total: rows.length,
        empty_actor: emptyActor,
        empty_tool: emptyTool,
        empty_key: emptyKey,
        bad_json: badJson,
        future_created: futureCreated,
        stuck_pending: stuckPending
      }
    };
  }
  return {
    name: "idempotency_integrity",
    status: "ok",
    message: `${rows.length} rows, no integrity issues`,
    details: { total: rows.length }
  };
}
