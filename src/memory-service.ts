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
import type { BudgetUsage, EntryFilters, SearchFilters, SQLiteMemoryStore } from "./sqlite-store.js";
import { CURRENT_SCHEMA_VERSION } from "./sqlite-store.js";
import { type RememberInput, type UpdateInput } from "./write-validator.js";
import type { RequestContext } from "./request-context.js";

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
    private readonly dataHome?: string
  ) {
    const resolveActorFn = (override?: string) => resolveActor(override ?? undefined, process.env);
    const resolveExporterFn = (): MarkdownExporter =>
      this.exporter ?? new MarkdownExporter(join(process.cwd(), ".agent-recall", "exports"));

    this.read = new MemoryReadService({
      store,
      defaultActor,
      resolveExporter: resolveExporterFn
    });
    this.write = new MemoryWriteService({
      store,
      defaultActor,
      configureProjectBudget: (project_id, budget, canonical_path, display_name) =>
        this.configureProjectBudget(project_id, budget, canonical_path, display_name)
    });
    this.maintenance = new MemoryMaintenanceService({
      store,
      defaultActor,
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

  // ============================================================
  // Public read methods — delegate to MemoryReadService
  // ============================================================

  getMemory(
    id: string,
    accessedBy?: string
  ): { entry: MemoryEntry; audit: MemoryAuditEvent[] } | undefined {
    return this.read.getMemory(id, accessedBy);
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

  remember(input: RememberInput, ctx?: RequestContext): Result<RememberResult, "invalid_schema" | "invalid_scope" | "secret_detected" | "capacity_exceeded" | "duplicate_candidate" | "idempotency_mismatch"> {
    return this.write.remember(input, ctx);
  }

  updateMemory(
    id: string,
    input: UpdateInput,
    ctx?: RequestContext
  ): Result<{ memory_id: string }, "not_found" | "invalid_state" | "invalid_schema" | "secret_detected" | "capacity_exceeded" | "stale_revision" | "idempotency_mismatch"> {
    return this.write.updateMemory(id, input, ctx);
  }

  supersedeMemory(input: {
    old_memory_ids: string[];
    replacement: RememberInput;
    reason: string;
    idempotency_key?: string;
  }, ctx?: RequestContext): Result<{ memory_id: string }, "not_found" | "invalid_state" | "invalid_schema" | "invalid_scope" | "secret_detected" | "capacity_exceeded" | "duplicate_candidate" | "idempotency_mismatch"> {
    return this.write.supersedeMemory(input, ctx);
  }

  mergeMemories(input: {
    old_memory_ids: string[];
    replacement: RememberInput;
    reason: string;
    strategy?: "keep_first" | "keep_newest";
    idempotency_key?: string;
  }, ctx?: RequestContext): Result<{ memory_id: string; merged_from?: string[] }, "not_found" | "invalid_state" | "invalid_schema" | "invalid_scope" | "secret_detected" | "capacity_exceeded" | "duplicate_candidate" | "idempotency_mismatch"> {
    return this.write.mergeMemories(input, ctx);
  }

  forgetMemory(
    id: string,
    reason: string,
    ctx?: RequestContext,
    options?: { idempotency_key?: string; expected_revision?: number }
  ): Result<{ memory_id: string; released_chars: number }, "not_found" | "idempotency_mismatch"> {
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
   * If any destructive item fails (stale revision, scope
   * mismatch, drift), the plan is marked `rejected` and
   * no further items are attempted. The apply step never
   * mutates an entry that is not in `proposed_actions`.
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

    // Idempotent retry: same plan + same key = no-op
    // success. The validator already returned `ok: true`
    // with the plan; we just emit the audit and return.
    const destructiveItems = plan.proposed_actions.filter((a) => a.kind !== "retain");
    if (destructiveItems.length === 0) {
      this.planStore.markCompleted(input.plan_id, input.idempotency_key);
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

    let applied = 0;
    let rejected = 0;
    for (const [, items] of groupsByFingerprint) {
      const target_ids = items.map((a) => a.target_memory_id);
      const expected_revisions: Record<string, number> = {};
      for (const a of items) expected_revisions[a.target_memory_id] = a.expected_revision;
      const result = this.maintenance.mergePlannedGroup({
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
      rejected += 1;
      // On the first failed merge, mark the plan
      // rejected and stop; we do NOT roll back already-
      // applied groups (they are audited and reversible
      // via the entry's own `superseded_by` + revision
      // history). Spec § 6.2 calls for a fail-loud
      // outcome; partial application is reported in the
      // return value.
      this.planStore.markRejected(input.plan_id);
      appendAudit(this.store, this.defaultActor, {
        scope: plan.scope,
        ...(plan.project_id !== undefined ? { project_id: plan.project_id } : {}),
        event: "apply_maintenance",
        actor: "system:maintenance",
        reason: "plan_partial",
        metadata: {
          plan_id: input.plan_id,
          ok: false,
          error: result.reason,
          target_ids,
          applied,
          rejected: rejected,
          idempotency_key: input.idempotency_key
        }
      });
      return {
        ok: true,
        value: {
          ok: false,
          plan_id: input.plan_id,
          error: "stale_revision",
          details: { reason: result.reason, target_ids, applied, rejected }
        }
      };
    }

    this.planStore.markCompleted(input.plan_id, input.idempotency_key);
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
      ...(input.now !== undefined ? { now: input.now } : {})
    });
    const limited = ranked.slice(0, topK);
    return {
      ok: true,
      value: {
        ranking_version: "coding-default-v1",
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
  insertImportedEntry(entry: MemoryEntry, actor: string): void {
    // Stage 13 PR10: importers go through the same
    // validation as live remember — we delegate to the
    // write service and reuse its audit + scope guards.
    this.write.insertImportedEntry(entry, actor);
  }

  /**
   * Stage 13 PR10: alternate name used by the import
   * path. The planImport + applyImport flow calls
   * this so the audit event's actor is the caller's
   * default actor, not the system.
   */
  writeInsertImportedEntry(entry: MemoryEntry, actor: string): void {
    this.write.insertImportedEntry(entry, actor);
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
