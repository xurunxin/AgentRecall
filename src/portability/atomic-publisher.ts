// src/portability/atomic-publisher.ts
//
// Stage 13 PR10 (spec § 6.7): the shared atomic file
// publisher. All three exporters (markdown / json / yaml)
// use the same stage-then-rename strategy so a write
// either completes fully or leaves the live export
// untouched. The previous Stage 8 implementation had
// this logic duplicated in `markdown-exporter.ts` and
// `format-exporters.ts`; PR10 lifts it here.
//
// The two-step contract:
//
//   1. `stageFiles(root, scopeDir, writeScopeFiles)`:
//      writes into a temp dir under `root/.staging/`. The
//      temp dir's path is returned in `stagingRoot`. No
//      rename happens; the live export is untouched.
//   2. `publishStagedFiles(staged, liveScopeDir)`: atomically
//      moves the live export (if any) to a backup, then
//      renames the staged dir over the live path. Returns
//      a `PublishedScope` handle that owns the cleanup.
//
// Splitting the two steps preserves the legacy "stage,
// then publish" two-phase API. The pre-PR10 `MarkdownExporter`
// (and the failing-stage test fixture) relied on
// `stageScope` being a pure write — the throw inside
// the staged scope did not have to be undone because
// nothing was published yet. The unified exporter
// keeps the same property: `stageScope` is write-only,
// `publishStagedScope` is the rename.

import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type ScopeFiles = {
  indexPath: string;
  topicPaths: string[];
};

export type StagedScope = ScopeFiles & {
  stagingRoot: string;
  stagingScopeDir: string;
  scopeDir: string;
};

export type PublishedScope = ScopeFiles & {
  complete(): void;
  rollback(): void;
};

function uniquePath(parent: string, prefix: string): string {
  let index = 0;
  while (true) {
    const candidate = join(parent, `${prefix}-${process.pid}-${Date.now()}-${index}`);
    if (!existsSync(candidate)) return candidate;
    index += 1;
  }
}

/**
 * Write a scope's files to a temp dir under
 * `root/.staging/`. The temp dir's path is returned;
 * the live export is NOT touched. The caller decides
 * when (and whether) to publish.
 *
 * On error the staging dir is removed and the error
 * rethrown. The caller does not need to clean up
 * anything on failure.
 */
export function stageFiles(
  root: string,
  scopeDir: string,
  writeScopeFiles: (stagingScopeDir: string) => ScopeFiles
): StagedScope {
  const stagingParent = join(root, ".staging");
  mkdirSync(stagingParent, { recursive: true });
  const stagingRoot = mkdtempSync(join(stagingParent, "export-"));
  const stagingScopeDir = join(stagingRoot, basename(scopeDir));
  mkdirSync(stagingScopeDir, { recursive: true });

  try {
    const files = writeScopeFiles(stagingScopeDir);
    return {
      indexPath: files.indexPath,
      topicPaths: files.topicPaths,
      stagingRoot,
      stagingScopeDir,
      scopeDir
    };
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Atomically promote a previously-staged scope to live.
 * If a live export already exists, it is moved to
 * `root/.backup-{scope}-{pid}-{ts}-{n}/` first; the
 * backup is removed on `complete()` and restored on
 * `rollback()`.
 */
export function publishStagedFiles(staged: StagedScope): PublishedScope {
  const parent = dirname(staged.scopeDir);
  mkdirSync(parent, { recursive: true });
  const backupDir = uniquePath(parent, `.backup-${basename(staged.scopeDir)}`);
  const hadLiveExport = existsSync(staged.scopeDir);
  let active = true;

  if (hadLiveExport) {
    renameSync(staged.scopeDir, backupDir);
  }
  try {
    renameSync(staged.stagingScopeDir, staged.scopeDir);
  } catch (error) {
    if (hadLiveExport) {
      try {
        renameSync(backupDir, staged.scopeDir);
      } catch {
        // The live export is gone and the backup could not
        // be restored. The caller will see the original
        // rename error and decide how to recover.
      }
    }
    rmSync(staged.stagingRoot, { recursive: true, force: true });
    active = false;
    throw error;
  }

  return {
    indexPath: staged.indexPath,
    topicPaths: staged.topicPaths,
    complete: () => {
      if (!active) return;
      try {
        rmSync(staged.stagingRoot, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      try {
        if (hadLiveExport) rmSync(backupDir, { recursive: true, force: true });
      } catch {
        // leaving a backup is safer than reporting failure
      }
      active = false;
    },
    rollback: () => {
      if (!active) return;
      try {
        rmSync(staged.scopeDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      if (hadLiveExport && existsSync(backupDir)) {
        try {
          renameSync(backupDir, staged.scopeDir);
        } catch {
          // the backup might be on a different filesystem;
          // surface via the original error already thrown
        }
      }
      try {
        rmSync(staged.stagingRoot, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      active = false;
    }
  };
}

/**
 * Convenience wrapper: stage + publish in one call.
 * Equivalent to `stageFiles(...)` followed by
 * `publishStagedFiles(...)`.
 */
export function stageAndPublish(
  root: string,
  scopeDir: string,
  writeScopeFiles: (stagingScopeDir: string) => ScopeFiles
): PublishedScope {
  const staged = stageFiles(root, scopeDir, writeScopeFiles);
  return publishStagedFiles(staged);
}

/**
 * Compute the live scope directory under `root` for a
 * given scope + project_id. Shared by the exporters.
 */
export function scopeDirFor(
  root: string,
  scope: "global" | "project",
  projectId?: string
): string {
  return scope === "global" ? join(root, "global") : join(root, "projects", projectId ?? "unknown-project");
}
