// src/cli/commands/doctor.ts
import { flagBool } from "../arg-parser.js";
import type { CliContext, CliResult } from "../index.js";
import { jsonOut, paint, resolveColorMode, statusGlyph, useColor } from "../format.js";
import { runDoctor } from "../../doctor/index.js";

// Stage 18 v1.1.2 third follow-up (Critical #2):
// the doctor command MUST surface a stable code
// in `[code]` form on stderr when the report
// returns a non-zero exit code. The stable code
// comes from
// `STABLE_ERROR_CODES.doctor_failed`-equivalent;
// ora-7 marked the previous `exitCode <= 1`
// assertion as too permissive — a healthy DB
// MUST exit 0, and a non-healthy report MUST
// pin the failure mode on stderr.
const STABLE_DOCTOR_FAILED = "doctor_failed";

export function doctorCommand(ctx: CliContext): CliResult {
  let report;
  try {
    report = runDoctor({
      dataHome: ctx.dataHome,
      store: ctx.store,
      now: () => new Date()
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 2,
      stdout: "",
      stderr: `[${STABLE_DOCTOR_FAILED}] doctor failed to run: ${message}`
    };
  }
  const json = flagBool(ctx.args, "json");
  if (json) {
    return { exitCode: report.exit_code, stdout: jsonOut(report), stderr: "" };
  }
  const colorMode = resolveColorMode(ctx.args);
  const color = useColor(colorMode);
  const lines = report.results.map((r) => {
    const glyph = statusGlyph(r.status, color);
    return `${glyph}  ${paint(r.name.padEnd(20), "bold", color)}  ${r.message}`;
  });
  const summary = paint(
    `\nSummary: ${report.summary.ok} OK, ${report.summary.warn} WARN, ${report.summary.fail} FAIL. Exit ${report.exit_code}.`,
    "bold",
    color
  );
  // Stable code on the failure path: a healthy
  // report (exit 0) leaves stderr empty; a report
  // with `fail > 0` exits 2 with a `[doctor_failed]`
  // prefix on stderr so a script can pin the failure
  // mode without scanning the human-readable summary.
  const stderr =
    report.exit_code === 0
      ? ""
      : `[${STABLE_DOCTOR_FAILED}] doctor reported ${report.summary.fail} failure(s) and ${report.summary.warn} warning(s); exit ${report.exit_code}`;
  return { exitCode: report.exit_code, stdout: lines.join("\n") + summary, stderr };
}
