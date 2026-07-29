// vitest.migrations.config.ts
//
// v1.1.3 GATE-06 (issue #36): per-suite vitest config
// for the migration / backup / import subset. The
// default config hosts the unit / integration layer;
// this config hosts ONLY the migration + backup +
// import tests so a failure here does not block the
// unit layer.
//
// Worker pool: `forks` with `singleFork: true` so the
// migration chain runs serially (the schema-version
// rebuild table path under `test/sqlite-store-migration*`
// must NOT race across workers).
//
// `setupFiles: []` — the v1.1.2 heartbeat-filter
// proxy (`test/setup/heartbeat-filter.ts`) is
// REMOVED in #36; this config never installs it.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "test/sqlite-store-migration.test.ts",
      "test/sqlite-store-migration-v3.test.ts",
      "test/backup.test.ts",
      "test/cli/backup.test.ts",
      "test/release-gate/p0-migration.test.ts",
      "test/release-gate/p0-migration-backup.test.ts",
      "test/release-gate/p0-backup.test.ts",
      "test/release-gate/p0-cleanup.test.ts",
      "test/release-gate/p1-atomic-import.test.ts",
      "test/release-gate/p3-strict-import.test.ts",
      "test/release-gate/p3-full-history-import.test.ts",
      "test/release-gate/p3-import-preflight-budget.test.ts",
      "test/release-gate/p3-import-batch-lineage.test.ts",
      "test/cli/import-preflight.test.ts",
      "test/portability-import.test.ts"
    ],
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true
      }
    },
    setupFiles: [],
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});