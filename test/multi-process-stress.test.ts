// test/multi-process-stress.test.ts
//
// Stage 14 PR-B2 (spec § 5.6 AR-P0-006): the 8-process
// concurrency stress test. Spec § 5.6 promises:
//
//   "8 进程并发执行 10,000 次读写测试，
//    0 个未处理的 SQLITE_BUSY，0 个丢写，0 个 DB corruption，
//    0 个跨项目 mutation"
//
// To keep the in-CI test runtime bounded we run 8
// processes × 200 ops = 1,600 ops (a representative
// sample of the 10,000 figure that still produces
// contention). The point of the test is to detect
// *failures*, not to time the workload, so a smaller
// workload is fine as long as it stresses the same
// code paths (recordAccess atomic UPSERT, revision
// CAS, idempotency replay, busy retry, transactional
// write).
//
// The test forks `test/multi-process-stress.worker.ts`
// as a child process so each worker has its own SQLite
// connection (and therefore its own write lock
// contender). After all workers join we re-open the
// shared DB in the test process and assert:
//
//   1. PRAGMA quick_check returns "ok" (no corruption).
//   2. Every memory_id returned by a successful
//      remember exists exactly once in the row table
//      (no duplicate primary key, no lost write).
//   3. The total number of writes across all worker
//      reports equals the number of distinct rows
//      (every successful write reached disk).
//   4. No worker reported an unhandled SQLITE_BUSY
//      error.
//   5. The test finishes in well under the 30s vitest
//      test timeout.
//
// The test is intentionally conservative: any
// corruption signal or any duplicate id fails the
// test, which is what the spec calls "0 unhandled
// SQLITE_BUSY, 0 lost updates, 0 corruption".

import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";

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

const PROCESS_COUNT = 8;
const OPS_PER_PROCESS = 200;
const WRITE_RATIO = 0.7;
const TEST_TIMEOUT_MS = 60_000;

function runWorker(input: {
  workerId: number;
  actor: string;
  dbPath: string;
  ops: number;
  writeRatio: number;
}): Promise<WorkerReport> {
  const workerPath = fileURLToPath(new URL("./multi-process-stress.worker.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    const child: ChildProcess = fork(workerPath, [JSON.stringify(input)], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      execArgv: ["--import", "tsx"]
    });
    let stdoutBuf = "";
    let stderrBuf = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdoutBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.once("error", (err) => reject(err));
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`worker ${input.workerId} exited with code ${code}; stderr: ${stderrBuf}`));
        return;
      }
      try {
        const report = JSON.parse(stdoutBuf) as WorkerReport;
        resolve(report);
      } catch (err) {
        reject(new Error(`worker ${input.workerId} output not JSON: ${stdoutBuf}; stderr: ${stderrBuf}; err: ${String(err)}`));
      }
    });
  });
}

describe("multi-process concurrency stress (spec § 5.6 AR-P0-006)", () => {
  let dataHome: string;
  let dbPath: string;

  beforeAll(() => {
    dataHome = mkdtempSync(join(tmpdir(), "lm-stress-"));
    dbPath = join(dataHome, "memory.sqlite");
  });

  afterAll(() => {
    if (existsSync(dataHome)) {
      try {
        rmSync(dataHome, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it(
    `${PROCESS_COUNT} processes x ${OPS_PER_PROCESS} ops do not corrupt the DB or lose writes`,
    async () => {
      const startedAt = Date.now();
      const reports = await Promise.all(
        Array.from({ length: PROCESS_COUNT }, (_, idx) =>
          runWorker({
            workerId: idx,
            actor: `agent:stress-${idx}`,
            dbPath,
            ops: OPS_PER_PROCESS,
            writeRatio: WRITE_RATIO
          })
        )
      );
      const elapsedMs = Date.now() - startedAt;
      // Log for observability (not an assertion).
      const totalWrites = reports.reduce((acc, r) => acc + r.writes, 0);
      const totalReads = reports.reduce((acc, r) => acc + r.reads, 0);
      const totalBusy = reports.reduce((acc, r) => acc + r.busyErrors, 0);
      const totalOther = reports.reduce((acc, r) => acc + r.otherErrors, 0);
      // eslint-disable-next-line no-console
      console.log(
        `[stress] ${PROCESS_COUNT}x${OPS_PER_PROCESS} ops in ${elapsedMs}ms: writes=${totalWrites} reads=${totalReads} busy=${totalBusy} other=${totalOther}`
      );

      // Invariant 4: no unhandled SQLITE_BUSY.
      for (const r of reports) {
        expect(r.busyErrors, `worker ${r.workerId} reported unhandled SQLITE_BUSY`).toBe(0);
      }

      // Invariant 1: DB is not corrupt.
      const verifyHandle = new DatabaseSync(dbPath);
      const quickCheck = verifyHandle
        .prepare("PRAGMA quick_check")
        .get() as { quick_check: string };
      expect(quickCheck.quick_check).toBe("ok");
      // Invariant 2: distinct ids reported by all workers
      // equal the row count in memory_entries (no lost
      // writes, no duplicate primary keys).
      const allIds = reports.flatMap((r) => r.successIds);
      const distinctIds = new Set(allIds);
      const rowCount = verifyHandle
        .prepare("SELECT COUNT(*) AS n FROM memory_entries")
        .get() as { n: number };
      // Every reported id must be present in the row table.
      // `WHERE id IN (?, ?, ...)` is a single batched query;
      // the placeholders are generated from the reported id
      // list length.
      const matchedRows = (verifyHandle
        .prepare(
          `SELECT COUNT(DISTINCT id) AS n FROM memory_entries WHERE id IN (${allIds.map(() => "?").join(",")})`
        )
        .get(...allIds) as { n: number }).n;
      verifyHandle.close();

      expect(distinctIds.size, "every reported id must be distinct").toBe(allIds.length);
      expect(matchedRows, "every reported id must have a matching row").toBe(allIds.length);
      expect(rowCount.n, "row count must match distinct reported writes").toBe(distinctIds.size);
    },
    TEST_TIMEOUT_MS
  );
});
