// src/cli/commands/import.ts
//
// Stage 13 PR10 (spec § 6.7): the `agent-recall import`
// command. Reads a previously-exported scope (the
// manifest + per-topic files) and replays the entries
// into the live SQLite store.
//
// Usage:
//   agent-recall import --from <export-root> --scope global
//   agent-recall import --from <export-root> --scope project --project-id repo-a
//   agent-recall import --from <export-root> --scope global --format json
//   agent-recall import --from <export-root> --scope global --dry-run
//   agent-recall import --from <export-root> --scope global --conflict keep|replace|merge|fail
//
// The default conflict policy is `keep`: existing
// entries are preserved and new entries are inserted.
// `--dry-run` plans the import without writing; the
// plan is printed to stdout (JSON when `--json` is
// passed, otherwise a human-readable table).

import { join } from "node:path";
import { flagString, flagBool } from "../arg-parser.js";
import type { CliContext, CliResult } from "../index.js";
import { MemoryService } from "../../memory-service.js";
import { MarkdownExporter } from "../../markdown-exporter.js";
import { resolveActor } from "../../actor.js";
import { importMemoryExport, type ConflictPolicy } from "../../portability/importer.js";
import type { MemoryScope } from "../../domain.js";

export function importCommand(ctx: CliContext): CliResult {
  const fromRaw = flagString(ctx.args, "from");
  if (fromRaw === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "usage: agent-recall import --from <export-root> [--scope global|project] [--project-id <id>] [--format json|yaml] [--conflict keep|replace|merge|fail] [--dry-run]"
    };
  }
  const scope = (flagString(ctx.args, "scope") ?? "global") as MemoryScope;
  const projectId = flagString(ctx.args, "project-id");
  const formatRaw = flagString(ctx.args, "format") ?? "json";
  // Stage 15 PR-M0-3 (issue #4, spec § 6.7): YAML
  // import is no longer supported. The CLI now
  // rejects `--format yaml` explicitly so the
  // caller doesn't waste a round-trip discovering
  // the format isn't implemented.
  if (formatRaw !== "json") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `usage: agent-recall import --format json (yaml is no longer supported; got "${formatRaw}")`
    };
  }
  const conflictRaw = flagString(ctx.args, "conflict") ?? "keep";
  if (conflictRaw !== "keep" && conflictRaw !== "replace" && conflictRaw !== "merge" && conflictRaw !== "fail") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `usage: agent-recall import --conflict keep|replace|merge|fail (got "${conflictRaw}")`
    };
  }
  const conflict: ConflictPolicy = conflictRaw;
  const dryRun = flagBool(ctx.args, "dry-run") === true;
  const json = flagBool(ctx.args, "json") === true;

  if (scope === "project" && projectId === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "import --scope project requires --project-id"
    };
  }

  // The exporter is required by the MemoryService
  // constructor even when we never call it. Pass a
  // throwaway path under the data home; we won't write
  // any markdown during an import.
  const exporter = new MarkdownExporter(join(ctx.dataHome, "exports"));
  const service = new MemoryService(ctx.store, exporter, resolveActor(undefined), ctx.dataHome);

  const exportScopeDir =
    scope === "global"
      ? join(fromRaw, "global")
      : join(fromRaw, "projects", projectId ?? "unknown-project");

  try {
    const result = importMemoryExport(
      service,
      exportScopeDir,
      scope,
      projectId,
      formatRaw,
      { conflict, dry_run: dryRun, actor: resolveActor(undefined) }
    );
    if (json) {
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          {
            dry_run: dryRun,
            conflict,
            scope: result.plan.scope,
            project_id: result.plan.project_id,
            inserts: result.plan.inserts.length,
            replacements: result.plan.replacements.length,
            skipped: result.plan.skipped.length,
            decisions: result.plan.decisions,
            duration_ms: result.duration_ms
          },
          null,
          2
        ),
        stderr: ""
      };
    }
    const lines: string[] = [];
    lines.push(`import plan (${dryRun ? "dry-run" : "applied"}):`);
    lines.push(`  scope: ${result.plan.scope}`);
    if (result.plan.project_id !== undefined) {
      lines.push(`  project_id: ${result.plan.project_id}`);
    }
    lines.push(`  conflict: ${conflict}`);
    lines.push(`  inserts: ${result.plan.inserts.length}`);
    lines.push(`  replacements: ${result.plan.replacements.length}`);
    lines.push(`  skipped: ${result.plan.skipped.length}`);
    if (!dryRun) {
      lines.push(`  duration_ms: ${result.duration_ms}`);
    }
    return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error)
    };
  }
}
