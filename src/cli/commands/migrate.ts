// src/cli/commands/migrate.ts
import { flagBool } from "../arg-parser.js";
import type { CliContext, CliResult } from "../index.js";
import { jsonOut } from "../format.js";
import { CURRENT_SCHEMA_VERSION } from "../../sqlite-store.js";

export function migrateCommand(ctx: CliContext): CliResult {
  const yes = flagBool(ctx.args, "yes");
  const json = flagBool(ctx.args, "json");
  if (!yes) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `refusing to migrate without --yes; current target is v${CURRENT_SCHEMA_VERSION}`
    };
  }
  const result = ctx.store.runMigrations();
  if (json) {
    return { exitCode: 0, stdout: jsonOut(result), stderr: "" };
  }
  return {
    exitCode: 0,
    stdout: `migrated: v${result.from} -> v${result.to}`,
    stderr: ""
  };
}
