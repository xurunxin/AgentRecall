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

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

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

export function listBackups(backupDir: string): BackupListEntry[] {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((name) => name.endsWith(".sqlite"))
    .map((name) => {
      const full = join(backupDir, name);
      const stat = statSync(full);
      return { name, size: stat.size, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}
