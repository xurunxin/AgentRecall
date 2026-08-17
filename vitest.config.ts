import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.mjs"],
    // v1.1.3 GATE-06 (issue #36): the heavyweight
    // suites are segregated into per-suite configs +
    // runner scripts. The default config hosts the
    // unit / integration layer only; the heavy
    // suites (multi-process stress, packaged-artifact
    // lifecycle) live under
    // `vitest.{stress,packaged-artifact}.config.ts`
    // and are invoked via `npm run test:<suite>`.
    //
    // The packaged lifecycle is an artifact-consumer
    // suite, not a source-checkout suite. It fails
    // closed when the extracted artifact env is absent
    // and is invoked explicitly by release workflows
    // after extraction.
    exclude: [
      "test/blackbox/packaged-install.test.ts",
      "test/blackbox/mcp-shutdown.test.ts",
      // v1.1.6 follow-up D1: mcp-stdio-idle.test.ts
      // is re-included. The v1.1.5 cap-bounded wait
      // (2.5 s `setTimeout` + SIGKILL path) flaked
      // on the release-candidate orchestrator when
      // 5 vitest suites ran in parallel; the test
      // is rewritten to wait for the
      // `[lifecycle] idle-sentinel` line on stderr
      // (emitted by `server-lifecycle.ts`
      // `onShutdownComplete` hook just before
      // `exitFn(0)` in the idle-shutdown path).
      // The backstop timeout is now 5 s and the
      // sentinel drives the assertion.
      "test/multi-process-stress.test.ts",
      "test/release-gate/**",
      // v1.1.5 (launcher release): the Bun
      // single-file-binary smoke skips when
      // `dist-bin/agent-recall-<plat>` is
      // absent (the host runner that runs the
      // default unit / integration layer
      // does not have the Bun build artefact).
      // The release-candidate workflow
      // exercises it on a per-matrix leg
      // that builds the artefact first.
      // Excluding it here keeps the default
      // `npm test` green and unsuppressed
      // (release-evidence.mjs is fail-closed
      // on `skipped !== 0`).
      "test/smoke/bun-binary.test.ts",
      ...(process.env.AGENT_RECALL_EXTRACTED_ARTIFACT !== undefined
        ? []
        : [])
    ],
    // Stage 1 migration tests rebuild tables and exercise the full DDL
    // path. With parallel workers this can stretch past the 5s default
    // timeout. 30s is generous for any single test in this project.
    testTimeout: 30_000,
    // Worker startup under heavy parallel load (CLI + doctor + migration
    // tests opening many SQLite files) can exceed the default 10s hook
    // timeout on slower Windows runners.
    hookTimeout: 30_000,
    // v1.1.3 GATE-06 (issue #36): the v1.1.2
    // heartbeat-filter proxy
    // (`test/setup/heartbeat-filter.ts`) is REMOVED.
    // The new `vitest.setup.ts` (added in commit 3)
    // registers an `unhandledRejection` handler that
    // logs the rejection AND throws in release mode
    // (`AGENT_RECALL_RELEASE_MODE=1`).
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"]
    }
  }
});
