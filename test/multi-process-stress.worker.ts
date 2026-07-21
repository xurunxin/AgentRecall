// test/multi-process-stress.worker.ts
//
// Stage 14 PR-B2 (spec § 5.6 AR-P0-006): worker process for
// the 8-process concurrency stress test. Forked by the
// driver in `test/multi-process-stress.test.ts` and given a
// fresh SQLite file plus a per-process actor id. Runs a
// fixed mix of remember / update / forget operations and
// reports counts of success / error / SQLITE_BUSY so the
// driver can assert the spec § 5.6 invariants:
//
//   1. No unhandled SQLITE_BUSY (every busy error is
//      retried by `runWithBusyRetry`).
//   2. No DB corruption (PRAGMA quick_check passes after
//      all workers join).
//   3. Every successful remember lands a row with no
//      duplicate primary key (the spec calls this "no
//      lost updates").
//
// The worker does NOT enforce `expected_revision` CAS by
// design — the spec says the *driver* asserts winner-take-
// all across two processes racing on the same entry. The
// worker just does the writes the driver asked for.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryService } from "../src/memory-service.js";
import { SQLiteMemoryStore } from "../src/sqlite-store.js";
import { buildRequestContext, type RequestContext } from "../src/request-context.js";

type WorkerInput = {
  workerId: number;
  actor: string;
  dbPath: string;
  ops: number;
  /** Proportion (0..1) of operations that should be writes; the rest are reads. */
  writeRatio: number;
};

type WorkerReport = {
  workerId: number;
  actor: string;
  reads: number;
  writes: number;
  busyErrors: number;
  otherErrors: number;
  successIds: string[];
  busied: number;
};

const input = JSON.parse(process.argv[2] ?? "null") as Partial<WorkerInput> | null;
if (
  input === null ||
  typeof input.workerId !== "number" ||
  typeof input.actor !== "string" ||
  typeof input.dbPath !== "string" ||
  typeof input.ops !== "number" ||
  typeof input.writeRatio !== "number"
) {
  process.stderr.write(`worker: bad input (got: ${JSON.stringify(input)})\n`);
  process.exit(2);
}

const { workerId, actor, dbPath, ops, writeRatio } = input as WorkerInput;

const store = new SQLiteMemoryStore(dbPath);
const service = new MemoryService(store, undefined, actor, mkdtempSync(join(tmpdir(), "lm-stress-home-")));

const ctxOf = (requestId: string): RequestContext =>
  buildRequestContext({
    actor_override: actor,
    client_name: "stress-test",
    client_version: "1.0.0",
    session_id: `stress-${workerId}`,
    request_id: requestId
  });

const report: WorkerReport = {
  workerId,
  actor,
  reads: 0,
  writes: 0,
  busyErrors: 0,
  otherErrors: 0,
  successIds: [],
  busied: 0
};

function isBusy(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /SQLITE_BUSY|database is locked/i.test(msg);
}

try {
  for (let i = 0; i < ops; i += 1) {
    const r = Math.random();
    const isWrite = r < writeRatio;
    const requestId = `req-${workerId}-${i}`;
    if (isWrite) {
      const result = service.remember(
        {
          scope: "global",
          type: "fact",
          topic: `t${workerId}`,
          title: `w${workerId}-${i}`,
          body: `body from worker ${workerId} op ${i}`,
          tags: ["stress"],
          source: { kind: "agent" },
          importance: 3,
          confidence: 3
        },
        ctxOf(requestId)
      );
      if (result.ok) {
        report.writes += 1;
        report.successIds.push(result.value.memory_id);
      } else if (result.error === "capacity_exceeded") {
        // Skip on capacity; this is a contention signal,
        // not a corruption signal. We track it as a
        // non-busy error so the driver knows.
        report.otherErrors += 1;
      } else {
        report.otherErrors += 1;
      }
    } else {
      // Read: just call getMemory on a random previously-
      // created id, or no-op if we don't have any.
      if (report.successIds.length > 0) {
        const target = report.successIds[Math.floor(Math.random() * report.successIds.length)];
        if (target !== undefined) {
          const got = service.getMemory(target, actor);
          if (got !== undefined) report.reads += 1;
        }
      }
    }
  }
} catch (err) {
  if (isBusy(err)) {
    report.busyErrors += 1;
    report.busied += 1;
  } else {
    report.otherErrors += 1;
    process.stderr.write(`worker ${workerId} crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
  }
}

try {
  store.close();
} catch {
  /* ignore */
}

// Best-effort cleanup of the per-process data home.
try {
  const home = service.listBackups();
  if (home.backup_dir !== undefined) {
    const parent = home.backup_dir.replace(/[\\/]backups$/, "");
    if (existsSync(parent)) {
      rmSync(parent, { recursive: true, force: true });
    }
  }
} catch {
  /* ignore */
}

process.stdout.write(JSON.stringify(report));
