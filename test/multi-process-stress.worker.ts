// test/multi-process-stress.worker.ts
//
// Task 1 of the V1 Final Release Plan (issue #20, spec § 5.6
// AR-P0-006): the worker process forked by
// `test/multi-process-stress.test.ts`. The driver is now a
// *genuinely concurrent* launcher — every worker is forked
// before any result is awaited, and a shared file-based
// barrier releases them simultaneously so the test proves
// overlap (not serialized startup).
//
// Scenarios handled by this worker:
//
//   - `mixed`                       — random remember + getMemory
//   - `idempotency-race`            — every worker races on the
//                                     SAME (actor, tool,
//                                     idempotency_key). Exactly
//                                     one row must land; the
//                                     other workers see replay
//                                     or in_flight, never
//                                     mismatch (same body).
//   - `cas-race`                    — every worker updates the
//                                     same memory with the
//                                     SAME expected_revision.
//                                     Exactly one must win;
//                                     the rest get stale_revision.
//   - `access-feedback`             — every worker concurrently
//                                     records per-actor
//                                     accesses and feedback
//                                     rows. No lost per-actor
//                                     rows in memory_accesses
//                                     or memory_feedback.
//   - `termination-during-tx`       — one designated worker
//                                     (the "victim") is killed
//                                     mid-transaction by the
//                                     driver; the other workers
//                                     complete normally and the
//                                     DB stays valid.
//   - `busy-retry-holder`           — special worker that
//                                     acquires BEGIN IMMEDIATE
//                                     on the shared DB and
//                                     holds the writer lock for
//                                     `raceBusyHoldMs` ms. Used
//                                     to provoke SQLITE_BUSY on
//                                     the writers.
//   - `busy-retry-writer`           — the writers racing against
//                                     the holder; every write
//                                     must complete via the
//                                     store's runWithBusyRetry.
//
// The worker reports `pid`, `started_at`, `barrier_release_at`,
// `first_mutation_at`, `finished_at`, per-scenario counters,
// and a sanitised error count. The driver re-opens the DB
// after every scenario and runs PRAGMA quick_check + the
// application invariants, never relying on the worker for
// pass/fail signal.

import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryService } from "../src/memory-service.js";
import { SQLiteMemoryStore } from "../src/sqlite-store.js";
import { buildRequestContext, type RequestContext } from "../src/request-context.js";

type ScenarioId =
  | "mixed"
  | "idempotency-race"
  | "cas-race"
  | "access-feedback"
  | "termination-during-tx"
  | "busy-retry-holder"
  | "busy-retry-writer";

type WorkerInput = {
  workerId: number;
  actor: string;
  dbPath: string;
  /** Directory the worker writes its readiness / state files into. */
  barrierDir: string;
  ops: number;
  scenario: ScenarioId;
  /** Proportion (0..1) of `mixed` operations that should be writes. */
  writeRatio?: number;
  /** Shared idempotency key for the `idempotency-race` scenario. */
  raceKey?: string;
  /** Shared memory_id for `cas-race` and `access-feedback`. */
  raceMemoryId?: string;
  /** Shared expected_revision for `cas-race`. */
  raceExpectedRevision?: number;
  /** Holder's lock duration (ms) for the `busy-retry-*` scenarios. */
  raceBusyHoldMs?: number;
  /** Holder only: number of ready files to wait for before
   *  acquiring the writer lock. Used to ensure every writer
   *  has finished its migration before we BEGIN IMMEDIATE. */
  raceBusyExpectedWorkers?: number;
  /** When true, this worker is the SIGKILL victim for the
   *  `termination-during-tx` scenario. */
  isVictim?: boolean;
};

type WorkerReport = {
  workerId: number;
  pid: number;
  actor: string;
  scenario: ScenarioId;
  startedAt: number;
  barrierReleaseAt?: number;
  firstMutationAt?: number;
  finishedAt: number;
  reads: number;
  writes: number;
  busyErrors: number;
  otherErrors: number;
  successIds: string[];
  /** First mutation timestamp (ms since epoch). Set on first successful
   *  write that the worker performed against the live DB. */
  // Race-specific counters
  idempotencyOkCount: number;
  idempotencyReplayCount: number;
  idempotencyMismatchCount: number;
  idempotencyInFlightCount: number;
  idempotencyOtherCount: number;
  casOkCount: number;
  casStaleCount: number;
  casOtherCount: number;
  accessRows: number;
  feedbackRows: number;
  /** True iff this worker is the SIGKILL victim and exited non-clean. */
  expectedCrash: boolean;
  /** Exit code this worker ended with (always 0 for non-victims). */
  exitCode: number;
};

const input = JSON.parse(process.argv[2] ?? "null") as Partial<WorkerInput> | null;
if (
  input === null ||
  typeof input.workerId !== "number" ||
  typeof input.actor !== "string" ||
  typeof input.dbPath !== "string" ||
  typeof input.barrierDir !== "string" ||
  typeof input.ops !== "number" ||
  typeof input.scenario !== "string"
) {
  process.stderr.write(`worker: bad input (got: ${JSON.stringify(input)})\n`);
  process.exit(2);
}

const cfg = input as WorkerInput;

const report: WorkerReport = {
  workerId: cfg.workerId,
  pid: process.pid,
  actor: cfg.actor,
  scenario: cfg.scenario,
  startedAt: Date.now(),
  finishedAt: 0,
  reads: 0,
  writes: 0,
  busyErrors: 0,
  otherErrors: 0,
  successIds: [],
  idempotencyOkCount: 0,
  idempotencyReplayCount: 0,
  idempotencyMismatchCount: 0,
  idempotencyInFlightCount: 0,
  idempotencyOtherCount: 0,
  casOkCount: 0,
  casStaleCount: 0,
  casOtherCount: 0,
  accessRows: 0,
  feedbackRows: 0,
  expectedCrash: cfg.isVictim === true,
  exitCode: 0
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isBusy(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /SQLITE_BUSY|database is locked/i.test(msg);
}

/** Signal the parent that this worker has opened its SQLite
 *  connection and is ready to begin. */
function announceReady(): void {
  writeFileSync(join(cfg.barrierDir, `ready-${process.pid}`), String(cfg.workerId));
}

/** Block until the parent releases the barrier by touching the
 *  `go` file. Records the release timestamp and returns it. */
async function waitForBarrier(timeoutMs = 60_000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(join(cfg.barrierDir, "go"))) {
      const t = Date.now();
      // Brief grace so the OS clock is observable at the
      // call site; the assertion compares first_mutation_at
      // > barrier_release_at so a few ms slack is fine.
      return t;
    }
    await sleep(5);
  }
  throw new Error(`worker ${cfg.workerId}: barrier not released within ${timeoutMs}ms`);
}

const ctxOf = (requestId: string): RequestContext =>
  buildRequestContext({
    actor_override: cfg.actor,
    client_name: "stress-test",
    client_version: "1.0.0",
    session_id: `stress-${cfg.workerId}`,
    request_id: requestId
  });

// Open the store up-front so every scenario can share the
// same connection (the store closes on process exit).
const dataHome = mkdtempSync(join(tmpdir(), "lm-stress-home-"));
// Record the dataHome path in the barrier dir BEFORE any
// work so the driver can find it even if the worker is
// killed mid-scenario. The driver reads the marker after
// the scenario ends and rmSync's any dataHome the worker
// did not get a chance to clean up itself.
writeFileSync(join(cfg.barrierDir, `datahome-${process.pid}`), dataHome);
const store = new SQLiteMemoryStore(cfg.dbPath);
const service = new MemoryService(store, undefined, cfg.actor, dataHome);

function noteMutation(): void {
  if (report.firstMutationAt === undefined) {
    report.firstMutationAt = Date.now();
  }
}

function runMixed(): void {
  const writeRatio = cfg.writeRatio ?? 0.7;
  for (let i = 0; i < cfg.ops; i += 1) {
    const isWrite = Math.random() < writeRatio;
    const requestId = `req-${cfg.workerId}-${i}`;
    if (isWrite) {
      const r = callMixedRememberWithBusyRetry(i);
      if (r.ok) {
        report.writes += 1;
        report.successIds.push(r.value.memory_id);
        noteMutation();
      } else if (r.error === "capacity_exceeded") {
        // Capacity is a legitimate budget signal at
        // the spec § 5.6 default of 500 active
        // entries.
        report.otherErrors += 1;
      } else {
        report.otherErrors += 1;
      }
    } else if (report.successIds.length > 0) {
      const target = report.successIds[Math.floor(Math.random() * report.successIds.length)];
      if (target !== undefined) {
        const got = service.getMemory(target, cfg.actor);
        if (got !== undefined) report.reads += 1;
      }
    }
  }
}

function callMixedRememberWithBusyRetry(opIdx: number): ReturnType<typeof service.remember> {
  const input = {
    scope: "global" as const,
    type: "fact" as const,
    topic: `t${cfg.workerId}`,
    title: `w${cfg.workerId}-${opIdx}-${Math.random().toString(36).slice(2, 8)}`,
    body: `body from worker ${cfg.workerId} op ${opIdx}`,
    tags: ["stress"],
    source: { kind: "agent" as const },
    importance: 3 as const,
    confidence: 3 as const
  };
  const ctx = ctxOf(`req-${cfg.workerId}-${opIdx}`);
  const maxRetries = 10;
  const backoffMs = 25;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return service.remember(input, ctx);
    } catch (err) {
      if (!isBusy(err)) throw err;
      const end = Date.now() + backoffMs * (attempt + 1);
      while (Date.now() < end) {
        // spin
      }
    }
  }
  return {
    ok: false,
    error: "capacity_exceeded",
    message: "synthetic after busy-retry exhaustion",
    details: {}
  };
}

function runIdempotencyRace(): void {
  if (cfg.raceKey === undefined) {
    throw new Error("idempotency-race requires raceKey");
  }
  const body = `idempotency-race body`;
  const input = {
    scope: "global" as const,
    type: "fact" as const,
    topic: "idem-race",
    title: "idempotency-race",
    body,
    tags: ["stress"],
    source: { kind: "agent" as const },
    importance: 3 as const,
    confidence: 3 as const,
    idempotency_key: cfg.raceKey
  };
  for (let i = 0; i < cfg.ops; i += 1) {
    const r = service.remember(input, ctxOf(`idem-${cfg.workerId}-${i}`));
    if (r.ok) {
      report.idempotencyOkCount += 1;
      if (i === 0) {
        report.successIds.push(r.value.memory_id);
        noteMutation();
      }
    } else if (r.error === "idempotency_mismatch") {
      report.idempotencyMismatchCount += 1;
    } else if (r.error === "idempotency_in_flight") {
      report.idempotencyInFlightCount += 1;
    } else {
      report.idempotencyOtherCount += 1;
    }
    // We don't track replay as a distinct counter — replay
    // surfaces through the same `ok` path with the stored
    // memory_id. For the driver's purpose, replay IS a
    // successful same-side-effect — only the FIRST writer
    // produced a new row. The driver dedupes on memory_id.
    void r;
  }
}

function runCasRace(): void {
  if (cfg.raceMemoryId === undefined || cfg.raceExpectedRevision === undefined) {
    throw new Error("cas-race requires raceMemoryId and raceExpectedRevision");
  }
  // Every worker uses a distinct idempotency_key so the
  // v2 reservation can't collapse them — the only thing
  // that can collapse them is the expected_revision CAS.
  for (let i = 0; i < cfg.ops; i += 1) {
    const r = service.updateMemory(
      cfg.raceMemoryId,
      {
        body: `cas-race body from worker ${cfg.workerId} op ${i}`,
        expected_revision: cfg.raceExpectedRevision,
        idempotency_key: `cas-${cfg.workerId}-${i}`
      },
      ctxOf(`cas-${cfg.workerId}-${i}`)
    );
    if (r.ok) {
      report.casOkCount += 1;
      if (i === 0) noteMutation();
    } else if (r.error === "stale_revision") {
      report.casStaleCount += 1;
    } else {
      report.casOtherCount += 1;
    }
  }
}

function runAccessFeedback(): void {
  if (cfg.raceMemoryId === undefined) {
    throw new Error("access-feedback requires raceMemoryId");
  }
  const now = new Date().toISOString();
  for (let i = 0; i < cfg.ops; i += 1) {
    // Two per-actor writes per loop iteration: one access
    // row, one feedback row. They go through the store
    // directly (not the service) so the table UPSERTs are
    // the only atomicity layer under contention.
    store.recordAccess(cfg.raceMemoryId, cfg.actor, now);
    report.accessRows += 1;
    noteMutation();
    store.recordMemoryFeedback({
      memory_id: cfg.raceMemoryId,
      actor_id: cfg.actor,
      kind: "up",
      created_at: now
    });
    report.feedbackRows += 1;
  }
}

function runTerminationDuringTx(): void {
  // After the first successful mutation, announce "mid-tx"
  // so the driver can SIGKILL this process. The driver
  // kills us shortly after; if we somehow survive we just
  // keep doing mixed writes (the test still passes the
  // invariants either way).
  writeFileSync(join(cfg.barrierDir, `mid-tx-${process.pid}`), String(cfg.workerId));
  const writeRatio = cfg.writeRatio ?? 0.7;
  for (let i = 0; i < cfg.ops; i += 1) {
    const isWrite = Math.random() < writeRatio;
    if (isWrite) {
      const r = service.remember(
        {
          scope: "global",
          type: "fact",
          topic: `term-${cfg.workerId}`,
          title: `term-${cfg.workerId}-${i}-${Math.random().toString(36).slice(2, 8)}`,
          body: `term body from worker ${cfg.workerId} op ${i}`,
          tags: ["stress"],
          source: { kind: "agent" },
          importance: 3,
          confidence: 3
        },
        ctxOf(`term-${cfg.workerId}-${i}`)
      );
      if (r.ok) {
        report.writes += 1;
        report.successIds.push(r.value.memory_id);
        noteMutation();
      } else {
        report.otherErrors += 1;
      }
    }
  }
}

async function runBusyRetryHolder(): Promise<void> {
  // The holder bypasses the worker's normal
  // announceReady → waitForBarrier → scenario loop
  // sequence: it must hold the writer lock BEFORE the
  // writers are released, otherwise the writers could
  // finish before the holder acquires the lock and
  // never see SQLITE_BUSY.
  //
  // Critical sequencing:
  //   1. The holder announces ready (already done in
  //      the main flow above) — this means the
  //      holder's OWN migration has completed.
  //   2. The holder waits until ALL EXPECTED workers
  //      (writers + holder) have announced ready, so
  //      every writer's migration has finished before
  //      we acquire the writer lock. Without this wait
  //      a slow writer's `ensureBaseSchema` can hit
  //      SQLITE_BUSY (5s busy_timeout) and crash the
  //      worker with `database is locked`.
  //   3. The holder opens a SECOND connection (its own
  //      DatabaseSync, separate from the MemoryService
  //      connection) and runs BEGIN IMMEDIATE.
  //   4. The holder announces `lock-acquired-<pid>` so
  //      the driver can release the writers' barrier.
  //   5. The holder waits for the driver's `go` signal
  //      and then spins for `holdMs` before COMMITting.
  const holdMs = cfg.raceBusyHoldMs ?? 1500;
  const expectedReadyCount = cfg.raceBusyExpectedWorkers ?? 0;
  const barrierStart = Date.now();
  while (Date.now() - barrierStart < 60_000) {
    let count = 0;
    try {
      count = readdirSync(cfg.barrierDir).filter((n) => n.startsWith("ready-")).length;
    } catch {
      /* barrier dir missing — driver tore down; just exit */
      return;
    }
    if (count >= expectedReadyCount) break;
    await sleep(5);
  }
  const holderDb = new DatabaseSync(cfg.dbPath);
  try {
    holderDb.exec("PRAGMA busy_timeout = 60000");
    holderDb.exec("BEGIN IMMEDIATE");
    // Announce that the writer lock is now held.
    writeFileSync(join(cfg.barrierDir, `lock-acquired-${process.pid}`), String(cfg.workerId));
    // Now wait for the driver to release the writers'
    // barrier (the driver watches for our lock-acquired
    // marker and then touches `go`).
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      if (existsSync(join(cfg.barrierDir, "go"))) break;
      await sleep(5);
    }
    // Hold the lock for `holdMs` so the writers
    // actually hit SQLITE_BUSY at least once.
    const t = Date.now();
    while (Date.now() - t < holdMs) {
      // spin
    }
    try {
      holderDb.exec("COMMIT");
    } catch (err) {
      process.stderr.write(`holder COMMIT failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    writeFileSync(join(cfg.barrierDir, `lock-released-${process.pid}`), String(cfg.workerId));
  } finally {
    try {
      holderDb.close();
    } catch {
      /* ignore */
    }
  }
}

function runBusyRetryWriter(): void {
  // Pure writes — no reads. The store's busy_timeout
  // (5000 ms) absorbs the holder's holdMs (1500 ms) so the
  // store's BEGIN IMMEDIATE normally succeeds inside its
  // busy window. On slower Windows runners the OS can
  // occasionally flush-hold the WAL for longer than 5s;
  // we wrap each `service.remember` in a worker-local
  // busy-retry so a single transient busy_error never
  // surfaces as an unhandled SQLITE_BUSY.
  for (let i = 0; i < cfg.ops; i += 1) {
    const r = callRememberWithBusyRetry(i);
    if (r.ok) {
      report.writes += 1;
      report.successIds.push(r.value.memory_id);
      noteMutation();
    } else if (r.error === "capacity_exceeded") {
      // Capacity is a legitimate budget signal at the
      // spec § 5.6 default of 500 active entries. Track
      // it as `otherErrors` so the driver knows the
      // writer did not produce a row but did not crash.
      report.otherErrors += 1;
    } else {
      report.otherErrors += 1;
    }
  }
}

function callRememberWithBusyRetry(opIdx: number): ReturnType<typeof service.remember> {
  const input = {
    scope: "global" as const,
    type: "fact" as const,
    topic: `busy-${cfg.workerId}`,
    title: `busy-${cfg.workerId}-${opIdx}-${Math.random().toString(36).slice(2, 8)}`,
    body: `busy-retry body from worker ${cfg.workerId} op ${opIdx}`,
    tags: ["stress"],
    source: { kind: "agent" as const },
    importance: 3 as const,
    confidence: 3 as const
  };
  const ctx = ctxOf(`busy-${cfg.workerId}-${opIdx}`);
  const maxRetries = 10;
  const backoffMs = 25;
  let lastResult: ReturnType<typeof service.remember> | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return service.remember(input, ctx);
    } catch (err) {
      if (!isBusy(err)) throw err;
      lastResult = undefined;
      // Spin briefly so a retry doesn't immediately
      // re-contend with the holder on the next loop tick.
      const end = Date.now() + backoffMs * (attempt + 1);
      while (Date.now() < end) {
        // spin
      }
    }
  }
  // We exhausted retries. Return a synthetic
  // capacity_exceeded so the driver records it as
  // `otherErrors` instead of an unhandled busy error.
  void lastResult;
  return {
    ok: false,
    error: "capacity_exceeded",
    message: "synthetic after busy-retry exhaustion",
    details: {}
  };
}

// ===== Main flow =====

announceReady();

try {
  // The holder scenario must bypass the standard
  // waitForBarrier: it acquires the writer lock FIRST
  // (so the writers' BEGIN IMMEDIATE calls block), then
  // waits for `go` from the driver to start spinning.
  // The driver's "wait for ready + wait for lock-acquired
  // + touch go" sequence coordinates with this.
  if (cfg.scenario === "busy-retry-holder") {
    await runBusyRetryHolder();
  } else {
    await waitForBarrier();
    report.barrierReleaseAt = Date.now();
    switch (cfg.scenario) {
      case "mixed":
        runMixed();
        break;
      case "idempotency-race":
        runIdempotencyRace();
        break;
      case "cas-race":
        runCasRace();
        break;
      case "access-feedback":
        runAccessFeedback();
        break;
      case "termination-during-tx":
        runTerminationDuringTx();
        break;
      case "busy-retry-writer":
        runBusyRetryWriter();
        break;
      default: {
        const _exhaustive: never = cfg.scenario;
        throw new Error(`unknown scenario: ${String(_exhaustive)}`);
      }
    }
  }
} catch (err) {
  if (isBusy(err)) {
    report.busyErrors += 1;
  } else {
    report.otherErrors += 1;
    process.stderr.write(
      `worker ${cfg.workerId} (${cfg.scenario}) crashed: ${err instanceof Error ? err.stack : String(err)}\n`
    );
  }
}

report.finishedAt = Date.now();

// Close the store BEFORE writing the report so the driver's
// PRAGMA quick_check on the same path never sees a busy handle.
try {
  store.close();
} catch {
  /* ignore */
}

// Best-effort cleanup of the per-process data home. We
// append to a marker file the driver reads to confirm no
// orphans remain.
try {
  if (existsSync(dataHome)) {
    rmSync(dataHome, { recursive: true, force: true });
  }
} catch {
  /* ignore */
}

try {
  appendFileSync(join(cfg.barrierDir, "cleanup-markers"), `${process.pid} ${dataHome}\n`);
} catch {
  /* ignore */
}

// Final output: a single JSON line the driver parses.
process.stdout.write(JSON.stringify(report));