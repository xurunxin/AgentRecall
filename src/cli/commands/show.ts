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
  const entry = ctx.store.peekEntry(id);
  if (entry === undefined) {
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
