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
  // Stage 18 v1.1.2 follow-up (review by ora-8):
  // the CLI read path MUST apply the same
  // SQL-boundary sensitivity filter as the MCP /
  // service layer. The CLI is fail-closed
  // (`actorMaxSensitivity: "normal"`) so a
  // `private` / `restricted` row returns a
  // stable `forbidden_visibility` error without
  // leaking title / body / tags. A future
  // operator-facing flag can opt in to the
  // broader sensitivity; the v1.1.2 contract
  // pins the default to `"normal"`.
  const entry = ctx.store.peekEntry(id, { actorMaxSensitivity: "normal" });
  if (entry === undefined) {
    // Distinguish `forbidden_visibility` from
    // `not_found` so a script can branch on the
    // failure mode. The privileged peek is the
    // diagnostic helper (mirrors the MCP
    // resource path).
    const raw = ctx.store.peekEntry(id);
    if (raw !== undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `forbidden_visibility: memory ${id} exceeds the operator's maximum sensitivity (${raw.sensitivity}); install an admin capability via \`agent-recall admin grant\` to surface this row`
      };
    }
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
