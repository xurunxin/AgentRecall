// src/cli/commands/eval.ts
//
// v1.2.0 (issue #55d, follow-up for v1.2.0 release):
// the `agent-recall eval` user-facing CLI
// subcommand. The harness is implemented in
// `test/eval-lifecycle/runner.ts`; this module
// is a thin CLI wrapper that re-exports the
// runner with the project-wide CLI conventions
// (stable error codes on stderr, JSON output via
// `--json`, human-readable Markdown via the
// default mode).
//
// Usage:
//   agent-recall eval run --corpus <dir> --out <dir> [--bail]
//   agent-recall eval list-corpora [--corpus <dir>]
//   agent-recall eval show-report <path> [--json]
//
// v1.2.0 release change: `eval run` now invokes
// the harness in-process (via dynamic `import()`)
// instead of shelling out to
// `scripts/eval-lifecycle.mjs`. The shell-out
// path failed in the Bun single-file binary
// because the wrapper script is not bundled;
// the in-process path uses a dynamic import to
// load `runner.ts` from the corpus's neighbour
// location, which works in both source mode
// (`pnpm exec tsx …`) and binary mode.
//
// The CLI does NOT swallow the runner's exit
// code: a per-fixture failure is exit 1, a
// baseline miss is exit 1, a schema violation
// is exit 2. The literal-typed
// `CliResult.exitCode` (`0 | 1 | 2 | 3`) is
// preserved by clamping any out-of-band exit
// code to 1.

import { resolve, isAbsolute } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { flagBool, flagString } from "../arg-parser.js";
import type { CliContext, CliResult } from "../index.js";
import { jsonOut, paint, resolveColorMode, useColor } from "../format.js";

const STABLE_USAGE_ERROR = "usage_error";
const STABLE_NOT_FOUND = "not_found";
const STABLE_INTERNAL_ERROR = "internal_error";

const USAGE = `usage: agent-recall eval <run|list-corpora|show-report> [...]

Subcommands:
  run --corpus <dir> --out <dir> [--bail]
      Walk the corpus at <dir> (default: test/eval-lifecycle),
      run every fixture, write report.json + report.md to <out>.

  list-corpora [--corpus <dir>]
      List the fixture ids declared in the corpus manifest.

  show-report <path> [--json]
      Read report.json from <path> and print a human summary
      (or --json for the raw payload).`;

/**
 * v1.2.0 release: the CLI now invokes the
 * harness in-process instead of shelling out
 * to `scripts/eval-lifecycle.mjs`. The shell-out
 * path worked in source mode (where
 * `scripts/eval-lifecycle.mjs` lives next to
 * `src/`) but failed in the Bun single-file
 * binary: the wrapper script is not present
 * in the staged binary, so the CLI surfaced
 * `[not_found] eval script not found at
 * B:\\scripts\\eval-lifecycle.mjs` on Windows. The
 * in-process call resolves the runner module
 * next to the corpus directory the user passed
 * (or the repo-root default) and writes the
 * report to the requested `--out` directory.
 * The harness stays available via
 * `pnpm run eval:lifecycle:quick` for source-tree
 * development.
 */
interface SubprocessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * @deprecated the CLI no longer shells out; the
 * `runEvalInline` path below replaces it. Kept for
 * the (currently dormant) `--external-script`
 * flag that future releases may opt into when the
 * runner needs to live in a separate process
 * (e.g. for memory isolation in CI). The shell-out
 * spawner is unchanged.
 */
async function runEvalScript(args: string[]): Promise<SubprocessResult> {
  const here = fileURLToPath(import.meta.url);
  const scriptPath = resolve(here, "..", "..", "..", "..", "scripts", "eval-lifecycle.mjs");
  const { spawn } = await import("node:child_process");
  if (!existsSync(scriptPath)) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `[${STABLE_NOT_FOUND}] eval script not found at ${scriptPath}`
    };
  }
  return new Promise<SubprocessResult>((resolveP) => {
    const child = spawn(
      process.execPath,
      [scriptPath, ...args],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolveP({ exitCode: code ?? 1, stdout, stderr });
    });
    child.on("error", (err) => {
      resolveP({
        exitCode: 2,
        stdout,
        stderr: `[${STABLE_INTERNAL_ERROR}] eval script failed to start: ${
          err instanceof Error ? err.message : String(err)
        }\n${stderr}`
      });
    });
  });
}

/**
 * Resolve the corpus's runner module. The runner
 * lives at `<corpusDir>/runner.ts` in source mode
 * and at `<corpusDir>/runner.js` after the
 * release-time `tsc` build (the runner compiles
 * to `dist/test/eval-lifecycle/runner.js` for
 * Node-mode deploys; the corpus-adjacent
 * `<corpusDir>/runner.{ts,js}` probe lets both
 * layouts resolve). The CLI also probes the
 * source-tree `test/eval-lifecycle/runner.ts`
 * fallback for development workflows that
 * run the CLI from the repo root without a
 * precompiled `dist/` next to the corpus.
 */
function resolveEvalRunnerCandidates(corpusDir: string): string[] {
  // v1.2.0 release: the `chdirToInstallRoot`
  // helper in `launcher.ts` makes `process.cwd()`
  // the install root before the CLI dispatches,
  // so we can resolve the runner relative to
  // the cwd (the repo root when the operator
  // runs from a checkout, or the deploy root
  // when the operator runs the staged binary).
  // The candidates are ordered by preference:
  //   1. Compiled `dist/test/eval-lifecycle/runner.js`
  //      (production deploys ship `dist/`)
  //   2. The corpus-adjacent `runner.{js,ts}` if
  //      a `runner.js` is next to the corpus
  //      (custom corpus layouts)
  //   3. The source-tree `test/eval-lifecycle/runner.ts`
  //      (dev-mode fallbacks for an operator
  //      running the CLI with the `tsx` loader)
  const cwd = process.cwd();
  const candidates: string[] = [];
  candidates.push(resolve(cwd, "dist", "test", "eval-lifecycle", "runner.js"));
  if (isAbsolute(corpusDir)) {
    candidates.push(resolve(corpusDir, "runner.js"));
    candidates.push(resolve(corpusDir, "runner.ts"));
  } else {
    candidates.push(resolve(cwd, corpusDir, "runner.js"));
    candidates.push(resolve(cwd, corpusDir, "runner.ts"));
    candidates.push(resolve(corpusDir, "runner.js"));
    candidates.push(resolve(corpusDir, "runner.ts"));
  }
  candidates.push(resolve(cwd, "test", "eval-lifecycle", "runner.js"));
  candidates.push(resolve(cwd, "test", "eval-lifecycle", "runner.ts"));
  return candidates;
}

interface InProcessEvalResult {
  exitCode: number;
  stderr: string;
}

/**
 * v1.2.0 release: invoke the harness in-process
 * via dynamic `import()`. The runner is a
 * `test/eval-lifecycle/runner.ts` module that
 * the source-mode `pnpm` build loads through the
 * `tsx` loader; the Bun binary's runtime can
 * load it directly because the binary's working
 * directory at install time is the repo root
 * (or wherever the operator deployed the
 * checkout). The in-process path returns a
 * `{exitCode, stderr}` shape that mirrors the
 * `runEvalScript` return type so the caller
 * (`evalRunCommand`) does not need to care which
 * mode was used.
 */
async function runEvalInline(args: {
  corpusDir: string;
  outDir: string;
  bail: boolean;
}): Promise<InProcessEvalResult> {
  const candidates = resolveEvalRunnerCandidates(args.corpusDir);
  let runnerPath: string | null = null;
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      runnerPath = candidate;
      break;
    }
  }
  if (process.env["DEBUG_AGENT_RECALL_EVAL"] === "1") {
    process.stderr.write(
      `agent-recall eval: candidate resolution\n  cwd=${process.cwd()}\n  corpusDir=${args.corpusDir}\n  candidates=${candidates.join("\n    ")}\n  resolved=${runnerPath ?? "<null>"}\n`
    );
  }
  if (runnerPath === null) {
    return {
      exitCode: 2,
      stderr: `[${STABLE_NOT_FOUND}] cannot locate the eval-lifecycle harness; checked ${candidates.join(", ")}. Run from the repo root or pass --corpus pointing at the directory that contains test/eval-lifecycle.`
    };
  }
  try {
    // Wrap the import through `pathToFileURL` so
    // the Windows path separator doesn't trip the
    // resolver on `file:///` round-trips.
    const runner = (await import(
      pathToFileURL(runnerPath).href
    )) as { runCorpusAndWriteReports?: unknown };
    const runFn = runner.runCorpusAndWriteReports;
    if (typeof runFn !== "function") {
      return {
        exitCode: 3,
        stderr: `[${STABLE_INTERNAL_ERROR}] eval runner does not export runCorpusAndWriteReports; refusing to fall back to a subprocess.`
      };
    }
    const report = await (runFn as (opts: {
      corpusDir: string;
      outDir: string;
      bailOnFailure: boolean;
    }) => Promise<{
      totals: { failed: number };
      baselines?: { passed: boolean; reasons: string[] };
    }>)({
      corpusDir: args.corpusDir,
      outDir: args.outDir,
      bailOnFailure: args.bail
    });
    if (report.totals.failed > 0) {
      return { exitCode: 1, stderr: "" };
    }
    if (report.baselines !== undefined && !report.baselines.passed) {
      return {
        exitCode: 1,
        stderr:
          "Quality baselines failed:\n" +
          report.baselines.reasons.map((r) => `  - ${r}`).join("\n")
      };
    }
    return { exitCode: 0, stderr: "" };
  } catch (err) {
    return {
      exitCode: 2,
      stderr: `[${STABLE_INTERNAL_ERROR}] eval runner crashed: ${
        err instanceof Error ? err.message : String(err)
      }`
    };
  }
}

/**
 * Top-level `eval` command. Branches on the
 * first positional argument (`run`,
 * `list-corpora`, `show-report`) and forwards to
 * the matching handler.
 */
export async function evalCommand(ctx: CliContext): Promise<CliResult> {
  const sub = ctx.args.positional[0];
  if (sub === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `[${STABLE_USAGE_ERROR}] ${USAGE}`
    };
  }
  if (sub === "run") {
    return evalRunCommand(ctx);
  }
  if (sub === "list-corpora") {
    return evalListCorporaCommand(ctx);
  }
  if (sub === "show-report") {
    return evalShowReportCommand(ctx);
  }
  return {
    exitCode: 1,
    stdout: "",
    stderr: `[${STABLE_USAGE_ERROR}] unknown eval subcommand: ${sub}\n\n${USAGE}`
  };
}

/**
 * `agent-recall eval run --corpus <dir> --out <dir> [--bail]`
 *
 * v1.2.0 release: the CLI now invokes the harness
 * in-process via `runEvalInline` (the previous
 * `runEvalScript` shell-out path is preserved as
 * `@deprecated` for the future `--external-script`
 * flag). The in-process call returns a
 * `{totals.failed, baselines.passed/reasons}` shape
 * that the CLI maps onto the literal-typed
 * `CliResult.exitCode`.
 */
async function evalRunCommand(ctx: CliContext): Promise<CliResult> {
  const corpusDir = flagString(ctx.args, "corpus") ?? "test/eval-lifecycle";
  const outDir = flagString(ctx.args, "out") ?? "artifacts/eval-lifecycle";
  const bail = flagBool(ctx.args, "bail");
  const json = flagBool(ctx.args, "json");
  if (!json) {
    // Echo the dispatch summary to stderr so the
    // caller can see what the harness is about to
    // do without parsing the JSON report.
    const banner = `agent-recall eval: corpus=${corpusDir} out=${outDir} bail=${bail}`;
    process.stderr.write(banner + "\n");
  }
  const result = await runEvalInline({ corpusDir, outDir, bail });
  // `CliResult.exitCode` is a 4-valued literal
  // union (`0 | 1 | 2 | 3`); the in-process
  // harness's exit code (0 or 1 in the normal
  // path, 2 on a schema violation) maps cleanly.
  // Any other value is clamped to 1 (failure) so
  // the CLI does not surface a literal-typed
  // mismatch.
  const clampedExit: 0 | 1 | 2 | 3 =
    result.exitCode === 0 ? 0
    : result.exitCode === 1 ? 1
    : result.exitCode === 2 ? 2
    : 1;
  return {
    exitCode: clampedExit,
    stdout: json ? jsonOut({ corpus: corpusDir, out: outDir, bail, exit_code: result.exitCode }) : "",
    stderr: result.stderr
  };
}

interface ManifestStub {
  schema_version: string;
  corpus_version: string;
  description: string;
  fixtures: string[];
}

/**
 * `agent-recall eval list-corpora [--corpus <dir>]`
 *
 * Reads the manifest at `<dir>/fixtures/manifest.json`
 * and prints the fixture id list. The default mode
 * is a single column; `--json` emits the raw
 * `ManifestStub` payload.
 */
function evalListCorporaCommand(ctx: CliContext): Promise<CliResult> {
  const corpusDir = flagString(ctx.args, "corpus") ?? "test/eval-lifecycle";
  const manifestPath = resolve(corpusDir, "fixtures", "manifest.json");
  if (!existsSync(manifestPath)) {
    return Promise.resolve({
      exitCode: 1,
      stdout: "",
      stderr: `[${STABLE_NOT_FOUND}] manifest not found at ${manifestPath}`
    });
  }
  const raw = readFileSync(manifestPath, "utf8");
  let parsed: ManifestStub;
  try {
    parsed = JSON.parse(raw) as ManifestStub;
  } catch (err) {
    return Promise.resolve({
      exitCode: 2,
      stdout: "",
      stderr: `[${STABLE_INTERNAL_ERROR}] manifest is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`
    });
  }
  const json = flagBool(ctx.args, "json");
  if (json) {
    return Promise.resolve({ exitCode: 0, stdout: jsonOut(parsed), stderr: "" });
  }
  const colorMode = resolveColorMode(ctx.args);
  const color = useColor(colorMode);
  const lines: string[] = [];
  lines.push(paint(`# ${parsed.corpus_version}  (${parsed.fixtures.length} fixtures)`, "bold", color));
  if (parsed.description.length > 0) {
    lines.push(parsed.description);
  }
  lines.push("");
  for (const name of parsed.fixtures) {
    lines.push(`  - ${name.replace(/\.json$/, "")}`);
  }
  return Promise.resolve({ exitCode: 0, stdout: lines.join("\n"), stderr: "" });
}

/**
 * `agent-recall eval show-report <path> [--json]`
 *
 * Reads a `report.json` previously written by the
 * harness and prints either the raw payload
 * (`--json`) or a compact one-line summary. The
 * Markdown report lives next to the JSON file and
 * can be `cat`-ed directly without going through
 * this command; the JSON form is for downstream
 * tooling that prefers structured data.
 */
function evalShowReportCommand(ctx: CliContext): Promise<CliResult> {
  const reportPath = ctx.args.positional[1];
  if (reportPath === undefined) {
    return Promise.resolve({
      exitCode: 1,
      stdout: "",
      stderr: `[${STABLE_USAGE_ERROR}] eval show-report: <path> argument is required`
    });
  }
  if (!existsSync(reportPath)) {
    return Promise.resolve({
      exitCode: 1,
      stdout: "",
      stderr: `[${STABLE_NOT_FOUND}] report not found at ${reportPath}`
    });
  }
  const raw = readFileSync(reportPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return Promise.resolve({
      exitCode: 2,
      stdout: "",
      stderr: `[${STABLE_INTERNAL_ERROR}] report is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`
    });
  }
  const json = flagBool(ctx.args, "json");
  if (json) {
    return Promise.resolve({
      exitCode: 0,
      stdout: JSON.stringify(parsed, null, 2),
      stderr: ""
    });
  }
  // Compact summary line. The full Markdown lives
  // next to the JSON file (the harness writes both).
  const r = parsed as {
    corpus_version?: string;
    totals?: { passed?: number; failed?: number; fixture_count?: number };
    safety_gate?: { passed?: boolean; reasons?: string[] };
    baselines?: {
      passed?: boolean;
      measured?: Record<string, number>;
      declared?: Record<string, number>;
      reasons?: string[];
    };
  };
  const totals = r.totals ?? {};
  const colorMode = resolveColorMode(ctx.args);
  const color = useColor(colorMode);
  const lines: string[] = [];
  lines.push(
    paint(`# ${r.corpus_version ?? "<unknown>"}  (${totals.fixture_count ?? 0} fixtures)`, "bold", color)
  );
  const safetyOk = r.safety_gate?.passed ?? false;
  const safetyReasons = r.safety_gate?.reasons ?? [];
  lines.push(
    `  safety gate: ${safetyOk ? paint("PASS", "green", color) : paint("FAIL", "red", color)}` +
      (safetyReasons.length === 0 ? "" : `  (${safetyReasons.length} reason(s))`)
  );
  if (r.baselines !== undefined) {
    const baselineOk = r.baselines.passed ?? false;
    const reasons = r.baselines.reasons ?? [];
    lines.push(
      `  baselines:    ${baselineOk ? paint("PASS", "green", color) : paint("FAIL", "red", color)}` +
        (reasons.length === 0 ? "" : `  (${reasons.length} reason(s))`)
    );
    const m = r.baselines.measured ?? {};
    const d = r.baselines.declared ?? {};
    for (const key of Object.keys(d)) {
      const measured = m[key];
      const declared = d[key];
      if (typeof measured === "number" && typeof declared === "number") {
        const mark = measured >= declared ? paint("ok", "green", color) : paint("miss", "red", color);
        lines.push(`    ${key}: measured=${measured.toFixed(4)} declared=${declared.toFixed(4)} ${mark}`);
      }
    }
    if (reasons.length > 0) {
      lines.push("");
      lines.push("  baseline reasons:");
      for (const reason of reasons) {
        lines.push(`    - ${reason}`);
      }
    }
  }
  return Promise.resolve({ exitCode: 0, stdout: lines.join("\n"), stderr: "" });
}
