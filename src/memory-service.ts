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

export type InvalidScopeResult = Result<never, "invalid_scope">;

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
  /** Stage 12 PR9 (spec § 6.2): in-memory plan store for the
   * plan/apply maintenance split. Reset on every server
   * restart; agents are expected to call plan_maintenance
   * again after a restart. */
  private readonly planStore = new MaintenancePlanStore();

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

  exportMemoryContext(input: ExportMemoryContextInput): string {
    return this.read.exportMemoryContext(input);
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

  remember(input: RememberInput): Result<RememberResult, "invalid_schema" | "invalid_scope" | "secret_detected" | "capacity_exceeded" | "duplicate_candidate"> {
    return this.write.remember(input);
  }

  updateMemory(
    id: string,
    input: UpdateInput
  ): Result<{ memory_id: string }, "not_found" | "invalid_state" | "invalid_schema" | "secret_detected" | "capacity_exceeded" | "stale_revision"> {
    return this.write.updateMemory(id, input);
  }

  supersedeMemory(input: {
    old_memory_ids: string[];
    replacement: RememberInput;
    reason: string;
  }): Result<{ memory_id: string }, "not_found" | "invalid_state" | "invalid_schema" | "invalid_scope" | "secret_detected" | "capacity_exceeded" | "duplicate_candidate"> {
    return this.write.supersedeMemory(input);
  }

  mergeMemories(input: {
    old_memory_ids: string[];
    replacement: RememberInput;
    reason: string;
    strategy?: "keep_first" | "keep_newest";
  }): Result<{ memory_id: string; merged_from?: string[] }, "not_found" | "invalid_state" | "invalid_schema" | "invalid_scope" | "secret_detected" | "capacity_exceeded" | "duplicate_candidate"> {
    return this.write.mergeMemories(input);
  }

  forgetMemory(
    id: string,
    reason: string
  ): Result<{ memory_id: string; released_chars: number }, "not_found"> {
    return this.write.forgetMemory(id, reason);
  }

  // ============================================================
  // Public maintenance methods — delegate to MemoryMaintenanceService
  // ============================================================

  maintainMemories(input: MaintainMemoriesInput): MaintainMemoriesResult {
    return this.maintenance.maintainMemories(input);
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
   * Build a maintenance plan. The plan captures the actions
   * the maintenance service would take (currently:
   * merge_duplicates) plus the expected revision of every
   * entry the plan touches, so apply can refuse if any
   * entry drifted (spec § 6.2).
   */
  planMaintenance(input: {
    scope: "global" | "project";
    project_id?: string;
    /** Cap on the number of merge groups in the plan. */
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
    const proposed_actions: MaintenancePlan["proposed_actions"] = [];
    const summary: string[] = [];

    for (const group of limited) {
      const kind = group.kind;
      const ids = group.memory_ids;
      if (ids.length < 2) continue;
      if (kind === "same_title_and_body") {
        // Spec § 6.2: only fully identical title+body auto-collapse.
        proposed_actions.push({ kind: "merge_duplicates", old_memory_ids: ids, reason: "same_title_and_body" });
        summary.push(`merge ${ids.length} duplicates of "${group.representative_title ?? "untitled"}"`);
        for (const id of ids) expected_revisions[id] = group.revisions[id] ?? 0;
      } else if (kind === "same_title" || kind === "same_body") {
        // Same-title or same-body alone is advisory; surface as a
        // plan entry but do not auto-merge.
        summary.push(`flag ${ids.length} entries with ${kind} (advisory only)`);
      } else {
        summary.push(`flag ${ids.length} near-duplicate entries (advisory only)`);
      }
    }

    const risk: "low" | "high" = proposed_actions.length === 0 ? "low" : "low";
    const plan = this.planStore.create({
      scope: input.scope,
      ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
      risk,
      expected_revisions,
      proposed_actions,
      summary
    });
    return { ok: true, value: plan };
  }

  /**
   * Apply a previously-built plan. The caller must pass
   * `confirm: true` and an `idempotency_key`; if any
   * expected revision drifted, the plan is invalidated
   * without mutation (spec § 6.2).
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
      return { ok: true, value: { ok: false, plan_id: input.plan_id, error: "plan_invalidated", details: { reason: "plan_not_found" } } };
    }

    // Capture current revisions for the entries the plan touches.
    const currentRevisions: Record<string, number> = {};
    for (const memoryId of Object.keys(plan.expected_revisions)) {
      const entry = this.store.peekEntry(memoryId);
      currentRevisions[memoryId] = entry?.revision ?? -1;
    }

    const validation = this.planStore.validate(input.plan_id, currentRevisions, input.idempotency_key);
    if (!validation.ok) {
      return { ok: true, value: validation };
    }
    if (validation.applied === 0) {
      // Idempotent retry: nothing to do.
      return { ok: true, value: validation };
    }

    let appliedCount = 0;
    for (const action of plan.proposed_actions) {
      if (action.kind !== "merge_duplicates") continue;
      // Spec § 6.2: only fully identical title+body auto-collapse.
      // The plan already filters; the merge service still re-checks
      // before mutating.
      const target = action.old_memory_ids[0];
      const rest = action.old_memory_ids.slice(1);
      if (target === undefined || rest.length === 0) continue;
      const result = this.maintenance.maintainMemories({
        action: "merge_duplicates",
        scope: plan.scope,
        ...(plan.project_id !== undefined ? { project_id: plan.project_id } : {}),
        batch_size: 100,
        dry_run: false,
        strategy: "keep_first"
      });
      // The plain `merge_duplicates` action processes the whole
      // dataset, so the per-action plan entry is "advisory" once
      // we are inside apply: we count success at the action level,
      // not at the per-group level. PR10 will replace this with a
      // targeted single-group merge helper.
      if (result.changed > 0) appliedCount += 1;
    }

    this.planStore.markApplied(input.plan_id, input.idempotency_key);
    return {
      ok: true,
      value: {
        ok: true,
        plan_id: input.plan_id,
        applied: appliedCount,
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
      }
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
          trust_boost: computeTrustBoost(item.entry, this.defaultActor, (e) => e.writer_actor_id)
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

function extractDuplicateGroups(maintenance: MaintainMemoriesResult): Array<{
  kind: string;
  memory_ids: string[];
  revisions: Record<string, number>;
  representative_title?: string;
}> {
  if (maintenance.action !== "find_duplicates") return [];
  const details = maintenance.details as { groups?: unknown } | undefined;
  const groups = details?.groups;
  if (!Array.isArray(groups)) return [];
  return groups as Array<{
    kind: string;
    memory_ids: string[];
    revisions: Record<string, number>;
    representative_title?: string;
  }>;
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
