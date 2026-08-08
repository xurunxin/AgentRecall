// vitest.blackbox.config.ts
//
// v1.1.3 GATE-06 (issue #36): per-suite vitest config
// for the MCP black-box subset. The default config
// (`vitest.config.ts`) hosts the unit / integration
// layer; this config hosts ONLY the MCP black-box
// tests so a failure here does not block the unit
// layer.
//
// Worker pool: `forks` with `singleFork: true` so the
// MCP stdio server runs serially (the MCP tests
// fork the server via `child_process.spawn` and
// parallelism would create contested stdio pipes).
//
// `setupFiles: []` — the v1.1.2 heartbeat-filter
// proxy (`test/setup/heartbeat-filter.ts`) is
// REMOVED in #36; this config never installs it.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "test/blackbox/mcp-client-e2e.test.ts",
      "test/blackbox/mcp-client-e2e-extended.test.ts",
      "test/blackbox/mcp-all-tools-e2e-core.test.ts",
      "test/blackbox/mcp-all-tools-e2e-extended.test.ts",
      "test/blackbox/mcp-shutdown.test.ts",
      "test/blackbox/mcp-stdio-idle.test.ts",
      "test/release-gate/admin-default/mcp-admin-default.test.ts",
      "test/release-gate/profile-default/mcp-profile-default.test.ts"
    ],
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true
      }
    },
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});