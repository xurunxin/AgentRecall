// src/cli/commands/doctor.ts
import { flagBool } from "../arg-parser.js";
import type { CliContext, CliResult } from "../index.js";
import { jsonOut, paint, resolveColorMode, statusGlyph, useColor } from "../format.js";
import { runDoctor } from "../../doctor/index.js";

export function doctorCommand(ctx: CliContext): CliResult {
  const report = runDoctor({
    dataHome: ctx.dataHome,
    store: ctx.store,
    now: () => new Date()
  });
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
  return { exitCode: report.exit_code, stdout: lines.join("\n") + summary, stderr: "" };
}
