// src/cli/commands/search.ts
import { flagBool, flagString } from "../arg-parser.js";
import type { CliContext, CliResult } from "../index.js";
import { jsonOut, paint, resolveColorMode, useColor } from "../format.js";
import type { SearchFilters } from "../../sqlite-store.js";

export function searchCommand(ctx: CliContext): CliResult {
  const query = ctx.args.positional[0];
  if (query === undefined) {
    return { exitCode: 1, stdout: "", stderr: "usage: agent-recall search <query> [options]" };
  }
  const scope = (flagString(ctx.args, "scope") ?? "global") as "global" | "project";
  const projectId = flagString(ctx.args, "project-id");
  const actor = flagString(ctx.args, "actor");
  const since = flagString(ctx.args, "since");
  const lastAccessedSince = flagString(ctx.args, "last-accessed-since");
  const updatedSince = flagString(ctx.args, "updated-since");
  const limit = Number.parseInt(flagString(ctx.args, "limit") ?? "10", 10);

  const filters: SearchFilters = { query, scope, status: "active", limit };
  if (projectId !== undefined) filters.project_id = projectId;
  if (actor !== undefined) filters.actor = actor;
  if (since !== undefined) filters.since = since;
  if (lastAccessedSince !== undefined) filters.last_accessed_since = lastAccessedSince;
  if (updatedSince !== undefined) filters.updated_since = updatedSince;

  const items = ctx.store.searchEntries(filters);
  const json = flagBool(ctx.args, "json");
  if (json) {
    return { exitCode: 0, stdout: jsonOut({ items }), stderr: "" };
  }
  const colorMode = resolveColorMode(ctx.args);
  const color = useColor(colorMode);
  if (items.length === 0) {
    return { exitCode: 0, stdout: paint(`no matches for "${query}"`, "dim", color), stderr: "" };
  }
  const body = items
    .map(
      (e) =>
        `${paint(e.id, "cyan", color)}  ${e.title}\n  ${paint(`${e.scope}/${e.type}/${e.topic}`, "dim", color)}`
    )
    .join("\n");
  return { exitCode: 0, stdout: `${body}\n\n${items.length} matches.`, stderr: "" };
}
