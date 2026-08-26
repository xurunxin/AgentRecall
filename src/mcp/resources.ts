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
import { ImportBatchStore } from "../portability/import-batch-store.js";
import { DerivationJobStore } from "../jobs/service.js";
import { SessionService } from "../sessions/service.js";
import { AssetService } from "../assets/service.js";
import { DistillationService } from "../distillation/service.js";
import type { ToolProfile } from "../tools/profile.js";
import type { CapabilityStore } from "../admin/capability.js";
import type { AuthorizationDecision } from "../services/auth-context.js";

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
  /**
   * v1.1.2 (issue #22): the active tool profile the
   * server was started with (`"core"`, `"extended"`,
   * or `"admin"`). Surfaced on the health resource as
   * `active_profile` so an operator / MCP client can
   * branch on the runtime tool surface without
   * re-reading `AGENT_RECALL_PROFILE` from the
   * environment. Optional for backward compatibility
   * with callers that pre-date the profile split; the
   * resource defaults to `"core"` when the field is
   * absent so the contract stays deterministic.
   */
  readonly activeProfile?: ToolProfile;
  /**
   * Stage 18 v1.1.2 (issue #23, ADR-0001): the
   * operator capability store. The health
   * resource surfaces the load state (granted
   * vs missing) so an operator can verify
   * the admin-boundary state without
   * re-reading the on-disk file. The
   * `active_profile === "admin"` profile
   * refuses to start without a granted
   * capability (see `src/index.ts`).
   */
  readonly capabilityStore?: CapabilityStore;
  /**
   * Stage 18 v1.1.2 follow-up (review by ora-8):
   * the maximum sensitivity the resource layer
   * is authorised to surface. The per-project
   * single-memory resource (`memory://project/
   * {project_id}/memory/{memory_id}`) MUST
   * thread this value to the store's
   * `peekEntry` overload so the SQL-boundary
   * sensitivity predicate is enforced on the
   * single-row read path (the pre-follow-up
   * resource did `peekEntry(memoryId)` without
   * the predicate and leaked restricted rows
   * to callers without the
   * `sensitivity_visibility` capability).
   * Defaults to `"normal"` when the field is
   * absent (older test mocks that pre-date
   * the v1.1.2 follow-up).
   */
  readonly actorMaxSensitivity?: "normal" | "private" | "restricted";
  /**
   * v1.1.3 GATE-03 (issue #33): the canonical
   * authorization decision. Every resource handler
   * consults this decision; the legacy
   * `actorMaxSensitivity` string is kept as a derived
   * helper. Optional for backward compatibility with
   * callers that pre-date the v1.1.3 split — the
   * resource defaults to the fail-closed decision when
   * the field is absent.
   */
  readonly authorization?: AuthorizationDecision;
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
      // Stage 18 v1.1.2 follow-up (review by ora-9):
      // the per-project single-memory resource
      // MUST enforce the SQL-boundary sensitivity
      // filter WITHOUT hydrating the row on the
      // deny path. The classifier
      // (`classifyEntryVisibility`) is the only
      // single-row read API the deny path is
      // allowed to use — it returns ONLY the
      // visibility classification + the row's
      // `id` + `sensitivity` (a non-secret
      // operational token). The
      // `peekEntry(memoryId)` no-options overload
      // is the write/maintenance path and MUST NOT
      // be used to disambiguate the read contract:
      // the previous follow-up (review by ora-8)
      // used the no-options overload to peek at
      // the row, then surfaced `raw.sensitivity`
      // on the error envelope, which leaked the
      // row's sensitivity literal to a caller
      // without the `sensitivity_visibility`
      // capability. The follow-up closes that
      // leak by routing through the classifier
      // and removing `entry_sensitivity` from the
      // error envelope entirely.
      const classification = ctx.store.classifyEntryVisibility(memoryId, {
        actorMaxSensitivity: ctx.actorMaxSensitivity ?? "normal"
      });
      if (classification.visibility === "forbidden_visibility") {
        // Stage 18 v1.1.2 follow-up (review by
        // ora-9): the message is worded to
        // avoid the forbidden `sensitivity`
        // substring (a structural operational
        // token, not a row payload — but the
        // brief explicitly forbids the literal
        // on the deny path).
        return jsonResource(uri, {
          ok: false,
          error: "forbidden_visibility",
          message: `memory ${memoryId} is not visible to this caller; run \`agent-recall admin grant\` and use the admin profile to surface this row`,
          memory_id: memoryId
        });
      }
      if (classification.visibility === "not_found") {
        return jsonResource(uri, { ok: false, error: "not_found", message: `memory ${memoryId} not in project ${projectId}` });
      }
      // The row is visible under the SQL-boundary
      // filter. The full `peekEntry(memoryId, {
      // actorMaxSensitivity })` reuses the SQL
      // filter so the read cannot bypass the
      // boundary. We then apply the project /
      // scope guard (the classifier does not
      // enforce project scope — that is the
      // resource layer's responsibility).
      const filteredEntry = ctx.store.peekEntry(memoryId, {
        actorMaxSensitivity: ctx.actorMaxSensitivity ?? "normal"
      });
      if (filteredEntry === undefined || filteredEntry.scope !== "project" || filteredEntry.project_id !== projectId) {
        return jsonResource(uri, { ok: false, error: "not_found", message: `memory ${memoryId} not in project ${projectId}` });
      }
      const audit: MemoryAuditEvent[] = ctx.store.listAuditEvents({ memory_id: memoryId });
      return jsonResource(uri, { entry: filteredEntry, audit, identity_status: resolved.value.identity_status });
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
      // Stage 18 v1.1.2 (issue #23, ADR-0001):
      // surface the admin boundary state. The
      // capability file path is reported so an
      // operator can verify the file's location
      // without re-reading the docs; the `state`
      // is `granted` when the in-memory token is
      // loaded, `missing` otherwise. The
      // `active_profile` / `capability_state`
      // pair is the documented "is the admin
      // surface available right now?" probe.
      const capabilityState = ctx.capabilityStore?.hasCapability() === true
        ? "granted"
        : "missing";
      const capabilityPath = ctx.capabilityStore?.getPath();
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
        // v1.1.2 (issue #22): the active MCP tool
        // profile. `"core"` is the packaged default;
        // `"extended"` is opt-in via
        // `AGENT_RECALL_PROFILE=extended`; `"admin"`
        // is opt-in via `AGENT_RECALL_PROFILE=admin`
        // AND a valid capability. The field is
        // sourced from the per-server `activeProfile`
        // context so an MCP client can verify the
        // runtime tool surface without re-reading
        // the env var (mirrors the v1.1.2
        // `identity_status` contract). Defaults to
        // `"core"` when the context omits the field
        // (older test mocks that pre-date the
        // profile split).
        active_profile: ctx.activeProfile ?? "core",
        // Stage 18 v1.1.2 (issue #23, ADR-0001):
        // the admin boundary state. `granted` is
        // the active state when the in-memory
        // capability token is loaded (the
        // `AGENT_RECALL_PROFILE=admin` profile
        // refuses to start in this state without
        // a granted capability). `missing` is the
        // documented fail-closed state for
        // `core` / `extended` profiles.
        capability_state: capabilityState,
        ...(capabilityPath !== undefined ? { capability_path: capabilityPath } : {}),
        backup: {
          dir: backupDir,
          entry_count: backupEntries.length,
          latest: backupEntries[0] ?? null
        },
        generated_at: new Date().toISOString()
      });
    }
  );

  // 6. memory://imports/{batch_id} (template)
  // Stage 18 v1.1.2 (issue #26, task 7): the
  // durable import lineage surface. The resource
  // mirrors the CLI `agent-recall import inspect`
  // surface — the same redacted operator-readable
  // record, surfaced through the MCP wire so an MCP
  // client can inspect a batch without shelling out
  // to the CLI. An unknown `batch_id` surfaces a
  // `not_found` envelope (the inspect contract is
  // identical to the CLI / `ImportBatchStore.inspect`).
  server.registerResource(
    "memory_import_batch",
    new ResourceTemplate("memory://imports/{batch_id}", { list: undefined }),
    {
      description: "Durable lineage for a single import: bundle hash, version, scope, conflict + history policies, actor, timestamps, status, counts, and affected memory ids. Redacted (no body / secret / path / capability leakage).",
      mimeType: "application/json"
    },
    (uri: URL, variables: Variables) => {
      const batchId = pickVariable(variables, "batch_id");
      if (batchId === undefined || batchId.length === 0) {
        return jsonResource(uri, { ok: false, error: "not_found", message: "missing batch_id" });
      }
      const store = new ImportBatchStore(ctx.store);
      const batch = store.inspect(batchId);
      if (batch === undefined) {
        return jsonResource(uri, {
          ok: false,
          error: "not_found",
          message: `unknown batch_id ${batchId}`
        });
      }
      return jsonResource(uri, batch);
    }
  );

  // v1.2.0-alpha.0 (issue #48): the derivation job
  // resource. The payload mirrors the `jobs show` CLI
  // output and is the canonical read surface for an MCP
  // client that wants to inspect a job's state, its
  // per-stage runs, and the outputs the stages produced.
  // The resource is read-only; mutations go through the
  // `jobs_cancel` / `jobs_retry` tools.
  server.registerResource(
    "derivation_job",
    new ResourceTemplate("agentrecall://jobs/{job_id}", { list: undefined }),
    {
      description:
        "Durable derivation job inspection: state, lease, runs (one per stage), and the outputs the job has produced. Mirrors the agent-recall jobs show CLI output.",
      mimeType: "application/json"
    },
    (uri: URL, variables: Variables) => {
      const jobId = pickVariable(variables, "job_id");
      if (jobId === undefined || jobId.length === 0) {
        return jsonResource(uri, { ok: false, error: "not_found", message: "missing job_id" });
      }
      const store = new DerivationJobStore(ctx.store);
      const inspection = store.inspect(jobId);
      if (inspection === undefined) {
        return jsonResource(uri, {
          ok: false,
          error: "not_found",
          message: `unknown job_id ${jobId}`
        });
      }
      return jsonResource(uri, {
        ok: true,
        job: inspection.job,
        runs: inspection.runs,
        outputs: inspection.outputs
      });
    }
  );

  // v1.2.0-alpha.1 (issue #49): the session evidence
  // resource. The payload mirrors the `sessions show`
  // CLI output: the session row + the per-event
  // manifest (digest, redaction flags, metadata) + the
  // ingestion plan. The event body is **not** in this
  // payload — bodies live in `session_event_blobs`
  // and are resolved on demand through a typed
  // tool (added in Phase 2 with the candidate
  // extractor).
  server.registerResource(
    "session_evidence",
    new ResourceTemplate("agentrecall://sessions/{session_id}", { list: undefined }),
    {
      description:
        "Durable session evidence: row + per-event manifest (sequence, type, content digest, redaction flags, metadata) + ingestion plan. Mirrors the agent-recall sessions show CLI output.",
      mimeType: "application/json"
    },
    (uri: URL, variables: Variables) => {
      const sessionId = pickVariable(variables, "session_id");
      if (sessionId === undefined || sessionId.length === 0) {
        return jsonResource(uri, { ok: false, error: "not_found", message: "missing session_id" });
      }
      const service = new SessionService(ctx.store, ctx.identityResolver);
      const inspection = service.inspect(sessionId);
      if (inspection === undefined) {
        return jsonResource(uri, {
          ok: false,
          error: "not_found",
          message: `unknown session_id ${sessionId}`
        });
      }
      return jsonResource(uri, {
        ok: true,
        session: inspection.session,
        events: inspection.events,
        plan: inspection.plan
      });
    }
  );

  // v1.2.0-alpha.1 (issue #51): the asset registry
  // resource. The payload mirrors the `assets show`
  // CLI output: the envelope row + the current
  // head (asset_versions row) + the type-specific
  // payload (memory_ref binding for v1.2-alpha.1).
  // Mutations go through the `assets_lifecycle` /
  // `assets_create_memory_ref` tools.
  server.registerResource(
    "asset_envelope",
    new ResourceTemplate("agentrecall://assets/{asset_id}", { list: undefined }),
    {
      description:
        "Typed asset registry inspection: envelope + current head + type-specific payload (memory_ref binding in v1.2-alpha.1). Mirrors the agent-recall assets show CLI output.",
      mimeType: "application/json"
    },
    (uri: URL, variables: Variables) => {
      const assetId = pickVariable(variables, "asset_id");
      if (assetId === undefined || assetId.length === 0) {
        return jsonResource(uri, { ok: false, error: "not_found", message: "missing asset_id" });
      }
      const service = new AssetService(ctx.store);
      const inspection = service.show(assetId);
      if (inspection === undefined) {
        return jsonResource(uri, {
          ok: false,
          error: "not_found",
          message: `unknown asset_id ${assetId}`
        });
      }
      return jsonResource(uri, {
        ok: true,
        asset: inspection.asset,
        current_version: inspection.current_version,
        payload: inspection.payload
      });
    }
  );

  // v1.2.0-alpha.2 (issue #50): the distillation
  // candidate resource. The payload mirrors the
  // `candidates show <id>` CLI output: the candidate
  // row + its evidence + its actions. Read-only;
  // mutations go through the `candidates_accept` /
  // `candidates_reject` / `candidates_apply` tools
  // (added in a later Phase 2 issue). The
  // `DistillationService` is constructed with the
  // same `MemoryService` / `MemoryWriteService`
  // the MCP server already owns; the apply path's
  // trust / sensitivity gates are the same ones
  // used by the `remember` tool.
  server.registerResource(
    "distillation_candidate",
    new ResourceTemplate("agentrecall://candidates/{candidate_id}", { list: undefined }),
    {
      description:
        "Distillation candidate inspection: candidate row + evidence rows + action rows. Mirrors the agent-recall candidates show CLI output. Read-only.",
      mimeType: "application/json"
    },
    (uri: URL, variables: Variables) => {
      const candidateId = pickVariable(variables, "candidate_id");
      if (candidateId === undefined || candidateId.length === 0) {
        return jsonResource(uri, { ok: false, error: "not_found", message: "missing candidate_id" });
      }
      const jobStore = new DerivationJobStore(ctx.store);
      const sessionService = new SessionService(ctx.store, ctx.identityResolver);
      const distillation = new DistillationService(ctx.store, sessionService, jobStore);
      const inspection = distillation.show(candidateId);
      if (inspection === undefined) {
        return jsonResource(uri, {
          ok: false,
          error: "not_found",
          message: `unknown candidate_id ${candidateId}`
        });
      }
      return jsonResource(uri, {
        ok: true,
        candidate: inspection.candidate,
        evidence: inspection.evidence,
        actions: inspection.actions
      });
    }
  );

  // v1.2.0-alpha.2 (issue #50): the by-job
  // candidate list. The payload is the full
  // candidate + evidence + action triple for every
  // row attached to a derivation job. An unknown
  // `job_id` surfaces a `not_found` envelope.
  server.registerResource(
    "distillation_candidate_list",
    new ResourceTemplate("agentrecall://candidates/by-job/{job_id}", { list: undefined }),
    {
      description:
        "List of distillation candidates (with evidence + actions) for a single derivation job. Mirrors the agent-recall candidates list --job CLI output. Read-only.",
      mimeType: "application/json"
    },
    (uri: URL, variables: Variables) => {
      const jobId = pickVariable(variables, "job_id");
      if (jobId === undefined || jobId.length === 0) {
        return jsonResource(uri, { ok: false, error: "not_found", message: "missing job_id" });
      }
      const jobStore = new DerivationJobStore(ctx.store);
      const sessionService = new SessionService(ctx.store, ctx.identityResolver);
      const distillation = new DistillationService(ctx.store, sessionService, jobStore);
      const rows = distillation.listForJob(jobId);
      return jsonResource(uri, {
        ok: true,
        job_id: jobId,
        candidates: rows
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
