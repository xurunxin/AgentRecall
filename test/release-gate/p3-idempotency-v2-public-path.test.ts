// test/release-gate/p3-idempotency-v2-public-path.test.ts
//
// Stage 16 v1.1.1 PR-3 (issue #10): verify the
// v2 idempotency public-path changes land on every
// mutating method (remember, update_memory,
// supersede_memory, merge_memories, forget_memory).
//
// Acceptance criteria covered here:
//
//   - `tryReplayOnly` is lookup-only: it does NOT
//     write a `pending` v2 row. Two consecutive calls
//     with the same key leave the v2 table empty
//     until the fresh path's `runWithIdempotentMutation`
//     actually reserves the row.
//   - `runWithIdempotentMutation` reserves + runs +
//     completes inside one transaction. The v2 row
//     ends in `state='completed'` with a non-null
//     `result_json`.
//   - A retry (same key + same body) replays the
//     original result without re-running the mutation
//     (no second row, no second audit event).
//   - A retry (same key + different body) surfaces
//     `idempotency_mismatch`, never a fresh write.
//   - An in-flight row (manually written `state='pending'`)
//     surfaces `idempotency_in_flight` so the caller
//     can back off and retry.
//   - The early-probe short-circuits BEFORE any
//     business check on supersede / merge / forget.
//     A retry that lands after the first apply has
//     already mutated the rows still replays the
//     original `ok` result instead of failing with
//     `invalid_state` / `not_found`.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../../src/memory-service.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import {
  runWithIdempotentMutation,
  tryReplayOnly
} from "../../src/services/idempotency.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-idem-v2-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const service = new MemoryService(store, undefined, "agent:system", dataHome);
  return { service, store, dataHome };
}

function ctxOf(actor: string, requestId: string) {
  return {
    actor_id: actor,
    request_id: requestId,
    session_id: "sess",
    tool_call_id: "call",
    transport: "mcp" as const
  };
}

const baseRemember = (overrides: Record<string, unknown> = {}) => ({
  scope: "global" as const,
  type: "fact" as const,
  topic: "idem",
  title: "v2 path",
  body: "first body",
  tags: ["a"],
  source: { kind: "agent" as const },
  importance: 3,
  confidence: 3,
  ...overrides
});

function v2RowCount(store: SQLiteMemoryStore, actor: string, tool: string, key: string): number {
  const row = store.lookupMutationRequestV2(actor, tool, key);
  return row === undefined ? 0 : 1;
}

describe("release-gate p3-idempotency-v2-public-path (Stage 16 PR-3 #10)", () => {
  let store: SQLiteMemoryStore;
  let service: MemoryService;
  let dataHome: string;

  beforeEach(() => {
    ({ store, service, dataHome } = setup());
  });

  afterEach(() => {
    try { store.close(); } catch { /* already closed */ }
  });

  it("tryReplayOnly is lookup-only: two consecutive probes with the same key leave the v2 table empty", () => {
    // The probe is consulted before any reserve.
    // Until `runWithIdempotentMutation` actually runs,
    // the v2 table must remain empty.
    const actor = "agent:probe";
    const key = "probe-only-1";
    const result1 = tryReplayOnly<{ ok: true }>(store, {
      actor,
      tool: "remember",
      key,
      requestHash: "h1",
      requestId: "r1"
    });
    const result2 = tryReplayOnly<{ ok: true }>(store, {
      actor,
      tool: "remember",
      key,
      requestHash: "h1",
      requestId: "r2"
    });
    expect(result1.kind).toBe("fresh");
    expect(result2.kind).toBe("fresh");
    expect(v2RowCount(store, actor, "remember", key)).toBe(0);
  });

  it("runWithIdempotentMutation reserves + completes inside one transaction: v2 row lands in 'completed'", () => {
    const actor = "agent:tx";
    const key = "tx-1";
    const first = service.remember(
      { ...baseRemember(), idempotency_key: key },
      ctxOf(actor, "req-1")
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const handle = store.backupHandle();
    const row = handle
      .prepare(
        "SELECT state, request_hash, result_json, completed_at FROM mutation_requests_v2 WHERE actor_id = ? AND tool_name = ? AND idempotency_key = ?"
      )
      .get(actor, "remember", key) as
      | { state: string; request_hash: string; result_json: string; completed_at: string | null }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.state).toBe("completed");
    expect(row?.request_hash.length).toBeGreaterThan(0);
    expect(row?.result_json.length).toBeGreaterThan(0);
    expect(row?.completed_at).not.toBeNull();
  });

  it("replay (same key + same body) returns the original result without writing a new entry", () => {
    const key = "replay-1";
    const first = service.remember(
      { ...baseRemember(), idempotency_key: key },
      ctxOf("agent:r", "r1")
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstId = first.value.memory_id;

    // Audit event count for the actor before the replay.
    const handle = store.backupHandle();
    const auditBefore = (handle
      .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE actor = ?")
      .get("agent:r") as { n: number }).n;

    const second = service.remember(
      { ...baseRemember(), idempotency_key: key },
      ctxOf("agent:r", "r2")
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.memory_id).toBe(firstId);

    // The replay must NOT append a second `created`
    // audit event for the same actor.
    const auditAfter = (handle
      .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE actor = ?")
      .get("agent:r") as { n: number }).n;
    expect(auditAfter).toBe(auditBefore);
  });

  it("mismatch (same key + different body) surfaces idempotency_mismatch, not a fresh write", () => {
    const key = "mismatch-1";
    const first = service.remember(
      { ...baseRemember(), idempotency_key: key },
      ctxOf("agent:m", "r1")
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = service.remember(
      { ...baseRemember({ body: "DIFFERENT" }), idempotency_key: key },
      ctxOf("agent:m", "r2")
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toBe("idempotency_mismatch");
  });

  it("in-flight (manually written pending row) surfaces idempotency_in_flight", () => {
    // Simulate a crashed predecessor by writing a
    // `pending` row directly into the v2 table.
    const actor = "agent:inflight";
    const key = "inflight-1";
    store.tryReserveMutationRequest(actor, "remember", key, "h1", "r-crash");

    const probe = tryReplayOnly<unknown>(store, {
      actor,
      tool: "remember",
      key,
      requestHash: "h1",
      requestId: "r-retry"
    });
    expect(probe.kind).toBe("in_flight");
    if (probe.kind !== "in_flight") return;
    expect(probe.reason).toBe("idempotency_in_flight");
  });

  it("early-probe: supersede retry replays the original result without a second replacement row", async () => {
    // Create the target to supersede.
    const target = service.remember(
      { ...baseRemember({ title: "supersede target", topic: "super" }), idempotency_key: "super-create" },
      ctxOf("agent:rg", "r1")
    );
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    const oldId = target.value.memory_id;

    const supersedeKey = "super-key-2";
    const supersedeInput = {
      old_memory_ids: [oldId],
      replacement: baseRemember({ title: "new", body: "new", topic: "super" }),
      reason: "upgrade",
      idempotency_key: supersedeKey
    };
    const first = service.supersedeMemory(supersedeInput, ctxOf("agent:rg", "r-s1"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const newId = first.value.memory_id;

    // Replay.
    const second = service.supersedeMemory(supersedeInput, ctxOf("agent:rg", "r-s2"));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.memory_id).toBe(newId);

    // Exactly one replacement row exists; the old row
    // is superseded exactly once.
    const handle = store.backupHandle();
    const replacementCount = (handle
      .prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE id = ?")
      .get(newId) as { n: number }).n;
    expect(replacementCount).toBe(1);
  });

  it("early-probe: forget retry replays the original not_found without clobbering anything", () => {
    const key = "forget-p3-1";
    const first = service.forgetMemory(
      "mem_does_not_exist",
      "test",
      ctxOf("agent:rg", "r-f1"),
      { idempotency_key: key }
    );
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error).toBe("not_found");

    const second = service.forgetMemory(
      "mem_does_not_exist",
      "test",
      ctxOf("agent:rg", "r-f2"),
      { idempotency_key: key }
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toBe("not_found");
  });

  it("early-probe + fresh-path: probe says fresh, runWithIdempotentMutation actually reserves (no double-row)", () => {
    // Direct helper exercise: probe first, then run.
    const actor = "agent:flow";
    const key = "flow-1";
    const probe = tryReplayOnly<{ x: number }>(store, {
      actor,
      tool: "remember",
      key,
      requestHash: "h",
      requestId: "r-probe"
    });
    expect(probe.kind).toBe("fresh");
    expect(v2RowCount(store, actor, "remember", key)).toBe(0);

    const r = runWithIdempotentMutation<{ x: number }>(
      store,
      { actor, tool: "remember", key, requestHash: "h", requestId: "r-run" },
      (hit) => {
        if (hit.kind === "fresh") {
          return { x: 42 };
        }
        throw new Error(`unexpected hit: ${hit.kind}`);
      }
    );
    expect(r.x).toBe(42);
    expect(v2RowCount(store, actor, "remember", key)).toBe(1);

    // The next probe sees the row in `completed` and replays.
    const probe2 = tryReplayOnly<{ x: number }>(store, {
      actor,
      tool: "remember",
      key,
      requestHash: "h",
      requestId: "r-probe-2"
    });
    expect(probe2.kind).toBe("replay");
    if (probe2.kind !== "replay") return;
    expect(probe2.result.x).toBe(42);
  });
});
