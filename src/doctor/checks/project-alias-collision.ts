// src/doctor/checks/project-alias-collision.ts
//
// Stage 14 PR-C (spec § 9.1): `project_scopes.canonical_path`
// is the on-disk identifier the scope resolver uses to
// map a working directory to a project. Two project
// scopes with the same `canonical_path` would either
// shadow each other (the second one wins, the first
// one's entries become invisible) or surface a duplicate
// row the v4 schema does not enforce at the DB level.
//
// The check groups by `canonical_path` and surfaces
// collisions. A single scope per path is `ok`; two or
// more is `fail`.

import type { CheckContext, CheckResult } from "../types.js";

export function checkProjectAliasCollision(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();
  const rows = handle
    .prepare(
      `SELECT canonical_path, GROUP_CONCAT(project_id, ',' ORDER BY project_id ASC) AS project_ids
       FROM project_scopes
       WHERE canonical_path IS NOT NULL AND TRIM(canonical_path) != ''
       GROUP BY canonical_path
       HAVING COUNT(*) > 1`
    )
    .all() as Array<{ canonical_path: string; project_ids: string }>;

  if (rows.length > 0) {
    return {
      name: "project_alias_collision",
      status: "fail",
      message: `${rows.length} canonical_path collision(s)`,
      details: {
        collisions: rows.map((r) => ({ canonical_path: r.canonical_path, project_ids: r.project_ids.split(",") }))
      }
    };
  }

  const total = handle
    .prepare("SELECT COUNT(*) AS n FROM project_scopes WHERE canonical_path IS NOT NULL AND TRIM(canonical_path) != ''")
    .get() as { n: number };
  return {
    name: "project_alias_collision",
    status: "ok",
    message: `${total.n} project scopes, no canonical_path collisions`,
    details: { total: total.n }
  };
}
