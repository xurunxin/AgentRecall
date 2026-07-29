// src/cli/commands/export.ts
import { flagString } from "../arg-parser.js";
import type { CliContext, CliResult } from "../index.js";
import { FormatRouter, type ExportFormat } from "../../format-exporters.js";
import { join } from "node:path";
import { ENV_ALLOW_UNBOUND_PROJECT_ID, isUnboundProjectIdAllowed } from "../../scope-resolver.js";
import type { MemoryScope } from "../../domain.js";
// v1.1.3 GATE-03 (issue #33): the MarkdownExporter
// throws `ForbiddenVisibilityError` when the caller's
// authorization does not lift to "restricted" and the
// export input contains restricted entries. The CLI
// catches the error and exits 1 with the stable
// `forbidden_visibility` code so the user can branch
// on the failure mode without parsing free-form prose.
import { ForbiddenVisibilityError } from "../../markdown-exporter.js";

// Stage 18 v1.1.2 third follow-up (review by
// ora-7, Critical #2): the CLI failure paths
// surface STABLE machine-readable error codes
// (the previous follow-up emitted free-form
// strings only — ora-7 forbade the soft
// `/invalid|usage|error/i` regex on the
// stderr assertions). The pattern is
// `[code] human-readable message`: a script
// can pin the `[code]` prefix without parsing
// the prose.
const STABLE_HISTORY_MODE_FAILED = "invalid_history_mode";
const STABLE_FORMAT_FAILED = "invalid_format";
const STABLE_SCOPE_FAILED = "invalid_scope";
const STABLE_FORBIDDEN_VISIBILITY = "forbidden_visibility";

export function exportCommand(ctx: CliContext): CliResult {
  const scope = (flagString(ctx.args, "scope") ?? "global") as MemoryScope;
  const projectId = flagString(ctx.args, "project-id");
  const projectPath = flagString(ctx.args, "project-path");
  const out = flagString(ctx.args, "out");
  const formatRaw = flagString(ctx.args, "format") ?? "markdown";
  const historyMode = flagString(ctx.args, "history-mode") ?? "snapshot";
  if (historyMode !== "snapshot" && historyMode !== "full_history") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `[${STABLE_HISTORY_MODE_FAILED}] export failed: invalid history_mode (expected snapshot or full_history)`
    };
  }
  if (formatRaw !== "markdown" && formatRaw !== "json" && formatRaw !== "yaml") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `[${STABLE_FORMAT_FAILED}] usage: agent-recall export --format markdown|json|yaml (got "${formatRaw}")`
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
    // The resolver returns
    // `err("invalid_scope", ...)`, which is
    // the v1.1.2 stable error code from
    // `STABLE_ERROR_CODES`. The CLI surfaces
    // the same code on stderr so a script can
    // pin `[invalid_scope]` instead of parsing
    // free-form prose.
    const code = resolved.error === "invalid_scope" ? STABLE_SCOPE_FAILED : resolved.error;
    return {
      exitCode: 1,
      stdout: "",
      stderr: `[${code}] ${resolved.message}${legacyHint}`
    };
  }
  const filters: Record<string, unknown> = { scope: resolved.value.scope, status: "active", limit: 10_000 };
  if (resolved.value.project_id) filters.project_id = resolved.value.project_id;
  // v1.1.3 GATE-03 (issue #33): the read-side
  // `listEntries` already threads the SQL-boundary
  // sensitivity filter via the active `activeProfile`
  // (the store's `actor_max_sensitivity` derivation
  // honours the canonical `AuthorizationDecision`).
  // A Core / Extended export therefore never
  // *fetches* restricted rows; the `ForbiddenVisibilityError`
  // throw path is defensive (the canonical filtering
  // should already have produced an empty `entries`
  // array).
  const activeProfile = process.env.AGENT_RECALL_PROFILE ?? "core";
  const ceiling: "normal" | "private" | "restricted" =
    activeProfile === "admin" ? "restricted" : "normal";
  const entries = ctx.store.listEntries({ ...filters, actor_max_sensitivity: ceiling });

  const router = new FormatRouter(out ?? join(ctx.dataHome, "exports"));
  let result: ReturnType<FormatRouter["export"]>;
  try {
    result = router.export({
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
      store: ctx.store,
      // v1.1.3 GATE-03 (issue #33): thread the
      // authorization decision through the export
      // so the MarkdownExporter throws fail-closed
      // when an unexpected restricted entry slips
      // through (e.g. a future store that does not
      // honour the filter).
      authorization: { max_sensitivity: ceiling }
    });
  } catch (error) {
    // v1.1.3 GATE-03 (issue #33): the MarkdownExporter
    // throws `ForbiddenVisibilityError` when the
    // export input contains restricted rows and the
    // caller's ceiling is below `"restricted"`. The
    // CLI exits 1 with the stable code so the
    // script can branch on the failure mode.
    if (error instanceof ForbiddenVisibilityError) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `[${STABLE_FORBIDDEN_VISIBILITY}] export refused: ${error.details.memory_ids.length} entry/entries exceed the caller's max_sensitivity=${ceiling}`
      };
    }
    throw error;
  }
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
