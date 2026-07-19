// src/cli/commands/audit.ts
import { flagBool } from "../arg-parser.js";
import type { CliContext, CliResult } from "../index.js";
import { jsonOut, paint, resolveColorMode, useColor } from "../format.js";
import { parseActor } from "../../actor.js";

export function auditCommand(ctx: CliContext): CliResult {
  const id = ctx.args.positional[0];
  if (id === undefined) {
    return { exitCode: 1, stdout: "", stderr: "usage: agent-recall audit <memory_id>" };
  }
  const events = ctx.store.getAuditEvents(id);
  if (events.length === 0) {
    return { exitCode: 1, stdout: "", stderr: `no audit events for ${id}` };
  }
  const json = flagBool(ctx.args, "json");
  if (json) {
    return { exitCode: 0, stdout: jsonOut({ events }), stderr: "" };
  }
  const colorMode = resolveColorMode(ctx.args);
  const color = useColor(colorMode);
  const body = events
    .map((a) => {
      const actor = parseActor(a.actor);
      return `${a.created_at}  ${a.event.padEnd(16)}  ${paint(actor.raw, "cyan", color)}${a.reason ? `  reason=${a.reason}` : ""}`;
    })
    .join("\n");
  return { exitCode: 0, stdout: body, stderr: "" };
}
