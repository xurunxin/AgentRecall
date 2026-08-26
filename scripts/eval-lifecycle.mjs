#!/usr/bin/env node
//
// v1.2.0-alpha.2 (issue #55): the lifecycle
// evaluation harness CLI. Wraps the TypeScript
// runner so a release manager can run
// `pnpm run eval:lifecycle:quick` from the
// project root without compiling the harness
// manually. The script intentionally lives under
// `scripts/` (not `bin/`) because the harness
// is currently a development tool — promotion
// to a user-facing `agent-recall eval` command
// is a Phase 3 follow-up.
//
// Exit codes:
//   0 — every fixture passed; safety gate PASS
//   1 — at least one fixture failed (the JSON
//       report is written regardless so a
//       regression can be diffed against the
//       last accepted baseline)
//   2 — corpus manifest or fixture JSON failed
//       schema validation (a CI / corpus
//       authoring regression, not a product
//       regression)

import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");
const defaultCorpusDir = resolve(projectRoot, "test", "eval-lifecycle");
const defaultOutDir = resolve(projectRoot, "artifacts", "eval-lifecycle");

function parseArgs(argv) {
  const args = { corpusDir: defaultCorpusDir, outDir: defaultOutDir, bail: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--corpus" && argv[i + 1] !== undefined) {
      args.corpusDir = resolve(argv[i + 1]);
      i += 1;
    } else if (arg === "--out" && argv[i + 1] !== undefined) {
      args.outDir = resolve(argv[i + 1]);
      i += 1;
    } else if (arg === "--bail") {
      args.bail = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`unknown flag: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  console.log(
    `Usage: node scripts/eval-lifecycle.mjs [--corpus DIR] [--out DIR] [--bail]\n` +
      `\n  --corpus DIR   path to the corpus directory (default: test/eval-lifecycle)\n` +
      `  --out DIR      output directory for report.json + report.md (default: artifacts/eval-lifecycle)\n` +
      `  --bail         fail-fast on the first failing fixture\n`
  );
}

const args = parseArgs(process.argv);

// Delegate to tsx so the TypeScript harness runs
// without a manual compile. tsx is already a
// dev-dependency (used by the vitest config).
const harnessEntry = resolve(projectRoot, "test", "eval-lifecycle", "runner-cli.ts");
const child = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    harnessEntry,
    "--corpus",
    args.corpusDir,
    "--out",
    args.outDir,
    ...(args.bail ? ["--bail"] : [])
  ],
  { stdio: "inherit" }
);
process.exit(child.status ?? 1);
