// src/cli/commands/migrate.ts
//
// Stage 14 PR-A (spec § 5.4 AR-P0-004 / § 14): the CLI
// `migrate` command takes a verified backup of the live DB
// BEFORE running any schema migration, and prints a restore
// hint so the user can roll back if the new schema turns out
// to break their data.
//
// Pre-PR-A the command called `store.runMigrations()` directly,
// so a destructive migration ran with no `backup_failed`
// short-circuit and no easy rollback path. Spec § 5.4 said:
//   migrate: open no-migrate → read version → generate
//   backup → verify backup → acquire migration lock →
//   execute migration.
// PR-A adds the pre-mutation backup + verify step. The store
// still uses `read_write_no_migrate` (no auto-upgrade); the
// SQLite transaction inside `runMigrations` is the migration
// lock.

import { join } from "node:path";
import { flagBool } from "../arg-parser.js";
import type { CliContext, CliResult } from "../index.js";
import { jsonOut } from "../format.js";
import { CURRENT_SCHEMA_VERSION } from "../../sqlite-store.js";
import { runBackup, verifyBackup, type VerifiedBackup } from "../../backup.js";

type PreMigrateBackup = {
  path: string;
  size: number;
  durationMs: number;
  verified: VerifiedBackup;
};

function preMigrateBackup(ctx: CliContext): PreMigrateBackup {
  const backupDir = join(ctx.dataHome, "backups");
  const result = runBackup(ctx.store.backupHandle(), { backupDir, keep: 14 });
  const verified = verifyBackup(result.path);
  return {
    path: result.path,
    size: result.size,
    durationMs: result.durationMs,
    verified
  };
}

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

  // 1. Pre-migration verified backup. Runs outside any
  //    transaction (VACUUM INTO cannot share a connection
  //    with a BEGIN IMMEDIATE). On any failure, the
  //    destructive migration does not run.
  let backup: PreMigrateBackup;
  try {
    backup = preMigrateBackup(ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      return {
        exitCode: 2,
        stdout: jsonOut({
          ok: false,
          error: "backup_failed",
          message: `pre-migration backup failed: ${message}`,
          details: { phase: "pre_migration_backup" }
        }),
        stderr: ""
      };
    }
    return {
      exitCode: 2,
      stdout: "",
      stderr: `pre-migration backup failed (refusing to migrate): ${message}`
    };
  }

  // 2. Apply the version-aware migration chain. The store
  //    uses `read_write_no_migrate` so this is the ONLY
  //    path that ever advances user_version.
  const result = ctx.store.runMigrations();

  const restoreHint = `agent-recall restore --from ${backup.path} --confirm`;
  const unchanged = result.from === result.to;

  if (json) {
    return {
      exitCode: 0,
      stdout: jsonOut({
        ok: true,
        from: result.from,
        to: result.to,
        unchanged,
        target: `v${CURRENT_SCHEMA_VERSION}`,
        backup: {
          path: backup.path,
          size: backup.size,
          duration_ms: backup.durationMs,
          schema_version: backup.verified.schemaVersion,
          quick_check: backup.verified.quickCheck,
          restore_command: restoreHint
        }
      }),
      stderr: ""
    };
  }

  if (unchanged) {
    return {
      exitCode: 0,
      stdout: [
        `no migration needed: already at v${result.to}`,
        `pre-migration backup: ${backup.path} (${backup.size} bytes, ${backup.durationMs}ms, schema_version=${backup.verified.schemaVersion})`,
        `to roll back: ${restoreHint}`
      ].join("\n"),
      stderr: ""
    };
  }

  return {
    exitCode: 0,
    stdout: [
      `migrated: v${result.from} -> v${result.to}`,
      `pre-migration backup: ${backup.path} (${backup.size} bytes, ${backup.durationMs}ms, schema_version=${backup.verified.schemaVersion})`,
      `to roll back: ${restoreHint}`
    ].join("\n"),
    stderr: ""
  };
}
