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
    coverage: {
      provider: "v8",
      reporter: ["text", "html"]
    }
  }
});
