// src/doctor/checks/audit-revision-gap.ts
//
// Stage 14 PR-C (spec § 9.1 / § 5.2): every accepted
// mutation event ("created", "updated", "superseded",
// "forgotten", "archived") MUST carry a `request_id` in
// its `metadata_json` AND a `revision` in its
// `metadata_json` (the latter is the post-image revision
// the agent will see on re-read). The `created` event
// seeded in PR-B1 carries `request_id` via the per-call
// RequestContext. `updated` / `superseded` / `forgotten`
// events were extended in PR-B2 to record the entry's
// `revision` in metadata (via the `memory_revisions`
// `change_reason` field on the post-image row).
//
// A gap means a request reached the server but neither
// of the two correlation fields was recorded — the agent
// cannot reason about the state change. This check walks
// the audit log and counts events missing either field.

import type { CheckContext, CheckResult } from "../types.js";

const MUTATION_EVENTS = ["created", "updated", "superseded", "forgotten", "archived", "merged"];

export function checkAuditRevisionGap(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();
  const rows = handle
    .prepare(
      `SELECT id, event, metadata_json
       FROM audit_events
       WHERE event IN (${MUTATION_EVENTS.map(() => "?").join(",")})
       ORDER BY created_at ASC`
    )
    .all(...MUTATION_EVENTS) as Array<{ id: string; event: string; metadata_json: string | null }>;

  const missingRequestId: string[] = [];
  const missingRevision: string[] = [];

  for (const row of rows) {
    let metadata: Record<string, unknown> = {};
    if (typeof row.metadata_json === "string" && row.metadata_json.length > 0) {
      try {
        const parsed = JSON.parse(row.metadata_json);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          metadata = parsed as Record<string, unknown>;
        }
      } catch {
        // Treat unparseable metadata as empty.
      }
    }
    const reqId = metadata.request_id;
    if (typeof reqId !== "string" || reqId.length === 0) {
      missingRequestId.push(row.id);
    }
    const rev = metadata.revision;
    if (typeof rev !== "number" || !Number.isInteger(rev) || rev < 0) {
      missingRevision.push(row.id);
    }
  }

  const issues: string[] = [];
  if (missingRequestId.length > 0) issues.push(`${missingRequestId.length} mutation events missing request_id`);
  if (missingRevision.length > 0) issues.push(`${missingRevision.length} mutation events missing revision`);

  if (issues.length > 0) {
    return {
      name: "audit_revision_gap",
      status: "warn",
      message: issues.join("; "),
      details: {
        total: rows.length,
        missing_request_id: missingRequestId.slice(0, 10),
        missing_revision: missingRevision.slice(0, 10)
      }
    };
  }
  return {
    name: "audit_revision_gap",
    status: "ok",
    message: `${rows.length} mutation events, all carry request_id and revision`,
    details: { total: rows.length }
  };
}
