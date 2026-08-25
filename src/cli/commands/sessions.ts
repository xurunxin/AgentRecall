// src/cli/commands/sessions.ts
//
// v1.2.0-alpha.1 (issue #49): the `agent-recall
// sessions ...` subcommand. Four verbs:
//
//   inspect  -- parse + display a bundle plan (no DB write)
//   ingest   -- parse + ingest a JSONL bundle (atomic)
//   list     -- show the captured sessions newest first
//   show     -- inspect one session + its events
//   forget   -- delete a session + its events (blob rows kept)

import { flagBool, flagString } from "../arg-parser.js";
import { jsonOut } from "../format.js";
import type { CliContext, CliResult } from "../index.js";
import { SessionService } from "../../sessions/service.js";
import { JsonlSessionAdapter } from "../../sessions/adapters/jsonl.js";
import type { ProjectIdentityResolver } from "../../scope-resolver.js";
import type { SessionRow } from "../../sqlite-store.js";

const HELP = `agent-recall sessions — manage captured session traces

Usage:
  agent-recall sessions inspect <bundle.jsonl> [--json]
  agent-recall sessions ingest   <bundle.jsonl> [--json]
  agent-recall sessions list     [--scope <global|project>] [--project-id <id>] [--limit <n>] [--json]
  agent-recall sessions show     <session_id> [--json]
  agent-recall sessions forget   <session_id> [--json]

Subcommands:
  inspect  Parse a JSONL bundle and print the planned ingestion result (no DB write).
  ingest   Parse + ingest a JSONL bundle atomically.
  list     List captured sessions, newest first.
  show     Inspect one session + its events.
  forget   Delete a session + its event rows (blob rows are content-addressed
           and may be referenced by other sessions; GC runs in #55).

Flags:
  --scope <s>           Filter (list) to a single scope.
  --project-id <id>     Filter (list) to a single project.
  --limit <n>           Cap (list) row count (default 50).
  --json                Emit JSON.
`;

function service(ctx: CliContext): SessionService {
  const resolver: ProjectIdentityResolver | undefined = ctx.identityResolver;
  return new SessionService(ctx.store, resolver);
}

function sessionRowToJson(row: SessionRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    session_id: row.session_id,
    source_kind: row.source_kind,
    source_version: row.source_version,
    source_instance_id: row.source_instance_id,
    source_session_id: row.source_session_id,
    scope: row.scope,
    actor_id: row.actor_id,
    client_name: row.client_name,
    client_version: row.client_version,
    started_at: row.started_at,
    ended_at: row.ended_at,
    sensitivity: row.sensitivity,
    bundle_hash: row.bundle_hash,
    adapter_id: row.adapter_id,
    adapter_version: row.adapter_version,
    ingested_at: row.ingested_at,
    retention_until: row.retention_until
  };
  if (row.project_id !== null) out["project_id"] = row.project_id;
  return out;
}

export async function sessionsCommand(ctx: CliContext): Promise<CliResult> {
  const sub = ctx.args.positional[0] ?? "help";
  switch (sub) {
    case "inspect":
      return sessionsInspect(ctx);
    case "ingest":
      return sessionsIngest(ctx);
    case "list":
      return sessionsList(ctx);
    case "show":
      return sessionsShow(ctx);
    case "forget":
      return sessionsForget(ctx);
    case "help":
    case "--help":
    case "-h":
      return { exitCode: 0, stdout: HELP, stderr: "" };
    default:
      return {
        exitCode: 1,
        stdout: "",
        stderr: `[usage_error] unknown sessions subcommand: ${sub}\n\n${HELP}`
      };
  }
}

function requireBundlePath(ctx: CliContext): string {
  const path = ctx.args.positional[1];
  if (path === undefined || path === "") {
    return "__missing__";
  }
  return path;
}

async function sessionsInspect(ctx: CliContext): Promise<CliResult> {
  const json = flagBool(ctx.args, "json");
  const path = requireBundlePath(ctx);
  if (path === "__missing__") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "[usage_error] sessions inspect requires a <bundle.jsonl> argument"
    };
  }
  const adapter = new JsonlSessionAdapter();
  const result = await adapter.parseFile(path);
  if (!result.ok) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `[adapter_error] ${result.error}${result.line !== undefined ? ` (line ${result.line})` : ""}`
    };
  }
  if (json) {
    return {
      exitCode: 0,
      stdout: jsonOut({ ok: true, line_count: result.line_count, bundle: result.bundle }),
      stderr: ""
    };
  }
  const lines: string[] = [];
  lines.push(`bundle_id: ${result.bundle.bundle_id}`);
  lines.push(`source: ${result.bundle.source_kind} ${result.bundle.source_version} (${result.bundle.source_instance_id})`);
  lines.push(`source_session_id: ${result.bundle.source_session_id}`);
  lines.push(`events: ${result.line_count}`);
  lines.push(`scope: ${result.bundle.scope} ${result.bundle.project_id ? `(${result.bundle.project_id})` : ""}`);
  return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}

async function sessionsIngest(ctx: CliContext): Promise<CliResult> {
  const json = flagBool(ctx.args, "json");
  const path = requireBundlePath(ctx);
  if (path === "__missing__") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "[usage_error] sessions ingest requires a <bundle.jsonl> argument"
    };
  }
  const adapter = new JsonlSessionAdapter();
  const result = await adapter.parseFile(path);
  if (!result.ok) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `[adapter_error] ${result.error}${result.line !== undefined ? ` (line ${result.line})` : ""}`
    };
  }
  try {
    const ingest = service(ctx).ingest(result.bundle);
    if (json) {
      return {
        exitCode: 0,
        stdout: jsonOut({
          session_id: ingest.session_id,
          bundle_hash: ingest.bundle_hash,
          replayed: ingest.replayed,
          plan: ingest.plan
        }),
        stderr: ""
      };
    }
    const lines: string[] = [];
    lines.push(`session_id: ${ingest.session_id}`);
    lines.push(`bundle_hash: ${ingest.bundle_hash}`);
    lines.push(`replayed: ${ingest.replayed}`);
    lines.push(
      `plan: accepted=${ingest.plan.accepted} redacted=${ingest.plan.redacted} ` +
        `skipped=${ingest.plan.skipped} rejected=${ingest.plan.rejected}`
    );
    return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: `[ingest_error] ${message}` };
  }
}

function sessionsList(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const scope = flagString(ctx.args, "scope") as "global" | "project" | undefined;
  const projectId = flagString(ctx.args, "project-id");
  const limit = Number(flagString(ctx.args, "limit") ?? "50");
  const rows = service(ctx).list({
    ...(scope !== undefined ? { scope } : {}),
    ...(projectId !== undefined ? { project_id: projectId } : {}),
    limit: Number.isFinite(limit) ? limit : 50
  });
  if (json) {
    return { exitCode: 0, stdout: jsonOut({ sessions: rows.map(sessionRowToJson) }), stderr: "" };
  }
  const lines: string[] = [];
  lines.push("SESSION_ID                        SOURCE            ADAPTER  STATE    INGESTED");
  for (const r of rows) {
    const id = r.session_id.padEnd(34);
    const src = `${r.source_kind}`.padEnd(18);
    const ad = r.adapter_id.padEnd(8);
    const st = "ok".padEnd(8);
    const ing = r.ingested_at;
    lines.push(`${id} ${src} ${ad} ${st} ${ing}`);
  }
  return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}

function sessionsShow(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const sessionId = ctx.args.positional[1];
  if (sessionId === undefined || sessionId === "") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "[usage_error] sessions show requires a <session_id> argument"
    };
  }
  const inspection = service(ctx).inspect(sessionId);
  if (inspection === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `[session_not_found] no session with id ${sessionId}`
    };
  }
  if (json) {
    return {
      exitCode: 0,
      stdout: jsonOut({
        session: sessionRowToJson(inspection.session),
        events: inspection.events.map((e) => ({
          event_id: e.event_id,
          sequence: e.sequence,
          turn_id: e.turn_id,
          event_type: e.event_type,
          role: e.role,
          content_digest: e.content_digest,
          tool_name: e.tool_name,
          tool_call_id: e.tool_call_id,
          timestamp: e.timestamp,
          sensitivity: e.sensitivity,
          redaction_flags: e.redaction_flags_json,
          metadata: e.metadata_json
        })),
        plan: inspection.plan
      }),
      stderr: ""
    };
  }
  const lines: string[] = [];
  const s = inspection.session;
  lines.push(`session_id:       ${s.session_id}`);
  lines.push(`source:            ${s.source_kind} ${s.source_version} (${s.source_instance_id})`);
  lines.push(`source_session_id: ${s.source_session_id}`);
  lines.push(`scope:             ${s.scope} ${s.project_id ? `(${s.project_id})` : ""}`);
  lines.push(`actor:             ${s.actor_id}`);
  lines.push(`bundle_hash:       ${s.bundle_hash}`);
  lines.push(`ingested_at:       ${s.ingested_at}`);
  lines.push("");
  lines.push(
    `plan: accepted=${inspection.plan.accepted} redacted=${inspection.plan.redacted} ` +
      `skipped=${inspection.plan.skipped} rejected=${inspection.plan.rejected}`
  );
  lines.push("");
  lines.push(`events (${inspection.events.length}):`);
  for (const e of inspection.events) {
    lines.push(
      `  - ${e.event_id} seq=${e.sequence} ${e.event_type} ts=${e.timestamp} ` +
        `digest=${e.content_digest}`
    );
  }
  return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}

function sessionsForget(ctx: CliContext): CliResult {
  const json = flagBool(ctx.args, "json");
  const sessionId = ctx.args.positional[1];
  if (sessionId === undefined || sessionId === "") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "[usage_error] sessions forget requires a <session_id> argument"
    };
  }
  const ok = service(ctx).forget(sessionId);
  if (!ok) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `[session_not_found] no session with id ${sessionId}`
    };
  }
  if (json) {
    return { exitCode: 0, stdout: jsonOut({ session_id: sessionId, forgotten: true }), stderr: "" };
  }
  return { exitCode: 0, stdout: `forgot ${sessionId}\n`, stderr: "" };
}
