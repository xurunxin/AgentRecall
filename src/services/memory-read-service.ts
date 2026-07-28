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
import type { ToolProfile } from "../tools/profile.js";
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
import { resolveMemoryScope, type ProjectIdentityResolver } from "../scope-resolver.js";
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
  /**
   * Stage 16 v1.1.1 PR-2 (#14): the project identity
   * resolver. Read paths use `lookup` (no mutations;
   * never creates an identity) or `strict_existing`
   * (refuses unknown `project_id`s).
   */
  identityResolver: ProjectIdentityResolver;
  /** Optional MarkdownExporter; rebuilt on each export call when missing. */
  exporter?: MarkdownExporter;
  /** Returns the MarkdownExporter for read-side exports. */
  resolveExporter: () => MarkdownExporter;
  /**
   * Stage 18 v1.1.2 (issue #23, ADR-0001): the
   * maximum sensitivity the read service is
   * authorised to surface. The store applies
   * this filter at the SQL boundary; rows
   * whose `sensitivity` exceeds the value
   * are excluded from every public read path
   * (`getMemory`, `listMemories`,
   * `searchMemories`, `exportMemoryContext`,
   * maintenance diagnostics). The default
   * (`"normal"`) is fail-closed; the MCP
   * server's admin profile overrides the
   * value to `"restricted"` once the
   * capability check passes.
   */
  actorMaxSensitivity?: "normal" | "private" | "restricted";
  /**
   * v1.1.3 GATE-02 (issue #32): the active
   * tool profile. The read service consults
   * this for diagnostics (the per-row
   * `actor_max_sensitivity` SQL filter is
   * already gated on `actorMaxSensitivity`
   * above; `activeProfile` is recorded on
   * the audit row for forensic review).
   * Defaults to `"core"` for legacy test
   * fixtures that pre-date the v1.1.3 split.
   */
  activeProfile?: ToolProfile;
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
    void accessedBy;
    // Stage 18 v1.1.2 follow-up (review by ora-8):
    // thread the read service's
    // `actorMaxSensitivity` to the store's
    // `peekEntry` overload so the single-row
    // read goes through the same SQL-boundary
    // sensitivity predicate as `listEntries`
    // and `searchEntries`. A row whose
    // `sensitivity` exceeds the value returns
    // `undefined` — the caller cannot probe
    // whether the row exists.
    const entry = this.ctx.store.peekEntry(id, {
      actorMaxSensitivity: this.ctx.actorMaxSensitivity ?? "normal"
    });
    return entry === undefined ? undefined : { entry, audit: this.ctx.store.getAuditEvents(id) };
  }

  /**
   * Stage 18 v1.1.2 follow-up (review by ora-9):
   * the public-boundary read that distinguishes
   * `forbidden_visibility` from `not_found`. The
   * SQL filter is the source of truth. The
   * classifier (`classifyEntryVisibility`) is
   * the only single-row read API the
   * `forbidden_visibility` path is allowed to
   * use — it returns ONLY the visibility
   * classification + the row's `id` +
   * `sensitivity` (a non-secret operational
   * token). The `peekEntry(id)` no-options
   * overload is the write/maintenance path
   * and MUST NOT be used to disambiguate the
   * read contract: the previous follow-up
   * (review by ora-8) used the no-options
   * overload to peek at the row, then
   * surfaced `raw.sensitivity` on the error
   * envelope, which leaked the row's
   * sensitivity literal to a caller without
   * the `sensitivity_visibility` capability.
   * The follow-up closes that leak.
   *
   * The MCP `get_memory` tool and the
   * per-project resource route through this
   * method so a client without the
   * `sensitivity_visibility` capability
   * receives a stable `forbidden_visibility`
   * error code (NOT `not_found`) so it can
   * branch on the failure mode WITHOUT
   * observing any row-derived secret
   * (title / body / tags / source /
   * sensitivity literal).
   */
  getMemoryWithVisibility(id: string): Result<
    { entry: MemoryEntry; audit: MemoryAuditEvent[] },
    "not_found" | "forbidden_visibility"
  > {
    const classification = this.ctx.store.classifyEntryVisibility(id, {
      actorMaxSensitivity: this.ctx.actorMaxSensitivity ?? "normal"
    });
    if (classification.visibility === "not_found") {
      return err("not_found", `memory ${id} not found`, { memory_id: id });
    }
    if (classification.visibility === "forbidden_visibility") {
      // The classifier returned ONLY the
      // visibility classification + the
      // row's `id` + `sensitivity` field. The
      // error envelope surfaces ONLY
      // `memory_id` + a stable error code; the
      // brief explicitly forbids
      // `entry_sensitivity` / `sensitivity`
      // literals / `sensitivity` keys on the
      // deny path. The `sensitivity` value is
      // captured in a closure but never
      // surfaced — the previous follow-up's
      // error envelope (`details.entry_sensitivity`)
      // was the leak the follow-up closes. The
      // message is worded to avoid the
      // forbidden `sensitivity` substring.
      return err(
        "forbidden_visibility",
        `memory ${id} is not visible to this caller; run \`agent-recall admin grant\` and use the admin profile to surface this row`,
        { memory_id: id }
      );
    }
    // The row is visible under the
    // SQL-boundary filter. The full
    // `peekEntry(id, { actorMaxSensitivity })`
    // reuses the SQL filter so the read
    // cannot bypass the boundary by reading
    // the row a second time.
    const entry = this.ctx.store.peekEntry(id, {
      actorMaxSensitivity: this.ctx.actorMaxSensitivity ?? "normal"
    });
    if (entry === undefined) {
      // The classifier said "visible" but the
      // filtered peek returned `undefined`.
      // This is a race (the row was deleted
      // between the two reads) — surface
      // `not_found` rather than fall through
      // to a privileged peek (which would
      // re-introduce the leak).
      return err("not_found", `memory ${id} not found`, { memory_id: id });
    }
    return ok({ entry, audit: this.ctx.store.getAuditEvents(id) });
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
        status: filters.status ?? "active",
        // Stage 18 v1.1.2 (issue #23, ADR-0001):
        // the SQL-boundary sensitivity filter
        // (the v1.1.2 fail-closed contract). A
        // caller without the `sensitivity_visibility`
        // capability cannot see `private` or
        // `restricted` rows.
        actor_max_sensitivity: this.ctx.actorMaxSensitivity ?? "normal"
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
    // Stage 16 v1.1.1 PR-6 (issue #15, spec § 5.3):
    // the v1.1.0 contract used FTS5 + a flat
    // `[...globalItems, ...projectItems].slice(0, limit)`
    // concatenation. v1.1.1 routes both
    // `search_memories` and `recall_context`
    // through the same candidate-collection +
    // ranker pipeline. The candidate collection
    // still uses the store's FTS5 query to bound
    // the candidate set (preserves the v1.1.0
    // `actor` / `type` / `topic` / `tags` /
    // `updated_at` filter forwarding); the ranker
    // then fuses the lexical RRF with the access
    // RRF over the candidate set so the project
    // scope priority survives the joint ranking.
    const { include_global: includeGlobal, ...storeFilters } = filters;
    const status = filters.status ?? "active";
    const limit = filters.limit ?? 10;
    const query = filters.query;
    const resolvedFilters = this.entryFiltersForRead(storeFilters, resolved.value);
    // Stage 18 v1.1.2 (issue #23, ADR-0001):
    // the SQL-boundary sensitivity filter. The
    // default (`"normal"`) is fail-closed; the
    // admin profile overrides via
    // `ReadContext.actorMaxSensitivity`.
    const maxSensitivity = this.ctx.actorMaxSensitivity ?? "normal";
    const projectFtsItems =
      resolved.value.scope === "project"
        ? this.ctx.store.searchEntries({
            ...resolvedFilters,
            query,
            status,
            limit: 10_000,
            actor_max_sensitivity: maxSensitivity
          })
        : [];
    const globalFtsItems =
      resolved.value.scope === "global" || (resolved.value.scope === "project" && includeGlobal)
        ? this.ctx.store.searchEntries({
            query,
            scope: "global",
            ...(filters.type !== undefined ? { type: filters.type } : {}),
            ...(filters.topic !== undefined ? { topic: filters.topic } : {}),
            status,
            ...(filters.tags !== undefined ? { tags: filters.tags } : {}),
            ...(storeFilters.actor !== undefined ? { actor: storeFilters.actor } : {}),
            ...(storeFilters.updated_since !== undefined
              ? { updated_since: storeFilters.updated_since }
              : {}),
            ...(storeFilters.updated_until !== undefined
              ? { updated_until: storeFilters.updated_until }
              : {}),
            limit: 10_000,
            actor_max_sensitivity: maxSensitivity
          })
        : [];
    // Dedup (FTS may return the same id in both
    // lists when `include_global` is on; the
    // ranker is pure so duplicates are deduped by
    // id before ranking).
    const seen = new Set<string>();
    const candidates: MemoryEntry[] = [];
    for (const item of [...globalFtsItems, ...projectFtsItems]) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      candidates.push(item);
    }
    const ranked = rankRecall({
      candidates,
      query,
      primaryScope: resolved.value.scope,
      actor: {
        currentActor: this.ctx.defaultActor,
        actorForEntry: (entry) => entry.writer_actor_id
      },
      store: this.ctx.store,
      topK: limit
    });
    return {
      items: ranked.map((item) => {
        const r: SearchMemoryItem = {
          id: item.entry.id,
          scope: item.entry.scope,
          type: item.entry.type,
          topic: item.entry.topic,
          title: item.entry.title,
          tags: item.entry.tags,
          source: item.entry.source,
          updated_at: item.entry.updated_at,
          status: item.entry.status,
          match_reason: "Shared pipeline: lexical RRF + access RRF + scope priority + signals"
        };
        if (item.entry.project_id !== undefined) r.project_id = item.entry.project_id;
        return r;
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
    // v1.1.2 (issue #21): route the read through the
    // strict resolver so an unknown `project_id` is
    // rejected with `invalid_scope` before any budget
    // query runs. Pre-v1.1.2 the read fell through to
    // `budgetFor` (which returned `DEFAULT_PROJECT_BUDGET`
    // for an unknown id and silently leaked the default
    // budget for an unbound namespace).
    const resolved = this.resolveReadScope(input);
    if (!resolved.ok) {
      // The strict resolver surfaces both
      // `invalid_scope` and `project_identity_conflict`;
      // the public `getMemoryBudget` contract only
      // promises `invalid_scope`, so we collapse the
      // conflict code to `invalid_scope` here. The
      // conflict metadata is preserved on `details`.
      if (resolved.error === "project_identity_conflict") {
        return err("invalid_scope", resolved.message, resolved.details);
      }
      return err("invalid_scope", resolved.message, resolved.details);
    }
    const resolvedProjectId = resolved.value.project_id;
    const budget = budgetFor(this.ctx.store, { scope: input.scope, project_id: resolvedProjectId });
    const usage = this.ctx.store.getBudgetUsage(input);
    const activeEntries = this.ctx.store.listEntries({
      scope: input.scope,
      ...(resolvedProjectId !== undefined ? { project_id: resolvedProjectId } : {}),
      status: "active",
      limit: 10_000,
      // Stage 18 v1.1.2 (issue #23, ADR-0001):
      // the budget accounting is filtered to the
      // caller's authorised sensitivity. A
      // `private` row counts against the budget
      // only for callers who can see it.
      actor_max_sensitivity: this.ctx.actorMaxSensitivity ?? "normal"
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
    // Stage 16 v1.1.1 PR-2 (#14): read paths go through
    // the injected `ProjectIdentityResolver` in
    // `strict_existing` mode. A read cannot create a
    // project identity; an unknown `project_id`
    // surfaces `invalid_scope` instead of an implicit
    // identity.
    const resolved = this.ctx.identityResolver.resolve(input, "strict_existing");
    if (!resolved.ok) {
      // The resolver may now surface
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
    // Stage 16 v1.1.1 PR-6 (issue #15): pass the store so
    // the ranker can read `memory_accesses`,
    // `memory_feedback`, and `memory_relations` for real
    // (non-placeholder) signals. Without the store, the
    // ranker falls back to writer-identity-only trust, and
    // access-based trust / access signal / rrf_access all
    // collapse to 0 — which would lose the
    // "recently-touched foreign memory ranks above
    // untouched foreign memory" behaviour from stage 5.
    const currentActor = ctx?.actor_id ?? this.ctx.defaultActor;
    const ranked: RankedItem[] = rankRecall({
      candidates: [...byId.values()],
      query: input.query ?? "",
      primaryScope: scope.scope,
      actor: {
        currentActor,
        actorForEntry: (e) => actorForEntry(this.ctx.store, e)
      },
      store: this.ctx.store,
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
      // Stage 16 v1.1.1 PR-6 (issue #15): pass the store
      // so the ranker reads the canonical `memory_accesses`
      // / `memory_feedback` / `memory_relations` tables for
      // real (non-placeholder) signals. Mirrors the
      // `collectContextEntries` call above; the two
      // ranking paths must stay in lockstep so the
      // explain breakdown matches what the markdown
      // exporter actually ordered.
      store: this.ctx.store,
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
        limit: 10_000,
        // Stage 18 v1.1.2 (issue #23, ADR-0001):
        // SQL-boundary sensitivity filter.
        actor_max_sensitivity: this.ctx.actorMaxSensitivity ?? "normal"
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
      limit: 10_000,
      // Stage 18 v1.1.2 (issue #23, ADR-0001):
      // SQL-boundary sensitivity filter.
      actor_max_sensitivity: this.ctx.actorMaxSensitivity ?? "normal"
    });
  }
}

/** Re-export for the Result<never, ...> compatibility used by tests. */
export type { Result };
