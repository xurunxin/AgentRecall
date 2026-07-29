// src/memory-service.ts
//
// Stage 9 façade. The 1670-line class that accumulated across
// Stages 1-8 has been split into three collaborator services
// in `src/services/`. This file keeps the public MemoryService
// API (constructor + every public method) byte-for-byte the
// same; it just delegates to the right sub-service.
//
// The three sub-services:
//
// - `MemoryReadService`      — getMemory, listMemories,
//                              searchMemories, getMemoryBudget,
//                              exportMemoryContext.
// - `MemoryWriteService`     — remember, updateMemory,
//                              supersedeMemory, mergeMemories,
//                              forgetMemory,
//                              configureProjectBudget.
// - `MemoryMaintenanceService` — maintainMemories (the public
//                                  switch), plus the per-action
//                                  implementations.
//
// The shared helpers (audit, budget, actor, comparison,
// env-var reads) live in `memory-service-helpers.ts`. All
// three sub-services depend on that module; they do NOT
// depend on each other.

import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { err, nowIso, type MemoryAuditEvent, type MemoryBudget, type MemoryEntry, type MemoryScope, type ProjectScope, type Result } from "./domain.js";
import { MarkdownExporter } from "./markdown-exporter.js";
import { resolveActor } from "./actor.js";
import { listBackups, runBackup } from "./backup.js";
import { MaintenancePlanStore, type MaintenancePlan, type PlanApplyResult } from "./maintenance-plan-store.js";
import { rankRecall, type RankedItem } from "./services/recall-ranker.js";
import { appendAudit, computeTrustBoost } from "./services/memory-service-helpers.js";
import { MemoryReadService, type ExportMemoryContextInput, type ListResult, type MemoryBudgetResult, type ResolvedReadScope, type SearchResult } from "./services/memory-read-service.js";
import { MemoryMaintenanceService, type MaintainMemoriesInput, type MaintainMemoriesResult, type MaintenanceAction } from "./services/memory-maintenance-service.js";
import { MemoryWriteService, type RememberResult } from "./services/memory-write-service.js";
import { explainProvenance, recordProvenance, type ProvenanceSourceKind, type ProvenanceExplanation } from "./services/provenance.js";
import { ProjectIdentityResolver } from "./scope-resolver.js";
import type { BudgetUsage, EntryFilters, SearchFilters, SQLiteMemoryStore } from "./sqlite-store.js";
import { CURRENT_SCHEMA_VERSION } from "./sqlite-store.js";
import { type RememberInput, type UpdateInput } from "./write-validator.js";
import { buildRequestContext, type RequestContext } from "./request-context.js";
import { CapabilityStore, InMemoryCapabilityStore } from "./admin/capability.js";
import type { ToolProfile } from "./tools/profile.js";
import { resolveAuthorization, type AuthorizationDecision } from "./services/auth-context.js";

// Re-export the public types from the read service so the
// existing `import { ListResult, ... } from "../memory-service"`
// keeps working.
export type {
  ExportMemoryContextInput,
  ListResult,
  MemoryBudgetResult,
  SearchResult
} from "./services/memory-read-service.js";
export type { MaintainMemoriesInput, MaintainMemoriesResult, MaintenanceAction } from "./services/memory-maintenance-service.js";
export type { RememberResult } from "./services/memory-write-service.js";

export type InvalidScopeResult = Result<never, "invalid_scope" | "project_identity_conflict">;

// Local aliases for the type shapes that the façade reuses.
type ListServiceFilters = EntryFilters & { project_path?: string };
type SearchServiceFilters = SearchFilters & {
  include_global?: boolean;
  project_path?: string;
};

// Stage 9: computeTrustBoost is now in services/memory-service-helpers.ts.
export { computeTrustBoost } from "./services/memory-service-helpers.js";

/**
 * Stage 9: façade over the three sub-services. Public API is
 * byte-for-byte the same as before the split; tests that
 * `new MemoryService(store, exporter?, defaultActor?, dataHome?)`
 * keep working unchanged.
 *
 * The constructor wires the shared context (store, default
 * actor, exporter factory, data home) into each sub-service
 * and holds them in private fields. The public methods
 * delegate to the appropriate sub-service.
 */
export class MemoryService {
  private readonly read: MemoryReadService;
  private readonly write: MemoryWriteService;
  private readonly maintenance: MemoryMaintenanceService;
  private readonly backupFn: () => { path: string; size: number; duration_ms: number } | { error: string };
  private readonly _store: SQLiteMemoryStore;
  /** Stage 15 PR-M0-4 (issue #3, spec § 6.2): durable plan
   * store for the plan/apply maintenance split. Pre-PR-M0-4
   * the plan lived in a process-local Map and was lost on
   * every MCP restart; agents had to re-plan after every
   * reconnect. Post-PR-M0-4 the plan is written to the
   * `maintenance_plans` table so a different session can
   * apply it later, and the apply step verifies the
   * per-item `expected_revision` (CAS) before mutating. */
  private readonly planStore: MaintenancePlanStore;
  /**
   * Stage 18 v1.1.2 (issue #23, ADR-0001): the
   * operator capability store. The service exposes
   * the same store through both the write path
   * (trust / sensitivity authorization) and the
   * service-level `confirmMemoryTrust` helper. When
   * the store is absent, all privileged writes are
   * fail-closed.
   */
  private readonly capabilityStore: CapabilityStore | InMemoryCapabilityStore | undefined;
  /**
   * v1.1.3 GATE-02 (issue #32): the active
   * tool profile. Threaded into the read
   * service context so the SQL-boundary
   * sensitivity filter only lifts to
   * `"restricted"` when `(activeProfile ===
   * "admin" && capability loaded)`. Core /
   * Extended processes NEVER inherit Admin
   * visibility merely because `admin.cap`
   * exists in their data home.
   */
  private readonly activeProfile: ToolProfile;

  constructor(
    store: SQLiteMemoryStore,
    private readonly exporter?: MarkdownExporter,
    /**
     * Default actor identifier for audit events. Stage 1 widened
     * the SQLite CHECK constraint in Stage 2 to accept structured
     * values like `agent:claude-code`.
     */
    private readonly defaultActor: string = "agent",
    /**
     * Data home directory, used as the destination for `backups/`.
     * If unset, automatic backup is disabled.
     */
    private readonly dataHome?: string,
    /**
     * Stage 18 v1.1.2 (issue #23, ADR-0001): the
     * operator capability store. The MCP server
     * constructs one from the data home at
     * startup; the CLI uses a separate instance
     * for the admin commands. The default
     * `undefined` is fail-closed — privileged
     * writes are rejected.
     *
     * v1.1.3 GATE-02 (issue #32): the parameter
     * type is widened to accept either the
     * persistent `CapabilityStore` (production)
     * OR the test-only `InMemoryCapabilityStore`
     * (which has the same `authorize(...)` /
     * `hasCapability()` / `getPath()` surface).
     * The runtime consults only the duck-typed
     * methods so both are valid capability
     * sources for tests; production callers
     * always pass a `CapabilityStore`.
     */
    capabilityStore?: CapabilityStore | InMemoryCapabilityStore,
    /**
     * v1.1.3 GATE-02 (issue #32): the active
     * tool profile. Defaults to `"core"` so
     * legacy call sites (test fixtures,
     * programmatic callers) compile unchanged.
     * The MCP server entry resolves the profile
     * via `resolveActiveProfile()` and threads
     * it through; the CLI default keeps the
     * existing fail-closed behaviour.
     */
    activeProfile: ToolProfile = "core"
  ) {
    const resolveActorFn = (override?: string) => resolveActor(override ?? undefined, process.env);
    const resolveExporterFn = (): MarkdownExporter =>
      this.exporter ?? new MarkdownExporter(join(process.cwd(), ".agent-recall", "exports"));

    // Stage 16 v1.1.1 PR-2 (#14): one
    // `ProjectIdentityResolver` per service, used by
    // every public path that needs to resolve a
    // `scope` / `project_id` / `project_path` triple.
    // The recordedBy is the default actor (the actor
    // responsible for any identity / alias rows the
    // resolver may create).
    const identityResolver = new ProjectIdentityResolver(store, defaultActor);

    this.capabilityStore = capabilityStore;
    this.activeProfile = activeProfile;
    // v1.1.3 GATE-02 (issue #32): the
    // SQL-boundary sensitivity filter is now
    // gated on BOTH the loaded capability AND
    // the active profile. Only the
    // Admin-profile process with a valid
    // capability lifts to `"restricted"`; Core
    // / Extended processes stay at `"normal"`
    // regardless of the on-disk capability.
    // The `memory://health.active_profile`
    // resource surfaces the active profile +
    // capability state so a reviewer can
    // verify the contract without re-reading
    // the env vars.
    const visibilityLifted =
      activeProfile === "admin" && capabilityStore?.hasCapability() === true;
    // v1.1.3 GATE-03 (issue #33): the canonical
    // authorization decision. The
    // `AuthorizationDecision` replaces the v1.1.2
    // derived string as the single source of
    // truth; the legacy `actorMaxSensitivity`
    // string is kept as a derived helper for
    // backward compatibility with callers that
    // still take the string.
    const authorization: AuthorizationDecision = resolveAuthorization(
      {
        activeProfile,
        hasCapability: visibilityLifted
      },
      { kind: "read", restrictedAllowed: false }
    );
    this.read = new MemoryReadService({
      store,
      defaultActor,
      identityResolver,
      resolveExporter: resolveExporterFn,
      actorMaxSensitivity: visibilityLifted ? "restricted" : "normal",
      activeProfile,
      authorization
    });
    this.write = new MemoryWriteService({
      store,
      defaultActor,
      identityResolver,
      ...(capabilityStore !== undefined ? { capabilityStore } : {}),
      // v1.1.3 GATE-02 (issue #32): thread the
      // active profile so the write service's
      // `authorize(...)` call can gate
      // `profile_required: "admin"` capability
      // types against the per-process
      // profile.
      activeProfile,
      configureProjectBudget: (project_id, budget, canonical_path, display_name) =>
        this.configureProjectBudget(project_id, budget, canonical_path, display_name)
    });
    this.maintenance = new MemoryMaintenanceService({
      store,
      defaultActor,
      identityResolver,
      ...(this.dataHome !== undefined ? { dataHome: this.dataHome } : {}),
      resolveExporter: resolveExporterFn
    });
    this._store = store;
    this.planStore = new MaintenancePlanStore(store);
    this.backupFn = () => this.backup();
  }

  /** Public read-only view of the underlying store. Used
   *  by the resource layer and the index entry point. */
  get store(): SQLiteMemoryStore {
    return this._store;
  }

  /** Stage 18 v1.1.2 (issue #23, ADR-0001): the
   *  capability store backing this service.
   *
   *  v1.1.3 GATE-02 (issue #32): the return type
   *  is widened to include `InMemoryCapabilityStore`
   *  so test fixtures that pass an in-memory store
   *  get the same accessor return shape as
   *  production callers passing a `CapabilityStore`.
   *  The duck-typed surface (`hasCapability` /
   *  `getPath` / `authorize`) is identical. */
  get adminCapabilityStore(): CapabilityStore | InMemoryCapabilityStore | undefined {
    return this.capabilityStore;
  }

  // ============================================================
  // Public read methods — delegate to MemoryReadService
  // ============================================================

  getMemory(
    id: string,
    accessedBy?: string
  ): { entry: MemoryEntry; audit: MemoryAuditEvent[] } | undefined {
    return this.read.getMemory(id, accessedBy);
  }

  /**
   * Stage 18 v1.1.2 follow-up (review by ora-8):
   * the public-boundary read that distinguishes
   * `forbidden_visibility` from `not_found`. The
   * MCP `get_memory` tool routes through this
   * method so a caller without the
   * `sensitivity_visibility` capability receives
   * a stable `forbidden_visibility` error code
   * (rather than `not_found`) and can branch on
   * the failure mode without re-reading the row.
   */
  getMemoryWithVisibility(id: string): Result<
    { entry: MemoryEntry; audit: MemoryAuditEvent[] },
    "not_found" | "forbidden_visibility"
  > {
    return this.read.getMemoryWithVisibility(id);
  }

  listMemories(filters: ListServiceFilters & { scope: "project"; project_id: string }): ListResult;
  listMemories(filters: ListServiceFilters & { scope: "project"; project_path: string }): ListResult;
  listMemories(filters: ListServiceFilters & { scope?: "global" }): ListResult;
  listMemories(filters: ListServiceFilters): ListResult | InvalidScopeResult;
  listMemories(filters: ListServiceFilters): ListResult | InvalidScopeResult {
    return this.read.listMemories(filters);
  }

  searchMemories(filters: SearchServiceFilters & { scope: "project"; project_id: string }): SearchResult;
  searchMemories(filters: SearchServiceFilters & { scope: "project"; project_path: string }): SearchResult;
  searchMemories(filters: SearchServiceFilters & { scope: "global" }): SearchResult;
  searchMemories(filters: SearchServiceFilters): SearchResult | InvalidScopeResult;
  searchMemories(filters: SearchServiceFilters): SearchResult | InvalidScopeResult {
    return this.read.searchMemories(filters);
  }

  getMemoryBudget(input: { scope: "global" }): MemoryBudgetResult;
  getMemoryBudget(input: { scope: "project"; project_id: string }): MemoryBudgetResult;
  getMemoryBudget(input: { scope: MemoryScope; project_id?: string }): MemoryBudgetResult | Result<never, "invalid_scope">;
  getMemoryBudget(input: { scope: MemoryScope; project_id?: string }): MemoryBudgetResult | Result<never, "invalid_scope"> {
    return this.read.getMemoryBudget(input);
  }

  exportMemoryContext(input: ExportMemoryContextInput, ctx?: RequestContext): string {
    return this.read.exportMemoryContext(input, ctx);
  }

  // ============================================================
  // Public write methods — delegate to MemoryWriteService
  // ============================================================

  configureProjectBudget(
    project_id: string,
    budget: MemoryBudget,
    canonical_path: string,
    display_name: string
  ): ProjectScope {
    return this.write.configureProjectBudget(project_id, budget, canonical_path, display_name);
  }

  remember(input: RememberInput, ctx?: RequestContext): Result<RememberResult, "invalid_schema" | "invalid_state" | "invalid_scope" | "secret_detected" | "unauthorized" | "capacity_exceeded" | "duplicate_candidate" | "idempotency_mismatch" | "idempotency_in_flight"> {
    return this.write.remember(input, ctx);
  }

  updateMemory(
    id: string,
    input: UpdateInput,
    ctx?: RequestContext,
    /**
     * Stage 18 v1.1.2 (issue #26, task 7): optional
     * import-lineage metadata. Threaded onto the
     * `updated` / `archived` audit event's metadata
     * so a reviewer can trace the row back to the
     * exact bundle / batch that produced the
     * mutation. A missing arg keeps the legacy audit
     * shape unchanged.
     */
    importLineage?: { import_batch_id: string; bundle_hash: string; bundle_version: number }
  ): Result<{ memory_id: string }, "not_found" | "invalid_state" | "invalid_schema" | "secret_detected" | "unauthorized" | "capacity_exceeded" | "stale_revision" | "idempotency_mismatch" | "idempotency_in_flight"> {
    return this.write.updateMemory(id, input, ctx, importLineage);
  }

  supersedeMemory(input: {
    old_memory_ids: string[];
    replacement: RememberInput;
    reason: string;
    idempotency_key?: string;
  }, ctx?: RequestContext): Result<{ memory_id: string }, "not_found" | "invalid_state" | "invalid_schema" | "invalid_scope" | "secret_detected" | "unauthorized" | "capacity_exceeded" | "duplicate_candidate" | "idempotency_mismatch" | "idempotency_in_flight"> {
    return this.write.supersedeMemory(input, ctx);
  }

  mergeMemories(input: {
    old_memory_ids: string[];
    replacement: RememberInput;
    reason: string;
    strategy?: "keep_first" | "keep_newest";
    idempotency_key?: string;
  }, ctx?: RequestContext): Result<{ memory_id: string; merged_from?: string[] }, "not_found" | "invalid_state" | "invalid_schema" | "invalid_scope" | "secret_detected" | "unauthorized" | "capacity_exceeded" | "duplicate_candidate" | "idempotency_mismatch" | "idempotency_in_flight"> {
    return this.write.mergeMemories(input, ctx);
  }

  forgetMemory(
    id: string,
    reason: string,
    ctx?: RequestContext,
    options?: { idempotency_key?: string; expected_revision?: number }
  ): Result<{ memory_id: string; released_chars: number }, "not_found" | "idempotency_mismatch" | "idempotency_in_flight"> {
    return this.write.forgetMemory(id, reason, ctx, options);
  }

  // ============================================================
  // Public maintenance methods — delegate to MemoryMaintenanceService
  // ============================================================

  maintainMemories(input: MaintainMemoriesInput, ctx?: RequestContext): MaintainMemoriesResult {
    return this.maintenance.maintainMemories(input, ctx);
  }

  // ============================================================
  // Public backup method (Stage 1, lives on the façade for
  // historical reasons; the maintenance service has its own
  // maybeBackup() helper but the user-callable backup is here)
  // ============================================================

  backup(): { path: string; size: number; duration_ms: number } | { error: string } {
    if (this.dataHome === undefined) {
      return { error: "data_home_unknown" };
    }
    const backupDir = join(this.dataHome, "backups");
    try {
      const result = runBackup(this.store.backupHandle(), { backupDir });
      appendAudit(this.store, this.defaultActor, {
        scope: "global",
        event: "backup_created",
        actor: "system:backup",
        reason: "backup_created",
        metadata: {
          path: result.path,
          size: result.size,
          duration_ms: result.durationMs,
          kept: result.kept,
          pruned: result.pruned
        }
      });
      return { path: result.path, size: result.size, duration_ms: result.durationMs };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendAudit(this.store, this.defaultActor, {
        scope: "global",
        event: "maintenance_run",
        actor: "system:backup",
        reason: "backup_failed",
        metadata: { action: "backup_failed", error: message }
      });
      return { error: message };
    }
  }

  // ============================================================
  // Stage 12 PR9 (spec § 6.2, § 6.3, § 6.4): plan/apply
  // maintenance, explain_recall, list_backups.
  // ============================================================

  /**
   * Stage 15 PR-M1-3 (issue #5, spec § 5.3): record
   * explicit per-actor feedback for a memory. The
   * `kind` enum is `up` (👍), `down` (👎), `pin`
   * (always surface), `hide` (always suppress). The
   * ranker reads the per-`kind` counts to compute
   * the `feedback_signal` component.
   */
  recordFeedback(input: {
    memory_id: string;
    kind: "up" | "down" | "pin" | "hide";
    actor_id?: string;
  }): { ok: true } | { ok: false; error: "not_found" } {
    const entry = this.store.peekEntry(input.memory_id);
    if (entry === undefined) {
      return { ok: false, error: "not_found" };
    }
    this.store.recordMemoryFeedback({
      memory_id: input.memory_id,
      actor_id: input.actor_id ?? this.defaultActor,
      kind: input.kind,
      created_at: nowIso()
    });
    return { ok: true };
  }

  /**
   * Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4):
   * record a provenance link for a memory. The
   * `source_kind` / `source_ref` pair identifies
   * the upstream source (GitHub issue, PR, commit,
   * tool call, session, or import batch). The
   * `recorded_by` actor is taken from the trusted
   * `RequestContext` when present, falling back to
   * the service's `defaultActor`. A repeat call
   * with the same `(memory_id, source_kind,
   * source_ref)` triple is a no-op (the store's
   * `INSERT OR IGNORE` on the table's primary key
   * keeps the link chain deduplicated).
   */
  recordProvenance(input: {
    memory_id: string;
    source_kind: ProvenanceSourceKind;
    source_ref: string;
    actor_id?: string;
  }): { ok: true } | { ok: false; error: "not_found" | "invalid_input" } {
    const entry = this.store.peekEntry(input.memory_id);
    if (entry === undefined) {
      return { ok: false, error: "not_found" };
    }
    return recordProvenance(this.store, {
      memory_id: input.memory_id,
      source_kind: input.source_kind,
      source_ref: input.source_ref,
      recorded_by: input.actor_id ?? this.defaultActor
    });
  }

  /**
   * Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4):
   * read the durable provenance link chain for a
   * memory. The `summary` field is what the
   * `explain_memory_provenance` MCP tool renders.
   */
  explainProvenance(memory_id: string): ProvenanceExplanation | { ok: false; error: "not_found" } {
    const entry = this.store.peekEntry(memory_id);
    if (entry === undefined) {
      return { ok: false, error: "not_found" };
    }
    return explainProvenance(this.store, memory_id);
  }

  /**
   * Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4)
   * + Stage 18 v1.1.2 (issue #23, ADR-0001):
   * the trusted-user confirmation gate. Promotes an
   * existing memory's `trust_level` to the value
   * the trusted user approved. The
   * `CapabilityStore.authorize(...)` call is the
   * only thing that authorises a trust promotion;
   * the legacy `user_confirmed: true` flag is a
   * HINT, not authorization evidence. The MCP
   * `confirm_memory_trust` tool is the canonical
   * path; this method is the service-level entry
   * point that the tool wraps.
   *
   * The promotion is restricted to the trust tiers
   * that the user can legitimately approve
   * (`user_confirmed`, `agent_observed`,
   * `inferred`); `imported` is reserved for the
   * import path. The capability check rejects
   * a privileged call before the row is updated;
   * the audit log records the rejection with the
   * actor, request_id, reason, and the previous /
   * next trust tier.
   */
  confirmMemoryTrust(input: {
    memory_id: string;
    trust_level: "user_confirmed" | "agent_observed" | "inferred";
    user_confirmed: true;
    reason?: string;
    actor_id?: string;
    capability?: string;
  }, ctx?: RequestContext):
    | {
        ok: true;
        memory_id: string;
        previous: MemoryEntry["trust_level"];
        next: MemoryEntry["trust_level"];
      }
    | { ok: false; error: "not_found" | "unauthorized" | "invalid_input"; message?: string } {
    // Stage 18 v1.1.2 follow-up (review by ora-8):
    // `peekEntry` is the write-path gate (the
    // promotion is a trust-tier escalation). The
    // SQL-boundary sensitivity predicate does
    // NOT apply here — the row must be visible
    // so the service can read the current
    // `trust_level` and decide whether the
    // transition is legal. The pre-follow-up
    // overload (no options) is the explicit
    // contract for this case.
    const entry = this.store.peekEntry(input.memory_id);
    if (entry === undefined) {
      return { ok: false, error: "not_found" };
    }
    // Stage 18 v1.1.2 (issue #23, ADR-0001): the
    // capability check is the gate. The
    // `user_confirmed: true` flag is preserved
    // for backward compatibility (the schema
    // requires it via `z.literal(true)`) but it
    // is NOT the authorization evidence. The
    // audit log records the rejection when the
    // capability is missing.
    if (this.capabilityStore === undefined) {
      const reason = "capability_missing";
      appendAudit(this.store, this.defaultActor, {
        memory_id: input.memory_id,
        scope: entry.scope,
        ...(entry.project_id !== undefined ? { project_id: entry.project_id } : {}),
        event: "write_rejected",
        actor: "system",
        reason: "unauthorized",
        metadata: {
          capability_type: "trust_promotion",
          reason,
          field: "trust_level",
          previous: entry.trust_level,
          next: input.trust_level
        }
      }, ctx);
      return { ok: false, error: "unauthorized", message: "trust promotion requires an operator capability; run `agent-recall admin grant` and supply the token" };
    }
    if (input.capability === undefined) {
      const reason = "capability_missing";
      appendAudit(this.store, this.defaultActor, {
        memory_id: input.memory_id,
        scope: entry.scope,
        ...(entry.project_id !== undefined ? { project_id: entry.project_id } : {}),
        event: "write_rejected",
        actor: "system",
        reason: "unauthorized",
        metadata: {
          capability_type: "trust_promotion",
          reason,
          field: "trust_level",
          previous: entry.trust_level,
          next: input.trust_level
        }
      }, ctx);
      return { ok: false, error: "unauthorized", message: "trust promotion requires a capability token on the request" };
    }
    // Stage 18 v1.1.2 follow-up (review by ora-8):
    // prefer the caller's `RequestContext` for
    // the authorization audit trail. The
    // pre-follow-up implementation synthesised a
    // fresh `randomUUID()` here, which made the
    // `write_rejected` audit row unlinkable to
    // the originating MCP request. The fix
    // threads `ctx` through `appendAudit` and
    // uses the caller's `request_id` /
    // `session_id` / `tool_call_id` when
    // available, falling back to a fresh UUID
    // when the caller did not supply a context.
    const decision = this.capabilityStore.authorize(
      {
        capability: input.capability,
        capability_type: "trust_promotion",
        requestContext: ctx ?? buildRequestContext({
          ...(input.actor_id !== undefined ? { actor_override: input.actor_id } : {}),
          client_name: "memory-service",
          request_id: randomUUID()
        })
      },
      // v1.1.3 GATE-02 (issue #32): thread
      // the active profile so the
      // `trust_promotion` capability type
      // (which carries
      // `profile_required: "admin"`) is
      // evaluated against the per-process
      // profile. Legacy test fixtures that
      // omit `activeProfile` default to
      // `"core"` and the per-request path
      // returns `profile_mismatch` (the
      // fail-closed contract).
      this.activeProfile
    );
    if (!decision.ok) {
      const reason = decision.reason;
      appendAudit(this.store, this.defaultActor, {
        memory_id: input.memory_id,
        scope: entry.scope,
        ...(entry.project_id !== undefined ? { project_id: entry.project_id } : {}),
        event: "write_rejected",
        actor: "system",
        reason: "unauthorized",
        metadata: {
          capability_type: "trust_promotion",
          reason,
          field: "trust_level",
          previous: entry.trust_level,
          next: input.trust_level
        }
      }, ctx);
      return { ok: false, error: "unauthorized", message: `trust promotion denied (${reason})` };
    }
    // Apply the new trust tier via a CAS update so
    // the audit log records the transition. The
    // mutation is small enough to skip the v2
    // idempotency reservation — the tool is already
    // idempotent in the "called twice with the
    // same memory" sense.
    const actor = input.actor_id ?? this.defaultActor;
    const previous = entry.trust_level;
    this.store.updateEntry(input.memory_id, {
      updated_at: nowIso(),
      trust_level: input.trust_level
    });
    appendAudit(this.store, actor, {
      memory_id: input.memory_id,
      scope: entry.scope,
      ...(entry.project_id !== undefined ? { project_id: entry.project_id } : {}),
      event: "updated",
      reason: input.reason ?? `trust_level confirmed to ${input.trust_level}`,
      metadata: {
        field: "trust_level",
        previous,
        next: input.trust_level,
        trusted_user_confirmation: true,
        capability_type: "trust_promotion"
      }
    }, ctx);
    return { ok: true, memory_id: input.memory_id, previous, next: input.trust_level };
  }


  /**
   * Build a maintenance plan. Stage 15 PR-M0-4 (issue
   * #3, spec § 6.2): the plan is durable (written to
   * `maintenance_plans`) and each item carries its own
   * `expected_revision` so apply can refuse stale plans.
   *
   * Pre-PR-M0-4 the plan was in-memory and the
   * `extractDuplicateGroups` helper read fields the
   * maintenance service never wrote (e.g. `kind`,
   * `revisions`, `representative_title`) — so
   * `proposed_actions` was always empty and the plan
   * applied nothing. Post-PR-M0-4 the helper reads the
   * actual `DuplicateGroup` shape (`reason`,
   * `memory_ids`, `titles`, `fingerprint`,
   * `details.similarity`) and the apply step targets a
   * single group per call.
   */
  planMaintenance(input: {
    scope: "global" | "project";
    project_id?: string;
    /** Cap on the number of duplicate groups in the plan. */
    max_groups?: number;
    /** Optional progress callback for long find_duplicates scans. */
    onProgress?: (processed: number, total: number) => void;
  }): Result<MaintenancePlan, "invalid_scope"> {
    if (input.scope === "project" && input.project_id === undefined) {
      return err("invalid_scope", "project scope requires project_id");
    }
    const maintenance = this.maintenance.maintainMemories({
      action: "find_duplicates",
      scope: input.scope,
      ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
      batch_size: 500,
      dry_run: true,
      strategy: "keep_first",
      ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {})
    });

    const groups = extractDuplicateGroups(maintenance);
    const max = input.max_groups ?? groups.length;
    const limited = groups.slice(0, max);

    const expected_revisions: Record<string, number> = {};
    // `seenTarget` records the per-target priority so a
    // target that appears in multiple groups (e.g. a
    // pair of identical title+body that ALSO shares
    // title and body separately) gets exactly one
    // plan item. The first group wins; groups arrive
    // in `findDuplicatesChunked`'s sort order, which
    // puts `same_title_and_body` ahead of
    // `same_title` / `same_body` /
    // `similar_title_and_body`, so the most specific
    // group wins.
    const seenTarget = new Map<string, MaintenancePlan["proposed_actions"][number]>();
    const proposed_actions: MaintenancePlan["proposed_actions"] = [];
    const summary: string[] = [];

    function addItem(item: MaintenancePlan["proposed_actions"][number]): void {
      const existing = seenTarget.get(item.target_memory_id);
      if (existing !== undefined) {
        // Same target in two groups: keep the one
        // with the higher action priority
        // (merge > forget > update > retain). If
        // equal, keep the first (most specific
        // group reason).
        if (actionPriority(item.kind) > actionPriority(existing.kind)) {
          const idx = proposed_actions.indexOf(existing);
          if (idx >= 0) proposed_actions[idx] = item;
          seenTarget.set(item.target_memory_id, item);
        }
        return;
      }
      seenTarget.set(item.target_memory_id, item);
      proposed_actions.push(item);
    }

    for (const group of limited) {
      if (group.memory_ids.length < 2) continue;
      // Read each candidate's current revision straight
      // from the store. The plan only needs `expected_revision`
      // for entries the apply step will mutate; advisory
      // (`retain`) items still record the revision so the
      // apply step can surface drift in the summary.
      const revisions = readRevisionsForIds(this.store, group.memory_ids);
      for (const [id, rev] of Object.entries(revisions)) {
        expected_revisions[id] = rev;
      }
      if (group.reason === "same_title_and_body") {
        // Spec § 6.2: only fully identical title+body
        // auto-collapse. Each target is its own item
        // (action_type='merge', evidence=the group) so
        // the apply step knows exactly which entries to
        // mutate.
        for (const id of group.memory_ids) {
          addItem({
            kind: "merge",
            target_memory_id: id,
            expected_revision: revisions[id] ?? 0,
            evidence: {
              group_reason: group.reason,
              fingerprint: group.fingerprint,
              memory_ids: group.memory_ids
            },
            risk: "high"
          });
        }
        summary.push(
          `merge ${group.memory_ids.length} duplicates of "${representativeTitle(group.titles)}"`
        );
      } else if (group.reason === "same_title" || group.reason === "same_body") {
        // Same-title or same-body alone is advisory; surface
        // a `retain` item with risk=low so the apply step
        // has a record but does not mutate.
        for (const id of group.memory_ids) {
          addItem({
            kind: "retain",
            target_memory_id: id,
            expected_revision: revisions[id] ?? 0,
            evidence: {
              group_reason: group.reason,
              fingerprint: group.fingerprint,
              memory_ids: group.memory_ids
            },
            risk: "low"
          });
        }
        summary.push(
          `flag ${group.memory_ids.length} entries with ${group.reason} (advisory only)`
        );
      } else {
        // similar_title_and_body: similar but distinct.
        // Advisory only.
        for (const id of group.memory_ids) {
          addItem({
            kind: "retain",
            target_memory_id: id,
            expected_revision: revisions[id] ?? 0,
            evidence: {
              group_reason: group.reason,
              fingerprint: group.fingerprint,
              memory_ids: group.memory_ids,
              similarity: group.details?.similarity
            },
            risk: "low"
          });
        }
        summary.push(
          `flag ${group.memory_ids.length} near-duplicate entries (advisory only)`
        );
      }
    }

    // Destructive items (merge / supersede / forget) make
    // the plan high-risk. Pure-retain plans (advisory)
    // are low-risk.
    const destructiveCount = proposed_actions.filter(
      (a) => a.kind !== "retain"
    ).length;
    const risk: MaintenancePlan["risk"] = destructiveCount > 0 ? "high" : "low";
    const plan = this.planStore.create({
      scope: input.scope,
      ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
      risk,
      creator_actor_id: this.defaultActor,
      expected_revisions,
      proposed_actions,
      summary
    });
    // Audit the plan creation so the audit log shows
    // "plan was built at <ts>, with <n> items".
    appendAudit(this.store, this.defaultActor, {
      scope: input.scope,
      ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
      event: "plan_maintenance",
      actor: "system:maintenance",
      reason: "plan_maintenance",
      metadata: {
        plan_id: plan.plan_id,
        item_count: proposed_actions.length,
        destructive_count: destructiveCount,
        advisory_count: proposed_actions.length - destructiveCount,
        risk,
        ttl_seconds: 24 * 60 * 60
      }
    });
    return { ok: true, value: plan };
  }

  /**
   * Apply a previously-built plan. Stage 15 PR-M0-4:
   * - load the plan from the durable `maintenance_plans` table;
   * - re-validate the `plan_hash` (catches tampering);
   * - re-validate every item's `expected_revision` (CAS);
   * - for each `merge` group, call the targeted
   *   `mergePlannedGroup` helper (NOT the broad
   *   `merge_duplicates` action);
   * - record per-item `apply_maintenance` audit + revision;
   * - mark the plan `completed` only when every
   *   destructive item succeeded.
   *
   * Stage 16 v1.1.1 PR-5 (issue #12): the entire apply
   * is now wrapped in a single `BEGIN IMMEDIATE`
   * transaction. The plan transitions through
   * `pending -> applying -> completed|rejected` inside
   * the transaction so a failure on group N rolls back
   * the business writes for groups 1..N-1 AND the
   * state transition. The apply never mutates an
   * entry that is not in `proposed_actions`.
   *
   * Crash semantics: a process crash before the
   * transaction commits leaves the plan in `pending`
   * (the `pending -> applying` transition is part of
   * the same transaction). A process crash after
   * `markApplying` but before `markCompleted` leaves
   * the plan in `applying`; the next apply call sees
   * `applying` and surfaces `plan_expired` so the
   * operator can wait for the takeover window or mark
   * the plan expired manually.
   */
  applyMaintenance(input: {
    plan_id: string;
    confirm: boolean;
    idempotency_key: string;
  }): Result<PlanApplyResult, "invalid_schema"> {
    if (input.confirm !== true) {
      return err("invalid_schema", "apply_maintenance requires confirm: true", { plan_id: input.plan_id });
    }
    if (typeof input.idempotency_key !== "string" || input.idempotency_key.length === 0) {
      return err("invalid_schema", "apply_maintenance requires a non-empty idempotency_key", { plan_id: input.plan_id });
    }
    const plan = this.planStore.get(input.plan_id);
    if (plan === undefined) {
      return {
        ok: true,
        value: {
          ok: false,
          plan_id: input.plan_id,
          error: "plan_not_found",
          details: { reason: "plan_not_found" }
        }
      };
    }

    // Capture current revisions for the entries the plan
    // touches. The plan may have items beyond the
    // expected_revisions map (e.g. a future plan could
    // touch a memory without a recorded revision); we
    // build the snapshot here so the validator can refuse
    // any "unplanned_target".
    const currentRevisions: Record<string, number> = {};
    for (const action of plan.proposed_actions) {
      const entry = this.store.peekEntry(action.target_memory_id);
      currentRevisions[action.target_memory_id] = entry?.revision ?? -1;
    }

    const validation = this.planStore.validate(input.plan_id, currentRevisions, input.idempotency_key);
    if (!validation.ok) {
      // Stage 15 PR-M0-4: only mark the plan `rejected`
      // when the refusal is a *correctness* failure
      // (stale revision, hash drift, plan completed
      // with a different key). Lifecycle failures
      // (`plan_expired`, `plan_completed`,
      // `plan_not_found`) carry their own terminal
      // state and the `markRejected` call would
      // overwrite it. The `validate` step has already
      // flipped `pending` -> `expired` when relevant.
      if (
        validation.error === "stale_revision" ||
        validation.error === "plan_hash_drift" ||
        validation.error === "unplanned_target"
      ) {
        this.planStore.markRejected(input.plan_id);
      }
      appendAudit(this.store, this.defaultActor, {
        scope: plan.scope,
        ...(plan.project_id !== undefined ? { project_id: plan.project_id } : {}),
        event: "apply_maintenance",
        actor: "system:maintenance",
        reason: "plan_rejected",
        metadata: {
          plan_id: input.plan_id,
          ok: false,
          error: validation.error,
          details: validation.details ?? {},
          idempotency_key: input.idempotency_key
        }
      });
      return { ok: true, value: validation };
    }

    // Stage 16 v1.1.1 PR-5 (issue #12): idempotent
    // replay. The validator returned `ok: true` with
    // a `replay` field when the plan is already
    // completed and the idempotency key matches the
    // one stored on the row. We return the original
    // success result verbatim.
    if (validation.replay !== undefined) {
      appendAudit(this.store, this.defaultActor, {
        scope: plan.scope,
        ...(plan.project_id !== undefined ? { project_id: plan.project_id } : {}),
        event: "apply_maintenance",
        actor: "system:maintenance",
        reason: "plan_replay",
        metadata: {
          plan_id: input.plan_id,
          ok: true,
          applied: validation.replay.applied,
          rejected: validation.replay.rejected,
          idempotency_key: input.idempotency_key,
          replayed: true
        }
      });
      return {
        ok: true,
        value: {
          ok: true,
          plan_id: input.plan_id,
          applied: validation.replay.applied,
          rejected: validation.replay.rejected,
          idempotency_key: input.idempotency_key
        }
      };
    }

    // Idempotent retry: same plan + same key = no-op
    // success. The validator already returned `ok: true`
    // with the plan; we just emit the audit and return.
    const destructiveItems = plan.proposed_actions.filter((a) => a.kind !== "retain");
    if (destructiveItems.length === 0) {
      this.planStore.markCompleted(input.plan_id, input.idempotency_key, { applied: 0, rejected: 0 });
      appendAudit(this.store, this.defaultActor, {
        scope: plan.scope,
        ...(plan.project_id !== undefined ? { project_id: plan.project_id } : {}),
        event: "apply_maintenance",
        actor: "system:maintenance",
        reason: "plan_no_destructive_items",
        metadata: {
          plan_id: input.plan_id,
          ok: true,
          applied: 0,
          rejected: 0,
          idempotency_key: input.idempotency_key
        }
      });
      return {
        ok: true,
        value: {
          ok: true,
          plan_id: input.plan_id,
          applied: 0,
          rejected: 0,
          idempotency_key: input.idempotency_key
        }
      };
    }

    // Group the merge items by `evidence.fingerprint` so
    // each duplicate group is processed as a single
    // targeted merge call. Items with the same fingerprint
    // share the same `memory_ids` list (per the plan
    // construction above), so grouping is unambiguous.
    const groupsByFingerprint = new Map<string, MaintenancePlan["proposed_actions"]>();
    for (const action of destructiveItems) {
      const fingerprint = readFingerprintFromEvidence(action.evidence);
      if (fingerprint === undefined) {
        // No fingerprint means the item was hand-crafted
        // outside the planner. Refuse; we never apply
        // unstructured items.
        this.planStore.markRejected(input.plan_id);
        appendAudit(this.store, this.defaultActor, {
          scope: plan.scope,
          ...(plan.project_id !== undefined ? { project_id: plan.project_id } : {}),
          event: "apply_maintenance",
          actor: "system:maintenance",
          reason: "plan_unstructured_item",
          metadata: {
            plan_id: input.plan_id,
            ok: false,
            error: "unplanned_target",
            details: { target_memory_id: action.target_memory_id },
            idempotency_key: input.idempotency_key
          }
        });
        return {
          ok: true,
          value: {
            ok: false,
            plan_id: input.plan_id,
            error: "unplanned_target",
            details: { target_memory_id: action.target_memory_id }
          }
        };
      }
      const list = groupsByFingerprint.get(fingerprint) ?? [];
      list.push(action);
      groupsByFingerprint.set(fingerprint, list);
    }

    const scope: ResolvedReadScope = {
      scope: plan.scope,
      ...(plan.project_id !== undefined ? { project_id: plan.project_id } : {})
    };

    // Stage 16 v1.1.1 PR-5 (issue #12): the entire
    // apply runs inside a single store transaction.
    // The transaction opens with `markApplying` (the
    // `pending -> applying` state transition); the
    // group apply calls run inside the same
    // transaction; the close writes
    // `markCompleted` (the `applying -> completed`
    // transition with the canonical result). A throw
    // anywhere inside the transaction rolls back every
    // mutation AND the state transition.
    //
    // The pre-mutation backup runs OUTSIDE the
    // transaction (VACUUM INTO cannot run against a
    // connection holding an open transaction; the
    // per-group `maybeBackup` is also disabled inside
    // the transaction for the same reason).
    const totalTargetIds = plan.proposed_actions.filter((a) => a.kind !== "retain").length;
    this.maintenance.applyPlannedPreBackup(totalTargetIds);
    let applied = 0;
    let rejected = 0;
    let firstFailure: { reason: string; target_ids: string[] } | undefined;
    try {
      this.store.transaction(() => {
        // Flip the plan to `applying`. If this
        // transition fails (the plan is no longer
        // `pending`), abort the apply with a clear
        // error.
        const transitioned = this.planStore.markApplying(input.plan_id);
        if (!transitioned) {
          throw new Error(
            `plan ${input.plan_id} is no longer pending; another caller may have applied it`
          );
        }
        for (const [, items] of groupsByFingerprint) {
          const target_ids = items.map((a) => a.target_memory_id);
          const expected_revisions: Record<string, number> = {};
          for (const a of items) expected_revisions[a.target_memory_id] = a.expected_revision;
          const result = this.maintenance.applyPlannedGroupInTransaction({
            scope,
            target_ids,
            expected_revisions,
            reason: "apply_maintenance",
            strategy: "keep_first"
          });
          if (result.ok) {
            applied += result.superseded_ids.length;
            continue;
          }
          // The first failed group triggers the
          // rollback. The transaction is closed by
          // the throw; the plan state stays
          // `pending` (the `markApplying` was
          // rolled back too).
          rejected += 1;
          firstFailure = { reason: result.reason, target_ids };
          throw new Error(
            `apply_maintenance: group failed (${result.reason}) for target_ids=${target_ids.join(",")}`
          );
        }
        // All groups succeeded. Persist the
        // canonical result so a replay with the
        // same key returns the same shape.
        this.planStore.markCompleted(input.plan_id, input.idempotency_key, { applied, rejected: 0 });
      });
    } catch (error) {
      // The transaction rolled back. The plan is
      // back in `pending` (or `applying` if the
      // crash happened after COMMIT; the next apply
      // will see `applying` and surface
      // `plan_expired`). Emit a single audit event
      // for the failure.
      appendAudit(this.store, this.defaultActor, {
        scope: plan.scope,
        ...(plan.project_id !== undefined ? { project_id: plan.project_id } : {}),
        event: "apply_maintenance",
        actor: "system:maintenance",
        reason: "plan_apply_failed",
        metadata: {
          plan_id: input.plan_id,
          ok: false,
          error: firstFailure?.reason ?? "transaction_error",
          target_ids: firstFailure?.target_ids ?? [],
          applied,
          rejected,
          idempotency_key: input.idempotency_key,
          error_message: error instanceof Error ? error.message : String(error)
        }
      });
      if (firstFailure !== undefined) {
        return {
          ok: true,
          value: {
            ok: false,
            plan_id: input.plan_id,
            error: "stale_revision",
            details: { reason: firstFailure.reason, target_ids: firstFailure.target_ids, applied, rejected }
          }
        };
      }
      // Re-throw a generic transaction error so
      // the caller sees something actionable. The
      // `markApplying` was rolled back so a retry
      // can re-apply.
      return err("invalid_schema", `apply_maintenance transaction failed: ${error instanceof Error ? error.message : String(error)}`, { plan_id: input.plan_id });
    }

    appendAudit(this.store, this.defaultActor, {
      scope: plan.scope,
      ...(plan.project_id !== undefined ? { project_id: plan.project_id } : {}),
      event: "apply_maintenance",
      actor: "system:maintenance",
      reason: "plan_applied",
      metadata: {
        plan_id: input.plan_id,
        ok: true,
        applied,
        rejected: 0,
        idempotency_key: input.idempotency_key
      }
    });

    return {
      ok: true,
      value: {
        ok: true,
        plan_id: input.plan_id,
        applied,
        rejected: 0,
        idempotency_key: input.idempotency_key
      }
    };
  }

  /**
   * Stage 12 PR9 (spec § 6.4): return the ranked recall
   * candidates with a score breakdown. The function uses
   * the same ranker the read service uses for export, so
   * the explain numbers match what the renderer consumed.
   * This call does NOT record an access (spec § 6.4 — "explain_recall
   * ... 不记录访问").
   */
  explainRecall(input: {
    query: string;
    scope: "global" | "project";
    project_id?: string;
    include_global?: boolean;
    top_k?: number;
    /**
     * Stage 15 PR-M1-1 (issue #6, spec § 5.3):
     * optional `now` for deterministic explanations.
     * When omitted, the ranker uses `new Date()`. Two
     * calls with the same inputs but different `now`
     * produce different `recency` scores, so the
     * byte-identical explanation contract only holds
     * when `now` is fixed. Tests should pass a fixed
     * `now`; production callers can omit it.
     */
    now?: Date;
  }): Result<{ ranking_version: string; items: Array<{ memory_id: string; score: number; components: RankedItem["components"]; title: string; trust_boost: number }> }, "invalid_scope"> {
    if (input.scope === "project" && input.project_id === undefined) {
      return err("invalid_scope", "project scope requires project_id");
    }
    const candidates = collectCandidates(this.store, input.scope, input.project_id, input.include_global ?? false);
    const topK = input.top_k ?? 10;
    const ranked = rankRecall({
      candidates,
      query: input.query,
      primaryScope: input.scope,
      actor: {
        currentActor: this.defaultActor,
        actorForEntry: (entry) => entry.writer_actor_id
      },
      // Stage 15 PR-M1-3 (issue #5, spec § 5.3):
      // pass the store so the ranker can read
      // `memory_accesses` + `memory_feedback` for
      // real (non-placeholder) signals.
      store: this.store,
      ...(input.now !== undefined ? { now: input.now } : {})
    });
    const limited = ranked.slice(0, topK);
    return {
      ok: true,
      value: {
        ranking_version: "coding-default-v2",
        items: limited.map((item) => ({
          memory_id: item.entry.id,
          score: item.score,
          components: item.components,
          title: item.entry.title,
          trust_boost: computeTrustBoost(this._store, item.entry, this.defaultActor, (e) => e.writer_actor_id)
        }))
      }
    };
  }

  /**
   * Stage 12 PR9 (spec § 6.3, § 6.7): list the backup files
   * in the data home. Returns the file metadata sorted by
   * mtime desc (newest first). When the data home is
   * unknown or the backup directory does not exist, return
   * an empty list.
   */
  listBackups(): { backup_dir: string | undefined; entries: Array<{ name: string; size: number; mtimeMs: number }> } {
    if (this.dataHome === undefined) {
      return { backup_dir: undefined, entries: [] };
    }
    const backupDir = join(this.dataHome, "backups");
    return { backup_dir: backupDir, entries: listBackups(backupDir) };
  }

  /**
   * Stage 13 PR10 (spec § 6.7): peek a memory entry by
   * id without recording an access. Used by the
   * importer's conflict-resolution path so a `replace`
   * can compare revisions without bumping the live
   * entry's access count.
   */
  peekMemoryById(id: string): MemoryEntry | undefined {
    return this._store.peekEntry(id);
  }

  /**
   * Stage 13 PR10 (spec § 6.7): insert an entry that
   * came from a prior export, preserving the source id.
   * The validation pipeline (scope / secret / budget)
   * runs the same way as `remember`, but the id is
   * taken from the entry instead of being generated.
   *
   * Throws on validation failure or on a duplicate id
   * (the caller is expected to have already checked
   * via `peekMemoryById`).
   */
  insertImportedEntry(
    entry: MemoryEntry,
    actor: string,
    /**
     * Stage 18 v1.1.2 (issue #26, task 7): optional
     * import-lineage metadata. Threaded onto the
     * `created` audit event's metadata so a reviewer
     * can trace the row back to the exact bundle /
     * batch that produced the mutation.
     */
    importLineage?: { import_batch_id: string; bundle_hash: string; bundle_version: number }
  ): void {
    // Stage 13 PR10: importers go through the same
    // validation as live remember — we delegate to the
    // write service and reuse its audit + scope guards.
    this.write.insertImportedEntry(entry, actor, importLineage);
  }

  /**
   * Stage 13 PR10: alternate name used by the import
   * path. The planImport + applyImport flow calls
   * this so the audit event's actor is the caller's
   * default actor, not the system.
   */
  writeInsertImportedEntry(
    entry: MemoryEntry,
    actor: string,
    importLineage?: { import_batch_id: string; bundle_hash: string; bundle_version: number }
  ): void {
    this.write.insertImportedEntry(entry, actor, importLineage);
  }
}

/**
 * Stage 15 PR-M0-4 (issue #3, spec § 6.2): extract
 * `DuplicateGroup` records from a `find_duplicates`
 * maintenance result. Pre-PR-M0-4 the helper read
 * `group.kind`, `group.revisions`, and
 * `group.representative_title` — fields the maintenance
 * service never wrote — so the planner always saw an
 * empty `proposed_actions` array. The new shape mirrors
 * what `MemoryMaintenanceService.findDuplicatesChunked`
 * actually produces (see `DuplicateGroup` in
 * `services/memory-maintenance-service.ts`).
 */
function extractDuplicateGroups(maintenance: MaintainMemoriesResult): Array<{
  reason: "same_title_and_body" | "same_title" | "same_body" | "similar_title_and_body";
  fingerprint: string;
  memory_ids: string[];
  titles: string[];
  details?: { similarity?: number };
}> {
  if (maintenance.action !== "find_duplicates") return [];
  const details = maintenance.details as { groups?: unknown } | undefined;
  const groups = details?.groups;
  if (!Array.isArray(groups)) return [];
  return groups as Array<{
    reason: "same_title_and_body" | "same_title" | "same_body" | "similar_title_and_body";
    fingerprint: string;
    memory_ids: string[];
    titles: string[];
    details?: { similarity?: number };
  }>;
}

function readRevisionsForIds(
  store: SQLiteMemoryStore,
  ids: readonly string[]
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of ids) {
    const entry = store.peekEntry(id);
    out[id] = entry?.revision ?? 0;
  }
  return out;
}

function readFingerprintFromEvidence(evidence: Record<string, unknown>): string | undefined {
  const fp = evidence.fingerprint;
  return typeof fp === "string" ? fp : undefined;
}

function representativeTitle(titles: readonly string[]): string {
  for (const t of titles) {
    if (typeof t === "string" && t.trim().length > 0) return t.trim();
  }
  return "untitled";
}

/**
 * Action priority used by the planner when a target
 * memory shows up in more than one duplicate group
 * (e.g. a pair of identical title+body that also share
 * their title alone). The higher number wins.
 */
function actionPriority(kind: MaintenancePlan["proposed_actions"][number]["kind"]): number {
  switch (kind) {
    case "merge":
      return 4;
    case "supersede":
      return 3;
    case "forget":
      return 2;
    case "update":
      return 1;
    case "retain":
      return 0;
  }
}

function collectCandidates(
  store: SQLiteMemoryStore,
  scope: "global" | "project",
  projectId: string | undefined,
  includeGlobal: boolean
): MemoryEntry[] {
  const filters: EntryFilters = { status: "active" };
  if (scope === "global") {
    return store.listEntries(filters);
  }
  if (projectId === undefined) return [];
  const projectEntries = store.listEntries({ ...filters, scope: "project", project_id: projectId });
  if (!includeGlobal) return projectEntries;
  const globalEntries = store.listEntries({ ...filters, scope: "global" });
  return [...projectEntries, ...globalEntries];
}
