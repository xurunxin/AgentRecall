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
import { runBackup } from "./backup.js";
import { appendAudit } from "./services/memory-service-helpers.js";
import { MemoryReadService, type ExportMemoryContextInput, type ListResult, type MemoryBudgetResult, type ResolvedReadScope, type SearchResult } from "./services/memory-read-service.js";
import { MemoryMaintenanceService, type MaintainMemoriesInput, type MaintainMemoriesResult, type MaintenanceAction } from "./services/memory-maintenance-service.js";
import { MemoryWriteService, type RememberResult } from "./services/memory-write-service.js";
import type { BudgetUsage, EntryFilters, SearchFilters, SQLiteMemoryStore } from "./sqlite-store.js";
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

  constructor(
    private readonly store: SQLiteMemoryStore,
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
    this.backupFn = () => this.backup();
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
  ): Result<{ memory_id: string }, "not_found" | "invalid_state" | "invalid_schema" | "secret_detected" | "capacity_exceeded"> {
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
}
