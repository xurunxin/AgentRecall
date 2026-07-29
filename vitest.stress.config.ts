// vitest.stress.config.ts
//
// v1.1.3 GATE-06 (issue #36): per-suite vitest config
// for the multi-process 10,000-op stress test. The
// default config hosts the unit / integration layer;
// this config hosts ONLY `test/multi-process-stress.test.ts`
// so the 10k-op cost is paid EXACTLY ONCE per release
// job (the orchestrator pins the counter via `JOB_ID`).
//
// Worker pool: `threads` with `maxThreads: 8`. The
// stress test forks its own 8 child processes via
// `node:child_process.fork()`; the parent thread
// only needs to host the driver, so 1 worker thread
// is sufficient and `maxThreads: 8` allows the
// driver to keep all 8 workers alive without
// fighting for the parent's event loop.
//
// `testTimeout: 300_000` (5 minutes) — the 10k-op
// stress on slower Windows runners can take > 2
// minutes; 5 minutes is generous.
//
// `setupFiles: []` — the v1.1.2 heartbeat-filter
// proxy is REMOVED in #36; this config never
// installs it.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/multi-process-stress.test.ts"],
    pool: "threads",
    poolOptions: {
      threads: {
        maxThreads: 8,
        singleThread: false
      }
    },
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000
  }
});