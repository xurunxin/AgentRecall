// src/cli/commands/eval.ts
//
// v1.2.0-alpha.3 (issue #55d): the
// `agent-recall eval` user-facing CLI subcommand.
// The runner is implemented in
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
// The CLI does NOT swallow the runner's exit
// code: a per-fixture failure is exit 1, a
// baseline miss is exit 1, a schema violation
// is exit 2. The CLI runs the runner through
// `tsx` (the same loader `scripts/eval-lifecycle.mjs`
// uses) so the same TypeScript source backs both
// surfaces.

import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
 * Resolve the eval runner entry point at runtime.
 * The CLI cannot import `test/eval-lifecycle/runner.ts`
 * directly because that file lives outside the
 * published `src/` graph and uses absolute paths into
 * `test/`. We shell out to `node --import tsx` instead
 * so the harness's pure API is exercised end-to-end
 * without a build step. The wrapper script
 * `scripts/eval-lifecycle.mjs` already does this for
 * `pnpm run eval:lifecycle:quick`; the CLI reuses
 * the same script.
 */
function evalScriptPath(): string {
  // Resolve the repo root from this file's
  // location: `src/cli/commands/eval.ts` lives
  // 3 directories below the repo root
  // (`src/cli/commands/<file>.ts` -> 4 levels:
  // the file itself + 3 parents). Walking 4
  // `..` segments lands on the root; the
  // harness script is then resolved under
  // `scripts/eval-lifecycle.mjs`.
  const here = fileURLToPath(import.meta.url);
  return resolve(here, "..", "..", "..", "..", "scripts", "eval-lifecycle.mjs");
}

interface SubprocessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `scripts/eval-lifecycle.mjs` as a child
 * process and capture its exit code + streams.
 * The harness already writes a structured
 * `report.json` and `report.md` to the
 * `artifacts/eval-lifecycle` directory; the CLI
 * forwards the exit code so the caller's `if
 * ((Get-Process ...).ExitCode)` style check works.
 */
async function runEvalScript(args: string[]): Promise<SubprocessResult> {
  const { spawn } = await import("node:child_process");
  const scriptPath = evalScriptPath();
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
 * The CLI hands the harness to
 * `scripts/eval-lifecycle.mjs`, which is the same
 * entry point `pnpm run eval:lifecycle:quick`
 * uses. The wrapper's exit code propagates as
 * the CLI's exit code so CI can gate on a
 * non-zero return without parsing stderr.
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
  const args = [
    "--corpus",
    corpusDir,
    "--out",
    outDir,
    ...(bail ? ["--bail"] : [])
  ];
  const result = await runEvalScript(args);
  // The harness's stdout is the Markdown report
  // (via formatReportMarkdown's intent) when the
  // child process pipes it; the script actually
  // writes the file and exits. The CLI only
  // forwards the exit code; the caller reads the
  // file from `--out` directly. `CliResult.exitCode`
  // is a 4-valued literal union; the harness's
  // exit code (0 or 1 in the normal path, 2 on
  // schema violation) maps cleanly. Any other
  // value is clamped to 1 (failure) so the CLI
  // does not surface a literal-typed mismatch.
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
