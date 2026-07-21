// src/doctor/checks/idempotency-integrity.ts
//
// Stage 14 PR-C (spec § 9.1): the `mutation_requests`
// table is the v4 source of truth for the per-actor
// idempotency replay. Spec § 5.6 promises:
//
//   "以 (actor, idempotency_key) 为键的请求去重，
//    request_hash 与 body 不一致时返回
//    idempotency_key_reuse"
//
// This check walks the table and surfaces three
// invariant breaks:
//
//   1. A row with an empty / null `actor_id` or
//      `idempotency_key` (would silently shadow any
//      future retry).
//   2. A row with an empty / unparseable `result_json`.
//   3. A `created_at` in the future (clock drift
//      between the agent and the server).
//
// The PRIMARY KEY `(actor_id, idempotency_key)` is
// enforced by the schema; this check is a *logical*
// integrity pass, not a duplicate-key pass.

import type { CheckContext, CheckResult } from "../types.js";

const MAX_FUTURE_SKEW_MS = 60_000;

export function checkIdempotencyIntegrity(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();
  const rows = handle
    .prepare(
      "SELECT actor_id, idempotency_key, request_hash, result_json, created_at FROM mutation_requests"
    )
    .all() as Array<{
      actor_id: string;
      idempotency_key: string;
      request_hash: string;
      result_json: string;
      created_at: string;
    }>;

  const issues: string[] = [];
  let emptyActor = 0;
  let emptyKey = 0;
  let badJson = 0;
  let futureCreated = 0;
  const now = ctx.now().getTime();

  for (const row of rows) {
    if (typeof row.actor_id !== "string" || row.actor_id.length === 0) {
      emptyActor += 1;
      continue;
    }
    if (typeof row.idempotency_key !== "string" || row.idempotency_key.length === 0) {
      emptyKey += 1;
      continue;
    }
    try {
      JSON.parse(row.result_json);
    } catch {
      badJson += 1;
      continue;
    }
    const created = Date.parse(row.created_at);
    if (Number.isFinite(created) && created - now > MAX_FUTURE_SKEW_MS) {
      futureCreated += 1;
    }
  }

  if (emptyActor > 0) issues.push(`${emptyActor} rows with empty actor_id`);
  if (emptyKey > 0) issues.push(`${emptyKey} rows with empty idempotency_key`);
  if (badJson > 0) issues.push(`${badJson} rows with unparseable result_json`);
  if (futureCreated > 0) issues.push(`${futureCreated} rows with future created_at`);

  if (issues.length > 0) {
    return {
      name: "idempotency_integrity",
      status: "fail",
      message: issues.join("; "),
      details: {
        total: rows.length,
        empty_actor: emptyActor,
        empty_key: emptyKey,
        bad_json: badJson,
        future_created: futureCreated
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
