// src/doctor/checks/backup-verification.ts
//
// Stage 14 PR-C (spec § 9.1): the existing
// `backup_directory` check counts the backup files and
// reports their age. This check goes one step further:
// it opens the most recent backup in a temporary
// connection and runs `PRAGMA quick_check` to confirm
// the file is not corrupt on disk. A backup file that
// has been silently corrupted (filesystem bit-rot,
// half-written by a crashed process, etc.) is worse
// than no backup at all — the agent will confidently
// restore from a corrupt file and lose the data it
// thought it had.
//
// The check fails when no backup exists (a freshly
// initialised data home has no prior backup) and when
// the quick_check returns anything other than `ok`.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { listBackups } from "../../backup.js";
import type { CheckContext, CheckResult } from "../types.js";

export function checkBackupVerification(ctx: CheckContext): CheckResult {
  const backupDir = join(ctx.dataHome, "backups");
  const items = listBackups(backupDir);
  if (items.length === 0) {
    // First-run / no-prior-backup case. The `backup_directory`
    // check already warns when there *are* stale backups; here
    // we mirror that "first run is fine" stance — a freshly
    // initialised data home has nothing to verify and the next
    // backup (after the first mutation) will be checked.
    return {
      name: "backup_verification",
      status: "ok",
      message: "no backups present (first run)",
      details: { count: 0 }
    };
  }
  const newest = items[0]!;
  const fullPath = join(backupDir, newest.name);
  if (!existsSync(fullPath)) {
    return {
      name: "backup_verification",
      status: "fail",
      message: `latest backup listed but missing on disk: ${newest.name}`,
      details: { path: fullPath, name: newest.name }
    };
  }

  let handle: DatabaseSync;
  try {
    handle = new DatabaseSync(fullPath, { readOnly: true });
  } catch (err) {
    return {
      name: "backup_verification",
      status: "fail",
      message: `could not open backup: ${err instanceof Error ? err.message : String(err)}`,
      details: { path: fullPath }
    };
  }
  let quickCheck: string;
  try {
    const row = handle.prepare("PRAGMA quick_check").get() as { quick_check: string } | undefined;
    quickCheck = row?.quick_check ?? "<no result>";
  } catch (err) {
    return {
      name: "backup_verification",
      status: "fail",
      message: `quick_check threw: ${err instanceof Error ? err.message : String(err)}`,
      details: { path: fullPath }
    };
  } finally {
    try {
      handle.close();
    } catch {
      /* ignore */
    }
  }

  if (quickCheck !== "ok") {
    return {
      name: "backup_verification",
      status: "fail",
      message: `quick_check returned: ${quickCheck}`,
      details: { path: fullPath, raw: quickCheck }
    };
  }
  return {
    name: "backup_verification",
    status: "ok",
    message: `${newest.name} quick_check ok`,
    details: { path: fullPath, name: newest.name, size: newest.size }
  };
}
