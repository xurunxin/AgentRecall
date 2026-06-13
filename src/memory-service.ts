import {
  estimateIndexChars,
  evaluateBudget,
  rankCleanupCandidates,
  type BudgetAccepted,
  type BudgetWarning,
  type CandidateAction
} from "./budget-governor.js";
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
import { resolveMemoryScope } from "./scope-resolver.js";
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

type RememberError = "invalid_schema" | "invalid_scope" | "secret_detected" | "capacity_exceeded";
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
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeScopeFromInput(input: unknown): MemoryScope {
  return isRecord(input) && input.scope === "project" ? "project" : "global";
}

function safeProjectIdFromInput(input: unknown): string | undefined {
  return isRecord(input) && typeof input.project_id === "string" ? input.project_id : undefined;
}

export class MemoryService {
  constructor(private readonly store: SQLiteMemoryStore) {}

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
    return this.store.transaction(() => ok(this.commitPreparedRemember(prepared.value)));
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

  private commitPreparedRemember(prepared: PreparedRemember): RememberResult {
    const { entry, budget } = prepared;
    this.store.insertEntry(entry);
    this.appendAudit({
      memory_id: entry.id,
      scope: entry.scope,
      ...(entry.project_id !== undefined ? { project_id: entry.project_id } : {}),
      event: "created",
      actor: "agent",
      metadata: {
        type: entry.type,
        topic: entry.topic
      }
    });

    return {
      memory_id: entry.id,
      status: entry.status,
      budget_after: budget.budget_after,
      warnings: budget.warnings
    };
  }

  getMemory(id: string): { entry: MemoryEntry; audit: MemoryAuditEvent[] } | undefined {
    const entry = this.store.getEntry(id);
    return entry === undefined ? undefined : { entry, audit: this.store.getAuditEvents(id) };
  }

  listMemories(filters: EntryFilters): ListResult {
    return {
      items: this.store.listEntries({
        ...filters,
        status: filters.status ?? "active"
      })
    };
  }

  searchMemories(filters: SearchServiceFilters): SearchResult {
    const { include_global: includeGlobal, ...storeFilters } = filters;
    const limit = filters.limit ?? 10;
    const status = filters.status ?? "active";
    const projectItems = this.store.searchEntries({
      ...storeFilters,
      status,
      limit
    });
    const globalItems =
      filters.scope === "project" && includeGlobal
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
    return evaluateBudget({ budget, usage, candidate: entry, existingEntries, now: entry.updated_at });
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

  private appendAudit(input: Omit<MemoryAuditEvent, "id" | "created_at">): void {
    const event: MemoryAuditEvent = {
      id: createAuditId(),
      scope: input.scope,
      event: input.event,
      actor: input.actor,
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
