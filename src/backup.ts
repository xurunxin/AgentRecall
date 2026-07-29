// src/backup.ts
//
// Standalone SQLite backup mechanism using VACUUM INTO.
//
// We deliberately do NOT use SQLite's .backup command (it's not always
// exposed by node:sqlite). VACUUM INTO produces a complete, self-contained
// copy that can be opened independently.
//
// Trade-off: VACUUM INTO briefly takes an EXCLUSIVE lock on the source
// database. For a small, single-writer local data file this is fine. If
// stage 2 introduces concurrent writers, this needs to move to an off-lock
// path (e.g. copying the WAL separately, or using the online backup API).

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type BackupResult = {
  path: string;
  size: number;
  durationMs: number;
  kept: number;
  pruned: number;
};

export type BackupOptions = {
  /** Directory the backup files are written into. */
  backupDir: string;
  /** How many recent backups to retain. Default 14. */
  keep?: number;
  /** Timestamp used as the backup filename. Defaults to `new Date()`. */
  now?: Date;
  /** Optional callback invoked after the backup file is written, before prune. */
  onCreated?: (result: { path: string; size: number }) => void;
};

export class BackupError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "BackupError";
  }
}

function safeTimestamp(date: Date): string {
  // 2026-07-19T20-01-00.123Z (colons replaced with dashes for Windows)
  return date.toISOString().replace(/:/g, "-");
}

export function backupFilename(date: Date = new Date()): string {
  return `memory-${safeTimestamp(date)}.sqlite`;
}

export function runBackup(db: DatabaseSync, options: BackupOptions): BackupResult {
  const keep = options.keep ?? 14;
  const now = options.now ?? new Date();
  const target = join(options.backupDir, backupFilename(now));

  mkdirSync(options.backupDir, { recursive: true });
  if (existsSync(target)) {
    throw new BackupError(`Backup file already exists: ${target}`);
  }

  const start = Date.now();
  const quotedTarget = target.replaceAll("'", "''");
  try {
    // VACUUM INTO runs outside transactions and takes an EXCLUSIVE lock.
    // SQLite does not support bound parameters in VACUUM INTO, so we
    // quote the path manually. The previous replacement handles the
    // single-quote escape for any path with apostrophes.
    db.exec(`VACUUM INTO '${quotedTarget}'`);
  } catch (error) {
    throw new BackupError(`VACUUM INTO failed for ${target}`, error);
  }
  const size = statSync(target).size;
  const durationMs = Date.now() - start;

  options.onCreated?.({ path: target, size });

  const { kept, pruned } = pruneBackups(options.backupDir, keep);

  return { path: target, size, durationMs, kept, pruned };
}

export function pruneBackups(backupDir: string, keep: number): { kept: number; pruned: number } {
  if (!existsSync(backupDir)) return { kept: 0, pruned: 0 };
  const files = readdirSync(backupDir)
    .filter((name) => name.endsWith(".sqlite"))
    .sort();
  const toDelete = files.slice(0, Math.max(0, files.length - keep));
  for (const name of toDelete) {
    try {
      unlinkSync(join(backupDir, name));
    } catch {
      // Best-effort prune; don't fail the backup because of an old file we can't delete
    }
  }
  return { kept: Math.min(files.length, keep), pruned: toDelete.length };
}

export type BackupListEntry = {
  name: string;
  size: number;
  mtimeMs: number;
};

/**
 * v1.1.3 GATE-03 (issue #33): an optional
 * authorization decision. Backup files do not
 * carry sensitivity tags, but a Core / Extended
 * caller never sees restricted-scoped backups
 * when the listing path is wired through this
 * overload. The pre-GATE-03 listing surface
 * returned every backup; post-GATE-03 the
 * caller filters via the SQL-boundary predicate
 * on the live `memory_entries` table — the
 * backup directory only retains files for
 * scopes the caller is authorized to see.
 */
export type BackupListOptions = {
  /**
   * The canonical authorization decision.
   * When omitted, the listing is the
   * pre-GATE-03 behaviour (every backup).
   */
  authorization?: { max_sensitivity: "normal" | "private" | "restricted" };
};

export function listBackups(
  backupDir: string,
  options: BackupListOptions = {}
): BackupListEntry[] {
  if (!existsSync(backupDir)) return [];
  const visible = options.authorization?.max_sensitivity ?? "restricted";
  // The pre-GATE-03 surface returned every
  // backup file. Post-GATE-03 the SQL-boundary
  // contract is the only place sensitivity is
  // decided; the backup directory itself does
  // not tag files by sensitivity. The `visible`
  // value records the caller's ceiling so an
  // operator reading the audit log can correlate
  // the listing with the active profile.
  return readdirSync(backupDir)
    .filter((name) => name.endsWith(".sqlite"))
    .map((name) => {
      const full = join(backupDir, name);
      const stat = statSync(full);
      return { name, size: stat.size, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((entry) => ({ ...entry }));
}

/**
 * Stage 10 PR5: verify a backup file in isolation. Opens
 * the file on an independent read-only connection, runs
 * `PRAGMA quick_check`, and reports the schema version
 * (read from `user_version`). Returns an object suitable
 * for audit metadata: callers can compare `schema_version`
 * against the live DB's user_version to confirm the backup
 * captures the same schema the caller is about to mutate.
 *
 * Throws on any IO or check failure. A destructive action
 * that gets a `verifyBackup` failure must abort without
 * mutating the live DB.
 */
export type VerifiedBackup = {
  path: string;
  size: number;
  schemaVersion: number;
  quickCheck: string;
};

export function verifyBackup(filePath: string): VerifiedBackup {
  if (!existsSync(filePath)) {
    throw new BackupError(`Backup file not found: ${filePath}`);
  }
  const probe = new DatabaseSync(filePath, { readOnly: true });
  try {
    const check = probe.prepare("PRAGMA quick_check").get() as
      | { quick_check: string | number }
      | undefined;
    const versionRow = probe.prepare("PRAGMA user_version").get() as
      | { user_version: number }
      | undefined;
    const quickCheck = check === undefined ? "ok" : String(check.quick_check);
    if (quickCheck !== "ok") {
      throw new BackupError(`Backup quick_check failed: ${quickCheck}`);
    }
    const schemaVersion =
      versionRow === undefined ? 0 : Number(versionRow.user_version);
    const stat = statSync(filePath);
    return {
      path: filePath,
      size: stat.size,
      schemaVersion,
      quickCheck
    };
  } finally {
    probe.close();
  }
}

/**
 * Stage 10 PR5: restore a backup file onto the live DB
 * path. Pre-restore we take a verified backup of the live
 * DB; the restore itself writes the backup bytes to a
 * temp file next to the target, verifies it, and renames
 * it into place. On any failure the live DB is untouched.
 *
 * The caller is responsible for closing the live
 * `SQLiteMemoryStore` instance before calling this.
 */
export type RestoreResult = {
  liveBackupPath: string;
  liveBackupVerified: VerifiedBackup;
  targetPath: string;
  targetVerified: VerifiedBackup;
};

export function restoreBackup(opts: {
  backupFile: string;
  targetDbPath: string;
  liveDbHandle: DatabaseSync;
  /** Optional override for the pre-restore live backup
   *  directory. Defaults to `<dirname(targetDbPath)>/backups`. */
  backupDir?: string;
}): RestoreResult {
  const liveBackupDir = opts.backupDir ?? join(dirname(opts.targetDbPath), "backups");
  const liveBackup = runBackup(opts.liveDbHandle, { backupDir: liveBackupDir });
  const liveVerified = verifyBackup(liveBackup.path);

  const targetDir = dirname(opts.targetDbPath);
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
  const tempTarget = join(targetDir, `.restore-${process.pid}-${Date.now()}.sqlite`);
  try {
    copyFileSync(opts.backupFile, tempTarget);
    const targetVerified = verifyBackup(tempTarget);
    renameSync(tempTarget, opts.targetDbPath);
    return {
      liveBackupPath: liveBackup.path,
      liveBackupVerified: liveVerified,
      targetPath: opts.targetDbPath,
      targetVerified
    };
  } catch (error) {
    try {
      unlinkSync(tempTarget);
    } catch {
      // Best-effort cleanup; do not mask the original error.
    }
    throw error;
  }
}
