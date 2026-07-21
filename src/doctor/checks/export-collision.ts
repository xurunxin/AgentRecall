// src/doctor/checks/export-collision.ts
//
// Stage 14 PR-C (spec § 9.1 / § 6.7): the markdown
// exporter groups entries by `scope` / `project_id` /
// `topic` and writes one topic file per group. A
// collision in this layout means two live memories
// that would render into the same topic file — either
// the exporter (or a hand-edited export) will silently
// drop one entry on import, or the importer will
// surface a `manifest_hash` mismatch the agent cannot
// resolve.
//
// The v1 markdown exporter already dedupes topic
// slugs via `buildTopicFilenameMap` (slug + shortHash
// on collision), so the question this check answers
// is one level up: do any two memories claim the same
// (scope, project_id, topic) tuple? A shared tuple
// means the same topic file holds both entries; the
// import side may still work (it appends), but the
// agent that hand-edits the export will lose the
// pairing between memory and file on the next
// re-export.

import type { CheckContext, CheckResult } from "../types.js";

export function checkExportCollision(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();
  const rows = handle
    .prepare(
      `SELECT scope, COALESCE(project_id, '') AS project_id, topic, COUNT(*) AS c
       FROM memory_entries
       WHERE status IN ('active', 'archived')
       GROUP BY scope, project_id, topic
       HAVING c > 1
       ORDER BY c DESC`
    )
    .all() as Array<{ scope: string; project_id: string; topic: string; c: number }>;

  if (rows.length > 0) {
    return {
      name: "export_collision",
      status: "warn",
      message: `${rows.length} (scope, project, topic) groups have > 1 entry (shared topic file)`,
      details: {
        groups: rows.slice(0, 10)
      }
    };
  }

  const total = handle
    .prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE status IN ('active', 'archived')")
    .get() as { n: number };
  return {
    name: "export_collision",
    status: "ok",
    message: `${total.n} entries, each in its own topic group`,
    details: { total: total.n }
  };
}
