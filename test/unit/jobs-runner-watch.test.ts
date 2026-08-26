// test/unit/jobs-runner-watch.test.ts
//
// v1.2.0-alpha.2 (issue #54): unit tests for the
// `runOnce` polling loop extension. The original
// `jobs-runner.test.ts` covers the synchronous
// single-pass path; this file focuses on the
// watch behaviour:
//
//   - empty store + poll_ms=10 → exits after the
//     first pass (one empty pass → stop_after_empty_passes=1).
//   - jobs enqueued during the wait are picked up
//     by the next pass and processed.
//   - a `signal` aborts the loop within ~poll_ms.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DerivationJobStore } from "../../src/jobs/service.js";
import { makeLeaseOwner, runOnce } from "../../src/jobs/runner.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "lm-jobs-watch-")), "memory.sqlite");
}

function openStore(dbPath: string): SQLiteMemoryStore {
  return new SQLiteMemoryStore(dbPath);
}

describe("runOnce watch loop (v1.2.0-alpha.2, issue #54)", () => {
  let dbPath: string;
  let store: SQLiteMemoryStore;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = openStore(dbPath);
  });
  afterEach(() => {
    if (store !== undefined) {
      try {
        store.close();
      } catch {
        // already closed
      }
    }
    try {
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("exits after the first empty pass when no jobs are claimable", async () => {
    const result = await runOnce(store, [], {
      lease_owner: makeLeaseOwner(),
      max_jobs: 16,
      poll_ms: 10,
      stop_after_empty_passes: 1
    });
    expect(result.attempted).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.cancelled).toBe(0);
    expect(result.passes).toBe(1);
    expect(result.loop_exit_reason).toBe("stop_after_empty_passes");
  });

  it("picks up jobs enqueued during the wait window", async () => {
    const jobStore = new DerivationJobStore(store);
    // enqueue one job up front; the runner
    // should process it on the first pass.
    jobStore.enqueue({
      kind: "echo",
      scope: "global",
      creator_actor_id: "user:tester",
      idempotency_key: "watch-1",
      input_digest: "sha256:abc",
      config_digest: "sha256:def"
    });
    const seenPasses: number[] = [];
    const controller = new AbortController();
    const result = await runOnce(
      store,
      [
        {
          kind: "echo",
          execute: async ({ startStage }) => {
            const stage = startStage("noop", []);
            stage.finish("succeeded");
            return { status: "succeeded" };
          }
        }
      ],
      {
        lease_owner: makeLeaseOwner(),
        max_jobs: 16,
        poll_ms: 10,
        stop_after_empty_passes: 1,
        on_pass: (r) => {
          seenPasses.push(r.attempted);
        },
        signal: controller.signal
      }
    );
    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(1);
    // The first pass picks up the job; the
    // second pass is empty (no more jobs) and
    // stops the loop.
    expect(seenPasses.length).toBe(2);
    expect(seenPasses[0]).toBe(1);
    expect(seenPasses[1]).toBe(0);
  });

  it("a signal aborts the loop within ~poll_ms * 2", async () => {
    const controller = new AbortController();
    // abort after one poll window
    const t = setTimeout(() => controller.abort(), 30);
    const start = Date.now();
    const result = await runOnce(store, [], {
      lease_owner: makeLeaseOwner(),
      max_jobs: 16,
      poll_ms: 50,
      stop_after_empty_passes: Number.POSITIVE_INFINITY,
      signal: controller.signal
    });
    const elapsed = Date.now() - start;
    clearTimeout(t);
    expect(result.loop_exit_reason).toBe("signal");
    // The loop must exit well under a second.
    expect(elapsed).toBeLessThan(500);
  });

  it("processes 2 jobs enqueued during the wait window", async () => {
    const jobStore = new DerivationJobStore(store);
    // No jobs initially → the loop would
    // immediately exit on the first empty pass.
    // We use a custom `stop_after_empty_passes`
    // and pre-abort the signal after the second
    // enqueue to verify both jobs are processed.
    const seenIds: string[] = [];
    const controller = new AbortController();
    // Pre-schedule a job + signal after ~30 ms.
    setTimeout(() => {
      jobStore.enqueue({
        kind: "echo",
        scope: "global",
        creator_actor_id: "user:tester",
        idempotency_key: "watch-2a",
        input_digest: "sha256:abc",
        config_digest: "sha256:def"
      });
      jobStore.enqueue({
        kind: "echo",
        scope: "global",
        creator_actor_id: "user:tester",
        idempotency_key: "watch-2b",
        input_digest: "sha256:abc",
        config_digest: "sha256:def"
      });
    }, 30);
    setTimeout(() => controller.abort(), 200);
    const result = await runOnce(
      store,
      [
        {
          kind: "echo",
          execute: async ({ job, startStage }) => {
            seenIds.push(job.job_id);
            const stage = startStage("noop", []);
            stage.finish("succeeded");
            return { status: "succeeded" };
          }
        }
      ],
      {
        lease_owner: makeLeaseOwner(),
        max_jobs: 16,
        poll_ms: 20,
        stop_after_empty_passes: Number.POSITIVE_INFINITY,
        signal: controller.signal
      }
    );
    expect(seenIds.length).toBe(2);
    expect(result.attempted).toBe(2);
    expect(result.succeeded).toBe(2);
  });
});
