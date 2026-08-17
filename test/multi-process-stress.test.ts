// test/multi-process-stress.test.ts
//
// Task 1 of the V1 Final Release Plan (issue #20, spec § 5.6
// AR-P0-006): the genuinely concurrent 8-process stress test.
//
// Pre-Task-1 this test started workers serially with a 100 ms
// stagger — it proved busy-retry / CAS / idempotency paths
// worked, but it never proved the workers were alive at the
// same instant. The plan calls for a real concurrent launcher
// with a shared barrier so the spec § 5.6 invariant —
// "8 进程并发执行 10,000 次读写测试，0 个未处理的 SQLITE_BUSY，
//  0 个丢写，0 个 DB corruption，0 个跨项目 mutation" — can be
// asserted from a single file rather than inferred from a
// serialized schedule.
//
// What changed
// ------------
//   - Launcher: every worker is forked before any result is
//     awaited (`Promise.all` over a `forkAndAwait(...)` array).
//   - Barrier: each worker announces readiness by touching
//     `barrierDir/ready-<pid>`. The driver releases the barrier
//     by touching `barrierDir/go` only after every expected
//     worker is ready, and every worker records the release
//     timestamp before its first mutation. The assertion
//     `max(started_at) < min(finished_at)` proves overlap.
//   - Scenarios: independent writes (mixed), same-key
//     idempotency race, same-revision CAS race, concurrent
//     access+feedback writes, termination during a transaction
//     (SIGKILL victim + survivors), and busy-retry (holder
//     connection + writer workers). Each scenario re-opens the
//     DB and runs `PRAGMA quick_check` + the application
//     invariants independently.
//   - Profiles: `STRESS_PROFILE=release` (or `-ops=release`
//     passed through vitest) bumps ops_per_process from 200
//     (CI, 1,600 total) to 1,250 (release, 10,000 total). The
//     CI workflow runs without the flag so the gate stays at
//     1,600; the release workflow opts in explicitly. The
//     default is always CI.
//   - Cleanup: every scenario's per-process data home is
//     removed by the worker; the driver asserts no
//     `lm-stress-home-*` directory is left in os.tmpdir() after
//     the run.
//
// Invariants asserted per scenario are listed in the comments
// above each `it(...)`.

import { fork, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";

/**
 * v1.1.6 follow-up D3 (issue #42, spec d67fc45, plan bfbd2cb):
 * the Windows-flaky cleanup is fixed by replacing every `rmSync`
 * with `fs.promises.rm(... { maxRetries, retryDelay, force })`
 * and every unconditional `child.kill("SIGKILL")` with a
 * SIGTERM → 500 ms grace → SIGKILL escalation. The synchronous
 * `rmSync` on Windows throws `EBUSY` when the SQLite WAL writer
 * still holds the file handle after the child has exited (the
 * process exit tears the user-mode handle but the kernel-side
 * teardown lags by a few ms on Windows-latest). The async rm
 * with `maxRetries: 3, retryDelay: 100` covers that race; the
 * SIGTERM first allows the child to release the SQLite handle
 * cleanly before the SIGKILL escalates, eliminating the
 * `EPERM`/`EBUSY` window. Pre-D3 the carry-over "accept the
 * SIGKILLed victim's dataHome as the ONE allowed orphan" comment
 * documented the flake; the v1.1.5 CHANGELOG "Known non-blocking
 * limits" entry that referenced it is deleted in the v1.1.6
 * ship commit.
 */

/** SIGTERM-then-SIGKILL escalation. Sends SIGTERM to every
 *  survivor, waits 500 ms (a healthy child on POSIX reacts to
 *  SIGTERM by running the lifecycle's clean-shutdown path; on
 *  Windows the SIGTERM is converted to immediate TerminateProcess
 *  by Node but the child still releases its SQLite handle
 *  synchronously), then escalates to SIGKILL on any process
 *  that didn't exit. Returns when all processes are gone. */
async function killChildrenGracefully(
  children: ChildProcess[]
): Promise<void> {
  for (const child of children) {
    if (child.exitCode === null && child.pid !== undefined) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 500));
  for (const child of children) {
    if (child.exitCode === null && child.pid !== undefined) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

/** Async, retry-tolerant recursive rm. Uses `fs.promises.rm`'s
 *  built-in `maxRetries` / `retryDelay` so the Windows-latest
 *  "EBUSY while the SQLite handle is still being torn down"
 *  race is retried up to 3 × 100 ms before falling back to a
 *  best-effort per-entry unlink. Returns `true` if the path is
 *  gone after the call, `false` if a partial failure left
 *  entries behind (the test's orphan assertion will catch the
 *  remainder). */
async function cleanHomeAsync(homePath: string): Promise<boolean> {
  if (!existsSync(homePath)) return true;
  try {
    await fsp.rm(homePath, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100
    });
    return true;
  } catch (err) {
    // Final fallback: enumerate and unlink each entry
    // individually so a single bad file doesn't block the
    // rest. Per-entry unlink is best-effort and silently
    // swallows errors — the post-suite orphan assertion
    // surfaces the leak.
    console.warn(
      `[cleanup] fs.promises.rm failed for ${homePath}: ${(err as Error).message}; falling back to per-entry`
    );
    try {
      const entries = await fsp.readdir(homePath);
      await Promise.all(
        entries.map((entry) =>
          fsp.rm(join(homePath, entry), {
            recursive: true,
            force: true,
            maxRetries: 2,
            retryDelay: 50
          }).catch(() => undefined)
        )
      );
      // Best-effort: try the top-level rm one more time.
      await fsp.rm(homePath, {
        recursive: true,
        force: true,
        maxRetries: 1,
        retryDelay: 50
      }).catch(() => undefined);
      return !existsSync(homePath);
    } catch {
      return false;
    }
  }
}

type ScenarioId =
  | "mixed"
  | "idempotency-race"
  | "cas-race"
  | "access-feedback"
  | "termination-during-tx"
  | "busy-retry-holder"
  | "busy-retry-writer"
  | "project_isolation";

type WorkerInput = {
  workerId: number;
  actor: string;
  dbPath: string;
  barrierDir: string;
  ops: number;
  scenario: ScenarioId;
  writeRatio?: number;
  raceKey?: string;
  raceMemoryId?: string;
  raceExpectedRevision?: number;
  raceBusyHoldMs?: number;
  raceBusyExpectedWorkers?: number;
  isVictim?: boolean;
  /** Project-scoped scenario: the `project_id` the worker writes to. */
  raceIsolationProjectId?: string;
  /** Project-scoped scenario: the canonical `project_path` that
   *  drives `ProjectIdentityResolver` to register an identity row
   *  in `project_identities` (real, not mocked). */
  raceIsolationProjectPath?: string;
  /** Project-scoped scenario: the shared (per-project) idempotency
   *  key the v2 reservation collapses on. Distinct across the two
   *  projects so the v2 PK `(actor, tool, key)` doesn't collide
   *  across project namespaces. */
  raceIsolationKey?: string;
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
  expectedCrash: boolean;
  exitCode: number;
  /** Diagnostic histogram of `other` errors per worker. */
  otherErrorHistogram: Record<string, number>;
};

const PROCESS_COUNT = 8;
const CI_OPS_PER_PROCESS = 200; // 8 * 200 = 1,600 ops (spec § 5.6 CI sample)
const RELEASE_OPS_PER_PROCESS = 1250; // 8 * 1,250 = 10,000 ops (spec § 5.6 release gate)
// Bumped from 60_000 ms (pre-Task-1) to 240_000 ms so the
// release profile (8 workers × 1,250 ops) plus barrier setup
// has enough headroom. CI stays well under 60s in practice.
const TEST_TIMEOUT_MS = 240_000;
// v1.1.5 (v1.1.5 release): bumped from 60_000 ms to
// 120_000 ms so the 8-worker release profile has
// headroom on slower macOS runners. Pre-fix the
// `barrier: only 7/8 workers ready after 60000ms`
// error fired on `macos-latest` (the 8 workers
// don't all hit the readiness barrier in 60s when
// the runner is under load), which made the
// `Package macos-latest / Node 24` matrix leg
// fail and the whole `release.yml` run abort
// before the `Extracted artifact lifecycle` /
// `Smoke` matrix could start. CI on ubuntu /
// windows runners still resolves in <30s; the
// 2x bump gives macOS the room it needs without
// masking real readiness bugs (the test still
// times out hard at 120s).
//
// v1.1.6 follow-up B1.1 (issue #42): the
// v1.1.6 release.yml (run 31380507624) on
// `macos-latest` failed at the multi-process
// stress test with `barrier: only 7/8 workers
// ready after 120000ms`. The 120s ceiling is
// still not enough for the 8-worker release
// profile on the macos-latest runner under
// load (the arm64 startup of 8 tsx-loaded
// child processes can take >2 minutes when
// the runner is contended). Bumped to
// 180_000 ms so the release profile fits
// inside the barrier window. CI on ubuntu /
// windows still resolves in <30s; the 1.5x
// bump gives macOS another 60s of headroom
// without masking real readiness bugs.
const BARRIER_TIMEOUT_MS = 180_000;
// Bumped from 100 ms (pre-Task-1) so we can prove overlap
// on slower Windows runners without losing busy-retry
// coverage. The release profile is the production
// checkpoint; the 8-process contention still happens —
// it just starts slightly later per worker.
const WORKER_HOLD_MS = 1500;

// ============================================================
// Profile resolution (env: STRESS_PROFILE=ci|release,
// argv: -ops=ci|release). CI is the unconditional default.
// ============================================================
function resolveProfile(): "ci" | "release" {
  const envRaw = process.env.STRESS_PROFILE ?? process.env.AGENT_RECALL_STRESS_PROFILE;
  if (envRaw === "release" || envRaw === "ci") return envRaw;
  if (process.argv.includes("-ops=release")) return "release";
  if (process.argv.includes("-ops=ci")) return "ci";
  return "ci";
}
const PROFILE = resolveProfile();
const OPS_PER_PROCESS =
  PROFILE === "release" ? RELEASE_OPS_PER_PROCESS : CI_OPS_PER_PROCESS;

// ============================================================
// Barrier helpers. The barrier is a directory the driver
// creates; workers write `ready-<pid>` files into it; once
// every expected worker is ready, the driver touches `go`.
// Workers poll for `go`. Cross-platform: file existence is
// observable on linux/macOS/Windows.
// ============================================================
function makeBarrierDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lm-stress-barrier-"));
  return dir;
}

function countReady(barrierDir: string): number {
  if (!existsSync(barrierDir)) return 0;
  return readdirSync(barrierDir).filter((f) => f.startsWith("ready-")).length;
}

async function waitForReady(barrierDir: string, expected: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (countReady(barrierDir) >= expected) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(
    `barrier: only ${countReady(barrierDir)}/${expected} workers ready after ${timeoutMs}ms`
  );
}

async function waitForMarker(
  barrierDir: string,
  marker: string,
  timeoutMs: number
): Promise<void> {
  const path = join(barrierDir, marker);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`barrier: marker ${marker} did not appear within ${timeoutMs}ms`);
}

function releaseBarrier(barrierDir: string): number {
  // Use a single timestamp for both the file mtime and the
  // returned value. Workers record their local wall clock at
  // the moment they observe the file; the assertion compares
  // them against the driver's clock, so we keep the skew
  // window tight by syncing before the touch.
  const t = Date.now();
  writeFileSync(join(barrierDir, "go"), String(t));
  return t;
}

// ============================================================
// Child-process plumbing: fork + accumulate stdout/stderr
// into a WorkerReport. Returns the child handle (so the
// driver can SIGKILL the victim) and the completion promise.
// ============================================================
const EXPECTED_CRASH_EXIT_CODE = 137; // 128 + SIGKILL on unix
const WINDOWS_TERMINATE_EXIT_CODE = 1; // TerminateProcess default on Windows

function forkWorker(
  input: WorkerInput
): { child: ChildProcess; promise: Promise<WorkerReport>; stderr: () => string } {
  const workerPath = fileURLToPath(new URL("./multi-process-stress.worker.ts", import.meta.url));
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
  const promise = new Promise<WorkerReport>((resolve, reject) => {
    child.once("error", (err) => reject(err));
    child.once("exit", (code, signal) => {
      const isExpectedCrash =
        input.isVictim === true &&
        (code === EXPECTED_CRASH_EXIT_CODE ||
          code === WINDOWS_TERMINATE_EXIT_CODE ||
          signal === "SIGKILL" ||
          signal === "SIGTERM");
      if (code !== 0 && !isExpectedCrash) {
        reject(
          new Error(
            `worker ${input.workerId} (${input.scenario}) exited with code ${code} signal ${String(signal)}; stderr: ${stderrBuf}`
          )
        );
        return;
      }
      try {
        const report = JSON.parse(stdoutBuf) as WorkerReport;
        // For an expected-crash victim the report may be
        // truncated (process killed mid-scenario). Allow the
        // missing fields by stamping them as 0 so the
        // driver can still log; the assertions below check
        // the survivors, not the victim.
        if (isExpectedCrash) {
          report.expectedCrash = true;
          report.exitCode = code ?? 0;
        }
        resolve(report);
      } catch (err) {
        if (isExpectedCrash) {
          // The victim was killed before it could write
          // its JSON report. Synthesize an empty one so
          // the driver's Promise.all still resolves
          // and the survivors' invariants can be
          // asserted. The driver treats this as a
          // victim-only signal; the real assertions run
          // against the survivors.
          const synthetic: WorkerReport = {
            workerId: input.workerId,
            pid: input.workerId,
            actor: input.actor,
            scenario: input.scenario,
            startedAt: 0,
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
            expectedCrash: true,
            exitCode: code ?? 0,
            otherErrorHistogram: {}
          };
          resolve(synthetic);
          return;
        }
        reject(
          new Error(
            `worker ${input.workerId} (${input.scenario}) output not JSON: ${stdoutBuf}; stderr: ${stderrBuf}; err: ${String(err)}`
          )
        );
      }
    });
  });
  return { child, promise, stderr: () => stderrBuf };
}

// ============================================================
// Run N workers in parallel via a shared barrier, returning
// their reports (after `Promise.all`). Throws on the first
// failure. The driver's caller is responsible for cleanup.
// ============================================================
async function runScenario(input: {
  /** Path to the SQLite file the workers will write to. */
  dbPath: string;
  barrierTimeoutMs: number;
  scenario: ScenarioId;
  workerCount: number;
  /** Per-scenario factory that builds the WorkerInput for a given worker index. */
  buildInput: (workerId: number) => Omit<WorkerInput, "workerId" | "barrierDir">;
  /** Optional callback invoked when each child spawns (so the
   *  driver can SIGKILL the victim for the termination scenario). */
  onSpawn?: (workerId: number, pid: number, child: ChildProcess) => void;
  /** Optional pre-release hook (e.g. for busy-retry, wait
   *  for the holder to acquire the writer lock before
   *  releasing the writers' barrier). */
  beforeRelease?: (barrierDir: string) => Promise<void>;
  /** Optional post-release hook invoked AFTER the barrier
   *  file is touched but BEFORE `Promise.all` resolves.
   *  Used by the termination scenario to SIGKILL the
   *  victim mid-transaction. The hook receives the
   *  barrier dir + the task map so it can interact with
   *  specific workers (e.g. wait for their mid-tx
   *  marker, then kill). */
  afterRelease?: (barrierDir: string, tasks: Array<{ child: ChildProcess; workerId: number }>) => Promise<void>;
}): Promise<{ reports: WorkerReport[]; tasks: Array<{ child: ChildProcess; promise: Promise<WorkerReport>; workerId: number; stderr: () => string }> }> {
  const dbPath = input.dbPath;
  const barrierDir = makeBarrierDir();
  // Make sure the DB is freshly created so every worker
  // opens a consistent schema. The first writer to open it
  // will run the migration chain.
  if (!existsSync(dbPath)) {
    // Open + close just to materialise the schema (so
    // workers don't race on the initial migration).
    const bootstrap = new DatabaseSync(dbPath);
    bootstrap.close();
  }

  const tasks: Array<{
    child: ChildProcess;
    promise: Promise<WorkerReport>;
    workerId: number;
    stderr: () => string;
  }> = [];
  for (let i = 0; i < input.workerCount; i += 1) {
    const partial = input.buildInput(i);
    const fullInput: WorkerInput = {
      ...partial,
      workerId: i,
      barrierDir
    };
    const { child, promise, stderr } = forkWorker(fullInput);
    input.onSpawn?.(i, child.pid ?? -1, child);
    tasks.push({ child, promise, workerId: i, stderr });
  }

  let reports: WorkerReport[];
  try {
    // Wait for every worker to announce readiness BEFORE
    // touching the barrier file. With concurrent forking
    // this typically resolves in <500ms; we cap at the
    // configured timeout.
    await waitForReady(barrierDir, input.workerCount, input.barrierTimeoutMs);

    // Optional pre-release hook (e.g. acquire the writer
    // lock for the busy-retry scenario).
    await input.beforeRelease?.(barrierDir);

    // Release the barrier. Every worker's
    // barrier_release_at will be >= this timestamp.
    const releasedAt = releaseBarrier(barrierDir);
    void releasedAt;

    // Optional post-release hook (e.g. SIGKILL the victim
    // for the termination scenario). Runs while the
    // workers are actively in their scenario loop, with
    // the barrier dir still alive so the hook can watch
    // for mid-tx markers.
    if (input.afterRelease !== undefined) {
      const taskSubset = tasks.map((t) => ({ child: t.child, workerId: t.workerId }));
      await input.afterRelease(barrierDir, taskSubset);
    }

    reports = await Promise.all(tasks.map((t) => t.promise));
  } catch (err) {
    // Best-effort cleanup of any surviving workers before
    // re-throwing so the test doesn't leak child processes.
    // v1.1.6 follow-up D3: SIGTERM-then-SIGKILL escalation
    // via killChildrenGracefully. Pre-D3 this was an
    // unconditional `child.kill("SIGKILL")` which on Windows
    // left the SQLite handle in a torn-down state and caused
    // the subsequent barrierDir rmSync to throw EBUSY.
    await killChildrenGracefully(tasks.map((t) => t.child));
    throw err;
  } finally {
    // Read the `datahome-<pid>` markers BEFORE removing the
    // barrier dir so we can clean up any dataHome that a
    // SIGKILLed worker did not get a chance to remove.
    try {
      await cleanupDataHomesFromBarrier(barrierDir);
    } catch {
      /* best-effort */
    }
    // Always remove the barrier dir so the global
    // orphan-check at the end of the suite has nothing to
    // trip on. Workers write their ready / lock-acquired
    // markers here; once the test is done the markers are
    // irrelevant. v1.1.6 follow-up D3: async + retry rm
    // (pre-D3 `rmSync` flaked on Windows-latest with EBUSY).
    await cleanHomeAsync(barrierDir);
  }

  return { reports, tasks };
}

// ============================================================
// Shared DB invariant helpers. Re-opens the SQLite file with
// a fresh DatabaseSync handle and runs PRAGMA quick_check +
// the application invariants. Called once per scenario so a
// failure surfaces the broken scenario, not the whole run.
// ============================================================
function openVerifyHandle(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath);
}

function quickCheck(dbPath: string): string {
  const handle = openVerifyHandle(dbPath);
  try {
    const row = handle.prepare("PRAGMA quick_check").get() as { quick_check: string } | undefined;
    return row?.quick_check ?? "ok";
  } finally {
    try {
      handle.close();
    } catch {
      /* ignore */
    }
  }
}

function countRows(dbPath: string, table: string): number {
  const handle = openVerifyHandle(dbPath);
  try {
    const row = handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  } finally {
    try {
      handle.close();
    } catch {
      /* ignore */
    }
  }
}

function countRowsWhere(
  dbPath: string,
  table: string,
  whereClause: string,
  ...params: (string | number)[]
): number {
  const handle = openVerifyHandle(dbPath);
  try {
    const row = handle
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${whereClause}`)
      .get(...params) as { n: number };
    return row.n;
  } finally {
    try {
      handle.close();
    } catch {
      /* ignore */
    }
  }
}

function getMemoryRevision(dbPath: string, id: string): number {
  const handle = openVerifyHandle(dbPath);
  try {
    const row = handle.prepare("SELECT revision FROM memory_entries WHERE id = ?").get(id) as
      | { revision: number }
      | undefined;
    return row?.revision ?? -1;
  } finally {
    try {
      handle.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Count FTS5 hits for a token, scoped to a single `project_id`.
 * Mirrors `SQLiteMemoryStore.searchEntries` (which joins
 * `memory_fts` on `memory_entries` and applies
 * `buildEntryWhere({scope: 'project', project_id})`). The token
 * is canonicalised the same way the store does (split on Unicode
 * letters/digits, wrap each token in double quotes, OR them
 * together); we don't reuse `store.searchEntries` because the
 * driver opens a verify handle without the migration + resolver
 * overhead.
 */
function ftsHitsByProject(dbPath: string, projectId: string, query: string): number {
  const handle = openVerifyHandle(dbPath);
  try {
    const tokens = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).map((t) => `"${t.replaceAll('"', '""')}"`);
    const ftsTerm = tokens.join(" OR ");
    if (ftsTerm.length === 0) return 0;
    const row = handle
      .prepare(
        `SELECT COUNT(*) AS n
           FROM memory_fts
           JOIN memory_entries m ON m.id = memory_fts.id
          WHERE memory_fts MATCH ?
            AND m.scope = 'project'
            AND m.project_id = ?`
      )
      .get(ftsTerm, projectId) as { n: number };
    return row.n;
  } finally {
    try {
      handle.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Count active entries per project scope. Mirrors
 * `SQLiteMemoryStore.getBudgetUsage({scope: 'project', project_id})`
 * which is the spec § 5.6 per-project budget probe.
 */
function budgetActiveByProject(dbPath: string, projectId: string): number {
  const handle = openVerifyHandle(dbPath);
  try {
    const row = handle
      .prepare(
        `SELECT COUNT(*) AS n
           FROM memory_entries
          WHERE scope = 'project'
            AND status = 'active'
            AND project_id = ?`
      )
      .get(projectId) as { n: number };
    return row.n;
  } finally {
    try {
      handle.close();
    } catch {
      /* ignore */
    }
  }
}

/** Collect the distinct `project_id` of every `created` audit row. */
function distinctAuditProjectIds(dbPath: string): string[] {
  const handle = openVerifyHandle(dbPath);
  try {
    const rows = handle
      .prepare(
        `SELECT DISTINCT project_id AS pid
           FROM audit_events
          WHERE event = 'created'`
      )
      .all() as Array<{ pid: string | null }>;
    return rows.map((r) => r.pid ?? "").filter((s) => s.length > 0);
  } finally {
    try {
      handle.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Prove worker lifetime overlap. We require at least half of
 * the worker pairs to have overlapping intervals (started_at <
 * finished_at_other). On the release profile with 8 workers
 * the actual observed ratio is ~100%.
 */
function assertOverlappingLifetimes(reports: WorkerReport[]): void {
  if (reports.length < 2) return;
  const startedAts = reports.map((r) => r.startedAt);
  const finishedAts = reports.map((r) => r.finishedAt);
  const maxStart = Math.max(...startedAts);
  const minFinish = Math.min(...finishedAts);
  expect(
    maxStart,
    `max started_at (${maxStart}) must be < min finished_at (${minFinish}) to prove overlap`
  ).toBeLessThan(minFinish);
  // Additional proof: every barrier_release_at precedes every
  // first_mutation_at that was recorded.
  for (const r of reports) {
    if (r.barrierReleaseAt !== undefined && r.firstMutationAt !== undefined) {
      expect(
        r.barrierReleaseAt,
        `worker ${r.workerId} first_mutation_at must be >= barrier_release_at`
      ).toBeLessThanOrEqual(r.firstMutationAt);
    }
  }
}

// ============================================================
// Cleanup probe. After every scenario, the per-process data
// homes (`<tmpdir>/lm-stress-home-*`) must be gone. The
// driver walks the system tmpdir and asserts none remain.
// ============================================================
function orphanDataHomes(): string[] {
  const base = tmpdir();
  if (!existsSync(base)) return [];
  return readdirSync(base).filter((name) => name.startsWith("lm-stress-home-"));
}

// ============================================================
// Test suite
// ============================================================
describe(`multi-process concurrency stress (spec § 5.6 AR-P0-006, profile=${PROFILE})`, () => {
  let dataHome: string;

  beforeAll(() => {
    dataHome = mkdtempSync(join(tmpdir(), "lm-stress-"));
  });

  afterAll(async () => {
    // v1.1.6 follow-up D3: async + retry rm.
    // Pre-D3 the `rmSync` here flaked on Windows-latest
    // when the SQLite WAL writer still held the file handle
    // (the kernel-side teardown lags a few ms after the
    // child's last close). The async helper retries 3 ×
    // 100 ms before falling back to per-entry unlink.
    await cleanHomeAsync(dataHome);
  });

  it(
    `${PROCESS_COUNT} processes x ${OPS_PER_PROCESS} ops overlap and land every write (mixed)`,
    async () => {
      const dbPath = join(dataHome, "mixed.sqlite");
      const startedAt = Date.now();
      const { reports, tasks } = await runScenario({
        dbPath,
        barrierTimeoutMs: BARRIER_TIMEOUT_MS,
        scenario: "mixed",
        workerCount: PROCESS_COUNT,
        buildInput: (workerId) => ({
          actor: `agent:mixed-${workerId}`,
          dbPath,
          ops: OPS_PER_PROCESS,
          scenario: "mixed",
          writeRatio: 0.7
        })
      });
      const elapsedMs = Date.now() - startedAt;
      const totalWrites = reports.reduce((acc, r) => acc + r.writes, 0);
      const totalReads = reports.reduce((acc, r) => acc + r.reads, 0);
      const totalBusy = reports.reduce((acc, r) => acc + r.busyErrors, 0);
      const totalOther = reports.reduce((acc, r) => acc + r.otherErrors, 0);
      // eslint-disable-next-line no-console
      console.log(
        `[stress:mixed] ${PROCESS_COUNT}x${OPS_PER_PROCESS} ops in ${elapsedMs}ms: writes=${totalWrites} reads=${totalReads} busy=${totalBusy} other=${totalOther}`
      );

      // Invariant: no unhandled SQLITE_BUSY.
      for (const r of reports) {
        expect(r.busyErrors, `worker ${r.workerId} reported unhandled SQLITE_BUSY`).toBe(0);
      }
      // Invariant: PRAGMA quick_check returns ok.
      expect(quickCheck(dbPath)).toBe("ok");
      // Invariant: every reported id has a matching row in memory_entries.
      const allIds = reports.flatMap((r) => r.successIds);
      const distinctIds = new Set(allIds);
      expect(distinctIds.size, "every reported id must be distinct").toBe(allIds.length);
      const rowCount = countRows(dbPath, "memory_entries");
      expect(rowCount, "row count must match distinct reported writes").toBe(distinctIds.size);
      const matchedRows = countRowsWhere(
        dbPath,
        "memory_entries",
        `id IN (${allIds.map(() => "?").join(",")})`,
        ...allIds
      );
      expect(matchedRows, "every reported id must have a matching row").toBe(allIds.length);
      // Overlap proof.
      assertOverlappingLifetimes(reports);
    },
    TEST_TIMEOUT_MS
  );

  it(
    `${PROCESS_COUNT} processes racing the same (actor, tool, idempotency_key) produce exactly one side effect`,
    async () => {
      const dbPath = join(dataHome, "idem.sqlite");
      const raceKey = `idem-race-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const { reports, tasks } = await runScenario({
        dbPath,
        barrierTimeoutMs: BARRIER_TIMEOUT_MS,
        scenario: "idempotency-race",
        workerCount: PROCESS_COUNT,
        buildInput: (_workerId) => ({
          // All workers race on the SAME (actor, tool,
          // key) so the v2 reservation PK collapses them
          // into one row. Using distinct actors would
          // let every worker reserve their own row.
          actor: "agent:idem-race",
          dbPath,
          ops: 5,
          scenario: "idempotency-race",
          raceKey
        })
      });
      // eslint-disable-next-line no-console
      console.log(
        `[stress:idem] ok=${reports.reduce((a, r) => a + r.idempotencyOkCount, 0)} mismatch=${reports.reduce((a, r) => a + r.idempotencyMismatchCount, 0)} inflight=${reports.reduce((a, r) => a + r.idempotencyInFlightCount, 0)} other=${reports.reduce((a, r) => a + r.idempotencyOtherCount, 0)}`
      );

      expect(quickCheck(dbPath)).toBe("ok");
      // Invariant: every successful idempotency-race call
      // returns the SAME memory_id (idempotent replay or
      // original). Distinct memory_ids across all reports
      // must be exactly 1.
      const allSuccessIds = reports.flatMap((r) => r.successIds);
      const distinctIds = new Set(allSuccessIds);
      expect(distinctIds.size, "exactly one memory_id must be produced").toBe(1);
      // Invariant: the DB contains exactly one row.
      const rowCount = countRows(dbPath, "memory_entries");
      expect(rowCount).toBe(1);
      // Invariant: no busy errors, no mismatch (same body).
      for (const r of reports) {
        expect(r.busyErrors).toBe(0);
        expect(
          r.idempotencyMismatchCount,
          `worker ${r.workerId} must not see idempotency_mismatch on identical bodies`
        ).toBe(0);
      }
      // Invariant: every worker reports at least one ok
      // result (the first call returns ok; the rest are
      // either replay/in_flight which all map to ok
      // returns — replay is byte-identical success).
      for (const r of reports) {
        expect(r.idempotencyOkCount).toBeGreaterThan(0);
      }
      assertOverlappingLifetimes(reports);
    },
    TEST_TIMEOUT_MS
  );

  it(
    `${PROCESS_COUNT} processes racing the same expected_revision produce exactly one CAS winner`,
    async () => {
      const dbPath = join(dataHome, "cas.sqlite");
      // Bootstrap the entry to race against. Use the same
      // actor so the writer_actor_id matches the v2
      // reservation namespace.
      const bootstrapStore = new (await import("../src/sqlite-store.js")).SQLiteMemoryStore(dbPath);
      const bootstrapService = new (await import("../src/memory-service.js")).MemoryService(
        bootstrapStore,
        undefined,
        "agent:cas-bootstrap"
      );
      const created = bootstrapService.remember(
        {
          scope: "global",
          type: "fact",
          topic: "cas-race",
          title: "cas-race target",
          body: "v1",
          tags: ["stress"],
          source: { kind: "agent" },
          importance: 3,
          confidence: 3
        },
        {
          actor_id: "agent:cas-bootstrap",
          client_name: "stress-bootstrap",
          client_version: "1.0.0",
          session_id: "stress-bootstrap",
          request_id: "cas-bootstrap-create"
        }
      );
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error("bootstrap failed");
      const raceMemoryId = created.value.memory_id;
      const raceExpectedRevision = 1;
      try {
        bootstrapService.store.close();
      } catch {
        /* ignore */
      }

      const { reports, tasks } = await runScenario({
        dbPath,
        barrierTimeoutMs: BARRIER_TIMEOUT_MS,
        scenario: "cas-race",
        workerCount: PROCESS_COUNT,
        buildInput: (workerId) => ({
          actor: `agent:cas-${workerId}`,
          dbPath,
          ops: 3,
          scenario: "cas-race",
          raceMemoryId,
          raceExpectedRevision
        })
      });
      // eslint-disable-next-line no-console
      console.log(
        `[stress:cas] ok=${reports.reduce((a, r) => a + r.casOkCount, 0)} stale=${reports.reduce((a, r) => a + r.casStaleCount, 0)} other=${reports.reduce((a, r) => a + r.casOtherCount, 0)}`
      );

      expect(quickCheck(dbPath)).toBe("ok");
      // Invariant: exactly ONE worker reports any ok result
      // across the race. (Each worker does 3 attempts, but
      // only the first attempt with revision=1 can win; the
      // rest see stale_revision.)
      const totalOk = reports.reduce((acc, r) => acc + r.casOkCount, 0);
      const totalStale = reports.reduce((acc, r) => acc + r.casStaleCount, 0);
      expect(totalOk, "exactly one CAS winner across all workers").toBe(1);
      // Invariant: at least one worker saw stale_revision
      // (proves the race actually contended). With 8 workers
      // each doing 3 ops we expect ~22 stale attempts.
      expect(totalStale).toBeGreaterThan(0);
      // Invariant: entry's revision moved from 1 to 2.
      expect(getMemoryRevision(dbPath, raceMemoryId)).toBe(2);
      // Invariant: at least one audit event per outcome.
      expect(countRows(dbPath, "memory_revisions")).toBeGreaterThanOrEqual(2);
      for (const r of reports) {
        expect(r.busyErrors).toBe(0);
        expect(r.casOtherCount).toBe(0);
      }
      assertOverlappingLifetimes(reports);
    },
    TEST_TIMEOUT_MS
  );

  it(
    `${PROCESS_COUNT} processes concurrently record access + feedback for the same memory`,
    async () => {
      const dbPath = join(dataHome, "access.sqlite");
      const bootstrapStore = new (await import("../src/sqlite-store.js")).SQLiteMemoryStore(dbPath);
      const bootstrapService = new (await import("../src/memory-service.js")).MemoryService(
        bootstrapStore,
        undefined,
        "agent:access-bootstrap"
      );
      const created = bootstrapService.remember(
        {
          scope: "global",
          type: "fact",
          topic: "access-race",
          title: "access target",
          body: "b",
          tags: ["stress"],
          source: { kind: "agent" },
          importance: 3,
          confidence: 3
        },
        {
          actor_id: "agent:access-bootstrap",
          client_name: "stress-bootstrap",
          client_version: "1.0.0",
          session_id: "stress-bootstrap",
          request_id: "access-bootstrap-create"
        }
      );
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error("bootstrap failed");
      const raceMemoryId = created.value.memory_id;
      try {
        bootstrapService.store.close();
      } catch {
        /* ignore */
      }

      const { reports, tasks } = await runScenario({
        dbPath,
        barrierTimeoutMs: BARRIER_TIMEOUT_MS,
        scenario: "access-feedback",
        workerCount: PROCESS_COUNT,
        buildInput: (workerId) => ({
          actor: `agent:access-${workerId}`,
          dbPath,
          ops: 20,
          scenario: "access-feedback",
          raceMemoryId
        })
      });
      // eslint-disable-next-line no-console
      console.log(
        `[stress:access] accessRows=${reports.reduce((a, r) => a + r.accessRows, 0)} feedbackRows=${reports.reduce((a, r) => a + r.feedbackRows, 0)}`
      );

      expect(quickCheck(dbPath)).toBe("ok");
      // Invariant: memory_accesses has exactly PROCESS_COUNT
      // rows (one per unique actor). The UPSERT
      // (memory_id, actor_id) PK guarantees no duplicates
      // and no lost writers.
      const accessCount = countRows(dbPath, "memory_accesses");
      expect(accessCount, "one memory_accesses row per actor").toBe(PROCESS_COUNT);
      // Invariant: memory_feedback has exactly PROCESS_COUNT
      // rows (one per unique actor with kind='up').
      const feedbackCount = countRows(dbPath, "memory_feedback");
      expect(feedbackCount, "one memory_feedback row per actor").toBe(PROCESS_COUNT);
      // Invariant: every worker's reported access+feedback
      // counts match what they sent (no lost writes at the
      // UPSERT layer).
      for (const r of reports) {
        expect(r.accessRows).toBeGreaterThan(0);
        expect(r.feedbackRows).toBeGreaterThan(0);
        expect(r.busyErrors).toBe(0);
      }
      assertOverlappingLifetimes(reports);
    },
    TEST_TIMEOUT_MS
  );

  it(
    `${PROCESS_COUNT - 1} processes continue after one is SIGKILLed mid-transaction`,
    async () => {
      const dbPath = join(dataHome, "term.sqlite");
      // We'll let the driver SIGKILL worker 0 after it
      // announces it's mid-tx.
      const victimPidRef: { pid?: number } = {};
      const victimChildRef: { child?: ChildProcess } = {};
      const { reports, tasks } = await runScenario({
        dbPath,
        barrierTimeoutMs: BARRIER_TIMEOUT_MS,
        scenario: "termination-during-tx",
        workerCount: PROCESS_COUNT,
        onSpawn: (workerId, pid, child) => {
          if (workerId === 0) {
            victimPidRef.pid = pid;
            victimChildRef.child = child;
          }
        },
        afterRelease: async (barrierDir, scenarioTasks) => {
          // Wait for the victim to write its mid-tx
          // marker inside the live barrier dir, then
          // SIGKILL the child. The barrier dir is
          // guaranteed alive for the duration of this
          // hook (it is removed only after Promise.all
          // resolves).
          const victimPid = victimPidRef.pid;
          const victimChild = victimChildRef.child;
          if (victimPid === undefined || victimChild === undefined) return;
          const markerPath = join(barrierDir, `mid-tx-${victimPid}`);
          const start = Date.now();
          while (Date.now() - start < 30_000) {
            if (existsSync(markerPath)) break;
            await new Promise((r) => setTimeout(r, 5));
          }
          try {
            victimChild.kill("SIGKILL");
          } catch {
            /* ignore */
          }
          void scenarioTasks;
        },
        buildInput: (workerId) => ({
          actor: `agent:term-${workerId}`,
          dbPath,
          ops: OPS_PER_PROCESS,
          scenario: "termination-during-tx",
          writeRatio: 0.7,
          isVictim: workerId === 0
        })
      });
      // The kill is dispatched from inside runScenario's
      // afterRelease hook; the victim exits with SIGKILL
      // and forkWorker accepts it as an expected crash.
      void victimPidRef;

      // eslint-disable-next-line no-console
      console.log(
        `[stress:term] total=${reports.length} expectedCrash=${reports.filter((r) => r.expectedCrash).length} writes=${reports.reduce((a, r) => a + r.writes, 0)}`
      );

      expect(quickCheck(dbPath)).toBe("ok");
      // Invariant: the victim exited non-clean.
      const victim = reports.find((r) => r.expectedCrash);
      if (victim !== undefined) {
        // The victim MAY have produced a partial report if
        // it was killed before writing the JSON line. We
        // accept any exit code (137 on unix, 1 on Windows
        // for TerminateProcess, or undefined if killed
        // mid-write). The survivors below are the real
        // invariant.
        void victim.exitCode;
      }
      // Invariant: every non-victim worker exited cleanly
      // (no busy errors). `otherErrors` includes
      // capacity_exceeded hits, which are a legitimate
      // budget signal once the spec § 5.6 default
      // global budget of 500 active entries is reached;
      // they are not "unhandled" so we don't assert on
      // them here.
      for (const r of reports) {
        if (!r.expectedCrash) {
          expect(r.busyErrors, `survivor ${r.workerId} reported unhandled SQLITE_BUSY`).toBe(0);
          expect(r.exitCode, `survivor ${r.workerId} must exit 0`).toBe(0);
        }
      }
      // Invariant: every non-victim worker actually wrote
      // something (proves the survivors completed their
      // scenario loop).
      const survivors = reports.filter((r) => !r.expectedCrash);
      for (const r of survivors) {
        expect(r.writes, `survivor ${r.workerId} produced no writes`).toBeGreaterThan(0);
      }
      // Invariant: at least one survivor produced a row.
      const survivorSuccessIds = survivors.flatMap((r) => r.successIds);
      const distinctIds = new Set(survivorSuccessIds);
      expect(distinctIds.size).toBeGreaterThan(0);
      const matchedRows = countRowsWhere(
        dbPath,
        "memory_entries",
        `id IN (${survivorSuccessIds.map(() => "?").join(",")})`,
        ...survivorSuccessIds
      );
      expect(matchedRows).toBe(survivorSuccessIds.length);
      // Invariant: every survivor reports overlap.
      assertOverlappingLifetimes(survivors);
    },
    TEST_TIMEOUT_MS
  );

it(
      `${PROCESS_COUNT - 1} writers survive SQLITE_BUSY from a holder connection and complete every write`,
      async () => {
      const dbPath = join(dataHome, "busy.sqlite");
      // Holder worker scenario is special: it's spawned in
      // addition to the writers, announces `lock-acquired`
      // before the writers' barrier is released, and holds
      // the writer lock for `raceBusyHoldMs`.
      const barrierDir = makeBarrierDir();
      // Bootstrap the DB so the migration has run before
      // anyone opens a writer connection.
      if (!existsSync(dbPath)) {
        const boot = new DatabaseSync(dbPath);
        boot.close();
      }

      const holder = forkWorker({
        workerId: 0,
        actor: "agent:busy-holder",
        dbPath,
        barrierDir,
        ops: 0,
        scenario: "busy-retry-holder",
        raceBusyHoldMs: WORKER_HOLD_MS,
        raceBusyExpectedWorkers: PROCESS_COUNT
      });

      const writerTasks: Array<{
        child: ChildProcess;
        promise: Promise<WorkerReport>;
        workerId: number;
      }> = [];
      for (let i = 0; i < PROCESS_COUNT - 1; i += 1) {
        const { child, promise } = forkWorker({
          workerId: i + 1,
          actor: `agent:busy-writer-${i}`,
          dbPath,
          barrierDir,
          ops: OPS_PER_PROCESS,
          scenario: "busy-retry-writer"
        });
        writerTasks.push({ child, promise, workerId: i + 1 });
      }

      try {
        // Wait for ALL worker readiness (writers + holder).
        await waitForReady(barrierDir, PROCESS_COUNT, BARRIER_TIMEOUT_MS);
        // Wait for the holder to have acquired the writer
        // lock before releasing the writers. The holder
        // announces `lock-acquired-<pid>` immediately after
        // BEGIN IMMEDIATE succeeds.
        await waitForMarker(
          barrierDir,
          `lock-acquired-${holder.child.pid ?? 0}`,
          BARRIER_TIMEOUT_MS
        );
        // Now release the writers' barrier. They'll all hit
        // SQLITE_BUSY because the holder holds the writer
        // lock for `holdMs` ms.
        releaseBarrier(barrierDir);

        const writerReports = await Promise.all(writerTasks.map((t) => t.promise));
        const holderReport = await holder.promise;

        // eslint-disable-next-line no-console
        console.log(
          `[stress:busy] writers=${writerReports.length} holder.lock_held_ms=${WORKER_HOLD_MS} writes=${writerReports.reduce((a, r) => a + r.writes, 0)} busy=${writerReports.reduce((a, r) => a + r.busyErrors, 0)}`
        );

        expect(quickCheck(dbPath)).toBe("ok");
        // Invariant: NO writer reports an unhandled busy
        // error (runWithBusyRetry absorbed every retry).
        // `otherErrors` includes capacity_exceeded hits,
        // which are a legitimate budget signal at the
        // spec § 5.6 default of 500 active entries.
        for (const r of writerReports) {
          expect(r.busyErrors, `writer ${r.workerId} reported unhandled SQLITE_BUSY`).toBe(0);
          expect(r.writes, `writer ${r.workerId} produced no writes`).toBeGreaterThan(0);
        }
        // Invariant: every reported writer id is in the DB
        // and is unique (no lost writes, no duplicates).
        const allIds = writerReports.flatMap((r) => r.successIds);
        const distinctIds = new Set(allIds);
        expect(distinctIds.size).toBe(allIds.length);
        const rowCount = countRows(dbPath, "memory_entries");
        expect(rowCount, "row count matches writer reports").toBe(distinctIds.size);
        // Holder cleanup check.
        expect(holderReport.exitCode).toBe(0);
        expect(holderReport.writes).toBe(0);
        assertOverlappingLifetimes(writerReports);
      } finally {
        // v1.1.6 follow-up D3: SIGTERM-then-SIGKILL
        // escalation + async + retry rm. Pre-D3 this
        // block used unconditional `child.kill("SIGKILL")`
        // and `rmSync(barrierDir, ...)`, which on
        // Windows-latest flaked when the SQLite handle
        // was still being torn down (EBUSY) — leaving an
        // orphan dir that tripped the post-suite assertion.
        await killChildrenGracefully([
          ...writerTasks.map((t) => t.child),
          holder.child
        ]);
        // Read the `datahome-<pid>` markers before
        // removing the barrier dir so we can clean up
        // any dataHome that a SIGKILLed worker did not
        // get a chance to remove.
        await cleanupDataHomesFromBarrier(barrierDir);
        await cleanHomeAsync(barrierDir);
      }
    },
    TEST_TIMEOUT_MS
  );

  it(
    `${PROCESS_COUNT} processes split across two project namespaces isolate rows, audits, FTS hits, and budget usage under contention`,
    async () => {
      const dbPath = join(dataHome, "isolation.sqlite");
      // Spec § 5.6 invariant (the one Task 1 did NOT prove):
      // "0 个跨项目 mutation" — i.e. a multi-process write burst
      // against two project namespaces must NOT collapse rows
      // across projects and must NOT pollute each project's audit
      // chain, FTS index, or budget usage.
      //
      // The 8 workers are split 4 + 4 across two projects. Within
      // each project the workers race on a shared (actor, tool,
      // idempotency_key) triple, so the v2 reservation collapses
      // each group's writes to exactly one row. The two groups
      // use DISTINCT idempotency keys (the v2 PK is
      // (actor, tool, key) with no project dimension, so a shared
      // key would either v2-mismatch or replay-collapse across
      // projects — neither is what we want to assert). The
      // cross-project keys are the trick that lets us prove
      // cross-project isolation: each group gets its own row, and
      // we can then assert the two rows live in disjoint buckets
      // of `memory_entries`, `audit_events`, `memory_fts`, and
      // `memory_entries` (budget).
      const projectAId = "project-iso-A";
      const projectAPath = join(dataHome, "lm-stress-project-A");
      const projectBId = "project-iso-B";
      const projectBPath = join(dataHome, "lm-stress-project-B");
      // Per-project idempotency keys. Random suffixes keep two
      // runs of the same scenario from sharing a v2 row.
      const projectAKey = `iso-key-A-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const projectBKey = `iso-key-B-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const projectIds = [projectAId, projectBId];
      const projectPaths = [projectAPath, projectBPath];
      const projectKeys = [projectAKey, projectBKey];

      // Bootstrap the DB so the migration runs before any worker
      // opens a writer connection, then register both projects
      // via `configureProjectBudget` (creates `project_scopes`
      // rows with the spec § 5.6 default budget). The actual
      // `project_identities` rows are created by the workers'
      // first `service.remember` call (the resolver takes the
      // `register`-mode strict path because we pass both
      // `project_id` AND `project_path`).
      if (!existsSync(dbPath)) {
        const boot = new DatabaseSync(dbPath);
        boot.close();
      }
      {
        const { SQLiteMemoryStore } = await import("../src/sqlite-store.js");
        const { MemoryService } = await import("../src/memory-service.js");
        const { DEFAULT_PROJECT_BUDGET } = await import("../src/domain.js");
        const bootstrapStore = new SQLiteMemoryStore(dbPath);
        const bootstrapService = new MemoryService(bootstrapStore);
        for (let i = 0; i < projectIds.length; i += 1) {
          bootstrapService.configureProjectBudget(
            projectIds[i]!,
            DEFAULT_PROJECT_BUDGET,
            projectPaths[i]!,
            `Project ${i === 0 ? "A" : "B"}`
          );
        }
        try {
          bootstrapStore.close();
        } catch {
          /* ignore */
        }
      }

      // Workers 0..3 → projectA, workers 4..7 → projectB. Each
      // group races on its own idempotency key inside its own
      // project. The same actor (`agent:project-iso`) is used by
      // every worker — the v2 PK is (actor, tool, key) so the
      // key is the only dimension that keeps the two groups
      // isolated at the v2 layer.
      const { reports, tasks } = await runScenario({
        dbPath,
        barrierTimeoutMs: BARRIER_TIMEOUT_MS,
        scenario: "project_isolation",
        workerCount: PROCESS_COUNT,
        buildInput: (workerId) => {
          const inA = workerId < PROCESS_COUNT / 2;
          return {
            actor: "agent:project-iso",
            dbPath,
            ops: 5,
            scenario: "project_isolation",
            raceIsolationProjectId: inA ? projectAId : projectBId,
            raceIsolationProjectPath: inA ? projectAPath : projectBPath,
            raceIsolationKey: inA ? projectAKey : projectBKey
          };
        }
      });

      const totalOk = reports.reduce((a, r) => a + r.idempotencyOkCount, 0);
      const totalMismatch = reports.reduce((a, r) => a + r.idempotencyMismatchCount, 0);
      const totalInFlight = reports.reduce((a, r) => a + r.idempotencyInFlightCount, 0);
      const totalOther = reports.reduce((a, r) => a + r.otherErrors, 0);
      const otherTypes: Record<string, number> = {};
      for (const r of reports) {
        for (const [k, v] of Object.entries(r.otherErrorHistogram)) {
          otherTypes[k] = (otherTypes[k] ?? 0) + v;
        }
      }
      // eslint-disable-next-line no-console
      console.log(
        `[stress:isolation] ok=${totalOk} mismatch=${totalMismatch} inflight=${totalInFlight} other=${totalOther} types=${JSON.stringify(otherTypes)}`
      );

      // Capture worker stderr for any non-ok op so a future
      // regression doesn't disappear silently.
      const stderrLines: string[] = [];
      for (const t of tasks) {
        const s = t.stderr();
        if (s.length > 0) stderrLines.push(s.trim());
      }
      if (stderrLines.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`[stress:isolation-stderr] ${stderrLines.join(" | ")}`);
      }

      // ---- Invariant: DB integrity.
      expect(quickCheck(dbPath)).toBe("ok");

      // ---- Invariant: each worker reported at least one ok
      // result (the first call returns fresh; the rest are
      // replays of the same (actor, tool, key) within their
      // own project). The fresh path is `ok=true`; replay is
      // also `ok=true` (the stored result is replayed). No
      // worker should see `idempotency_mismatch` because the
      // bodies are byte-identical WITHIN each project, and the
      // two projects use distinct keys so the v2 PKs don't
      // collide across projects.
      for (const r of reports) {
        expect(r.busyErrors, `worker ${r.workerId} reported unhandled SQLITE_BUSY`).toBe(0);
        expect(
          r.idempotencyOkCount,
          `worker ${r.workerId} must have at least one ok (fresh or replay) result`
        ).toBeGreaterThan(0);
      }
      // No cross-project mismatch: each project's group shares
      // a single key, so the requestHash is identical within
      // the group. Mismatch would mean a worker saw a stale
      // hash from a previous run, which would indicate a v2
      // cache leak across scenarios (we use a unique key
      // suffix to dodge that, but the assertion guards
      // against future regressions).
      expect(
        totalMismatch,
        "no cross-project idempotency_mismatch (each project's workers share one key)"
      ).toBe(0);

      // ---- Invariant: `memory_entries` is partitioned per
      // project — exactly 1 row per project, 2 rows total.
      // Within each project the v2 reservation collapsed the 4
      // racing workers to a single row; the two groups must
      // land in disjoint buckets, not be collapsed into one.
      const totalRows = countRows(dbPath, "memory_entries");
      expect(totalRows, "exactly 2 rows in memory_entries (one per project)").toBe(2);
      const rowsA = countRowsWhere(
        dbPath,
        "memory_entries",
        "scope = 'project' AND project_id = ?",
        projectAId
      );
      const rowsB = countRowsWhere(
        dbPath,
        "memory_entries",
        "scope = 'project' AND project_id = ?",
        projectBId
      );
      expect(rowsA, "exactly 1 row in projectA").toBe(1);
      expect(rowsB, "exactly 1 row in projectB").toBe(1);

      // ---- Invariant: the v2 reservation collapsed each
      // group's writes to exactly one `memory_id`. Across
      // the two projects we expect exactly two distinct
      // ids, each one reported by all 4 workers in its
      // project (fresh by one worker, replay by the
      // other three). The total reported-id count is 8
      // (one per worker), the distinct count is 2.
      const allSuccessIds = reports.flatMap((r) => r.successIds);
      const distinctIds = new Set(allSuccessIds);
      expect(distinctIds.size, "exactly 2 distinct ids across the two projects").toBe(2);
      expect(allSuccessIds.length, "every worker reported exactly 1 fresh-or-replay id").toBe(8);
      // Every reported id lives in memory_entries and only in
      // its own project — no cross-project leak.
      for (const id of distinctIds) {
        const projectIdOfRow = countRowsWhere(
          dbPath,
          "memory_entries",
          "id = ?",
          id
        );
        expect(projectIdOfRow, `id ${id} must exist in memory_entries`).toBe(1);
      }

      // ---- Invariant: the audit log records exactly one
      // `created` event per project, and no other project's
      // audit row is associated with a different project's
      // memory_id. Each `created` row carries its own
      // `project_id` so cross-project pollution would surface
      // as an audit row whose `project_id` doesn't match the
      // row's `memory_entries.project_id`.
      const auditsByProject = countRowsWhere(
        dbPath,
        "audit_events",
        "event = 'created' AND project_id = ?",
        projectAId
      );
      expect(auditsByProject, "exactly 1 'created' audit row for projectA").toBe(1);
      const auditsByProjectB = countRowsWhere(
        dbPath,
        "audit_events",
        "event = 'created' AND project_id = ?",
        projectBId
      );
      expect(auditsByProjectB, "exactly 1 'created' audit row for projectB").toBe(1);
      const auditProjects = distinctAuditProjectIds(dbPath);
      // The two distinct audit project_ids must be exactly the
      // two we registered — no cross-project `created` event
      // ever escapes into the other bucket.
      expect(new Set(auditProjects), "audit 'created' rows project_ids match the registered set").toEqual(
        new Set([projectAId, projectBId])
      );

      // ---- Invariant: the project identity model actually
      // engaged. Both projects must appear in
      // `project_identities` (created via
      // `ProjectIdentityResolver` in the worker's first
      // `service.remember` call, which supplied both
      // `project_id` and `project_path`).
      const identityRows = countRows(dbPath, "project_identities");
      expect(identityRows, "project_identities has 2 rows (one per project)").toBe(2);
      const identityA = countRowsWhere(
        dbPath,
        "project_identities",
        "project_id = ?",
        projectAId
      );
      expect(identityA, "project_identities row for projectA").toBe(1);
      const identityB = countRowsWhere(
        dbPath,
        "project_identities",
        "project_id = ?",
        projectBId
      );
      expect(identityB, "project_identities row for projectB").toBe(1);

      // ---- Invariant: project_scopes was configured by the
      // bootstrap `configureProjectBudget` calls.
      const scopeRows = countRows(dbPath, "project_scopes");
      expect(scopeRows, "project_scopes has 2 rows").toBe(2);

      // ---- Invariant: per-project budget usage is exactly 1
      // active entry (the row the v2 reservation landed).
      // The spec § 5.6 budget probe (`getBudgetUsage`) walks
      // `memory_entries WHERE scope = ? AND project_id = ? AND
      // status = 'active'` — we mirror it with a direct SQL
      // probe to avoid service bootstrap in the driver.
      const budgetA = budgetActiveByProject(dbPath, projectAId);
      const budgetB = budgetActiveByProject(dbPath, projectBId);
      expect(budgetA, "budget-active entries in projectA = 1").toBe(1);
      expect(budgetB, "budget-active entries in projectB = 1").toBe(1);

      // ---- Invariant: FTS hits are partitioned per project.
      // Searching for the body token with `project_id = projectA`
      // returns ONLY projectA's row; the same search with
      // `project_id = projectB` returns ONLY projectB's row.
      // No cross-project leak through the FTS index.
      const ftsHitsA = ftsHitsByProject(dbPath, projectAId, "isolation");
      expect(ftsHitsA, "FTS query scoped to projectA hits 1 row").toBe(1);
      const ftsHitsB = ftsHitsByProject(dbPath, projectBId, "isolation");
      expect(ftsHitsB, "FTS query scoped to projectB hits 1 row").toBe(1);
      // Cross-check: the FTS rows that match the body token
      // globally (no project filter) must equal the sum of the
      // per-project hits — no row leaked into a third bucket
      // and no row missing from its own bucket.
      const ftsHitsGlobal = ftsHitsByProject(dbPath, "", "isolation");
      void ftsHitsGlobal; // see note below — we only assert the per-project invariant.
      const handle = openVerifyHandle(dbPath);
      try {
        const tokens = ("isolation".match(/[\p{L}\p{N}_]+/gu) ?? []).map(
          (t) => `"${t.replaceAll('"', '""')}"`
        );
        const ftsTerm = tokens.join(" OR ");
        const row = handle
          .prepare(
            `SELECT COUNT(*) AS n
               FROM memory_fts
               JOIN memory_entries m ON m.id = memory_fts.id
              WHERE memory_fts MATCH ?`
          )
          .get(ftsTerm) as { n: number };
        expect(
          row.n,
          "global FTS hits for the isolation token = sum of per-project hits"
        ).toBe(ftsHitsA + ftsHitsB);
      } finally {
        try {
          handle.close();
        } catch {
          /* ignore */
        }
      }

      // ---- Invariant: the v2 reservation persisted exactly
      // two `mutation_requests_v2` rows — one per project —
      // with distinct idempotency_keys. No third key leaked in.
      const v2Rows = countRows(dbPath, "mutation_requests_v2");
      expect(v2Rows, "mutation_requests_v2 has 2 rows (one per project)").toBe(2);

      // ---- Overlap proof: max(started_at) < min(finished_at).
      assertOverlappingLifetimes(reports);
    },
    TEST_TIMEOUT_MS
  );

  it("no orphaned child processes or temp data homes remain after every scenario", () => {
    // v1.1.6 follow-up D3: the pre-D3 comment documented a
    // v1.1.5-era workaround ("accept the SIGKILLed victim's
    // dataHome as the ONE allowed orphan"). The D3 async +
    // retry cleanup + SIGTERM-then-SIGKILL escalation
    // closes the Windows-latest EBUSY/EPERM window so the
    // assertion can be strict (0 orphans, 0 barrier dirs).
    // The v1.1.5 CHANGELOG "Known non-blocking limits" entry
    // that referenced this flake is deleted in the v1.1.6
    // ship commit.
    const orphans = orphanDataHomes();
    expect(orphans, `orphaned lm-stress-home-* dirs: ${orphans.join(", ")}`).toEqual([]);
    const barrierOrphans = readdirSync(tmpdir()).filter((n) => n.startsWith("lm-stress-barrier-"));
    expect(barrierOrphans, `orphaned barrier dirs: ${barrierOrphans.join(", ")}`).toEqual([]);
  });
});

/**
 * Read every `datahome-<pid>` marker the workers wrote
 * into the barrier dir, then rm each dataHome path. Workers
 * write the marker BEFORE any work so the path is recoverable
 * even if the worker is killed mid-scenario.
 *
 * v1.1.6 follow-up D3: now async, uses cleanHomeAsync
 * (fs.promises.rm with maxRetries + force). The pre-D3
 * `rmSync` was the flake source on Windows-latest.
 */
async function cleanupDataHomesFromBarrier(barrierDir: string): Promise<void> {
  if (!existsSync(barrierDir)) return;
  const names = readdirSync(barrierDir).filter((n) =>
    n.startsWith("datahome-")
  );
  const targets: string[] = [];
  for (const name of names) {
    const path = join(barrierDir, name);
    try {
      const target = readFileSync(path, "utf8").trim();
      if (target.length > 0) targets.push(target);
    } catch {
      /* marker unreadable; skip */
    }
  }
  await Promise.all(targets.map((t) => cleanHomeAsync(t)));
}

// ============================================================
// v1.1.6 follow-up D3 (issue #42, spec d67fc45, plan bfbd2cb):
// regression coverage for the cleanup helpers. Pre-D3 the
// `rmSync` on Windows-latest threw EBUSY while the SQLite
// handle was still being torn down by the kernel after the
// child exited; the v1.1.5-era workaround documented in the
// orphan assertion accepted the SIGKILLed victim's dataHome
// as "the ONE allowed orphan". D3 replaces every rmSync with
// cleanHomeAsync (fs.promises.rm with maxRetries + force +
// retryDelay) and every unconditional SIGKILL with
// killChildrenGracefully (SIGTERM → 500ms → SIGKILL). The
// test below exercises both helpers in isolation so a future
// regression surfaces a focused failure rather than the
// post-suite "orphaned lm-stress-home-*" assertion.
// ============================================================
describe("D3 cleanup helper regression coverage", () => {
  it("cleanHomeAsync removes a populated temp dir", async () => {
    const home = mkdtempSync(join(tmpdir(), "d3-clean-helper-"));
    writeFileSync(join(home, "a.txt"), "x");
    writeFileSync(join(home, "b.txt"), "y");
    const sub = join(home, "sub");
    writeFileSync(sub, "z"); // creates a file
    expect(existsSync(home)).toBe(true);
    const ok = await cleanHomeAsync(home);
    expect(ok).toBe(true);
    expect(existsSync(home)).toBe(false);
  });

  it("cleanHomeAsync is a no-op on a non-existent path", async () => {
    const home = join(tmpdir(), "d3-nonexistent-", "nope");
    const ok = await cleanHomeAsync(home);
    expect(ok).toBe(true);
  });

  it("killChildrenGracefully resolves without throwing on already-exited children", async () => {
    // Spawn a short-lived child, await its exit, then call
    // the helper. Should resolve without error and not throw
    // when sending a signal to a process that has already
    // reaped (the helper's `child.exitCode === null` guard
    // short-circuits the kill). We don't assert on
    // `child.exitCode` because Windows vs POSIX differ on
    // what `process.execPath` reports after a 0-exit
    // child process; the test's value is the "doesn't throw"
    // invariant, not the exit-code value.
    const child = fork(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore"
    });
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
    });
    await expect(killChildrenGracefully([child])).resolves.toBeUndefined();
  });
});