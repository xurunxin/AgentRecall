// src/cli/commands/list.ts
import { flagBool, flagString } from "../arg-parser.js";
import type { CliContext, CliResult } from "../index.js";
import { jsonOut, paint, resolveColorMode, useColor } from "../format.js";

export function listCommand(ctx: CliContext): CliResult {
  const scope = (flagString(ctx.args, "scope") ?? "global") as "global" | "project";
  const projectId = flagString(ctx.args, "project-id");
  const status = flagString(ctx.args, "status") ?? "active";
  const limit = Number.parseInt(flagString(ctx.args, "limit") ?? "20", 10);
  const offset = Number.parseInt(flagString(ctx.args, "offset") ?? "0", 10);

  const filters: Record<string, unknown> = { scope, status, limit, offset };
  if (projectId !== undefined) filters.project_id = projectId;

  const items = ctx.store.listEntries(filters);
  const json = flagBool(ctx.args, "json");
  if (json) {
    return { exitCode: 0, stdout: jsonOut({ items }), stderr: "" };
  }

  const colorMode = resolveColorMode(ctx.args);
  const color = useColor(colorMode);
  if (items.length === 0) {
    return { exitCode: 0, stdout: paint("no memories found", "dim", color), stderr: "" };
  }
  const widths = [36, 12, 24, 4, 24] as const;
  const header = ["ID", "TYPE", "TITLE", "IMP", "UPDATED"];
  const title = paint(
    header.map((h, i) => h.padEnd(widths[i] ?? 0)).join("  "),
    "bold",
    color
  );
  const body = items
    .map((e) => [e.id, e.type, e.title, String(e.importance), e.updated_at])
    .map((r) => r.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  "))
    .join("\n");
  const count = paint(`\n\n${items.length} entries.`, "dim", color);
  return { exitCode: 0, stdout: `${title}\n${body}${count}`, stderr: "" };
}
