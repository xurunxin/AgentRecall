// vitest.packaged-artifact.config.ts
//
// v1.1.3 GATE-06 (issue #36): per-suite vitest config
// for the extracted-artifact lifecycle tests. The
// default config excludes these (the lifecycle E2E
// requires `AGENT_RECALL_EXTRACTED_ARTIFACT` env and
// a real extracted archive on disk); this config
// hosts ONLY the lifecycle subset so the suite is
// isolated from the unit / integration layer.
//
// Worker pool: `forks` with `singleFork: true` so
// the lifecycle E2E runs serially (it touches the
// extracted artifact's `dist/` + the runtime
// install under `node_modules/`; parallelism would
// race on the on-disk install).
//
// `setupFiles: []` — the v1.1.2 heartbeat-filter
// proxy is REMOVED in #36; this config never
// installs it.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "test/blackbox/packaged-install.test.ts",
      "test/release-gate/p3-extracted-artifact-lifecycle.test.ts"
    ],
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true
      }
    },
    setupFiles: [],
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
});