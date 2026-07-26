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
import { CURRENT_SCHEMA_VERSION } from "../sqlite-store.js";
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
import { RANKING_VERSION, rankRecall, type RankedItem } from "./recall-ranker.js";
import { detectRisksInEntry } from "../tools/risk-detector.js";
import { dataOnlyFramingPreamble } from "../tools/data-only-framing.js";
import type { RequestContext } from "../request-context.js";

export type ResolvedReadScope = {
  scope: MemoryScope;
  project_id?: string;
};

export type ListResult = { items: MemoryEntry[] };

// Stage 15 PR-M1-2 (issue #7, spec § 5.4): the read
// surface now also surfaces `project_identity_conflict`
// when the caller's `project_id` does not match the
// identity pinned to the supplied `project_path` (or
// vice versa). The MCP contract still keys off
// `invalid_scope`; `project_identity_conflict` is a
// more specific code so a client can surface a
// helpful message ("this project is already pinned
// to a different path").
export type InvalidScopeResult = Result<never, "invalid_scope" | "project_identity_conflict">;

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
  /**
   * Stage 10 PR4: cap on how many ranked items the
   * renderer should consume. Defaults to no cap (i.e. every
   * ranked entry is included in the order the ranker
   * produced).
   */
  max_items?: number;
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
    /**
     * Stage 16 v1.1.1 PR-1 (#11): the `accessedBy` parameter is
     * accepted for backward compatibility with the v1.1.0
     * service contract, but it is no longer used to mutate
     * access state from a read. `getMemory` is now a pure
     * read — the `memory_accesses` row, the per-actor last-
     * access map, and `memory_entries.access_count` are no
     * longer touched from a read. If a caller legitimately
     * needs to record access (e.g. `recall_context` selecting
     * a memory for the context budget), call
     * `store.recordMemoryAccess(memoryId, actorId)` explicitly
     * after the read.
     *
     * @deprecated Pass `undefined`; this parameter is a no-op
     * and will be removed in v1.2.
     */
    accessedBy?: string
  ): { entry: MemoryEntry; audit: MemoryAuditEvent[] } | undefined {
    const entry = this.ctx.store.peekEntry(id);
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

  exportMemoryContext(input: ExportMemoryContextInput, ctx?: RequestContext): string {
    const exporter = this.ctx.resolveExporter();
    const resolved = this.resolveReadScope(input);
    if (!resolved.ok) {
      return exporter.buildContextPack({
        title: "AgentRecall Context",
        budget_chars: input.budget_chars,
        entries: []
      });
    }
    const collected = this.collectContextEntries(resolved.value, input, ctx);
    const currentActor = ctx?.actor_id ?? this.ctx.defaultActor;
    const entries = collected.map((entry) => ({
      ...entry,
      trust_boost: computeTrustBoost(this.ctx.store, entry, currentActor, (e) =>
        actorForEntry(this.ctx.store, e)
      ),
      writer: actorForEntry(this.ctx.store, entry)
    }));
    // Stage 12 PR9 (spec § 6.6): prepend the data-only
    // framing preamble so the agent prompt treats the
    // context pack as untrusted data. We compute the
    // pack first (so the budget is correct), then walk
    // the entries once to detect any unsafe_content
    // patterns. The preamble's `risk` attribute flips
    // from "low" to "high" when at least one entry
    // matched.
    let riskLevel: "low" | "high" = "low";
    for (const entry of collected) {
      if (detectRisksInEntry({ title: entry.title, topic: entry.topic, body: entry.body, tags: entry.tags }).unsafe_content) {
        riskLevel = "high";
        break;
      }
    }
    const preamble = dataOnlyFramingPreamble({
      scope: resolved.value.scope,
      ...(resolved.value.project_id !== undefined ? { projectId: resolved.value.project_id } : {}),
      riskLevel,
      packEntryCount: entries.length,
      generatedAt: new Date().toISOString(),
      schemaVersion: CURRENT_SCHEMA_VERSION
    });
    return preamble + exporter.buildContextPack({
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
  }): Result<ResolvedReadScope, "invalid_scope" | "project_identity_conflict"> {
    const resolved = resolveMemoryScope(input);
    if (!resolved.ok) {
      // Stage 15 PR-M1-2: the resolver may now surface
      // `project_identity_conflict` when the caller's
      // `project_id` + `project_path` triple does not
      // match an existing identity. `invalid_alias` is
      // collapsed to `invalid_scope` for callers.
      if (resolved.error === "invalid_alias") {
        return err("invalid_scope", resolved.message, resolved.details);
      }
      if (resolved.error === "project_identity_conflict") {
        return err("project_identity_conflict", resolved.message, resolved.details);
      }
      return err("invalid_scope", resolved.message, resolved.details);
    }
    return ok(resolved.value);
  }

  private resolveOptionalReadScope(input: {
    scope?: MemoryScope;
    project_id?: string;
    project_path?: string;
  }): Result<ResolvedReadScope, "invalid_scope" | "project_identity_conflict"> {
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

  private collectContextEntries(scope: ResolvedReadScope, input: ExportMemoryContextInput, ctx?: RequestContext): MemoryEntry[] {
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
    // Stage 10 PR4: route all candidate ordering through the
    // single RecallRanker. The pre-PR4 code inlined a
    // query_score sort with `trust_boost: 0` hardcoded; the
    // markdown exporter then re-sorted by importance + trust,
    // overriding the read-side ranking. With a single ranker
    // the export preserves the ranker order end-to-end.
    const currentActor = ctx?.actor_id ?? this.ctx.defaultActor;
    const ranked: RankedItem[] = rankRecall({
      candidates: [...byId.values()],
      query: input.query ?? "",
      primaryScope: scope.scope,
      actor: {
        currentActor,
        actorForEntry: (e) => actorForEntry(this.ctx.store, e)
      },
      ...(input.max_items !== undefined ? { topK: input.max_items } : {})
    });
    return ranked.map((r) => r.entry);
  }

  /**
   * Stage 10 PR4: explain_recall tool entry point. Returns
   * the ranker's score breakdown without recording access
   * (separate from `exportMemoryContext`).
   */
  explainRecall(input: ExportMemoryContextInput): {
    ranking_version: string;
    items: Array<{
      memory_id: string;
      title: string;
      score: number;
      components: RankedItem["components"];
    }>;
  } {
    const resolved = this.resolveReadScope(input);
    if (!resolved.ok) {
      return { ranking_version: RANKING_VERSION, items: [] };
    }
    const scope: ResolvedReadScope = {
      scope: resolved.value.scope,
      ...(resolved.value.project_id !== undefined ? { project_id: resolved.value.project_id } : {})
    };
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
    const ranked = rankRecall({
      candidates: [...byId.values()],
      query: input.query ?? "",
      primaryScope: scope.scope,
      actor: {
        currentActor: this.ctx.defaultActor,
        actorForEntry: (e) => actorForEntry(this.ctx.store, e)
      },
      ...(input.max_items !== undefined ? { topK: input.max_items } : {})
    });
    return {
      ranking_version: RANKING_VERSION,
      items: ranked.map((r) => ({
        memory_id: r.entry.id,
        title: r.entry.title,
        score: r.score,
        components: r.components
      }))
    };
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
