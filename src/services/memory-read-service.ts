// src/services/memory-read-service.ts
//
// Stage 9: the read path of MemoryService, extracted into
// its own service. Owns: getMemory, listMemories,
// searchMemories, getMemoryBudget, exportMemoryContext.
//
// Stateless from the perspective of the caller's writes:
// every method is read-only (a listEntries / searchEntries
// / getEntry call). The trust_boost annotation that
// exportMemoryContext adds to each entry is computed here
// because the writer actor lookup is part of the read
// pipeline (the agent should see "I wrote this" at
// recall time, not at write time).

import {
  rankCleanupCandidates,
  type CandidateAction
} from "../budget-governor.js";
import {
  nowIso,
  err,
  ok,
  type MemoryAuditEvent,
  type MemoryBudget,
  type MemoryEntry,
  type MemoryScope,
  type ProjectScope,
  type Result
} from "../domain.js";
import { MarkdownExporter } from "../markdown-exporter.js";
import { resolveMemoryScope } from "../scope-resolver.js";
import type { BudgetUsage, EntryFilters, SearchFilters, SQLiteMemoryStore } from "../sqlite-store.js";
import {
  actorForEntry,
  budgetFor,
  compareText,
  computeTrustBoost,
  contextQueryScore,
  queryTokens,
  usageFromActiveEntries
} from "./memory-service-helpers.js";

export type ResolvedReadScope = {
  scope: MemoryScope;
  project_id?: string;
};

export type ListResult = { items: MemoryEntry[] };

export type InvalidScopeResult = Result<never, "invalid_scope">;

export type SearchMemoryItem = Pick<
  MemoryEntry,
  "id" | "scope" | "type" | "topic" | "title" | "tags" | "source" | "updated_at" | "status"
> & {
  project_id?: string;
  match_reason: string;
};

export type SearchResult = { items: SearchMemoryItem[] };

export type MemoryBudgetResult = {
  budget: MemoryBudget;
  usage: BudgetUsage;
  cleanup_candidates: CandidateAction[];
};

export type ExportMemoryContextInput = {
  scope: MemoryScope;
  project_id?: string;
  project_path?: string;
  query?: string;
  include_global?: boolean;
  budget_chars: number;
  types?: string[];
  topics?: string[];
};

type ListServiceFilters = EntryFilters & { project_path?: string };
type SearchServiceFilters = SearchFilters & { include_global?: boolean; project_path?: string };

export type ReadContext = {
  store: SQLiteMemoryStore;
  defaultActor: string;
  /** Optional MarkdownExporter; rebuilt on each export call when missing. */
  exporter?: MarkdownExporter;
  /** Returns the MarkdownExporter for read-side exports. */
  resolveExporter: () => MarkdownExporter;
};

export class MemoryReadService {
  constructor(private readonly ctx: ReadContext) {}

  getMemory(
    id: string,
    accessedBy?: string
  ): { entry: MemoryEntry; audit: MemoryAuditEvent[] } | undefined {
    const entry = this.ctx.store.getEntry(id, accessedBy);
    return entry === undefined ? undefined : { entry, audit: this.ctx.store.getAuditEvents(id) };
  }

  listMemories(filters: ListServiceFilters & { scope: "project"; project_id: string }): ListResult;
  listMemories(filters: ListServiceFilters & { scope: "project"; project_path: string }): ListResult;
  listMemories(filters: ListServiceFilters & { scope?: "global" }): ListResult;
  listMemories(filters: ListServiceFilters): ListResult | InvalidScopeResult;
  listMemories(filters: ListServiceFilters): ListResult | InvalidScopeResult {
    const resolved = this.resolveOptionalReadScope(filters);
    if (!resolved.ok) {
      return resolved;
    }
    return {
      items: this.ctx.store.listEntries({
        ...this.entryFiltersForRead(filters, resolved.value),
        status: filters.status ?? "active"
      })
    };
  }

  searchMemories(filters: SearchServiceFilters & { scope: "project"; project_id: string }): SearchResult;
  searchMemories(filters: SearchServiceFilters & { scope: "project"; project_path: string }): SearchResult;
  searchMemories(filters: SearchServiceFilters & { scope: "global" }): SearchResult;
  searchMemories(filters: SearchServiceFilters): SearchResult | InvalidScopeResult;
  searchMemories(filters: SearchServiceFilters): SearchResult | InvalidScopeResult {
    const resolved = this.resolveOptionalReadScope(filters);
    if (!resolved.ok) {
      return resolved;
    }
    // Stage 9: pull `include_global` out before forwarding filters
    // to the store (the store has no native global-merge concept).
    // When a project search is asked to also surface global hits,
    // run a second searchEntries against the global scope and
    // prepend the global items, then slice to the limit. This
    // matches the pre-split MemoryService.searchMemories behavior.
    const { include_global: includeGlobal, ...storeFilters } = filters;
    const resolvedFilters = this.entryFiltersForRead(storeFilters, resolved.value);
    const limit = filters.limit ?? 10;
    const status = filters.status ?? "active";
    const projectItems = this.ctx.store.searchEntries({
      ...resolvedFilters,
      query: filters.query,
      status,
      limit
    });
    const globalItems =
      resolved.value.scope === "project" && includeGlobal
        ? this.ctx.store.searchEntries({
            query: filters.query,
            scope: "global",
            ...(filters.type !== undefined ? { type: filters.type } : {}),
            ...(filters.topic !== undefined ? { topic: filters.topic } : {}),
            status,
            ...(filters.tags !== undefined ? { tags: filters.tags } : {}),
            limit
          })
        : [];
    const items = [...globalItems, ...projectItems].slice(0, limit);
    return {
      items: items.map((entry) => {
        const item: SearchMemoryItem = {
          id: entry.id,
          scope: entry.scope,
          type: entry.type,
          topic: entry.topic,
          title: entry.title,
          tags: entry.tags,
          source: entry.source,
          updated_at: entry.updated_at,
          status: entry.status,
          match_reason: "SQLite FTS matched query text against title, body, topic, or tags"
        };
        if (entry.project_id !== undefined) item.project_id = entry.project_id;
        return item;
      })
    };
  }

  getMemoryBudget(input: { scope: "global" }): MemoryBudgetResult;
  getMemoryBudget(input: { scope: "project"; project_id: string }): MemoryBudgetResult;
  getMemoryBudget(input: { scope: MemoryScope; project_id?: string }): MemoryBudgetResult | Result<never, "invalid_scope">;
  getMemoryBudget(input: { scope: MemoryScope; project_id?: string }): MemoryBudgetResult | Result<never, "invalid_scope"> {
    if (input.scope === "project" && input.project_id === undefined) {
      return err("invalid_scope", "project budget requires project_id");
    }
    const budget = budgetFor(this.ctx.store, { scope: input.scope, project_id: input.project_id });
    const usage = this.ctx.store.getBudgetUsage(input);
    const activeEntries = this.ctx.store.listEntries({
      scope: input.scope,
      ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
      status: "active",
      limit: 10_000
    });
    return {
      budget,
      usage,
      cleanup_candidates: rankCleanupCandidates(activeEntries, nowIso())
    };
  }

  exportMemoryContext(input: ExportMemoryContextInput): string {
    const exporter = this.ctx.resolveExporter();
    const resolved = this.resolveReadScope(input);
    if (!resolved.ok) {
      return exporter.buildContextPack({
        title: "AgentRecall Context",
        budget_chars: input.budget_chars,
        entries: []
      });
    }
    const collected = this.collectContextEntries(resolved.value, input);
    const entries = collected.map((entry) => ({
      ...entry,
      trust_boost: computeTrustBoost(entry, this.ctx.defaultActor, (e) =>
        actorForEntry(this.ctx.store, e)
      ),
      writer: actorForEntry(this.ctx.store, entry)
    }));
    return exporter.buildContextPack({
      title: "AgentRecall Context",
      budget_chars: input.budget_chars,
      entries
    });
  }

  // ============================================================
  // Read-side helpers (private to the read path)
  // ============================================================

  private resolveReadScope(input: {
    scope: MemoryScope;
    project_id?: string;
    project_path?: string;
  }): Result<ResolvedReadScope, "invalid_scope"> {
    const resolved = resolveMemoryScope(input);
    if (!resolved.ok) return resolved;
    return ok(resolved.value);
  }

  private resolveOptionalReadScope(input: {
    scope?: MemoryScope;
    project_id?: string;
    project_path?: string;
  }): Result<ResolvedReadScope, "invalid_scope"> {
    const scope: MemoryScope = input.scope ?? "global";
    return this.resolveReadScope({ scope, ...(input.project_id !== undefined ? { project_id: input.project_id } : {}), ...(input.project_path !== undefined ? { project_path: input.project_path } : {}) });
  }

  private entryFiltersForRead<T extends EntryFilters & { project_path?: string }>(
    filters: T,
    resolved: Partial<ResolvedReadScope>
  ): EntryFilters {
    const entryFilters: EntryFilters = {};
    const scope = resolved.scope ?? filters.scope;
    const projectId = resolved.project_id ?? filters.project_id;
    if (scope !== undefined) entryFilters.scope = scope;
    if (projectId !== undefined && scope !== "global") entryFilters.project_id = projectId;
    if (filters.type !== undefined) entryFilters.type = filters.type;
    if (filters.topic !== undefined) entryFilters.topic = filters.topic;
    if (filters.tags !== undefined) entryFilters.tags = filters.tags;
    if (filters.limit !== undefined) entryFilters.limit = filters.limit;
    if (filters.offset !== undefined) entryFilters.offset = filters.offset;
    if (filters.actor !== undefined) entryFilters.actor = filters.actor;
    if (filters.since !== undefined) entryFilters.since = filters.since;
    if (filters.until !== undefined) entryFilters.until = filters.until;
    if (filters.last_accessed_since !== undefined) entryFilters.last_accessed_since = filters.last_accessed_since;
    if (filters.updated_since !== undefined) entryFilters.updated_since = filters.updated_since;
    if (filters.updated_until !== undefined) entryFilters.updated_until = filters.updated_until;
    return entryFilters;
  }

  private collectContextEntries(scope: ResolvedReadScope, input: ExportMemoryContextInput): MemoryEntry[] {
    const scopes: ResolvedReadScope[] = [
      ...(scope.scope === "project" && input.include_global ? [{ scope: "global" as const }] : []),
      scope
    ];
    const byId = new Map<string, MemoryEntry>();
    for (const readScope of scopes) {
      for (const entry of this.contextEntriesForScope(readScope, input.query)) {
        if (this.matchesContextFilters(entry, input)) {
          byId.set(entry.id, entry);
        }
      }
    }
    const tokens = queryTokens(input.query);
    return [...byId.values()]
      .map((entry) => ({
        entry,
        query_score: contextQueryScore(entry, tokens),
        trust_boost: 0
      }))
      .sort((a, b) => {
        const queryOrder = b.query_score - a.query_score;
        if (queryOrder !== 0) return queryOrder;
        const importanceOrder = b.entry.importance - a.entry.importance;
        if (importanceOrder !== 0) return importanceOrder;
        const confidenceOrder = b.entry.confidence - a.entry.confidence;
        if (confidenceOrder !== 0) return confidenceOrder;
        const updatedOrder = compareText(b.entry.updated_at, a.entry.updated_at);
        if (updatedOrder !== 0) return updatedOrder;
        return compareText(a.entry.id, b.entry.id);
      })
      .map((s) => s.entry);
  }

  private contextEntriesForScope(scope: ResolvedReadScope, query: string | undefined): MemoryEntry[] {
    if (query !== undefined && query.length > 0) {
      return this.ctx.store.searchEntries({
        scope: scope.scope,
        ...(scope.project_id !== undefined ? { project_id: scope.project_id } : {}),
        status: "active",
        query,
        limit: 10_000
      });
    }
    return this.activeEntriesForScope(scope);
  }

  private matchesContextFilters(entry: MemoryEntry, input: ExportMemoryContextInput): boolean {
    if (input.types !== undefined && input.types.length > 0 && !input.types.includes(entry.type)) {
      return false;
    }
    if (input.topics !== undefined && input.topics.length > 0 && !input.topics.includes(entry.topic)) {
      return false;
    }
    return true;
  }

  private activeEntriesForScope(scope: ResolvedReadScope): MemoryEntry[] {
    return this.ctx.store.listEntries({
      scope: scope.scope,
      ...(scope.project_id !== undefined ? { project_id: scope.project_id } : {}),
      status: "active",
      limit: 10_000
    });
  }
}

/** Re-export for the Result<never, ...> compatibility used by tests. */
export type { Result };
