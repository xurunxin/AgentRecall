#!/usr/bin/env node
// scripts/smoke-bun-binary.mjs
//
// Seven-step smoke test for the locally-built Bun CLI binary.
// Skips (exits 0 with a "skipped" note) if no binary exists for
// the host platform, so the script is safe to call before
// `npm run build:bun`.
//
// Steps:
//   1. --version                          exit 0, prints 1.1.3
//   2. help                               exit 0, lists every command name
//   3. doctor --json (empty DB)           exit 0, summary.fail === 0
//   4. export --scope global --format json
//      then import --from <out> --scope global --dry-run
//                                          exit 0, plan printed
//   5. backup                             exit 0, prints "[backup path]"
//   6. post-backup doctor --json          exit 0, summary.fail === 0
//
// Stable failure code on the failure path: "[smoke_failed]"
// (analogous to the existing [doctor_failed] convention).

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOST_PLATFORM =
  `${process.platform}-${process.arch}` === "linux-x64" ? "linux-x64"
  : `${process.platform}-${process.arch}` === "darwin-x64" ? "darwin-x64"
  : `${process.platform}-${process.arch}` === "darwin-arm64" ? "darwin-arm64"
  : `${process.platform}-${process.arch}` === "win32-x64" ? "win32-x64"
  : null;

const EXT = process.platform === "win32" ? ".exe" : "";
const BINARY = `dist-bin/agent-recall-${HOST_PLATFORM}${EXT}`;

if (HOST_PLATFORM === null) {
  console.error(`smoke-bun-binary: host platform ${process.platform}-${process.arch} is not in the canonical platform list`);
  process.exit(2);
}

import { existsSync } from "node:fs";
if (!existsSync(BINARY)) {
  console.log(`bun: smoke skipped \u2014 no binary at ${BINARY}`);
  process.exit(0);
}

const FAIL = "[smoke_failed]";

function fail(step, msg) {
  console.error(`${FAIL} step ${step}: ${msg}`);
  process.exit(1);
}

function run(binary, args, env, stepName) {
  try {
    return execFileSync(binary, args, {
      encoding: "utf8",
      env: { ...process.env, ...env }
    });
  } catch (e) {
    fail(stepName, `${args.join(" ")} -> exit ${e.status}; stderr: ${e.stderr?.slice(-400) ?? ""}`);
  }
}

const home = mkdtempSync(join(tmpdir(), "agent-recall-bun-smoke-"));
const env = { AGENT_RECALL_HOME: home };

try {
  // Step 1: --version
  const v = run(BINARY, ["--version"], env, 1).trim();
  if (!/^\d+\.\d+\.\d+$/.test(v)) fail(1, `--version output is not semver: "${v}"`);
  if (v !== "1.1.3") fail(1, `--version expected "1.1.3", got "${v}"`);

  // Step 2: help lists every command name
  const help = run(BINARY, ["help"], env, 2);
  for (const cmd of ["list", "show", "search", "audit", "doctor", "export", "import", "backup", "restore", "migrate", "admin", "version", "help"]) {
    if (!help.includes(`\n  ${cmd} `)) fail(2, `help text missing command "${cmd}"`);
  }

  // Step 3: doctor on an empty DB
  const doctor1 = JSON.parse(run(BINARY, ["doctor", "--json"], env, 3));
  if (doctor1.summary.fail !== 0) fail(3, `doctor on empty DB reported fail=${doctor1.summary.fail}`);

  // Step 4: export round-trip
  const outDir = join(home, "export");
  run(BINARY, ["export", "--scope", "global", "--format", "json", "--out", outDir], env, 4);
  run(BINARY, ["import", "--from", outDir, "--scope", "global", "--dry-run"], env, 4);

  // Step 5: backup
  const backupOut = run(BINARY, ["backup"], env, 5);
  if (!backupOut.includes("backup written:")) fail(5, `backup output missing "backup written:" prefix: ${backupOut}`);

  // Step 6: post-backup doctor
  const doctor2 = JSON.parse(run(BINARY, ["doctor", "--json"], env, 6));
  if (doctor2.summary.fail !== 0) fail(6, `post-backup doctor reported fail=${doctor2.summary.fail}`);

  console.log("bun smoke: all 6 steps passed");
} finally {
  rmSync(home, { recursive: true, force: true });
}