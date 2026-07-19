// src/cli/commands/backup.ts
import { flagBool, flagString } from "../arg-parser.js";
import type { CliContext, CliResult } from "../index.js";
import { jsonOut } from "../format.js";
import { runBackup } from "../../backup.js";
import { join } from "node:path";

export function backupCommand(ctx: CliContext): CliResult {
  const keep = Number.parseInt(flagString(ctx.args, "keep") ?? "14", 10);
  const json = flagBool(ctx.args, "json");
  const backupDir = join(ctx.dataHome, "backups");
  try {
    const result = runBackup(ctx.store.backupHandle(), { backupDir, keep });
    if (json) {
      return { exitCode: 0, stdout: jsonOut(result), stderr: "" };
    }
    return {
      exitCode: 0,
      stdout: `backup written: ${result.path} (${result.size} bytes, ${result.durationMs}ms, kept ${result.kept}, pruned ${result.pruned})`,
      stderr: ""
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 2, stdout: "", stderr: `backup failed: ${message}` };
  }
}
