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
// Stage 18 v1.1.2 (issue #26, task 7): the `import
// inspect <batch_id> [--json]` subcommand surfaces the
// durable `import_batches` lineage row. The CLI's
// inspect surface is the documented operator entry
// point: a successful import can be traced back to its
// bundle hash + version + actor + counts, a failed
// import surfaces the `failure_code` + `failed_at`
// timestamp, and the inspect payload is redacted (no
// memory bodies / secret values / raw filesystem
// paths / operator capability tokens).
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
import { ImportBatchStore } from "../../portability/import-batch-store.js";
import type { MemoryScope } from "../../domain.js";

const INSPECT_USAGE = "usage: agent-recall import inspect <batch_id> [--json]";

export function importCommand(ctx: CliContext): CliResult {
  // Stage 18 v1.1.2 (issue #26, task 7): the
  // `import inspect` subcommand. We branch on the
  // first positional argument (`ctx.args.positional`)
  // before falling through to the apply path. A
  // missing positional falls through to the legacy
  // `--from` path so the existing CLI surface is
  // unchanged.
  const subcommand = ctx.args.positional[0];
  if (subcommand === "inspect") {
    return importInspectCommand(ctx);
  }
  const fromRaw = flagString(ctx.args, "from");
  if (fromRaw === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "usage: agent-recall import --from <export-root> [--scope global|project] [--project-id <id>] [--format json|yaml] [--conflict keep|replace|merge|fail] [--dry-run]\n\n" + INSPECT_USAGE
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
  const historyMode = flagString(ctx.args, "history-mode") ?? "snapshot";
  if (historyMode !== "snapshot" && historyMode !== "full_history") {
    return { exitCode: 1, stdout: "", stderr: "import failed: invalid history_mode (expected snapshot or full_history)" };
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
      { conflict, dry_run: dryRun, actor: resolveActor(undefined), history_mode: historyMode, allow_restricted: true },
      ctx.ctx
    );
    if (json) {
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          {
            import_batch_id: result.import_batch_id,
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
    lines.push(`  import_batch_id: ${result.import_batch_id}`);
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
    lines.push("");
    lines.push(`Inspect the lineage with: agent-recall import inspect ${result.import_batch_id}`);
    return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Stage 18 v1.1.2 (issue #26, task 7): the
 * `agent-recall import inspect <batch_id> [--json]`
 * subcommand. Reads the durable `import_batches` row
 * and prints the redacted operator-readable record.
 * Missing batch id => exit 1 with `not_found`.
 *
 * The redaction contract is enforced at the schema +
 * `ImportBatchStore` boundary (no body / secret / path
 * fields exist on the row); the CLI just serialises
 * the inspected record verbatim.
 */
function importInspectCommand(ctx: CliContext): CliResult {
  const batchId = ctx.args.positional[1];
  if (typeof batchId !== "string" || batchId.length === 0) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: INSPECT_USAGE
    };
  }
  const json = flagBool(ctx.args, "json") === true;
  const store = new ImportBatchStore(ctx.store);
  const batch = store.inspect(batchId);
  if (batch === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `import inspect: unknown batch_id ${batchId} (not_found)`
    };
  }
  if (json) {
    return {
      exitCode: 0,
      stdout: JSON.stringify(batch, null, 2),
      stderr: ""
    };
  }
  // Human-readable text. The field order mirrors the
  // CLI's documented "what an operator needs to
  // triage an import" surface: status first, then
  // bundle identity, then policy, then counts.
  const lines: string[] = [];
  lines.push(`import_batch_id: ${batch.import_batch_id}`);
  lines.push(`status: ${batch.status}`);
  if (batch.failure_code !== null) {
    lines.push(`failure_code: ${batch.failure_code}`);
  }
  lines.push(`bundle_hash: ${batch.bundle_hash}`);
  lines.push(`bundle_hash_algorithm: ${batch.bundle_hash_algorithm}`);
  lines.push(`bundle_version: ${batch.bundle_version}`);
  if (batch.bundle_filename !== null) {
    lines.push(`bundle_filename: ${batch.bundle_filename}`);
  }
  if (batch.bundle_size_bytes !== null) {
    lines.push(`bundle_size_bytes: ${batch.bundle_size_bytes}`);
  }
  lines.push(`source_format: ${batch.source_format}`);
  lines.push(`source_schema_version: ${batch.source_schema_version}`);
  lines.push(`target_scope: ${batch.target_scope}`);
  if (batch.target_project_id !== null) {
    lines.push(`target_project_id: ${batch.target_project_id}`);
  }
  lines.push(`conflict_policy: ${batch.conflict_policy}`);
  lines.push(`history_mode: ${batch.history_mode}`);
  lines.push(`actor_id: ${batch.actor_id}`);
  if (batch.request_id !== null) lines.push(`request_id: ${batch.request_id}`);
  if (batch.session_id !== null) lines.push(`session_id: ${batch.session_id}`);
  if (batch.tool_call_id !== null) lines.push(`tool_call_id: ${batch.tool_call_id}`);
  lines.push(`started_at: ${batch.started_at}`);
  if (batch.completed_at !== null) lines.push(`completed_at: ${batch.completed_at}`);
  if (batch.failed_at !== null) lines.push(`failed_at: ${batch.failed_at}`);
  lines.push(`counts:`);
  lines.push(`  inserts: ${batch.counts.inserts}`);
  lines.push(`  replacements: ${batch.counts.replacements}`);
  lines.push(`  merges: ${batch.counts.merges}`);
  lines.push(`  skipped: ${batch.counts.skipped}`);
  lines.push(`  failed: ${batch.counts.failed}`);
  lines.push(`  total_affected: ${batch.counts.total_affected}`);
  if (batch.counts.revisions !== undefined) {
    lines.push(`  revisions: ${batch.counts.revisions}`);
  }
  if (batch.counts.audit_events !== undefined) {
    lines.push(`  audit_events: ${batch.counts.audit_events}`);
  }
  if (batch.counts.relations !== undefined) {
    lines.push(`  relations: ${batch.counts.relations}`);
  }
  if (batch.counts.provenance !== undefined) {
    lines.push(`  provenance: ${batch.counts.provenance}`);
  }
  lines.push(`affected_ids: [${batch.affected_ids.join(", ")}]`);
  return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
}