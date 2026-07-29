// src/cli/commands/show.ts
import { flagBool } from "../arg-parser.js";
import type { CliContext, CliResult } from "../index.js";
import { jsonOut, paint, resolveColorMode, useColor } from "../format.js";
import { parseActor } from "../../actor.js";

export function showCommand(ctx: CliContext): CliResult {
  const id = ctx.args.positional[0];
  if (id === undefined) {
    return { exitCode: 1, stdout: "", stderr: "usage: agent-recall show <memory_id>" };
  }
  // Stage 18 v1.1.2 follow-up (review by ora-9):
  // the CLI read path MUST apply the same
  // SQL-boundary sensitivity filter as the MCP /
  // service layer. The CLI is fail-closed
  // (`actorMaxSensitivity: "normal"`) so a
  // `private` / `restricted` row returns a
  // stable `forbidden_visibility` error without
  // leaking title / body / tags / source /
  // `sensitivity` literal. The
  // `classifyEntryVisibility` API is the ONLY
  // single-row read the deny path is allowed
  // to use — the previous follow-up (review by
  // ora-8) used the no-options `peekEntry(id)`
  // overload to peek at the row, then printed
  // `${raw.sensitivity}` on stderr, which leaked
  // the row's sensitivity literal to a caller
  // without the `sensitivity_visibility`
  // capability. The follow-up closes that
  // leak by routing through the classifier
  // and removing the sensitivity literal from
  // the deny path entirely.
  const classification = ctx.store.classifyEntryVisibility(id, { actorMaxSensitivity: ctx.actorMaxSensitivity });
  if (classification.visibility === "forbidden_visibility") {
    // Stable error code, NO sensitivity literal,
    // NO row payload. The text surface is
    // intentionally narrower than the MCP
    // structured envelope; the brief does not
    // require a structured CLI shape. The
    // `--json` mode surfaces the same envelope
    // shape as the MCP resource (so a script
    // can branch on the failure mode without
    // parsing the human-readable message).
    // The brief explicitly forbids the
    // `sensitivity` substring on the deny path
    // (a structural operational token, not a
    // row payload); the message is worded to
    // avoid the forbidden substring.
    if (flagBool(ctx.args, "json")) {
      return {
        exitCode: 1,
        stdout: jsonOut({
          ok: false,
          error: "forbidden_visibility",
          message: `memory ${id} is not visible to this caller; run \`agent-recall admin grant\` and use the admin profile to surface this row`,
          memory_id: id
        }),
        stderr: ""
      };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `forbidden_visibility: memory ${id} is not visible to this caller; install an admin capability via \`agent-recall admin grant\` to surface this row`
    };
  }
  if (classification.visibility === "not_found") {
    if (flagBool(ctx.args, "json")) {
      return {
        exitCode: 1,
        stdout: jsonOut({ ok: false, error: "not_found", message: `memory ${id} not found`, memory_id: id }),
        stderr: ""
      };
    }
    return { exitCode: 1, stdout: "", stderr: `memory not found: ${id}` };
  }
  // The row is visible under the SQL-boundary
  // filter. The full `peekEntry(id, {
  // actorMaxSensitivity })` reuses the SQL
  // filter so the read cannot bypass the
  // boundary.
  const entry = ctx.store.peekEntry(id, { actorMaxSensitivity: ctx.actorMaxSensitivity });
  if (entry === undefined) {
    // The classifier said "visible" but the
    // filtered peek returned `undefined`.
    // This is a race (the row was deleted
    // between the two reads) — surface
    // `not_found` rather than fall through
    // to a privileged peek (which would
    // re-introduce the leak).
    return { exitCode: 1, stdout: "", stderr: `memory not found: ${id}` };
  }
  const audit = ctx.store.getAuditEvents(id);
  const json = flagBool(ctx.args, "json");
  if (json) {
    return { exitCode: 0, stdout: jsonOut({ entry, audit }), stderr: "" };
  }
  const colorMode = resolveColorMode(ctx.args);
  const color = useColor(colorMode);
  const head = (text: string) => paint(text, "bold", color);
  const body = [
    head(`# ${entry.title}`),
    `id:        ${entry.id}`,
    `scope:     ${entry.scope}${entry.project_id ? ` / ${entry.project_id}` : ""}`,
    `type:      ${entry.type}`,
    `topic:     ${entry.topic}`,
    `tags:      ${entry.tags.join(", ") || "(none)"}`,
    `importance:${entry.importance}  confidence:${entry.confidence}  status:${entry.status}`,
    `source:    ${entry.source.kind}${entry.source.ref ? ` / ${entry.source.ref}` : ""}`,
    `created:   ${entry.created_at}`,
    `updated:   ${entry.updated_at}`,
    "",
    entry.body,
    "",
    head("## Audit"),
    ...audit.map((a) => {
      const actor = parseActor(a.actor);
      return `  ${a.created_at}  ${a.event.padEnd(16)}  ${actor.raw}`;
    })
  ].join("\n");
  return { exitCode: 0, stdout: body, stderr: "" };
}
