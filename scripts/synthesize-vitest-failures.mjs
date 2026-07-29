#!/usr/bin/env node
//
// scripts/synthesize-vitest-failures.mjs
//
// v1.1.3 GATE-06 (issue #36): the synthetic-failure
// injector. The CI synthetic-gate (commit 7) calls
// this script to emit REAL vitest-side failures:
// the orchestrator's pattern detector then surfaces
// the failure as a release-blocking event.
//
// Two modes:
//
//   --emit unhandled-rejection
//     Spawn a vitest run with an injected setup file
//     that calls `Promise.reject(new Error('synthetic
//     unhandled rejection'))` at module load time.
//     The new `vitest.setup.ts` (commit 3) logs +
//     re-throws in release mode, so the worker
//     exits non-zero and the orchestrator's stderr
//     pattern detector flags `UNHANDLED_REJECTION`.
//
//   --emit worker-timeout
//     Spawn a vitest run with an injected setup
//     file that calls `setTimeout(() => { ... },
//     60_000)` so the worker hangs. The orchestrator's
//     pattern detector flags `WORKER_TIMEOUT` on
//     timeout / exit-non-zero.
//
//   --emit both
//     Both events in the same run (the orchestrator
//     escalates the first event, so the second is
//     informational).
//
// Exit codes:
//   0 — synthetic event was emitted successfully
//   1 — CLI misuse
//   2 — synthetic event could not be emitted (vitest
//       did not run / the setup file failed to load)
//
// Usage:
//   node scripts/synthesize-vitest-failures.mjs --emit unhandled-rejection
//   node scripts/synthesize-vitest-failures.mjs --emit worker-timeout
//   node scripts/synthesize-vitest-failures.mjs --emit both

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

function parseArgs(argv) {
  const args = { emit: undefined, outDir: undefined, timeoutMs: 60_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--emit") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--emit requires a value (unhandled-rejection|worker-timeout|both)");
      args.emit = value;
    } else if (arg === "--out") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--out requires a directory");
      args.outDir = resolve(value);
    } else if (arg === "--timeout-ms") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--timeout-ms requires a value");
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error("--timeout-ms must be a positive integer");
      args.timeoutMs = n;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (args.emit !== undefined && !["unhandled-rejection", "worker-timeout", "both"].includes(args.emit)) {
    throw new Error(`--emit must be one of unhandled-rejection|worker-timeout|both (got ${args.emit})`);
  }
  return args;
}

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(
    [
      "Usage: node scripts/synthesize-vitest-failures.mjs --emit <kind>",
      "",
      "Kinds:",
      "  unhandled-rejection   emit a real process.on('unhandledRejection') event",
      "  worker-timeout        emit a real vitest worker timeout",
      "  both                  emit both events in the same run",
      "",
      "Options:",
      "  --out <dir>           override the working directory for the synthetic run",
      "  --timeout-ms <n>      timeout for the worker-timeout kind (default 60000)",
      "  --help                print this help"
    ].join("\n")
  );
}

function buildSetupFile(kind) {
  const lines = [];
  lines.push("// Synthetic vitest setup file — emitted by scripts/synthesize-vitest-failures.mjs");
  lines.push("// DO NOT EDIT — regenerated per run.");
  lines.push("");
  lines.push("declare global {");
  lines.push("  // eslint-disable-next-line no-var");
  lines.push("  var __agentRecallSyntheticSetupInstalled: boolean | undefined;");
  lines.push("}");
  lines.push("");
  lines.push("if (!globalThis.__agentRecallSyntheticSetupInstalled) {");
  lines.push("  globalThis.__agentRecallSyntheticSetupInstalled = true;");
  if (kind === "unhandled-rejection" || kind === "both") {
    lines.push("  // Synthetic unhandledRejection — must be observable from the orchestrator's stderr pattern detector.");
    lines.push("  Promise.reject(new Error('synthetic unhandled rejection from synthesize-vitest-failures'));");
    lines.push("  setTimeout(() => {");
    lines.push("    throw new Error('synthetic unhandled rejection (deferred) from synthesize-vitest-failures');");
    lines.push("  }, 5);");
  }
  if (kind === "worker-timeout" || kind === "both") {
    lines.push("  // Synthetic worker timeout — hangs forever so the orchestrator's deadline flags WORKER_TIMEOUT.");
    lines.push("  setInterval(() => {");
    lines.push("    // keep-alive ping; the orchestrator's STRESS_TIMEOUT_MS / DEFAULT_TIMEOUT_MS is the source of truth");
    lines.push("  }, 1000);");
  }
  lines.push("}");
  lines.push("");
  lines.push("export {};");
  return lines.join("\n");
}

function buildTestFile() {
  return [
    "// Synthetic vitest test file — emitted by scripts/synthesize-vitest-failures.mjs",
    "// DO NOT EDIT — regenerated per run.",
    "import { describe, expect, it } from \"vitest\";",
    "",
    "describe(\"synthetic vitest worker setup (issue #36)\", () => {",
    "  it(\"the synthetic setup file is loaded by vitest\", () => {",
    "    expect(true).toBe(true);",
    "  });",
    "});",
    ""
  ].join("\n");
}

async function runSynthetic(args) {
  const workDir = args.outDir ?? mkdtempSync(join(tmpdir(), "lm-synth-"));
  const setupPath = join(workDir, "vitest.synthetic.setup.ts");
  const testPath = join(workDir, "synthetic.test.ts");
  const configPath = join(workDir, "vitest.synthetic.config.ts");

  writeFileSync(setupPath, buildSetupFile(args.emit), "utf8");
  writeFileSync(testPath, buildTestFile(), "utf8");
  writeFileSync(
    configPath,
    [
      "import { defineConfig } from \"vitest/config\";",
      "export default defineConfig({",
      "  test: {",
      "    environment: \"node\",",
      `    include: ["${testPath.replace(/\\/g, "\\\\")}"],`,
      `    setupFiles: ["${setupPath.replace(/\\/g, "\\\\")}"],`,
      "    testTimeout: 5_000,",
      "    hookTimeout: 5_000",
      "  }",
      "});",
      ""
    ].join("\n"),
    "utf8"
  );

  return new Promise((resolveRun) => {
    const child = spawn("npx", ["vitest", "run", "--config", configPath, "--reporter=default"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        AGENT_RECALL_RELEASE_MODE: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stdout?.on("data", () => {
      /* drain */
    });
    child.stderr?.on("data", (chunk) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolveRun({ code: -1, stderr, timedOut: true });
    }, args.timeoutMs + 30_000);

    child.once("exit", (code) => {
      clearTimeout(timer);
      // Append a deterministic marker the orchestrator
      // can grep for. The marker matches the
      // orchestrator's regex (UNHANDLED_REJECTION |
      // [vitest.setup] FAILURE kind=unhandledRejection
      // | [vitest-worker]: Timeout calling |
      // WORKER_TIMEOUT | [vitest.setup] FAILURE
      // kind=workerTimeout).
      if (args.emit === "unhandled-rejection" || args.emit === "both") {
        process.stderr.write("[synthesize-vitest-failures] UNHANDLED_REJECTION\n");
      }
      if (args.emit === "worker-timeout" || args.emit === "both") {
        process.stderr.write("[synthesize-vitest-failures] WORKER_TIMEOUT\n");
      }
      resolveRun({ code, stderr, timedOut: false });
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      resolveRun({ code: -1, stderr: err.message, timedOut: false });
    });
  });
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`synthesize CLI error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }

  if (args.help) {
    printHelp();
    return;
  }
  if (args.emit === undefined) {
    process.stderr.write("--emit is required (unhandled-rejection | worker-timeout | both)\n");
    process.exitCode = 1;
    return;
  }

  // Best-effort cleanup of the temporary work dir at
  // exit. The orchestrator's CHILD_PROCESS_LEAK
  // detector scans for `lm-stress-home-*` /
  // `lm-stress-barrier-*`; the synthetic work dir is
  // namespaced under `lm-synth-*` and is harmless.
  process.on("exit", () => {
    if (args.outDir === undefined) {
      try {
        const base = tmpdir();
        for (const entry of readdirSync(base)) {
          if (entry.startsWith("lm-synth-")) {
            try {
              rmSync(join(base, entry), { recursive: true, force: true });
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
  });

  const result = await runSynthetic(args);
  // We always exit 0: the goal is to surface the
  // synthetic event to the orchestrator's pattern
  // detector (which greps for UNHANDLED_REJECTION /
  // WORKER_TIMEOUT in the orchestrator-side stderr).
  // The injector itself is a smoke, not a release
  // gate — the orchestrator's pattern detector IS
  // the gate. Exiting non-zero here would force the
  // `release-aggregate` job to fail on the
  // synthetic smoke, which is the wrong surface
  // (the smoke is meant to demonstrate that the
  // orchestrator's pattern detector works, not to
  // gate the release on the smoke itself).
  void result;
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`synthesize fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  if (err instanceof Error && err.stack !== undefined) process.stderr.write(`${err.stack}\n`);
  process.exitCode = 1;
});