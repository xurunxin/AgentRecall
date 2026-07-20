// src/services/idempotency.ts
//
// Stage 11 PR7: idempotency for mutating service methods.
//
// Every mutating tool that the v1 spec calls out
// (`remember`, `update`, `supersede`, `merge`,
// `forget`, plus `plan_maintenance` / `apply_maintenance`)
// accepts an `idempotency_key`. The first call
// computes the result and stores it in
// `mutation_requests` keyed by `(actor_id, key)`. A
// retry with the same `(actor, key, request_hash)`
// returns the stored result without re-running the
// mutation. A retry with the same `(actor, key)` but
// a different request body is rejected with
// `idempotency_key_reuse` so the caller cannot
// silently collide on a key.
//
// The cache result is stored as JSON so the structured
// service result (which can be a `Result<...>` envelope
// with `{ok, value}` or `{ok: false, error, ...}`) is
// rehydrated without losing the failure code.

import { createHash } from "node:crypto";
import type { SQLiteMemoryStore } from "../sqlite-store.js";

export type IdempotencyHit<T> =
  | { kind: "fresh" }
  | { kind: "replay"; result: T }
  | { kind: "rejected"; reason: "idempotency_key_reuse" };

export function hashRequest(input: unknown): string {
  const canonical = JSON.stringify(input, Object.keys(input as object).sort());
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * Look up an existing `mutation_requests` row for the
 * (actor, key) pair. The caller passes the
 * `request_hash` of the request body so a retry with a
 * different body is rejected.
 *
 * Returns:
 *   - `{kind: "fresh"}` when no row exists
 *   - `{kind: "replay", result}` when a row exists with
 *     a matching request_hash (return the stored result)
 *   - `{kind: "rejected", reason: "idempotency_key_reuse"}`
 *     when a row exists with a different request_hash
 */
export function lookupIdempotency<T>(
  store: SQLiteMemoryStore,
  actor: string,
  key: string,
  requestHash: string
): IdempotencyHit<T> {
  const row = store.lookupMutationRequest(actor, key);
  if (row === undefined) return { kind: "fresh" };
  if (row.request_hash !== requestHash) {
    return { kind: "rejected", reason: "idempotency_key_reuse" };
  }
  try {
    const result = JSON.parse(row.result_json) as T;
    return { kind: "replay", result };
  } catch {
    // The stored result is unparseable; treat as a fresh
    // request so the caller can recover rather than
    // being permanently locked out.
    return { kind: "fresh" };
  }
}

/**
 * Persist a (actor, key, requestHash, result) tuple.
 * Called after a successful mutation so a retry can
 * replay the same result.
 */
export function recordIdempotency<T>(
  store: SQLiteMemoryStore,
  actor: string,
  key: string,
  requestHash: string,
  result: T
): void {
  store.upsertMutationRequest(actor, key, requestHash, JSON.stringify(result));
}
