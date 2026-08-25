# Derivation Jobs Guide (v1.2.0-alpha.0)

> 🌏 Language: English. 中文(默认): [jobs.md](jobs.md)

This guide covers the **derivation job** substrate introduced in v1.2.0-alpha.0 — the execution layer AgentRecall stands up to evolve from "explicit memory control plane" to "memory lifecycle system". Phase 0 (issue #48) only delivers the substrate (jobs, state machine, lease, reap, redaction); Phase 1 / 2 will layer concrete executors on top (session distillation, skill extraction, bootstrap scan, etc.).

## What the substrate solves

v1.2 introduces workflows that share three properties: **expensive + interruptible + multi-stage + evidence-required**. Building a per-workflow queue / recovery / lineage would produce three incompatible implementations. The `derivation job` substrate extracts this common layer:

- One derivation request = one `derivation_jobs` row, with idempotency key + input digest + config digest
- Each stage = one `derivation_runs` row, with `started_at` / `finished_at` / `policy_version` / `provider_id`
- Each produced artifact = one `derivation_outputs` row, with `(job_id, run_id, output_kind, output_id, disposition)` — the lineage edge from job to memory / asset / plan
- Multi-process mutual exclusion via SQLite `BEGIN IMMEDIATE` + lease; **no Redis, no external service**.

## Three entry points

Phase 0 exposes three equivalent entry points:

1. **CLI**: `agent-recall jobs list | show | cancel | run`
2. **MCP resource**: `agentrecall://jobs/{job_id}` (read-only, returns job + runs + outputs as JSON)
3. **Programmatic**: from Node `import { DerivationJobStore } from "agent-recall/jobs/service.js"`, passing in a `SQLiteMemoryStore` instance

All three share the same `DerivationJobStore`, so `enqueue` / `claim` / `cancel` semantics are identical across entry points.

## State machine

```
        enqueue
          │
          ▼
       queued ──claim──▶ running ──complete──▶ succeeded
          │               │   │
          │               │   └──fail─────▶ failed (next_retry_at? ──re-claim──▶ queued)
          │               │   │
          │               │   └──markCancelled─▶ cancelled
          │               │   │
          │               │   └──requestCancel (cancel_requested_at)
          │               │
          └──────────────reap expired lease────────────▶ queued
```

Key invariants:

- Same `(creator_actor_id, kind, idempotency_key)` + same `(input_digest, config_digest)` → same `job_id`; **different digest → `idempotency_digest_mismatch` exception** (deterministic refusal).
- A `running` job must have `lease_owner` + `lease_expires_at`; an expired lease = reap-takeover eligible.
- A `failed` state needs `next_retry_at IS NOT NULL` to be re-claimable; **a failed job without `next_retry_at` is terminal** and is not picked up again.
- `cancel_requested_at` is consumed only at stage boundaries, never in the middle of a stage.

## End-to-end example

### 1. Issue a derivation (pseudocode — Phase 2 has the real executors)

```ts
import { DerivationJobStore, DEFAULT_LEASE_TTL_MS } from "agent-recall/jobs/service";
import { SQLiteMemoryStore } from "agent-recall/sqlite-store";
import { createHash } from "node:crypto";

const store = new SQLiteMemoryStore(`${process.env.AGENT_RECALL_HOME}/memory.sqlite`);
const jobs = new DerivationJobStore(store);

const inputDigest = "sha256:" + createHash("sha256").update(JSON.stringify(input)).digest("hex");
const configDigest = "sha256:" + createHash("sha256").update(JSON.stringify(providerConfig)).digest("hex");

const { job, replayed } = jobs.enqueue({
  kind: "session_distill",       // real executor lands in Phase 2
  scope: "project",
  project_id: "proj_alpha",
  creator_actor_id: "user:dev",
  idempotency_key: "distill-2026-08-25-001",
  input_digest: inputDigest,
  config_digest: configDigest
});

if (replayed) {
  console.log("Already enqueued:", job.job_id);
}
```

### 2. Register an executor (Phase 0 has no real executors; Phase 2 fills in)

```ts
import { runOnce, makeLeaseOwner } from "agent-recall/jobs/runner";

const result = await runOnce(store, [
  {
    kind: "session_distill",
    execute: async ({ job, startStage }) => {
      const stage = startStage("window_select", [{ kind: "session_event", id: "evt_1" }]);
      const outputs = await doExtraction(job);
      stage.finish("succeeded", "sha256:abc", [
        { output_kind: "candidate", output_id: "cand_1", disposition: "proposed" }
      ]);
      return { status: "succeeded" };
    }
  }
], {
  lease_owner: makeLeaseOwner(),
  lease_ttl_ms: 30_000,
  max_jobs: 16
});

console.log(result);
// { attempted: 1, succeeded: 1, failed: 0, cancelled: 0 }
```

### 3. CLI view

```bash
# List all jobs
agent-recall jobs list

# Inspect one job (full runs + outputs)
agent-recall jobs show job_<uuid>

# Request cancellation (runner handles at next stage boundary)
agent-recall jobs cancel job_<uuid>

# Synchronous one-pass run (no real executor in Phase 0; will mark failed)
agent-recall jobs run --kind session_distill --json
```

### 4. MCP view

Read a job's full state (consumed by the admin app / clients):

```jsonc
// resource: agentrecall://jobs/{job_id}
// returns:
{
  "ok": true,
  "job":   { "job_id": "...", "kind": "session_distill", "state": "succeeded", ... },
  "runs":  [ { "run_id": "...", "stage": "window_select", "status": "succeeded", ... } ],
  "outputs": [
    { "job_id": "...", "run_id": "...", "output_kind": "candidate",
      "output_id": "cand_1", "disposition": "proposed" }
  ]
}
```

## Common diagnostics

### "I enqueued but `list` doesn't show it"

1. Check `agent-recall migrate` walked to v14 (`SELECT user_version FROM pragma_user_version;` from `sqlite3` CLI).
2. Check the `--json` list output's `state` field — only `queued` is "successfully enqueued".
3. Check the `(creator_actor_id, kind, idempotency_key)` triple — collision returns the original `job_id`, not a new row.

### "Two workers claimed the same job"

This should not happen: claim is a single `BEGIN IMMEDIATE` transaction with a lease-expiry predicate. If you observe it:

1. Confirm both workers are sharing the same data home (same SQLite file).
2. Confirm WAL is on (`PRAGMA journal_mode=WAL`); AgentRecall enables WAL by default.

### "My job is stuck in `running`"

Most likely the previous worker crashed but the lease has not yet expired (default 30 s). Wait it out and re-run `runOnce` — the internal `reap()` resets expired `running` rows to `queued`. A manual `cancel` only takes effect at stage boundaries, so a dead-locked stage still needs reap.

### "I replayed the same idempotency_key with a different input and got rejected"

This is intentional (issue #48 AC #3): same key + different digest = a different derivation request. Use a new key (e.g. `distill-2026-08-25-002`) for a real re-run.

### "Which job produced this memory?"

Query `derivation_outputs` directly: `WHERE output_id = ? AND output_kind = 'applied_memory' AND disposition = 'applied'`. JOIN `derivation_runs` for stage info, JOIN `derivation_jobs` for `input_digest` / `config_digest` / creator. Phase 3 (issue #55) will surface this query through a UI; Phase 0 has no UI — direct SQL only.

## Relationship to existing tools

- `remember` / `search_memories` / `recall_context` are unchanged. Phase 0 has no user-visible behaviour change.
- `apply_maintenance` still goes through `maintenance_plans` / `maintenance_plan_items` (v6 schema), not the derivation substrate.
- `import_batches` (v13) keeps its current path. v1.2 session ingest (#49) uses a new `sessions` table + derivation job submission, out of scope for this guide.
- The v1.1.x OpenCode plugin still reads SQLite directly for prompt injection. Phase 2 (#52) replaces it with a shared assembler.

## Out of scope

- Concrete executors (`#50` / `#53` / `#54` land in Phase 1 / 2)
- HTTP bridge `jobs` endpoint (Phase 2)
- Admin app job browser / candidate review UI (Phase 2)
- `--watch` loop (deferred to Phase 2 / #54 bootstrap planner)
- Evaluation / shadow metrics (Phase 3 / #55)
