// src/cli/commands/export.ts
import { flagString } from "../arg-parser.js";
import type { CliContext, CliResult } from "../index.js";
import { FormatRouter, type ExportFormat } from "../../format-exporters.js";
import { join } from "node:path";
import { resolveMemoryScope } from "../../scope-resolver.js";
import type { MemoryScope } from "../../domain.js";

export function exportCommand(ctx: CliContext): CliResult {
  const scope = (flagString(ctx.args, "scope") ?? "global") as MemoryScope;
  const projectId = flagString(ctx.args, "project-id");
  const projectPath = flagString(ctx.args, "project-path");
  const out = flagString(ctx.args, "out");
  const formatRaw = flagString(ctx.args, "format") ?? "markdown";
  if (formatRaw !== "markdown" && formatRaw !== "json" && formatRaw !== "yaml") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `usage: agent-recall export --format markdown|json|yaml (got "${formatRaw}")`
    };
  }
  const format: ExportFormat = formatRaw;

  const resolved = resolveMemoryScope({
    scope,
    ...(projectId ? { project_id: projectId } : {}),
    ...(projectPath ? { project_path: projectPath } : {})
  });
  if (!resolved.ok) {
    return { exitCode: 1, stdout: "", stderr: resolved.message };
  }
  const filters: Record<string, unknown> = { scope: resolved.value.scope, status: "active", limit: 10_000 };
  if (resolved.value.project_id) filters.project_id = resolved.value.project_id;
  const entries = ctx.store.listEntries(filters);

  const router = new FormatRouter(out ?? join(ctx.dataHome, "exports"));
  const result = router.export({
    scope: resolved.value.scope,
    ...(resolved.value.project_id ? { project_id: resolved.value.project_id } : {}),
    entries,
    budgetStatus: ctx.store.getBudgetUsage({
      scope: resolved.value.scope,
      ...(resolved.value.project_id ? { project_id: resolved.value.project_id } : {})
    }),
    format
  });
  return {
    exitCode: 0,
    stdout: `exported (${format}): ${result.indexPath} (+ ${result.topicPaths.length} topic files)`,
    stderr: ""
  };
}
