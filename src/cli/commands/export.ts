// src/cli/commands/export.ts
import { flagString } from "../arg-parser.js";
import type { CliContext, CliResult } from "../index.js";
import { FormatRouter, type ExportFormat } from "../../format-exporters.js";
import { join } from "node:path";
import { ENV_ALLOW_UNBOUND_PROJECT_ID, isUnboundProjectIdAllowed } from "../../scope-resolver.js";
import type { MemoryScope } from "../../domain.js";

export function exportCommand(ctx: CliContext): CliResult {
  const scope = (flagString(ctx.args, "scope") ?? "global") as MemoryScope;
  const projectId = flagString(ctx.args, "project-id");
  const projectPath = flagString(ctx.args, "project-path");
  const out = flagString(ctx.args, "out");
  const formatRaw = flagString(ctx.args, "format") ?? "markdown";
  const historyMode = flagString(ctx.args, "history-mode") ?? "snapshot";
  if (historyMode !== "snapshot" && historyMode !== "full_history") {
    return { exitCode: 1, stdout: "", stderr: "export failed: invalid history_mode (expected snapshot or full_history)" };
  }
  if (formatRaw !== "markdown" && formatRaw !== "json" && formatRaw !== "yaml") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `usage: agent-recall export --format markdown|json|yaml (got "${formatRaw}")`
    };
  }
  const format: ExportFormat = formatRaw;

  // v1.1.2 (issue #21): route the project-scope export
  // through the strict resolver. A `project_id`-only
  // input without a registered identity is rejected
  // before any store query runs. Path-supplied inputs
  // register the identity under `strict_existing` /
  // `register` mode semantics (path-supplied calls go
  // through `resolveMemoryScopeWithStore(this.store, ...)`
  // in the class).
  const resolved = ctx.identityResolver.resolve(
    {
      scope,
      ...(projectId ? { project_id: projectId } : {}),
      ...(projectPath ? { project_path: projectPath } : {})
    },
    "strict_existing"
  );
  if (!resolved.ok) {
    const legacyHint = isUnboundProjectIdAllowed()
      ? ""
      : ` (or set ${ENV_ALLOW_UNBOUND_PROJECT_ID}=1 to allow the legacy unbound mode)`;
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${resolved.message}${legacyHint}`
    };
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
    format,
    history_mode: historyMode,
    source_actor_id: "user:cli",
    store: ctx.store  });
  // v1.1.2 (issue #21): surface the binding status
  // for the legacy / strict-mode observability
  // contract. A bound export is the default; an
  // unbound export (only reachable with the legacy
  // escape hatch) prints a warning so the operator
  // knows strict isolation is disabled.
  const identitySuffix = resolved.value.identity_status === "unbound"
    ? " [identity_status: unbound — strict isolation disabled]"
    : "";
  return {
    exitCode: 0,
    stdout: `exported (${format}): ${result.indexPath} (+ ${result.topicPaths.length} topic files)${identitySuffix}`,
    stderr: ""
  };
}
