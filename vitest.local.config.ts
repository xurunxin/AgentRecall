import { defineConfig } from "vitest/config";

// v1.1.6 follow-up A1 (Task 1): a local-only
// vitest config that does NOT exclude the
// `test/release-gate/**` directory. The default
// `vitest.config.ts` excludes it (the per-suite
// jobs in the release-candidate workflow run
// release-gate tests via specific scripts, not
// the default config). Use this config to
// validate the verifier end-to-end on a
// developer machine: `npx vitest run --config
// vitest.local.config.ts <test-file>`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: [
      "test/blackbox/packaged-install.test.ts",
      "test/blackbox/mcp-shutdown.test.ts",
      "test/blackbox/mcp-stdio-idle.test.ts",
      "test/multi-process-stress.test.ts",
      "test/smoke/bun-binary.test.ts"
    ],
    setupFiles: ["./vitest.setup.ts"]
  }
});
