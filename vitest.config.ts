import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Stage 1 migration tests rebuild tables and exercise the full DDL
    // path. With parallel workers this can stretch past the 5s default
    // timeout. 30s is generous for any single test in this project.
    testTimeout: 30_000,
    // Worker startup under heavy parallel load (CLI + doctor + migration
    // tests opening many SQLite files) can exceed the default 10s hook
    // timeout on slower Windows runners.
    hookTimeout: 30_000,
    // Task 0 of the V1 Final Release Plan (`feat/v1-final-release`,
    // issue #19): install a worker-side wrapper around
    // `globalThis.__vitest_worker__.rpc` that swallows the known vitest
    // `birpc onTaskUpdate` heartbeat noise (60_000 ms RPC timeout)
    // without weakening any test assertion or skipping any test. See
    // `test/setup/heartbeat-filter.ts` for the background and rationale.
    setupFiles: ["./test/setup/heartbeat-filter.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"]
    }
  }
});
