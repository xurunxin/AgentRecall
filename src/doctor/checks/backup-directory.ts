import { listBackups } from "../../backup.js";
import type { CheckContext, CheckResult } from "../types.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function checkBackupDirectory(ctx: CheckContext): CheckResult {
  const backupDir = `${ctx.dataHome}/backups`;
  const items = listBackups(backupDir);
  if (items.length === 0) {
    return { name: "backup_directory", status: "ok", message: "no backups present (first run)" };
  }
  const newest = items[0]!;
  const ageMs = ctx.now().getTime() - newest.mtimeMs;
  if (ageMs > SEVEN_DAYS_MS) {
    return {
      name: "backup_directory",
      status: "warn",
      message: `newest backup is ${Math.round(ageMs / 86_400_000)}d old`,
      details: { count: items.length, newest: newest.name, age_ms: ageMs }
    };
  }
  return {
    name: "backup_directory",
    status: "ok",
    message: `${items.length} backups, newest ${Math.round(ageMs / 3_600_000)}h ago`,
    details: { count: items.length, newest: newest.name, age_ms: ageMs }
  };
}
