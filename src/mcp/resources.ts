// src/mcp/resources.ts
//
// Stage 12 PR9 (spec § 6.3): the five read-only MCP
// resources. Each resource is a stable URI + a JSON
// payload. The v2 client can subscribe to a resource and
// get a notification when the underlying data changes
// (server side: we just compute the JSON on each read; the
// MCP SDK handles the notifications).
//
// Resources use the `memory://` scheme and are registered
// via the SDK's `registerResource` (and the template variant
// for parametric URIs like `memory://project/{id}/summary`).
//
// Payloads:
//   - `memory://projects` — the project roster (id, budget,
//                          usage, health).
//   - `memory://project/{id}/summary` — counts + recent
//                          activity for one project.
//   - `memory://project/{id}/memory/{mid}` — one memory
//                          entry plus its audit trail.
//   - `memory://global/summary` — counts for global scope.
//   - `memory://health` — server liveness, schema version,
//                          backup directory status.
//
// We compute the summaries by reusing the store's existing
// `listEntries` / `getEntry` / `listAuditEvents` /
// `getBudgetUsage` helpers. No new SQL is introduced here.

import type { MemoryEntry, MemoryAuditEvent } from "../domain.js";
import type { SQLiteMemoryStore } from "../sqlite-store.js";
import { CURRENT_SCHEMA_VERSION } from "../sqlite-store.js";
import { serverVersion } from "../server-version.js";
import { listBackups } from "../backup.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ProjectIdentityResolver } from "../scope-resolver.js";

export interface MemoryServerContext {
  readonly store: SQLiteMemoryStore;
  readonly dataHome?: string;
  readonly defaultActor: string;
  /**
   * v1.1.2 (issue #21): the per-server project identity
   * resolver. The per-project resources
   * (`memory://project/{id}/summary` /
   * `memory://project/{id}/memory/{mid}`) route through
   * `strict_existing` so a request for an unknown id
   * is rejected at the resolver before any store
   * query. The health resource surfaces the resolver's
   * `allowUnbound` flag and the current
   * `identity_status` for the active configuration.
   */
  readonly identityResolver: ProjectIdentityResolver;
}

type Variables = Record<string, string | string[] | undefined>;

/**
 * Resource registration. The MCP SDK's
 * `registerResource` is overloaded between the static and
 * template variants; the callback types differ (static
 * variant takes 2 args, template variant takes 3). We
 * expose a permissive shim that accepts both shapes; the
 * real `McpServer` is structurally compatible.
 */
type StaticResourceCallback = (uri: URL, extra: unknown) => unknown;
type TemplateResourceCallback = (uri: URL, variables: Variables, extra: unknown) => unknown;

type MemoryResourceServer = {
  registerResource(name: string, uriOrTemplate: string, config: { description?: string; mimeType?: string }, cb: StaticResourceCallback): unknown;
  registerResource(name: string, uriOrTemplate: ResourceTemplate, config: { description?: string; mimeType?: string }, cb: TemplateResourceCallback): unknown;
};

function jsonResource(uri: URL, payload: unknown): { contents: Array<{ uri: string; mimeType: string; text: string }> } {
  return {
    contents: [
      {
        uri: uri.toString(),
        mimeType: "application/json",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

interface ProjectSummary {
  project_id: string;
  display_name: string;
  budget: { max_active_entries: number; max_total_chars: number; max_index_chars: number };
  usage: { active_entries: number; active_chars: number };
  health: "ok" | "warning" | "unknown";
  memory_count: number;
}

function listProjectSummaries(ctx: MemoryServerContext): ProjectSummary[] {
  // We do not have a `listProjectScopes` helper on the
  // store yet; project scopes are written through
  // `upsertProjectScope` but there is no enumerate call.
  // To keep this resource useful without adding a new SQL
  // helper in PR9, we walk the entries table once and
  // collect the distinct project_ids that have entries.
  // Empty projects (configured budget but no entries) are
  // not exposed; PR10 will add a proper scope enumeration.
  const all = ctx.store.listEntries({});
  const seen = new Map<string, { memory_count: number; sample: MemoryEntry | undefined }>();
  for (const entry of all) {
    if (entry.scope !== "project" || entry.project_id === undefined) continue;
    const prior = seen.get(entry.project_id);
    if (prior === undefined) {
      seen.set(entry.project_id, { memory_count: 1, sample: entry });
    } else {
      prior.memory_count += 1;
    }
  }
  const summaries: ProjectSummary[] = [];
  for (const [projectId, info] of seen.entries()) {
    const scope = ctx.store.getProjectScope(projectId);
    if (scope === undefined) continue;
    const budget = ctx.store.getBudgetUsage({ scope: "project", project_id: projectId });
    const health: ProjectSummary["health"] =
      budget.active_entries / Math.max(1, scope.budget.max_active_entries) > 0.9 ? "warning" : "ok";
    summaries.push({
      project_id: projectId,
      display_name: scope.display_name,
      budget: {
        max_active_entries: scope.budget.max_active_entries,
        max_total_chars: scope.budget.max_total_chars,
        max_index_chars: scope.budget.max_index_chars
      },
      usage: { active_entries: budget.active_entries, active_chars: budget.active_chars },
      health,
      memory_count: info.memory_count
    });
  }
  return summaries;
}

function countByStatus(entries: MemoryEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  }
  return counts;
}

function recentActivity(entries: MemoryEntry[], limit: number): Array<{ memory_id: string; title: string; updated_at: string }> {
  return [...entries]
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
    .slice(0, limit)
    .map((entry) => ({ memory_id: entry.id, title: entry.title, updated_at: entry.updated_at }));
}

const PROJECTS_URI = "memory://projects";
const GLOBAL_SUMMARY_URI = "memory://global/summary";
const HEALTH_URI = "memory://health";

export function registerMemoryResources(server: MemoryResourceServer, ctx: MemoryServerContext): void {
  // 1. memory://projects
  server.registerResource(
    "memory_projects",
    PROJECTS_URI,
    {
      description: "Roster of all known projects (id, budget, usage, health, memory count).",
      mimeType: "application/json"
    },
    (uri: URL) => {
      const payload = {
        server_version: serverVersion(),
        schema_version: CURRENT_SCHEMA_VERSION,
        generated_at: new Date().toISOString(),
        projects: listProjectSummaries(ctx)
      };
      return jsonResource(uri, payload);
    }
  );

  // 2. memory://project/{project_id}/summary (template)
  server.registerResource(
    "memory_project_summary",
    new ResourceTemplate("memory://project/{project_id}/summary", { list: undefined }),
    {
      description: "Per-project summary: budget, usage, status counts, recent activity.",
      mimeType: "application/json"
    },
    (uri: URL, variables: Variables) => {
      const projectId = pickVariable(variables, "project_id");
      if (projectId === undefined || projectId.length === 0) {
        return jsonResource(uri, { ok: false, error: "not_found", message: "missing project_id" });
      }
      // v1.1.2 (issue #21): route through the strict
      // resolver. An unknown `project_id` is rejected
      // here with `identity_status: "unbound"` (or
      // `invalid_scope` when strict isolation is on).
      const resolved = ctx.identityResolver.resolve(
        { scope: "project", project_id: projectId },
        "strict_existing"
      );
      if (!resolved.ok) {
        return jsonResource(uri, {
          ok: false,
          error: "not_found",
          message: `project ${projectId} not registered`,
          identity_status: ctx.identityResolver.isAllowUnbound() ? "unbound" : "strict"
        });
      }
      const scope = ctx.store.getProjectScope(projectId);
      if (scope === undefined) {
        return jsonResource(uri, { ok: false, error: "not_found", message: `project ${projectId} not found` });
      }
      const entries = ctx.store.listEntries({ scope: "project", project_id: projectId });
      const budget = ctx.store.getBudgetUsage({ scope: "project", project_id: projectId });
      return jsonResource(uri, {
        project_id: projectId,
        display_name: scope.display_name,
        identity_status: resolved.value.identity_status,
        budget: scope.budget,
        usage: { active_entries: budget.active_entries, active_chars: budget.active_chars },
        status_counts: countByStatus(entries),
        recent_activity: recentActivity(entries, 5)
      });
    }
  );

  // 3. memory://project/{project_id}/memory/{memory_id} (template)
  server.registerResource(
    "memory_project_memory",
    new ResourceTemplate("memory://project/{project_id}/memory/{memory_id}", { list: undefined }),
    {
      description: "A single memory entry plus its full audit trail. Read-only.",
      mimeType: "application/json"
    },
    (uri: URL, variables: Variables) => {
      const projectId = pickVariable(variables, "project_id");
      const memoryId = pickVariable(variables, "memory_id");
      if (projectId === undefined || memoryId === undefined) {
        return jsonResource(uri, { ok: false, error: "not_found", message: "missing project_id or memory_id" });
      }
      // v1.1.2 (issue #21): strict resolver check.
      const resolved = ctx.identityResolver.resolve(
        { scope: "project", project_id: projectId },
        "strict_existing"
      );
      if (!resolved.ok) {
        return jsonResource(uri, {
          ok: false,
          error: "not_found",
          message: `project ${projectId} not registered`,
          identity_status: ctx.identityResolver.isAllowUnbound() ? "unbound" : "strict"
        });
      }
      const entry = ctx.store.peekEntry(memoryId);
      if (entry === undefined || entry.scope !== "project" || entry.project_id !== projectId) {
        return jsonResource(uri, { ok: false, error: "not_found", message: `memory ${memoryId} not in project ${projectId}` });
      }
      const audit: MemoryAuditEvent[] = ctx.store.listAuditEvents({ memory_id: memoryId });
      return jsonResource(uri, { entry, audit, identity_status: resolved.value.identity_status });
    }
  );

  // 4. memory://global/summary
  server.registerResource(
    "memory_global_summary",
    GLOBAL_SUMMARY_URI,
    {
      description: "Counts and recent activity for the global scope.",
      mimeType: "application/json"
    },
    (uri: URL) => {
      const entries = ctx.store.listEntries({ scope: "global" });
      const budget = ctx.store.getBudgetUsage({ scope: "global" });
      return jsonResource(uri, {
        scope: "global",
        usage: { active_entries: budget.active_entries, active_chars: budget.active_chars },
        status_counts: countByStatus(entries),
        recent_activity: recentActivity(entries, 5)
      });
    }
  );

  // 5. memory://health
  server.registerResource(
    "memory_health",
    HEALTH_URI,
    {
      description: "Server liveness, schema version, and backup-directory status.",
      mimeType: "application/json"
    },
    (uri: URL) => {
      const dataHome = ctx.dataHome;
      const backupDir = dataHome === undefined ? undefined : `${dataHome}/backups`;
      const backupEntries = backupDir === undefined ? [] : listBackups(backupDir);
      // v1.1.2 (issue #21): surface the strict
      // isolation contract on the health resource.
      // `strict_isolation: true` is the documented
      // v1.1.2 default; the operator opts into the
      // legacy unbound mode via
      // `AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID=1`.
      const allowUnbound = ctx.identityResolver.isAllowUnbound();
      return jsonResource(uri, {
        status: "ok",
        server_version: serverVersion(),
        schema_version: CURRENT_SCHEMA_VERSION,
        default_actor: ctx.defaultActor,
        data_home: dataHome,
        strict_isolation: !allowUnbound,
        // v1.1.2 (issue #21): `identity_status` is
        // `bound` when strict isolation is on (the
        // default) and `unbound` when the legacy
        // escape hatch is enabled. The CLI / MCP
        // client surfaces this in the response so
        // an operator can verify the runtime mode
        // without re-reading the env var.
        identity_status: allowUnbound ? "unbound" : "bound",
        allow_unbound_project_id: allowUnbound,
        backup: {
          dir: backupDir,
          entry_count: backupEntries.length,
          latest: backupEntries[0] ?? null
        },
        generated_at: new Date().toISOString()
      });
    }
  );
}

function pickVariable(variables: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = variables[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}
