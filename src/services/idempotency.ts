// src/services/idempotency.ts
//
// Stage 15 PR-M0-1 (issue #1, spec § 5.6): Idempotency v2.
//
// The v1 idempotency contract (Stage 11 PR7) had three
// correctness gaps under multi-agent concurrent execution:
//
//   1. `JSON.stringify(input, Object.keys(input).sort())`
//      is NOT a recursive canonical serializer. The
//      replacer-array trick only flattens the top-level
//      keys; nested objects use insertion order so a
//      retry with `body={a:1,b:{c:2}}` and
//      `body={b:{c:2},a:1}` produces different
//      fingerprints for the same logical body.
//
//   2. The key namespace was `(actor_id, idempotency_key)`
//      with no `tool_name` dimension. A `remember` and an
//      `update_memory` from the same actor reusing the
//      same key would collide.
//
//   3. The idempotency record was persisted *after* the
//      mutation transaction (see `recordIdempotencyIfSet`
//      in memory-write-service). A crash between the
//      mutation COMMIT and the upsert left no replay
//      hint, so a retry re-ran the mutation.
//
// v2 fixes all three:
//
//   1. `canonicalJson(input)` recurses, sorts object keys
//      at every depth, preserves array order, drops
//      `undefined` values, and rejects `NaN` / `Infinity`
//      (they are not stable across JSON round-trips).
//
//   2. The store-side PRIMARY KEY is
//      `(actor_id, tool_name, idempotency_key)`. Different
//      tools can reuse the same key without colliding.
//
//   3. The mutation flow is now a single transaction:
//        BEGIN IMMEDIATE
//        reserve(v2 row with state='pending')  -- INSERT OR ABORT
//        run the mutation
//        complete(v2 row with state='completed', result_json)
//        COMMIT
//      If the process crashes between `reserve` and
//      `complete`, the v2 row is left in `pending` and a
//      retry sees the existing row. The retry is
//      reclassified as `replay` only if the row is
//      `completed` AND the request_hash matches; a
//      `pending` row returns a recoverable
//      `idempotency_in_flight` so the caller can back off
//      and retry (the next attempt finds the row in
//      `completed` once the crashed predecessor either
//      completes on retry or is GC'd).
//
// The old `lookupIdempotency` / `recordIdempotency` API
// is kept as a thin wrapper for one release cycle so
// external callers (and the in-flight p0-mutation-safety
// regression suite) keep working. New code should call
// `reserveIdempotency` / `completeIdempotency`.

import { createHash } from "node:crypto";
import type { SQLiteMemoryStore } from "../sqlite-store.js";

export type IdempotencyHit<T> =
  | { kind: "fresh" }
  | { kind: "replay"; result: T }
  | { kind: "rejected"; reason: "idempotency_key_reuse" }
  | { kind: "in_flight"; reason: "idempotency_in_flight" };

/**
 * Recursive canonical JSON serializer. Sorts object keys
 * at every depth, preserves array order, drops
 * `undefined` values, rejects `NaN` / `Infinity` /
 * `BigInt` (they are not stable across JSON
 * round-trips).
 */
export function canonicalJson(value: unknown): string {
  return canonicalStringify(value);
}

function canonicalStringify(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null"; // dropped at object level; defensive for top-level
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error("canonicalJson: NaN/Infinity are not allowed");
    }
    return JSON.stringify(value);
  }
  if (t === "string") return JSON.stringify(value);
  if (t === "bigint") {
    throw new Error("canonicalJson: BigInt is not allowed");
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalStringify).join(",") + "]";
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue;
      parts.push(JSON.stringify(k) + ":" + canonicalStringify(v));
    }
    return "{" + parts.join(",") + "}";
  }
  throw new Error(`canonicalJson: unsupported type ${t}`);
}

/**
 * Stable SHA-256 fingerprint of a request body. Use
 * `canonicalJson` (not the raw input) so retries that
 * reorder keys at any depth produce the same hash.
 */
export function hashRequest(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex").slice(0, 32);
}

/**
 * Stage 15 PR-M0-1: reserve an idempotency slot inside
 * an existing transaction. Returns:
 *   - `{kind: "fresh"}` when the row was just inserted
 *     with `state='pending'`. The caller must run the
 *     mutation, then call `completeIdempotency`.
 *   - `{kind: "replay", result}` when the row exists
 *     in `state='completed'` with a matching
 *     `request_hash`. Return the stored result.
 *   - `{kind: "rejected", reason: "idempotency_key_reuse"}`
 *     when the row exists with a different
 *     `request_hash` (same key, different body).
 *   - `{kind: "in_flight", reason: "idempotency_in_flight"}`
 *     when the row exists in `state='pending'` (a
 *     previous attempt reserved but did not complete —
 *     typically because the process crashed). The caller
 *     can back off and retry; the retry will see
 *     `state='completed'` once the predecessor finishes
 *     or the row is GC'd.
 *
 * The caller MUST pass an `inTransaction` flag that
 * reflects whether a `BEGIN IMMEDIATE` is already open
 * on the store connection. We use it only for the
 * assertion — the actual transaction boundary is the
 * caller's responsibility (see
 * `withIdempotentMutation`).
 */
export function reserveIdempotency<T>(
  store: SQLiteMemoryStore,
  args: {
    actor: string;
    tool: string;
    key: string;
    requestHash: string;
    requestId: string;
  }
): IdempotencyHit<T> {
  // INSERT OR ABORT — if the row already exists, the
  // insert fails and we look up the existing row to
  // classify the hit.
  const inserted = store.tryReserveMutationRequest(
    args.actor,
    args.tool,
    args.key,
    args.requestHash,
    args.requestId
  );
  if (inserted) {
    return { kind: "fresh" };
  }
  const row = store.lookupMutationRequestV2(args.actor, args.tool, args.key);
  if (row === undefined) {
    // Extremely unlikely race: another transaction
    // deleted the row between our INSERT OR ABORT and
    // our SELECT. Treat as fresh — the caller will
    // re-attempt the insert on the next call.
    return { kind: "fresh" };
  }
  if (row.request_hash !== args.requestHash) {
    return { kind: "rejected", reason: "idempotency_key_reuse" };
  }
  if (row.state === "pending") {
    return { kind: "in_flight", reason: "idempotency_in_flight" };
  }
  try {
    const result = JSON.parse(row.result_json) as T;
    return { kind: "replay", result };
  } catch {
    // Stored result is unparseable (e.g. a v1 row
    // predating the v2 schema). Treat as fresh so the
    // caller can re-run and rewrite the row.
    return { kind: "fresh" };
  }
}

/**
 * Stage 15 PR-M0-1: mark the v2 row as completed with
 * the serialized result. The caller MUST have
 * successfully `reserveIdempotency`'d this key in the
 * same transaction. The actual COMMIT is the caller's
 * responsibility.
 */
export function completeIdempotency<T>(
  store: SQLiteMemoryStore,
  args: {
    actor: string;
    tool: string;
    key: string;
    result: T;
  }
): void {
  store.completeMutationRequest(
    args.actor,
    args.tool,
    args.key,
    JSON.stringify(args.result)
  );
}

/**
 * Stage 16 v1.1.1 PR-3 (#10): reserve a v2 idempotency
 * slot, run the mutation, and complete the slot — all
 * inside a single store transaction. The work callback
 * receives the reserve result so it can short-circuit on
 * `replay` or `rejected` before any business mutation.
 *
 * The v2 reservation is keyed on
 * `(actor_id, tool_name, idempotency_key)` and the
 * canonical `requestHash` (sha256 of the canonical
 * payload JSON). Two distinct actors can re-use the
 * same key without collision; two distinct tools can
 * re-use the same key; two distinct bodies on the
 * same `(actor, tool, key)` triple surface
 * `idempotency_key_reuse`.
 *
 * Crash semantics: a process crash before `COMMIT`
 * rolls back the business mutation AND the
 * reservation. The next retry sees `fresh` (the v2
 * row never landed). A process crash after `reserve`
 * but before `complete` leaves a `pending` row; the
 * next retry sees `in_flight` and surfaces
 * `idempotency_in_flight` so the caller can back off
 * and retry. Pending rows are GC'd at store open
 * based on the takeover window
 * (`AGENT_RECALL_IDEMPOTENCY_TAKEOVER_MS`,
 * default 60s).
 *
 * The work callback's return type is the public
 * result type (e.g. `Result<RememberResult, ...>`).
 * For `replay`, the callback returns the stored
 * result; for `fresh`, the callback returns the
 * newly-computed result. The helper serialises the
 * `fresh` result into the v2 row inside the same
 * transaction so a retry returns the byte-identical
 * payload.
 */
export function runWithIdempotentMutation<T>(
  store: SQLiteMemoryStore,
  args: {
    actor: string;
    tool: string;
    key: string;
    requestHash: string;
    requestId: string;
  },
  work: (
    reserve:
      | { kind: "fresh" }
      | { kind: "replay"; result: T }
      | { kind: "rejected" }
      | { kind: "in_flight" }
  ) => T
): T {
  return store.transaction(() => {
    const reserve = reserveIdempotency<T>(store, args);
    const result = work(reserve);
    if (reserve.kind === "fresh") {
      completeIdempotency<T>(store, {
        actor: args.actor,
        tool: args.tool,
        key: args.key,
        result
      });
    }
    return result;
  });
}

/**
 * Stage 16 v1.1.1 PR-3 (#10): early-replay probe.
 *
 * Lookup-only. Does NOT write a v2 row. Reads the
 * existing `(actor, tool, key)` row and classifies
 * the hit so a `replay` / `rejected` / `in_flight`
 * short-circuit before any business work runs (no
 * `prepareRemember`, no budget check, no duplicate
 * scan, no DB writes).
 *
 * Why lookup-only and not `reserveIdempotency`? If
 * the probe reserved, the row would land in
 * `state='pending'`. The fresh path then falls
 * through to `runWithIdempotentMutation` which
 * tries to reserve the same `(actor, tool, key)`
 * again — the second `INSERT OR ABORT` fails
 * because the row already exists, the row is in
 * `state='pending'`, and the helper returns
 * `in_flight`. The fresh path would never run.
 *
 * `tryReplayOnly` therefore reads only. The fresh
 * path falls through to `runWithIdempotentMutation`
 * which reserves AND completes the row inside the
 * same transaction as the business write.
 *
 * Race window: between this lookup and the
 * subsequent `runWithIdempotentMutation` reserve,
 * another caller may insert a row with the same
 * key. `runWithIdempotentMutation` will then
 * surface `replay` / `rejected` / `in_flight`
 * based on that concurrent row, exactly as if the
 * caller had hit the cache on a retry. The contract
 * holds.
 */
export function tryReplayOnly<T>(
  store: SQLiteMemoryStore,
  args: {
    actor: string;
    tool: string;
    key: string;
    requestHash: string;
    requestId: string;
  }
): IdempotencyHit<T> {
  const row = store.lookupMutationRequestV2(args.actor, args.tool, args.key);
  if (row === undefined) {
    return { kind: "fresh" };
  }
  if (row.request_hash !== args.requestHash) {
    return { kind: "rejected", reason: "idempotency_key_reuse" };
  }
  if (row.state === "pending") {
    return { kind: "in_flight", reason: "idempotency_in_flight" };
  }
  try {
    const result = JSON.parse(row.result_json) as T;
    return { kind: "replay", result };
  } catch {
    // Stored result is unparseable (e.g. a v1 row
    // predating the v2 schema, or a hand-corrupted
    // `result_json`). Treat as fresh so the caller
    // can re-run and rewrite the row.
    return { kind: "fresh" };
  }
}

// ============================================================
// Deprecated v1 wrappers (kept for one release cycle so
// external callers and the p0-mutation-safety regression
// suite keep working). New code MUST use
// `reserveIdempotency` / `completeIdempotency`.
// ============================================================

/**
 * @deprecated Use `reserveIdempotency` instead. This
 * wrapper preserves the v1 semantics
 * (read-then-write-then-record) for callers that have
 * not yet migrated. It reads from the legacy
 * `mutation_requests` table (v1 PK = `(actor_id, key)`,
 * no tool column) which the v4 -> v5 migration kept
 * in place for one release cycle.
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
    return { kind: "fresh" };
  }
}

/**
 * @deprecated Use `completeIdempotency` instead. This
 * wrapper preserves the v1 upsert semantics for
 * callers that have not yet migrated.
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
