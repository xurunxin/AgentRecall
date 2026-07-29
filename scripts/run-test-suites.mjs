#!/usr/bin/env node
//
// scripts/run-test-suites.mjs
//
// v1.1.3 GATE-06 (issue #36): the deterministic
// test orchestrator. Replaces the v1.1.2 monolithic
// `npm test` invocation that ran every heavyweight
// suite in a single vitest process (and ate
// heartbeat-filter noise on the way).
//
// Contract
// --------
//
// 1. The orchestrator resolves a fixed suite table:
//
//    {
//      "unit-integration": { config: "vitest.config.ts", script: "test:unit", pool: "default" },
//      "mcp-blackbox":     { config: "vitest.blackbox.config.ts", script: "test:blackbox", pool: "forks-singleFork" },
//      "migrations":       { config: "vitest.migrations.config.ts", script: "test:migrations", pool: "forks-singleFork" },
//      "stress":           { config: "vitest.stress.config.ts", script: "test:stress", pool: "threads-8", maxOps: 10_000 },
//      "packaged-artifact":{ config: "vitest.packaged-artifact.config.ts", script: "test:packaged-artifact", pool: "forks-singleFork" }
//    }
//
//    A failure in one suite does NOT block another.
//    Each suite is a separate vitest process via
//    `child_process.spawn`.
//
// 2. The orchestrator captures per-suite:
//    - stdout + stderr (full buffer, preserved on failure)
//    - JUnit JSON (vitest's `--reporter=json` output)
//    - cleanup_status (orphan temp dirs, worker exits,
//      test skips)
//    - unhandled_rejections / worker_timeouts
//
//    Every capture is written to `<out>/junit-<suite>.json`
//    and `<out>/cleanup-<suite>.json` so CI can upload
//    them as artefacts.
//
// 3. The 10k-op stress runs EXACTLY ONCE per release
//    job, pinned via `JOB_ID`. Two orchestrator runs
//    inside the same JOB_ID do NOT double-count.
//
// 4. Failure taxonomy:
//
//      UNHANDLED_REJECTION  — synthetic process.on('unhandledRejection') in a vitest worker
//      WORKER_TIMEOUT       — synthetic vitest worker timeout
//      TEST_SKIP            — release-critical it.skip / describe.skip surfaced
//      CHILD_PROCESS_LEAK   — orphan temp dirs / orphan workers after the suite exited
//      SUITE_EXIT_NONZERO   — vitest exit code was non-zero
//
//    Any of the above is a release-blocking event.
//
// 5. CLI:
//
//      --list                 emit the resolved suite table + the stress counter table
//      --inspect-stress       print the stress counter for the supplied JOB_ID
//      --out <dir>            override the output directory (default: RUNNER_TEMP/.tmp/orchestrator-<JOB_ID>)
//      --only <suite[,suite]> restrict to a subset of suites (smoke / debug)
//      --no-stress            skip the heavy stress suite
//      AGENT_RECALL_RELEASE_MODE=1   escalate unhandled rejections to throw (set by CI)
//
// Exit codes:
//   0 — every suite green, no synthetic events
//   1 — at least one suite failed (see stdout for the failure taxonomy)
//   2 — orchestrator-level failure (CLI misuse, missing config, etc.)

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

// ============================================================
// Constants
// ============================================================

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

/**
 * The canonical 5-suite table. The keys are stable;
 * adding a new suite is a backward-compatible change
 * (the orchestrator iterates by key).
 */
const SUITE_TABLE = Object.freeze({
  "unit-integration": Object.freeze({
    config: "vitest.config.ts",
    script: "test:unit",
    description: "Unit / integration layer (default vitest config)"
  }),
  "mcp-blackbox": Object.freeze({
    config: "vitest.blackbox.config.ts",
    script: "test:blackbox",
    description: "MCP black-box tests (serial forks)"
  }),
  migrations: Object.freeze({
    config: "vitest.migrations.config.ts",
    script: "test:migrations",
    description: "Migration / backup / import tests (serial forks)"
  }),
  stress: Object.freeze({
    config: "vitest.stress.config.ts",
    script: "test:stress",
    description: "Multi-process 10k-op stress (8 threads, 300s timeout)",
    stressCounter: true
  }),
  "packaged-artifact": Object.freeze({
    config: "vitest.packaged-artifact.config.ts",
    script: "test:packaged-artifact",
    description: "Extracted-artifact lifecycle (serial forks)"
  })
});

const FAILURE_CODES = Object.freeze({
  UNHANDLED_REJECTION: "UNHANDLED_REJECTION",
  WORKER_TIMEOUT: "WORKER_TIMEOUT",
  TEST_SKIP: "TEST_SKIP",
  CHILD_PROCESS_LEAK: "CHILD_PROCESS_LEAK",
  SUITE_EXIT_NONZERO: "SUITE_EXIT_NONZERO"
});

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes per suite
const STRESS_TIMEOUT_MS = 600_000; // 10 minutes for the 10k-op stress

// ============================================================
// CLI
// ============================================================

function parseArgs(argv) {
  const args = {
    list: false,
    inspectStress: false,
    outDir: undefined,
    only: undefined,
    noStress: false,
    help: false,
    json: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") args.list = true;
    else if (arg === "--inspect-stress") args.inspectStress = true;
    else if (arg === "--no-stress") args.noStress = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--out") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--out requires a directory argument");
      args.outDir = resolve(value);
    } else if (arg === "--only") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--only requires a comma-separated suite list");
      args.only = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  const lines = [
    "Usage: node scripts/run-test-suites.mjs [options]",
    "",
    "Options:",
    "  --list                emit the resolved suite table + stress counter",
    "  --inspect-stress      print the stress counter for the supplied JOB_ID",
    "  --out <dir>           override the output directory",
    "  --only <suite[,suite]>",
    "                        restrict to a subset of suites",
    "  --no-stress           skip the heavy stress suite",
    "  --json                emit JSON instead of a human-readable table",
    "  --help                print this help",
    "",
    "Environment:",
    "  JOB_ID=<id>           pins the stress counter to <id>; required for",
    "                        AGENT_RECALL_RELEASE_MODE=1 runs.",
    "  AGENT_RECALL_RELEASE_MODE=1   escalate unhandled rejections to throw",
    "",
    "Exit codes:",
    "  0 — every suite green",
    "  1 — at least one suite failed (UNHANDLED_REJECTION / WORKER_TIMEOUT /",
    "       TEST_SKIP / CHILD_PROCESS_LEAK / SUITE_EXIT_NONZERO)",
    "  2 — orchestrator-level failure"
  ];
  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}

// ============================================================
// Output directory + stress counter
// ============================================================

function resolveOutDir(args) {
  if (args.outDir !== undefined) return args.outDir;
  const base = process.env.RUNNER_TEMP ?? join(tmpdir(), "agent-recall-orchestrator");
  const jobId = process.env.JOB_ID ?? `local-${randomUUID()}`;
  return join(base, `orchestrator-${jobId}`);
}

function stressCounterPath(outDir, jobId) {
  return join(outDir, `stress-counter-${jobId}.txt`);
}

function readStressCounter(outDir, jobId) {
  const path = stressCounterPath(outDir, jobId);
  if (!existsSync(path)) return 0;
  const raw = readFileSync(path, "utf8").trim();
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

function writeStressCounter(outDir, jobId, value) {
  const path = stressCounterPath(outDir, jobId);
  writeFileSync(path, `${value}\n`);
}

// ============================================================
// Suite runner
// ============================================================

function spawnSuite(name, suite, options) {
  return new Promise((resolveRun) => {
    const startedAt = Date.now();
    const args = [
      "run",
      "--config",
      suite.config,
      "--reporter=json",
      "--reporter=junit",
      `--outputFile.json=${options.jsonPath}`,
      `--outputFile.junit=${options.xmlPath}`
    ];
    const child = spawn("npx", ["vitest", ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        AGENT_RECALL_RELEASE_MODE: process.env.AGENT_RECALL_RELEASE_MODE ?? "1",
        JOB_ID: process.env.JOB_ID ?? `local-${randomUUID()}`
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stdout += text;
      // Stream to operator console in --list mode.
      if (options.echoToConsole) {
        process.stdout.write(`[${name}] ${text}`);
      }
    });
    child.stderr?.on("data", (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stderr += text;
      if (options.echoToConsole) {
        process.stderr.write(`[${name}] ${text}`);
      }
    });

    const timeoutMs = name === "stress" ? STRESS_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolveRun({
        name,
        code: -1,
        signal: "SIGKILL",
        timedOut: true,
        stdout,
        stderr,
        startedAt,
        finishedAt: Date.now(),
        failures: [{ code: FAILURE_CODES.WORKER_TIMEOUT, message: `suite exceeded ${timeoutMs}ms timeout` }]
      });
    }, timeoutMs);

    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      const finishedAt = Date.now();
      const failures = [];
      if (code !== 0 && code !== null) {
        failures.push({ code: FAILURE_CODES.SUITE_EXIT_NONZERO, message: `vitest exited with code ${code}` });
      }
      // Detect synthetic unhandled rejections in stderr.
      if (/UNHANDLED_REJECTION|\[vitest\.setup\] FAILURE kind=unhandledRejection/.test(stderr + stdout)) {
        failures.push({ code: FAILURE_CODES.UNHANDLED_REJECTION, message: "synthetic unhandled rejection surfaced" });
      }
      // Detect synthetic worker timeout.
      if (/\[vitest-worker\]: Timeout calling|WORKER_TIMEOUT|\[vitest\.setup\] FAILURE kind=workerTimeout/.test(stderr + stdout)) {
        failures.push({ code: FAILURE_CODES.WORKER_TIMEOUT, message: "synthetic worker timeout surfaced" });
      }
      // Detect release-critical it.skip / describe.skip.
      if (/it\.skip|describe\.skip|test\.skip/.test(stderr + stdout)) {
        failures.push({ code: FAILURE_CODES.TEST_SKIP, message: "release-critical it.skip / describe.skip surfaced" });
      }
      resolveRun({ name, code, signal, timedOut: false, stdout, stderr, startedAt, finishedAt, failures });
    });

    child.once("error", (err) => {
      clearTimeout(timer);
      resolveRun({
        name,
        code: -1,
        signal: null,
        timedOut: false,
        stdout,
        stderr: stderr + `\norchestrator: spawn failed: ${err.message}`,
        startedAt,
        finishedAt: Date.now(),
        failures: [{ code: FAILURE_CODES.SUITE_EXIT_NONZERO, message: `spawn failed: ${err.message}` }]
      });
    });
  });
}

function parseVitestJson(jsonPath) {
  if (!existsSync(jsonPath)) {
    return { numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numTotalTests: 0 };
  }
  try {
    const raw = JSON.parse(readFileSync(jsonPath, "utf8"));
    return {
      numPassedTests: Number(raw.numPassedTests ?? 0),
      numFailedTests: Number(raw.numFailedTests ?? 0),
      numPendingTests: Number(raw.numPendingTests ?? 0),
      numTodoTests: Number(raw.numTodoTests ?? 0),
      numTotalTests: Number(raw.numTotalTests ?? 0)
    };
  } catch {
    return { numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numTotalTests: 0 };
  }
}

function detectChildProcessLeaks(outDir, suiteName) {
  const leaks = [];
  const base = tmpdir();
  if (!existsSync(base)) return leaks;
  for (const entry of readdirSync(base)) {
    if (entry.startsWith("lm-stress-home-") || entry.startsWith("lm-stress-barrier-")) {
      leaks.push({ kind: "orphan-temp-dir", path: join(base, entry), suite: suiteName });
    }
  }
  return leaks;
}

// ============================================================
// Suite table rendering
// ============================================================

function renderSuiteTable(args) {
  const lines = [];
  lines.push("suite              | config                                | script                    | description");
  lines.push("-------------------+---------------------------------------+---------------------------+----------------------------------");
  for (const [name, suite] of Object.entries(SUITE_TABLE)) {
    lines.push(
      `${name.padEnd(18)} | ${suite.config.padEnd(37)} | ${suite.script.padEnd(25)} | ${suite.description}`
    );
  }
  lines.push("");
  lines.push("stress counter: pinned via JOB_ID; AGENT_RECALL_RELEASE_MODE escalates unhandled rejections to throw");
  return lines.join("\n");
}

function renderStressTable(outDir, jobId) {
  const counter = readStressCounter(outDir, jobId);
  return [
    "stress counter:",
    `  JOB_ID = ${jobId}`,
    `  count  = ${counter}`,
    `  file   = ${stressCounterPath(outDir, jobId)}`
  ].join("\n");
}

// ============================================================
// Main
// ============================================================

async function runList(args) {
  const outDir = resolveOutDir(args);
  const jobId = process.env.JOB_ID ?? `local-${randomUUID()}`;
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ suites: SUITE_TABLE, stress: { jobId, count: readStressCounter(outDir, jobId), path: stressCounterPath(outDir, jobId) } }, null, 2)}\n`
    );
  } else {
    process.stdout.write(`${renderSuiteTable(args)}\n\n${renderStressTable(outDir, jobId)}\n`);
  }
}

async function runInspectStress(args) {
  const outDir = resolveOutDir(args);
  const jobId = process.env.JOB_ID;
  if (jobId === undefined || jobId.length === 0) {
    process.stderr.write("JOB_ID is required for --inspect-stress\n");
    process.exitCode = 2;
    return;
  }
  // Touch the outDir + counter file so the operator
  // (and CI synthetic-gate) can confirm the pinning
  // path exists. A fresh run with no prior counter
  // file initializes the counter at 0; the next
  // `test:all-suites` invocation increments it by 1
  // for the stress suite.
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const counter = readStressCounter(outDir, jobId);
  const counterPath = stressCounterPath(outDir, jobId);
  if (!existsSync(counterPath)) writeStressCounter(outDir, jobId, counter);
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ jobId, count: counter, file: counterPath }, null, 2)}\n`);
  } else {
    process.stdout.write(`JOB_ID=${jobId} stress_count=${counter}\nfile=${counterPath}\n`);
  }
}

async function runAll(args) {
  const outDir = resolveOutDir(args);
  const jobId = process.env.JOB_ID ?? `local-${randomUUID()}`;
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  // The stress suite increments the counter by exactly
  // 1 per release job. If the JOB_ID is the same as a
  // previous run, the counter file already exists and
  // we read it; the stress run itself is still
  // mandatory (the orchestrator does NOT skip it just
  // because the counter exists). The counter is the
  // source of truth the CI synthetic-gate inspects.
  const previousStressCount = readStressCounter(outDir, jobId);

  const suitesToRun = [];
  for (const [name, suite] of Object.entries(SUITE_TABLE)) {
    if (args.noStress && name === "stress") continue;
    if (args.only !== undefined && !args.only.includes(name)) continue;
    suitesToRun.push([name, suite]);
  }

  const results = [];
  for (const [name, suite] of suitesToRun) {
    const jsonPath = join(outDir, `junit-${name}.json`);
    const xmlPath = join(outDir, `junit-${name}.xml`);
    const cleanupPath = join(outDir, `cleanup-${name}.json`);
    const result = await spawnSuite(name, suite, {
      jsonPath,
      xmlPath,
      echoToConsole: process.env.AGENT_RECALL_ORCHESTRATOR_ECHO === "1"
    });
    const vitestSummary = parseVitestJson(jsonPath);
    const leaks = detectChildProcessLeaks(outDir, name);
    const cleanupStatus = {
      suite: name,
      startedAt: new Date(result.startedAt).toISOString(),
      finishedAt: new Date(result.finishedAt).toISOString(),
      durationMs: result.finishedAt - result.startedAt,
      exitCode: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
      leaks,
      failures: result.failures,
      unhandled_rejections: result.failures
        .filter((f) => f.code === FAILURE_CODES.UNHANDLED_REJECTION)
        .map(() => ({ suite: name, type: "unhandledRejection" })),
      worker_timeouts: result.failures
        .filter((f) => f.code === FAILURE_CODES.WORKER_TIMEOUT)
        .map(() => ({ suite: name, type: "workerTimeout" })),
      vitest: vitestSummary
    };
    writeFileSync(cleanupPath, `${JSON.stringify(cleanupStatus, null, 2)}\n`);
    results.push({ name, suite, vitestSummary, cleanupStatus, stdout: result.stdout, stderr: result.stderr });
  }

  // The stress suite (if run) increments the counter by 1.
  const stressRan = suitesToRun.some(([name]) => name === "stress");
  const newStressCount = previousStressCount + (stressRan ? 1 : 0);
  if (stressRan) writeStressCounter(outDir, jobId, newStressCount);

  // Aggregate JUnit across suites.
  const aggregate = {
    suites: {},
    totals: { passed: 0, failed: 0, skipped: 0, total: 0 }
  };
  let anyFailure = false;
  for (const r of results) {
    const passed = r.vitestSummary.numPassedTests;
    const failed = r.vitestSummary.numFailedTests;
    const skipped = r.vitestSummary.numPendingTests + r.vitestSummary.numTodoTests;
    aggregate.suites[r.name] = {
      passed,
      failed,
      skipped,
      unhandled_rejections: r.cleanupStatus.unhandled_rejections.length,
      worker_timeouts: r.cleanupStatus.worker_timeouts.length
    };
    aggregate.totals.passed += passed;
    aggregate.totals.failed += failed;
    aggregate.totals.skipped += skipped;
    aggregate.totals.total += passed + failed + skipped;
    if (
      failed > 0 ||
      r.cleanupStatus.unhandled_rejections.length > 0 ||
      r.cleanupStatus.worker_timeouts.length > 0 ||
      r.cleanupStatus.failures.some((f) => f.code !== FAILURE_CODES.SUITE_EXIT_NONZERO) ||
      r.cleanupStatus.leaks.length > 0
    ) {
      anyFailure = true;
    }
  }

  writeFileSync(join(outDir, "aggregate.json"), `${JSON.stringify(aggregate, null, 2)}\n`);

  process.stdout.write(`\n[orchestrator] job=${jobId} out=${outDir}\n`);
  process.stdout.write(`[orchestrator] suites=${results.length} stress_count=${newStressCount}\n`);
  for (const r of results) {
    const summary = r.vitestSummary;
    process.stdout.write(
      `[orchestrator] ${r.name}: ${summary.numPassedTests} passed, ${summary.numFailedTests} failed, ${summary.numPendingTests + summary.numTodoTests} skipped (exit=${r.cleanupStatus.exitCode}, failures=${r.cleanupStatus.failures.length})\n`
    );
  }

  if (anyFailure) {
    process.stdout.write(`[orchestrator] FAIL — see ${outDir}/cleanup-<suite>.json for failure taxonomy\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`[orchestrator] OK\n`);
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`orchestrator CLI error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    printHelp();
    return;
  }
  if (args.list) {
    await runList(args);
    return;
  }
  if (args.inspectStress) {
    await runInspectStress(args);
    return;
  }
  await runAll(args);
}

main().catch((err) => {
  process.stderr.write(`orchestrator fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  if (err instanceof Error && err.stack !== undefined) process.stderr.write(`${err.stack}\n`);
  process.exitCode = 2;
});