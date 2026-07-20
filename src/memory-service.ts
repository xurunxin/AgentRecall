import {
  estimateIndexChars,
  evaluateBudget,
  rankCleanupCandidates,
  type BudgetAccepted,
  type BudgetWarning,
  type CandidateAction
} from "./budget-governor.js";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_GLOBAL_BUDGET,
  DEFAULT_PROJECT_BUDGET,
  computeEntrySize,
  createAuditId,
  createMemoryId,
  err,
  nowIso,
  ok,
  type MemoryAuditEvent,
  type MemoryBudget,
  type MemoryEntry,
  type MemoryScope,
  type ProjectScope,
  type Result
} from "./domain.js";
import { MarkdownExporter } from "./markdown-exporter.js";
import { resolveActor } from "./actor.js";
import { resolveMemoryScope } from "./scope-resolver.js";
import { runBackup } from "./backup.js";
import { SIMILARITY_THRESHOLD, textSimilarity, tokenizeForSimilarity } from "./text-similarity.js";
import type { BudgetUsage, EntryFilters, SearchFilters, SQLiteMemoryStore } from "./sqlite-store.js";
import {
  type RememberInput,
  type UpdateInput,
  type ValidatedRememberInput,
  validateRememberInput,
  validateUpdateInput
} from "./write-validator.js";

export type RememberResult = {
  memory_id: string;
  status: MemoryEntry["status"];
  budget_after: BudgetUsage;
  warnings: BudgetWarning[];
};

export type ListResult = {
  items: MemoryEntry[];
};

export type InvalidScopeResult = Result<never, "invalid_scope">;

export type SearchMemoryItem = Pick<
  MemoryEntry,
  "id" | "scope" | "type" | "topic" | "title" | "tags" | "source" | "updated_at" | "status"
> & {
  project_id?: string;
  match_reason: string;
};

export type SearchResult = {
  items: SearchMemoryItem[];
};

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

export type MaintenanceAction =
  | "archive_low_value"
  | "expire_due"
  | "rebuild_markdown_index"
  | "vacuum_fts"
  | "find_duplicates";

export type DuplicateGroup = {
  reason: "same_title_and_body" | "same_title" | "same_body" | "similar_title_and_body";
  fingerprint: string;
  memory_ids: string[];
  titles: string[];
  details?: { similarity?: number };
};

export type MaintainMemoriesInput = {
  action: MaintenanceAction;
  scope: MemoryScope;
  project_id?: string;
  project_path?: string;
  /**
   * Stage 7: chunk size for maintenance operations that scan the
   * whole entries table. Each chunk runs in its own transaction,
   * so other agents' remember / getMemory calls are not blocked
   * for the full duration. Default 500; min 50, max 5000.
   */
  batch_size?: number;
  /**
   * Stage 7: progress callback fired after each chunk completes.
   * Receives (processed, total). Useful for the MCP tool to
   * report a partial result, and for the CLI / smoke test.
   */
  onProgress?: (processed: number, total: number) => void;
};

export type MaintainMemoriesResult = {
  action: MaintenanceAction;
  changed: number;
  details: unknown;
};

type RememberError = "invalid_schema" | "invalid_scope" | "secret_detected" | "capacity_exceeded" | "duplicate_candidate";
type UpdateError = "not_found" | "invalid_state" | "invalid_schema" | "secret_detected" | "capacity_exceeded";
type SupersedeError = RememberError | "not_found" | "invalid_state";
type ForgetError = "not_found";

type PreparedRemember = {
  entry: MemoryEntry;
  budget: BudgetAccepted;
};

type ResolvedRemember = {
  entry: MemoryEntry;
  project_path?: string;
  display_name?: string;
};

type PrepareRememberOptions = {
  excludedActiveMemoryIds?: ReadonlySet<string>;
};

type SearchServiceFilters = SearchFilters & {
  include_global?: boolean;
  project_path?: string;
};

type ListServiceFilters = EntryFilters & {
  project_path?: string;
};

type ResolvedReadScope = {
  scope: MemoryScope;
  project_id?: string;
};

type ContextScore = {
  entry: MemoryEntry;
  query_score: number;
  trust_boost: number;
};

const DEFAULT_STRONG_TRUST_BOOST = 0.3;
const DEFAULT_SOFT_TRUST_BOOST = 0.1;
const ENV_TRUST_STRONG = "AGENT_RECALL_TRUST_STRONG";
const ENV_TRUST_SOFT = "AGENT_RECALL_TRUST_SOFT";

function parseEnvFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    process.stderr.write(
      `agent-recall: invalid ${name}="${raw}", using default ${fallback}\n`
    );
    return fallback;
  }
  return parsed;
}

/**
 * Stage 5: per-memory trust boost for recall ranking.
 *
 * Returns the strong boost (default 0.3) when the memory was
 * written by `currentActor` ("I wrote this, trust my own
 * knowledge"), the soft boost (default 0.1) when the current
 * actor appears in the memory's `last_accessed_by` map ("I've
 * touched this recently"), or 0 when there is no relationship.
 * Returns 0 when `currentActor` is empty (legacy callers
 * constructed without `defaultActor`).
 *
 * Stage 7: the strong / soft weights are configurable via the
 * AGENT_RECALL_TRUST_STRONG and AGENT_RECALL_TRUST_SOFT env
 * vars. Defaults are 0.3 / 0.1; invalid values fall back to
 * defaults with a one-line stderr warning.
 */
export function computeTrustBoost(
  entry: MemoryEntry,
  currentActor: string,
  actorForEntry: (entry: MemoryEntry) => string
): number {
  if (currentActor.length === 0) return 0;
  const strong = parseEnvFloat(ENV_TRUST_STRONG, DEFAULT_STRONG_TRUST_BOOST);
  const soft = parseEnvFloat(ENV_TRUST_SOFT, DEFAULT_SOFT_TRUST_BOOST);
  const writer = actorForEntry(entry);
  if (writer === currentActor) return strong;
  if (entry.last_accessed_by !== undefined && entry.last_accessed_by[currentActor] !== undefined) {
    return soft;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeScopeFromInput(input: unknown): MemoryScope {
  return isRecord(input) && input.scope === "project" ? "project" : "global";
}

function safeProjectIdFromInput(input: unknown): string | undefined {
  return isRecord(input) && typeof input.project_id === "string" ? input.project_id : undefined;
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isDue(timestamp: string | undefined, now: string): boolean {
  const dueAt = parseTimestamp(timestamp);
  const current = parseTimestamp(now);
  return dueAt !== undefined && current !== undefined && dueAt <= current;
}

function normalizeDuplicateText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function duplicateFingerprint(reason: DuplicateGroup["reason"], key: string): string {
  return createHash("sha256").update(`${reason}\n${key}`).digest("hex").slice(0, 12);
}

function queryTokens(query: string | undefined): string[] {
  if (query === undefined) return [];
  return [...new Set((query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((token) => token.length > 0))].sort();
}

function contextQueryScore(entry: MemoryEntry, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const title = entry.title.toLowerCase();
  const topic = entry.topic.toLowerCase();
  const tags = entry.tags.join(" ").toLowerCase();
  const body = entry.body.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (title.includes(token)) score += 8;
    if (topic.includes(token)) score += 4;
    if (tags.includes(token)) score += 3;
    if (body.includes(token)) score += 1;
  }
  return score;
}

function compareContextScores(a: ContextScore, b: ContextScore): number {
  const queryOrder = b.query_score - a.query_score;
  if (queryOrder !== 0) return queryOrder;

  const trustOrder = b.trust_boost - a.trust_boost;
  if (trustOrder !== 0) return trustOrder;

  const importanceOrder = b.entry.importance - a.entry.importance;
  if (importanceOrder !== 0) return importanceOrder;

  const confidenceOrder = b.entry.confidence - a.entry.confidence;
  if (confidenceOrder !== 0) return confidenceOrder;

  const updatedOrder = compareText(b.entry.updated_at, a.entry.updated_at);
  if (updatedOrder !== 0) return updatedOrder;

  return compareText(a.entry.id, b.entry.id);
}

function compareLowValueCandidates(a: MemoryEntry, b: MemoryEntry): number {
  const importanceOrder = a.importance - b.importance;
  if (importanceOrder !== 0) return importanceOrder;

  const confidenceOrder = a.confidence - b.confidence;
  if (confidenceOrder !== 0) return confidenceOrder;

  const updatedOrder = compareText(a.updated_at, b.updated_at);
  if (updatedOrder !== 0) return updatedOrder;

  return compareText(a.id, b.id);
}

export class MemoryService {
  constructor(
    private readonly store: SQLiteMemoryStore,
    private readonly exporter?: MarkdownExporter,
    /**
     * Default actor identifier for audit events. Resolved per-write through
     * `resolveActor`, so an explicit override on each call still wins.
     * Stage 1 only relaxes the TS type here; the underlying SQLite CHECK
     * constraint is still `(agent, user, system)`. Stage 2 (v1->v2
     * migration) widens the constraint, after which the call sites
     * start writing structured values like `agent:claude-code`.
     */
    private readonly defaultActor: string = "agent",
    /**
     * Data home directory, used as the destination for `backups/`.
     * If unset, automatic backup is disabled.
     */
    private readonly dataHome?: string
  ) {}

  configureProjectBudget(
    project_id: string,
    budget: MemoryBudget,
    canonical_path: string,
    display_name: string
  ): ProjectScope {
    const now = nowIso();
    const existing = this.store.getProjectScope(project_id);
    const scope: ProjectScope = {
      project_id,
      canonical_path,
      display_name,
      budget,
      created_at: existing?.created_at ?? now,
      updated_at: now
    };
    this.store.upsertProjectScope(scope);
    return scope;
  }

  remember(input: RememberInput): Result<RememberResult, RememberError> {
    const prepared = this.prepareRemember(input, true);
    if (!prepared.ok) {
      return prepared;
    }
    // Forced-confirm flow: if a duplicate candidate is detected, the
    // caller must opt in by passing `confirm_write: true` to proceed.
    if (input.confirm_write !== true) {
      const matchingIds = prepared.value.budget.warnings
        .filter((w) => w.code === "duplicate_candidate")
        .map((w) => w.memory_id);
      if (matchingIds.length > 0) {
        // No store writes have happened yet; prepareRemember is read-only.
        // We audit the rejection so the agent can see what happened.
        this.auditRejected(input, "duplicate_candidate", { matching_ids: matchingIds });
        return err(
          "duplicate_candidate",
          "existing active memory has the same title or body; pass confirm_write: true to proceed",
          { matching_ids: matchingIds }
        );
      }
    }
    // When the caller has acknowledged the warnings (confirm_write: true),
    // suppress advisory warnings from the response so the agent doesn't
    // re-read what it just told us to ignore.
    const suppressed = input.confirm_write === true ? [] : prepared.value.budget.warnings;
    return this.store.transaction(() => ok(this.commitPreparedRemember(prepared.value, suppressed)));
  }

  private prepareRemember(
    input: RememberInput,
    auditRejections: boolean,
    options: PrepareRememberOptions = {}
  ): Result<PreparedRemember, RememberError> {
    const resolved = this.resolveRememberInput(input, auditRejections);
    if (!resolved.ok) {
      return resolved;
    }

    let budget = DEFAULT_GLOBAL_BUDGET;
    if (resolved.value.entry.scope === "project") {
      const projectId = resolved.value.entry.project_id;
      if (projectId === undefined) {
        if (auditRejections) this.auditRejected(input, "invalid_scope", undefined);
        return err("invalid_scope", "project scope requires project_id or project_path");
      }
      budget = this.ensureProjectScope(
        projectId,
        resolved.value.project_path ?? "",
        resolved.value.display_name ?? projectId
      ).budget;
    }

    const budgetResult = this.evaluateEntryBudget(resolved.value.entry, budget, options);
    if (!budgetResult.ok) {
      if (auditRejections) this.auditRejected(input, "capacity_exceeded", budgetResult.details);
      return budgetResult;
    }

    return ok({ entry: resolved.value.entry, budget: budgetResult.value });
  }

  private resolveRememberInput(input: RememberInput, auditRejections: boolean): Result<ResolvedRemember, RememberError> {
    const validated = validateRememberInput(input);
    if (!validated.ok) {
      if (auditRejections) this.auditRejected(input, validated.error, validated.details);
      return validated;
    }

    const resolved = resolveMemoryScope(validated.value);
    if (!resolved.ok) {
      if (auditRejections) this.auditRejected(input, resolved.error, resolved.details);
      return resolved;
    }

    if (resolved.value.scope === "project") {
      if (resolved.value.project_id === undefined) {
        if (auditRejections) this.auditRejected(input, "invalid_scope", undefined);
        return err("invalid_scope", "project scope requires project_id or project_path");
      }
    }

    const now = nowIso();
    const entry = this.buildEntry(validated.value, resolved.value.scope, now, {
      ...(resolved.value.project_id !== undefined ? { project_id: resolved.value.project_id } : {}),
      ...(resolved.value.project_path !== undefined ? { project_path: resolved.value.project_path } : {})
    });

    const result: ResolvedRemember = { entry };
    if (resolved.value.project_path !== undefined) result.project_path = resolved.value.project_path;
    if (resolved.value.display_name !== undefined) result.display_name = resolved.value.display_name;
    return ok(result);
  }

  private commitPreparedRemember(prepared: PreparedRemember, warnings?: BudgetWarning[]): RememberResult {
    const { entry, budget } = prepared;
    this.store.insertEntry(entry);
    // Omit `actor` so appendAudit falls back to this.defaultActor
    // (resolved through resolveActor). Previously this wrote a hardcoded
    // "agent", which prevented the structured actor (e.g. agent:claude-code)
    // from being recorded in the audit log.
    this.appendAudit({
      memory_id: entry.id,
      scope: entry.scope,
      ...(entry.project_id !== undefined ? { project_id: entry.project_id } : {}),
      event: "created",
      metadata: {
        type: entry.type,
        topic: entry.topic
      }
    });

    return {
      memory_id: entry.id,
      status: entry.status,
      budget_after: budget.budget_after,
      warnings: warnings ?? budget.warnings
    };
  }

  getMemory(
    id: string,
    accessedBy?: string
  ): { entry: MemoryEntry; audit: MemoryAuditEvent[] } | undefined {
    const entry = this.store.getEntry(id, accessedBy);
    return entry === undefined ? undefined : { entry, audit: this.store.getAuditEvents(id) };
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
      items: this.store.listEntries({
        ...this.entryFiltersForRead(filters, resolved.value),
        status: filters.status ?? "active"
      })
    };
  }

  searchMemories(filters: SearchServiceFilters & { scope: "project"; project_id: string }): SearchResult;
  searchMemories(filters: SearchServiceFilters & { scope: "project"; project_path: string }): SearchResult;
  searchMemories(filters: SearchServiceFilters & { scope?: "global" }): SearchResult;
  searchMemories(filters: SearchServiceFilters): SearchResult | InvalidScopeResult;
  searchMemories(filters: SearchServiceFilters): SearchResult | InvalidScopeResult {
    const resolved = this.resolveOptionalReadScope(filters);
    if (!resolved.ok) {
      return resolved;
    }

    const { include_global: includeGlobal, ...storeFilters } = filters;
    const resolvedFilters = this.entryFiltersForRead(storeFilters, resolved.value);
    const limit = filters.limit ?? 10;
    const status = filters.status ?? "active";
    const projectItems = this.store.searchEntries({
      ...resolvedFilters,
      query: filters.query,
      status,
      limit
    });
    const globalItems =
      resolved.value.scope === "project" && includeGlobal
        ? this.store.searchEntries({
            query: filters.query,
            scope: "global",
            ...(filters.type !== undefined ? { type: filters.type } : {}),
            ...(filters.topic !== undefined ? { topic: filters.topic } : {}),
            status,
            ...(filters.tags !== undefined ? { tags: filters.tags } : {}),
            limit
          })
        : [];

    return {
      items: [...globalItems, ...projectItems].slice(0, limit).map((entry) => ({
        id: entry.id,
        scope: entry.scope,
        ...(entry.project_id !== undefined ? { project_id: entry.project_id } : {}),
        type: entry.type,
        topic: entry.topic,
        title: entry.title,
        tags: entry.tags,
        source: entry.source,
        updated_at: entry.updated_at,
        status: entry.status,
        match_reason: "SQLite FTS matched query text against title, body, topic, or tags"
      }))
    };
  }

  updateMemory(id: string, input: UpdateInput): Result<{ memory_id: string }, UpdateError> {
    const current = this.store.peekEntry(id);
    if (current === undefined) {
      return err("not_found", "memory not found");
    }
    if (current.status !== "active" && current.status !== "archived") {
      this.auditRejectedForEntry(current, "invalid_state", {
        memory_id: id,
        status: current.status
      });
      return err("invalid_state", "only active or archived memories can be updated", {
        status: current.status
      });
    }

    const validated = validateUpdateInput(input);
    if (!validated.ok) {
      this.auditRejectedForEntry(current, validated.error, validated.details);
      return validated;
    }

    const patch: Parameters<SQLiteMemoryStore["updateEntry"]>[1] = {
      updated_at: nowIso()
    };
    if (validated.value.topic !== undefined) patch.topic = validated.value.topic;
    if (validated.value.title !== undefined) patch.title = validated.value.title;
    if (validated.value.body !== undefined) patch.body = validated.value.body;
    if (validated.value.tags !== undefined) patch.tags = validated.value.tags;
    if (validated.value.importance !== undefined) patch.importance = validated.value.importance;
    if (validated.value.confidence !== undefined) patch.confidence = validated.value.confidence;
    if (validated.value.status !== undefined) patch.status = validated.value.status;
    if (validated.value.expires_at !== undefined) patch.expires_at = validated.value.expires_at;
    if (validated.value.review_after !== undefined) patch.review_after = validated.value.review_after;

    if (validated.value.title !== undefined || validated.value.body !== undefined || validated.value.tags !== undefined) {
      const size = computeEntrySize(
        validated.value.title ?? current.title,
        validated.value.body ?? current.body,
        validated.value.tags ?? current.tags
      );
      patch.char_count = size.char_count;
      patch.token_estimate = size.token_estimate;
    }

    const next: MemoryEntry = { ...current, ...patch, id: current.id };
    const existingEntries = this.activeEntriesFor(next).filter((entry) => entry.id !== id);
    const budget = this.budgetFor(next);
    const budgetResult = evaluateBudget({
      budget,
      usage: this.usageFromActiveEntries(existingEntries),
      candidate: next,
      existingEntries,
      now: patch.updated_at
    });
    if (!budgetResult.ok) {
      this.auditRejectedForEntry(current, "capacity_exceeded", budgetResult.details);
      return err("capacity_exceeded", budgetResult.message, budgetResult.details);
    }

    const event = current.status === "active" && patch.status === "archived" ? "archived" : "updated";

    return this.store.transaction(() => {
      this.store.updateEntry(id, patch);
      this.appendAudit({
        memory_id: id,
        scope: current.scope,
        ...(current.project_id !== undefined ? { project_id: current.project_id } : {}),
        event,
        actor: "agent",
        metadata: {
          fields: Object.keys(validated.value).sort()
        }
      });
      return ok({ memory_id: id });
    });
  }

  supersedeMemory(input: {
    old_memory_ids: string[];
    replacement: RememberInput;
    reason: string;
  }): Result<{ memory_id: string }, SupersedeError> {
    const oldIds = [...new Set(input.old_memory_ids)];
    if (oldIds.length === 0 || oldIds.some((id) => id.trim().length === 0)) {
      this.auditRejected(input.replacement, "invalid_schema", {
        old_memory_ids_count: oldIds.length
      });
      return err("invalid_schema", "supersede requires at least one old memory id");
    }

    const resolvedReplacement = this.resolveRememberInput({ ...input.replacement, supersedes: oldIds }, true);
    if (!resolvedReplacement.ok) {
      return resolvedReplacement;
    }
    const replacement = resolvedReplacement.value.entry;

    const oldEntries: MemoryEntry[] = [];
    for (const oldId of oldIds) {
      const old = this.store.peekEntry(oldId);
      if (old === undefined) {
        this.auditRejectedForScope(replacement.scope, replacement.project_id, "not_found", {
          memory_id: oldId
        });
        return err("not_found", "memory not found", { memory_id: oldId });
      }
      if (old.status !== "active" && old.status !== "archived") {
        this.auditRejectedForEntry(old, "invalid_state", {
          memory_id: oldId,
          status: old.status
        });
        return err("invalid_state", "only active or archived memories can be superseded", {
          memory_id: oldId,
          status: old.status
        });
      }
      oldEntries.push(old);
    }

    for (const old of oldEntries) {
      if (!this.matchesReplacementScope(old, replacement)) {
        this.auditRejectedForEntry(old, "invalid_scope", {
          memory_id: old.id,
          replacement_scope: replacement.scope,
          replacement_project_id: replacement.project_id ?? null
        });
        return err("invalid_scope", "superseded memories must match replacement scope and project_id", {
          memory_id: old.id,
          replacement_scope: replacement.scope,
          replacement_project_id: replacement.project_id ?? null
        });
      }
    }

    let budget = DEFAULT_GLOBAL_BUDGET;
    if (replacement.scope === "project") {
      const projectId = replacement.project_id;
      if (projectId === undefined) {
        this.auditRejectedForScope(replacement.scope, replacement.project_id, "invalid_scope", undefined);
        return err("invalid_scope", "project scope requires project_id or project_path");
      }
      budget = this.ensureProjectScope(
        projectId,
        resolvedReplacement.value.project_path ?? "",
        resolvedReplacement.value.display_name ?? projectId
      ).budget;
    }

    const excludedActiveMemoryIds = new Set(oldEntries.filter((old) => old.status === "active").map((old) => old.id));
    const budgetResult = this.evaluateEntryBudget(replacement, budget, { excludedActiveMemoryIds });
    if (!budgetResult.ok) {
      this.auditRejectedForScope(replacement.scope, replacement.project_id, "capacity_exceeded", budgetResult.details);
      return budgetResult;
    }
    const prepared: PreparedRemember = { entry: replacement, budget: budgetResult.value };

    return this.store.transaction(() => {
      const created = this.commitPreparedRemember(prepared);
      for (const old of oldEntries) {
        this.store.updateEntry(old.id, {
          status: "superseded",
          superseded_by: created.memory_id,
          updated_at: nowIso()
        });
        this.appendAudit({
          memory_id: old.id,
          scope: old.scope,
          ...(old.project_id !== undefined ? { project_id: old.project_id } : {}),
          event: "superseded",
          actor: "agent",
          reason: input.reason,
          metadata: {
            superseded_by: created.memory_id
          }
        });
      }
      return ok({ memory_id: created.memory_id });
    });
  }

  /**
   * Stage 2: collapse N near-duplicate memories into one, marking the old
   * entries as superseded. Differs from `supersedeMemory` in that the
   * caller is explicitly merging multiple source entries (≥ 2), and the
   * budget check excludes the old ids from the active count so the merge
   * passes the budget even when the pre-merge state is at the cap.
   */
  mergeMemories(input: {
    old_memory_ids: string[];
    replacement: RememberInput;
    reason: string;
    strategy?: "keep_first" | "keep_newest";
  }): Result<{ memory_id: string; merged_from: string[] }, SupersedeError> {
    const oldIds = [...new Set(input.old_memory_ids)];
    if (oldIds.length < 2 || oldIds.some((id) => id.trim().length === 0)) {
      this.auditRejected(input.replacement, "invalid_schema", {
        old_memory_ids_count: oldIds.length
      });
      return err("invalid_schema", "merge_memories requires at least two old memory ids");
    }

    const resolvedReplacement = this.resolveRememberInput(
      { ...input.replacement, supersedes: oldIds },
      true
    );
    if (!resolvedReplacement.ok) {
      return resolvedReplacement;
    }
    const replacement = resolvedReplacement.value.entry;

    const oldEntries: MemoryEntry[] = [];
    for (const oldId of oldIds) {
      const old = this.store.peekEntry(oldId);
      if (old === undefined) {
        this.auditRejectedForScope(replacement.scope, replacement.project_id, "not_found", {
          memory_id: oldId
        });
        return err("not_found", "memory not found", { memory_id: oldId });
      }
      if (old.status !== "active" && old.status !== "archived") {
        this.auditRejectedForEntry(old, "invalid_state", {
          memory_id: oldId,
          status: old.status
        });
        return err("invalid_state", "only active or archived memories can be merged", {
          memory_id: oldId,
          status: old.status
        });
      }
      oldEntries.push(old);
    }

    for (const old of oldEntries) {
      if (!this.matchesReplacementScope(old, replacement)) {
        this.auditRejectedForEntry(old, "invalid_scope", {
          memory_id: old.id,
          replacement_scope: replacement.scope,
          replacement_project_id: replacement.project_id ?? null
        });
        return err("invalid_scope", "merged memories must match replacement scope and project_id", {
          memory_id: old.id,
          replacement_scope: replacement.scope,
          replacement_project_id: replacement.project_id ?? null
        });
      }
    }

    let budget = DEFAULT_GLOBAL_BUDGET;
    if (replacement.scope === "project") {
      const projectId = replacement.project_id;
      if (projectId === undefined) {
        this.auditRejectedForScope(replacement.scope, replacement.project_id, "invalid_scope", undefined);
        return err("invalid_scope", "project scope requires project_id or project_path");
      }
      budget = this.ensureProjectScope(
        projectId,
        resolvedReplacement.value.project_path ?? "",
        resolvedReplacement.value.display_name ?? projectId
      ).budget;
    }

    // Budget relaxation: exclude the old ids from the active count so a
    // merge at the budget cap still succeeds.
    const excludedActiveMemoryIds = new Set(
      oldEntries.filter((old) => old.status === "active").map((old) => old.id)
    );
    const budgetResult = this.evaluateEntryBudget(replacement, budget, { excludedActiveMemoryIds });
    if (!budgetResult.ok) {
      this.auditRejectedForScope(
        replacement.scope,
        replacement.project_id,
        "capacity_exceeded",
        budgetResult.details
      );
      return budgetResult;
    }
    const prepared: PreparedRemember = { entry: replacement, budget: budgetResult.value };

    const canonicalId = input.strategy === "keep_newest"
      ? oldEntries.reduce((acc, e) => (acc === undefined || e.created_at > acc.created_at ? e : acc)).id
      : oldEntries.reduce((acc, e) => (acc === undefined || e.created_at < acc.created_at ? e : acc)).id;

    return this.store.transaction(() => {
      const created = this.commitPreparedRemember(prepared);
      for (const old of oldEntries) {
        this.store.updateEntry(old.id, {
          status: "superseded",
          superseded_by: created.memory_id,
          updated_at: nowIso()
        });
        this.appendAudit({
          memory_id: old.id,
          scope: old.scope,
          ...(old.project_id !== undefined ? { project_id: old.project_id } : {}),
          event: "superseded",
          actor: "agent",
          reason: input.reason,
          metadata: {
            superseded_by: created.memory_id,
            canonical: old.id === canonicalId,
            merged_count: oldEntries.length
          }
        });
      }
      return ok({
        memory_id: created.memory_id,
        merged_from: oldEntries.map((e) => e.id).sort()
      });
    });
  }

  forgetMemory(id: string, reason: string): Result<{ memory_id: string; released_chars: number }, ForgetError> {
    const current = this.store.peekEntry(id);
    if (current === undefined) {
      return err("not_found", "memory not found");
    }

    const released_chars = current.status === "active" ? current.char_count : 0;
    return this.store.transaction(() => {
      this.store.updateEntry(id, {
        status: "forgotten",
        body: "",
        tags: [],
        char_count: 0,
        token_estimate: 0,
        updated_at: nowIso()
      });
      this.appendAudit({
        memory_id: id,
        scope: current.scope,
        ...(current.project_id !== undefined ? { project_id: current.project_id } : {}),
        event: "forgotten",
        actor: "agent",
        reason,
        metadata: {
          released_chars
        }
      });
      return ok({ memory_id: id, released_chars });
    });
  }

  backup(): { path: string; size: number; duration_ms: number } | { error: string } {
    if (this.dataHome === undefined) {
      return { error: "data_home_unknown" };
    }
    const backupDir = join(this.dataHome, "backups");
    try {
      const result = runBackup(this.store.backupHandle(), { backupDir });
      this.appendAudit({
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
      this.appendAudit({
        scope: "global",
        event: "maintenance_run",
        actor: "system:backup",
        reason: "backup_failed",
        metadata: { action: "backup_failed", error: message }
      });
      return { error: message };
    }
  }

  getMemoryBudget(input: { scope: "global" }): MemoryBudgetResult;
  getMemoryBudget(input: { scope: "project"; project_id: string }): MemoryBudgetResult;
  getMemoryBudget(input: { scope: MemoryScope; project_id?: string }): MemoryBudgetResult | Result<never, "invalid_scope">;
  getMemoryBudget(input: { scope: MemoryScope; project_id?: string }): MemoryBudgetResult | Result<never, "invalid_scope"> {
    if (input.scope === "project" && input.project_id === undefined) {
      return err("invalid_scope", "project budget requires project_id");
    }
    const budget =
      input.scope === "global" ? DEFAULT_GLOBAL_BUDGET : this.store.getProjectScope(input.project_id ?? "")?.budget ?? DEFAULT_PROJECT_BUDGET;
    const usage = this.store.getBudgetUsage(input);
    const activeEntries = this.store.listEntries({
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
    const exporter = this.markdownExporter();
    const resolved = this.resolveReadScope(input);
    if (!resolved.ok) {
      return exporter.buildContextPack({
        title: "AgentRecall Context",
        budget_chars: input.budget_chars,
        entries: []
      });
    }

    const collected = this.collectContextEntries(resolved.value, input);
    // Stage 5: annotate each entry with its trust_boost (so the
    // exporter can break importance ties in favor of the calling
    // agent's own or recently-touched memories) and the writer
    // actor (so the markdown output can show who wrote it).
    const entries = collected.map((entry) => ({
      ...entry,
      trust_boost: computeTrustBoost(entry, this.defaultActor, (e) => this.actorForEntry(e)),
      writer: this.actorForEntry(entry)
    }));
    return exporter.buildContextPack({
      title: "AgentRecall Context",
      budget_chars: input.budget_chars,
      entries
    });
  }

  maintainMemories(input: MaintainMemoriesInput): MaintainMemoriesResult {
    const resolved = this.resolveReadScope(input);
    if (!resolved.ok) {
      return {
        action: input.action,
        changed: 0,
        details: {
          error: "invalid_scope",
          message: resolved.message
        }
      };
    }

    switch (input.action) {
      case "find_duplicates":
        return this.findDuplicatesChunked(resolved.value, input);
      case "rebuild_markdown_index":
        return this.rebuildMarkdownIndex(resolved.value);
      case "expire_due":
        return this.expireDueMemories(resolved.value);
      case "archive_low_value":
        return this.archiveLowValueMemories(resolved.value);
      case "vacuum_fts":
        return this.vacuumFts(resolved.value);
    }
  }

  /**
   * Stage 7: chunked find_duplicates. Loads all active entries for
   * the resolved scope in one read (the personal-tool scale keeps
   * this small; well under the SQLite page cache for any realistic
   * store), then runs the bucketed inverted index from T4 in
   * chunks of `batch_size`. Each chunk's results are merged into
   * the running set; groups with the same fingerprint (computed
   * deterministically from reason + memory_id pair + similarity)
   * are deduped across chunks.
   *
   * The progress callback (input.onProgress) fires after each chunk
   * with (processed, total).
   */
  private findDuplicatesChunked(
    scope: ResolvedReadScope,
    input: MaintainMemoriesInput
  ): MaintainMemoriesResult {
    if (input.batch_size !== undefined) {
      if (input.batch_size < 50 || input.batch_size > 5000 || !Number.isInteger(input.batch_size)) {
        throw new Error(
          `maintain_memories batch_size must be an integer in [50, 5000], got ${input.batch_size}`
        );
      }
    }
    const batchSize = input.batch_size ?? 500;
    const onProgress = input.onProgress;

    const allEntries = this.activeEntriesForScope(scope);
    const total = allEntries.length;
    if (total === 0) {
      onProgress?.(0, 0);
      return { action: "find_duplicates", changed: 0, details: { groups: [] } };
    }

    const seenFingerprints = new Set<string>();
    const groups: DuplicateGroup[] = [];
    let processed = 0;
    for (let offset = 0; offset < total; offset += batchSize) {
      const batch = allEntries.slice(offset, offset + batchSize);
      const batchGroups = this.findDuplicateGroups(batch);
      for (const g of batchGroups) {
        if (seenFingerprints.has(g.fingerprint)) continue;
        seenFingerprints.add(g.fingerprint);
        groups.push(g);
      }
      processed += batch.length;
      onProgress?.(processed, total);
    }

    return { action: "find_duplicates", changed: 0, details: { groups } };
  }

  /**
   * Run a backup after a maintenance action that mutated state. No-op if
   * the changed count is zero or if dataHome is unset. Backup errors are
   * swallowed (they're already audited inside `backup()`).
   */
  private maybeBackup(changed: number): void {
    if (changed <= 0 || this.dataHome === undefined) return;
    this.backup();
  }

  private markdownExporter(): MarkdownExporter {
    return this.exporter ?? new MarkdownExporter(join(process.cwd(), ".agent-recall", "exports"));
  }

  private resolveReadScope(input: { scope: MemoryScope; project_id?: string; project_path?: string }): Result<ResolvedReadScope, "invalid_scope"> {
    const resolved = resolveMemoryScope(input);
    if (!resolved.ok) {
      return resolved;
    }
    if (resolved.value.scope === "project" && resolved.value.project_id === undefined) {
      return err("invalid_scope", "project scope requires project_id or project_path");
    }
    return ok({
      scope: resolved.value.scope,
      ...(resolved.value.project_id !== undefined ? { project_id: resolved.value.project_id } : {})
    });
  }

  private resolveOptionalReadScope(input: {
    scope?: MemoryScope;
    project_id?: string;
    project_path?: string;
  }): Result<Partial<ResolvedReadScope>, "invalid_scope"> {
    if (input.scope === undefined) {
      return ok({});
    }
    return this.resolveReadScope(input as { scope: MemoryScope; project_id?: string; project_path?: string });
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
    if (filters.status !== undefined) entryFilters.status = filters.status;
    if (filters.tags !== undefined) entryFilters.tags = filters.tags;
    if (filters.limit !== undefined) entryFilters.limit = filters.limit;
    if (filters.offset !== undefined) entryFilters.offset = filters.offset;
    if (filters.actor !== undefined) entryFilters.actor = filters.actor;
    // Stage 6: time-window filters (ISO 8601 strings; lexicographic
    // comparison is correct for the format).
    if (filters.since !== undefined) entryFilters.since = filters.since;
    if (filters.until !== undefined) entryFilters.until = filters.until;
    if (filters.last_accessed_since !== undefined) entryFilters.last_accessed_since = filters.last_accessed_since;
    // Stage 7: updated_at filters (parallel to Stage 6's created_at
    // pair). Useful for "what memories have I touched in the last
    // week?" queries.
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
        trust_boost: computeTrustBoost(entry, this.defaultActor, (e) => this.actorForEntry(e))
      }))
      .sort(compareContextScores)
      .map(({ entry }) => entry);
  }

  private contextEntriesForScope(scope: ResolvedReadScope, query: string | undefined): MemoryEntry[] {
    const baseFilters = {
      scope: scope.scope,
      ...(scope.project_id !== undefined ? { project_id: scope.project_id } : {}),
      status: "active" as const,
      limit: 10_000
    };
    if (query !== undefined && query.trim().length > 0) {
      return this.store.searchEntries({
        ...baseFilters,
        query
      });
    }
    return this.store.listEntries(baseFilters);
  }

  private matchesContextFilters(entry: MemoryEntry, input: ExportMemoryContextInput): boolean {
    if (input.types !== undefined && input.types.length > 0 && !input.types.includes(entry.type)) {
      return false;
    }
    if (input.topics !== undefined && input.topics.length > 0 && !input.topics.includes(entry.topic)) {
      return false;
    }
    return entry.status === "active";
  }

  private activeEntriesForScope(scope: ResolvedReadScope): MemoryEntry[] {
    return this.store.listEntries({
      scope: scope.scope,
      ...(scope.project_id !== undefined ? { project_id: scope.project_id } : {}),
      status: "active",
      limit: 10_000
    });
  }

  private allEntriesForScope(scope: ResolvedReadScope): MemoryEntry[] {
    return this.store.listEntries({
      scope: scope.scope,
      ...(scope.project_id !== undefined ? { project_id: scope.project_id } : {}),
      limit: 10_000
    });
  }

  private usageForScope(scope: ResolvedReadScope): BudgetUsage {
    return this.store.getBudgetUsage({
      scope: scope.scope,
      ...(scope.project_id !== undefined ? { project_id: scope.project_id } : {})
    });
  }

  private rebuildMarkdownIndex(scope: ResolvedReadScope): MaintainMemoriesResult {
    const exporter = this.markdownExporter();
    const staged = exporter.stageScope({
      scope: scope.scope,
      ...(scope.project_id !== undefined ? { project_id: scope.project_id } : {}),
      entries: this.allEntriesForScope(scope),
      budgetStatus: this.usageForScope(scope)
    });

    const changed = staged.topicPaths.length + 1;
    const paths = {
      indexPath: staged.indexPath,
      topicPaths: staged.topicPaths
    };
    let published: ReturnType<MarkdownExporter["publishStagedScope"]> | undefined;
    try {
      published = exporter.publishStagedScope(staged);
      const result = this.store.transaction(() => {
        this.appendAudit({
          scope: scope.scope,
          ...(scope.project_id !== undefined ? { project_id: scope.project_id } : {}),
          event: "markdown_exported",
          actor: "agent",
          metadata: paths
        });
        this.appendMaintenanceAudit(scope, "rebuild_markdown_index", changed, paths);
        return {
          action: "rebuild_markdown_index" as const,
          changed,
          details: paths
        };
      });
      published.complete();
      this.maybeBackup(changed);
      return result;
    } catch (error) {
      if (published === undefined) {
        rmSync(staged.stagingRoot, { recursive: true, force: true });
      } else {
        published.rollback();
      }
      throw error;
    }
  }

  private expireDueMemories(scope: ResolvedReadScope): MaintainMemoriesResult {
    const now = nowIso();
    const expired = this.activeEntriesForScope(scope)
      .filter((entry) => isDue(entry.expires_at, now))
      .sort((a, b) => compareText(a.expires_at ?? "", b.expires_at ?? "") || compareText(a.id, b.id));

    return this.store.transaction(() => {
      const forgotten: Array<{ memory_id: string; expires_at: string }> = [];
      const failed: Array<{ memory_id: string; error: string }> = [];
      for (const entry of expired) {
        const result = this.forgetMemory(entry.id, "expired by maintain_memories");
        if (result.ok) {
          forgotten.push({
            memory_id: entry.id,
            expires_at: entry.expires_at ?? ""
          });
        } else {
          failed.push({ memory_id: entry.id, error: result.error });
        }
      }
      const details = failed.length === 0 ? { expired: forgotten } : { expired: forgotten, failed };
      this.appendMaintenanceAudit(scope, "expire_due", forgotten.length, details);
      this.maybeBackup(forgotten.length);
      return {
        action: "expire_due",
        changed: forgotten.length,
        details
      };
    });
  }

  private archiveLowValueMemories(scope: ResolvedReadScope): MaintainMemoriesResult {
    const lowValue = this.activeEntriesForScope(scope)
      .filter((entry) => entry.importance <= 2 && entry.confidence <= 2 && entry.access_count === 0 && entry.source.kind !== "user")
      .sort(compareLowValueCandidates);

    return this.store.transaction(() => {
      const archived: Array<{ memory_id: string; reason: string }> = [];
      const failed: Array<{ memory_id: string; error: string }> = [];
      for (const entry of lowValue) {
        const result = this.updateMemory(entry.id, { status: "archived" });
        if (result.ok) {
          archived.push({
            memory_id: entry.id,
            reason: "low importance, low confidence, never accessed"
          });
        } else {
          failed.push({ memory_id: entry.id, error: result.error });
        }
      }
      const details = failed.length === 0 ? { archived } : { archived, failed };
      this.appendMaintenanceAudit(scope, "archive_low_value", archived.length, details);
      this.maybeBackup(archived.length);
      return {
        action: "archive_low_value",
        changed: archived.length,
        details
      };
    });
  }

  private vacuumFts(scope: ResolvedReadScope): MaintainMemoriesResult {
    const vacuum = (this.store as SQLiteMemoryStore & { vacuumFts?: () => void }).vacuumFts;
    if (typeof vacuum === "function") {
      vacuum.call(this.store);
      const details = { status: "vacuumed" };
      this.appendMaintenanceAudit(scope, "vacuum_fts", 1, details);
      return {
        action: "vacuum_fts",
        changed: 1,
        details
      };
    }

    const details = {
      status: "noop",
      reason: "SQLiteMemoryStore does not expose FTS vacuum support"
    };
    this.appendMaintenanceAudit(scope, "vacuum_fts", 0, details);
    return {
      action: "vacuum_fts",
      changed: 0,
      details
    };
  }

  private findDuplicateGroups(entries: MemoryEntry[]): DuplicateGroup[] {
    const sortedEntries = [...entries].sort((a, b) => compareText(a.id, b.id));
    const exactGroups: DuplicateGroup[] = [
      ...this.duplicateGroupsFor(sortedEntries, "same_title_and_body", (entry) => `${normalizeDuplicateText(entry.title)}\n${normalizeDuplicateText(entry.body)}`),
      ...this.duplicateGroupsFor(sortedEntries, "same_title", (entry) => normalizeDuplicateText(entry.title)),
      ...this.duplicateGroupsFor(sortedEntries, "same_body", (entry) => normalizeDuplicateText(entry.body))
    ];
    const similarGroups = this.similarDuplicateGroups(sortedEntries, this.coveredPairKeys(exactGroups));
    const groups: DuplicateGroup[] = [...exactGroups, ...similarGroups];
    const reasonRank: Record<DuplicateGroup["reason"], number> = {
      same_title_and_body: 0,
      same_title: 1,
      same_body: 2,
      similar_title_and_body: 3
    };
    return groups.sort((a, b) => {
      const reasonOrder = reasonRank[a.reason] - reasonRank[b.reason];
      if (reasonOrder !== 0) return reasonOrder;

      const firstIdOrder = compareText(a.memory_ids[0] ?? "", b.memory_ids[0] ?? "");
      if (firstIdOrder !== 0) return firstIdOrder;

      return compareText(a.fingerprint, b.fingerprint);
    });
  }

  private coveredPairKeys(groups: DuplicateGroup[]): Set<string> {
    // For every exact-match group of size >= 2, record the (a|b) pair
    // keys so the similar-detector can skip pairs that are already
    // covered by a stronger exact signal.
    const keys = new Set<string>();
    for (const group of groups) {
      const ids = [...group.memory_ids].sort(compareText);
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          keys.add(`${ids[i]}|${ids[j]}`);
        }
      }
    }
    return keys;
  }

  private similarDuplicateGroups(entries: MemoryEntry[], covered: Set<string>): DuplicateGroup[] {
    // Stage 7: token-bucketed inverted index. The old N×N loop ran
    // 500k pairs at N=1k and 50M at N=10k. Now we only consider
    // pairs that share at least one token, dropping the pair count
    // by 5-10x in realistic stores.
    //
    // Per-bucket cap (BUCKET_CAP) bounds worst case for stop-word-
    // heavy stores where a single token has thousands of entries.
    // Buckets above the cap are skipped; the entries inside them
    // are still detectable via other (smaller) buckets they share.
    const BUCKET_CAP = 200;
    const bucket = new Map<string, MemoryEntry[]>();
    for (const entry of entries) {
      const tokens = tokenizeForSimilarity(`${entry.title}\n${entry.body}`);
      for (const token of tokens) {
        const list = bucket.get(token);
        if (list === undefined) {
          bucket.set(token, [entry]);
        } else {
          list.push(entry);
        }
      }
    }

    const seen = new Set<string>();
    const groups: DuplicateGroup[] = [];
    for (const entriesInBucket of bucket.values()) {
      if (entriesInBucket.length > BUCKET_CAP) continue;
      for (let i = 0; i < entriesInBucket.length; i += 1) {
        const a = entriesInBucket[i];
        if (a === undefined) continue;
        for (let j = i + 1; j < entriesInBucket.length; j += 1) {
          const b = entriesInBucket[j];
          if (b === undefined) continue;
          const pairKey = compareText(a.id, b.id) <= 0
            ? `${a.id}|${b.id}`
            : `${b.id}|${a.id}`;
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);
          if (covered.has(pairKey)) continue;
          const titleSim = textSimilarity(a.title, b.title);
          const bodySim = textSimilarity(a.body, b.body);
          const max = Math.max(titleSim, bodySim);
          if (max < SIMILARITY_THRESHOLD) continue;
          const memory_ids = [a.id, b.id].sort(compareText);
          const titles = [a.title.trim(), b.title.trim()].filter((t) => t.length > 0).sort(compareText);
          groups.push({
            reason: "similar_title_and_body",
            fingerprint: duplicateFingerprint("similar_title_and_body", `${max.toFixed(3)}|${pairKey}`),
            memory_ids,
            titles,
            details: { similarity: max }
          });
        }
      }
    }
    return groups;
  }

  private duplicateGroupsFor(
    entries: MemoryEntry[],
    reason: DuplicateGroup["reason"],
    keyForEntry: (entry: MemoryEntry) => string
  ): DuplicateGroup[] {
    const buckets = new Map<string, MemoryEntry[]>();
    for (const entry of entries) {
      const key = keyForEntry(entry);
      if (key.length === 0) continue;
      buckets.set(key, [...(buckets.get(key) ?? []), entry]);
    }

    return [...buckets.entries()]
      .filter(([, group]) => group.length > 1)
      .map(([key, group]) => {
        const memory_ids = group.map((entry) => entry.id).sort(compareText);
        const titles = [...new Set(group.map((entry) => entry.title.trim()).filter((title) => title.length > 0))].sort(compareText);
        return {
          reason,
          fingerprint: duplicateFingerprint(reason, key),
          memory_ids,
          titles
        };
      });
  }

  private appendMaintenanceAudit(
    scope: ResolvedReadScope,
    action: Exclude<MaintenanceAction, "find_duplicates">,
    changed: number,
    details: unknown
  ): void {
    this.appendAudit({
      scope: scope.scope,
      ...(scope.project_id !== undefined ? { project_id: scope.project_id } : {}),
      event: "maintenance_run",
      actor: "agent",
      reason: action,
      metadata: {
        action,
        changed,
        details
      }
    });
  }

  private matchesReplacementScope(old: MemoryEntry, replacement: MemoryEntry): boolean {
    if (old.scope !== replacement.scope) {
      return false;
    }
    if (old.scope === "project") {
      return old.project_id === replacement.project_id;
    }
    return replacement.project_id === undefined;
  }

  private evaluateEntryBudget(
    entry: MemoryEntry,
    budget: MemoryBudget,
    options: PrepareRememberOptions = {}
  ): Result<BudgetAccepted, "capacity_exceeded"> {
    const existingEntries = this.activeEntriesFor(entry).filter(
      (existing) => !options.excludedActiveMemoryIds?.has(existing.id)
    );
    const usage = this.usageFromActiveEntries(existingEntries);
    const result = evaluateBudget({ budget, usage, candidate: entry, existingEntries, now: entry.updated_at });
    if (!result.ok) return result;
    // Stage 3: enrich each warning with the matching memory's writer
    // actor (from the audit log) and its last_accessed_by map (from
    // the entry itself) so the agent can decide whether the
    // candidate is its own stale write or a fresh write by another
    // agent.
    const enrichedWarnings = result.value.warnings.map((w) => {
      const matched = existingEntries.find((e) => e.id === w.memory_id);
      if (matched === undefined) return w;
      const enriched: BudgetWarning = { ...w };
      enriched.actor = this.actorForEntry(matched);
      if (matched.last_accessed_by !== undefined) {
        enriched.last_accessed_by = matched.last_accessed_by;
      }
      return enriched;
    });
    return ok({ ...result.value, warnings: enrichedWarnings });
  }

  private actorForEntry(entry: MemoryEntry): string {
    // Walk the audit log to find the first "created" event for this
    // entry. That event's actor is the canonical writer. Fall back
    // to the legacy kind if no audit row is found.
    const events = this.store.getAuditEvents(entry.id);
    const created = events.find((e) => e.event === "created");
    if (created !== undefined) return created.actor;
    return entry.source.kind;
  }

  private budgetFor(entry: MemoryEntry): MemoryBudget {
    if (entry.scope === "global") {
      return DEFAULT_GLOBAL_BUDGET;
    }
    return this.store.getProjectScope(entry.project_id ?? "")?.budget ?? DEFAULT_PROJECT_BUDGET;
  }

  private activeEntriesFor(entry: Pick<MemoryEntry, "scope" | "project_id">): MemoryEntry[] {
    return this.store.listEntries({
      scope: entry.scope,
      ...(entry.project_id !== undefined ? { project_id: entry.project_id } : {}),
      status: "active",
      limit: 10_000
    });
  }

  private usageFromActiveEntries(entries: MemoryEntry[]): BudgetUsage {
    const topic_chars: Record<string, number> = {};
    let active_chars = 0;
    let index_chars = 0;

    for (const entry of entries) {
      active_chars += entry.char_count;
      topic_chars[entry.topic] = (topic_chars[entry.topic] ?? 0) + entry.char_count;
      index_chars += estimateIndexChars(entry.title, entry.topic, entry.tags);
    }

    return {
      active_entries: entries.length,
      active_chars,
      topic_chars,
      index_chars
    };
  }

  private ensureProjectScope(project_id: string, project_path: string, display_name: string): ProjectScope {
    const existing = this.store.getProjectScope(project_id);
    return existing ?? this.configureProjectBudget(project_id, DEFAULT_PROJECT_BUDGET, project_path, display_name);
  }

  private buildEntry(
    input: ValidatedRememberInput,
    scope: MemoryScope,
    timestamp: string,
    project: { project_id?: string; project_path?: string }
  ): MemoryEntry {
    return {
      id: createMemoryId(),
      scope,
      ...(project.project_id !== undefined ? { project_id: project.project_id } : {}),
      ...(project.project_path !== undefined ? { project_path: project.project_path } : {}),
      type: input.type,
      topic: input.topic,
      title: input.title,
      body: input.body,
      tags: input.tags,
      source: input.source,
      importance: input.importance,
      confidence: input.confidence,
      status: input.status,
      created_at: timestamp,
      updated_at: timestamp,
      access_count: 0,
      ...(input.expires_at !== undefined ? { expires_at: input.expires_at } : {}),
      ...(input.review_after !== undefined ? { review_after: input.review_after } : {}),
      supersedes: input.supersedes,
      token_estimate: input.token_estimate,
      char_count: input.char_count
    };
  }

  private appendAudit(input: Omit<MemoryAuditEvent, "id" | "created_at" | "actor"> & { actor?: string }): void {
    const event: MemoryAuditEvent = {
      id: createAuditId(),
      scope: input.scope,
      event: input.event,
      actor: resolveActor(input.actor ?? this.defaultActor) as MemoryAuditEvent["actor"],
      metadata: input.metadata,
      created_at: nowIso()
    };
    if (input.memory_id !== undefined) event.memory_id = input.memory_id;
    if (input.project_id !== undefined) event.project_id = input.project_id;
    if (input.reason !== undefined) event.reason = input.reason;
    this.store.appendAudit(event);
  }

  private auditRejected(input: unknown, error: string, details: Record<string, unknown> | undefined): void {
    const project_id = safeProjectIdFromInput(input);
    this.appendAudit({
      scope: safeScopeFromInput(input),
      ...(project_id !== undefined ? { project_id } : {}),
      event: "write_rejected",
      actor: "system",
      reason: error,
      metadata: this.rejectionMetadata(error, details)
    });
  }

  private auditRejectedForEntry(entry: MemoryEntry, error: string, details: Record<string, unknown> | undefined): void {
    this.appendAudit({
      memory_id: entry.id,
      scope: entry.scope,
      ...(entry.project_id !== undefined ? { project_id: entry.project_id } : {}),
      event: "write_rejected",
      actor: "system",
      reason: error,
      metadata: this.rejectionMetadata(error, details)
    });
  }

  private auditRejectedForScope(
    scope: MemoryScope,
    project_id: string | undefined,
    error: string,
    details: Record<string, unknown> | undefined
  ): void {
    this.appendAudit({
      scope,
      ...(project_id !== undefined ? { project_id } : {}),
      event: "write_rejected",
      actor: "system",
      reason: error,
      metadata: this.rejectionMetadata(error, details)
    });
  }

  private rejectionMetadata(error: string, details: Record<string, unknown> | undefined): Record<string, unknown> {
    return details === undefined ? { error } : { error, ...details };
  }
}
