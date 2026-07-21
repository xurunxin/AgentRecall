// src/doctor/checks/scope-safety.ts
//
// Stage 14 PR-C (spec § 9.1): every `memory_entries`
// row whose `scope` is `project` MUST carry a non-null
// `project_id` (the project the entry belongs to).
// A `project` row with `project_id IS NULL` is an
// "orphan" — the entry cannot be listed under any
// project and the project-scope filter would silently
// drop it, breaking the recall contract for the agent.
//
// The check also flags rows whose `project_id` does not
// match any row in `project_scopes` (a deleted / renamed
// project that still has live entries — these belong to
// a stale project and the agent should either re-link
// them or move them out).

import type { CheckContext, CheckResult } from "../types.js";

export function checkScopeSafety(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();

  const orphanRows = handle
    .prepare(
      "SELECT id, scope, project_id FROM memory_entries WHERE scope = 'project' AND (project_id IS NULL OR TRIM(project_id) = '')"
    )
    .all() as Array<{ id: string; scope: string; project_id: string | null }>;

  const staleProjectRows = handle
    .prepare(
      `SELECT m.id, m.project_id
       FROM memory_entries m
       WHERE m.scope = 'project'
         AND m.project_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM project_scopes p WHERE p.project_id = m.project_id)`
    )
    .all() as Array<{ id: string; project_id: string }>;

  const issues: string[] = [];
  if (orphanRows.length > 0) issues.push(`${orphanRows.length} project-scope entries without project_id`);
  if (staleProjectRows.length > 0) issues.push(`${staleProjectRows.length} entries referencing a deleted project_id`);

  if (issues.length > 0) {
    return {
      name: "scope_safety",
      status: "fail",
      message: issues.join("; "),
      details: {
        orphans: orphanRows.slice(0, 10),
        stale_project: staleProjectRows.slice(0, 10)
      }
    };
  }
  return {
    name: "scope_safety",
    status: "ok",
    message: "no orphan or stale-project entries",
    details: { orphans: [], stale_project: [] }
  };
}
