// src/services/memory-write-service.ts
//
// Stage 9: the write path of MemoryService, extracted into
// its own service. Owns: remember, updateMemory,
// supersedeMemory, mergeMemories, forgetMemory,
// configureProjectBudget.
//
// All write methods are transactional: each public method
// wraps its work in `store.transaction(...)`. They also
// emit audit events for accepted writes and rejected
// writes (so the agent and the human reviewer can see
// what happened).

import { nowIso, err, ok, type MemoryEntry, type MemoryBudget, type MemoryScope, type ProjectScope, type Result } from "../domain.js";
import type { SQLiteMemoryStore } from "../sqlite-store.js";
import {
  type RememberInput,
  type UpdateInput,
  type ValidatedRememberInput,
  validateRememberInput,
  validateUpdateInput
} from "../write-validator.js";
import { resolveMemoryScope } from "../scope-resolver.js";
import { computeEntrySize, createMemoryId } from "../domain.js";
import {
  activeEntriesFor,
  appendAudit,
  auditRejected,
  auditRejectedForEntry,
  auditRejectedForScope,
  budgetFor,
  buildEntry,
  DEFAULT_GLOBAL_BUDGET,
  ensureProjectScope,
  evaluateEntryBudget,
  matchesReplacementScope
} from "./memory-service-helpers.js";

type RememberError = "invalid_schema" | "invalid_scope" | "secret_detected" | "capacity_exceeded" | "duplicate_candidate";
type UpdateError = "not_found" | "invalid_state" | "invalid_schema" | "secret_detected" | "capacity_exceeded";
type SupersedeError = RememberError | "not_found" | "invalid_state";
type ForgetError = "not_found";

type PreparedRemember = {
  entry: MemoryEntry;
  budget: { warnings: Array<{ code: string; memory_id: string; actor?: string; last_accessed_by?: Record<string, string> }> };
};

type ResolvedRemember = {
  entry: MemoryEntry;
  project_path?: string;
  display_name?: string;
};

type PrepareRememberOptions = {
  excludedActiveMemoryIds?: ReadonlySet<string>;
};

export type RememberResult = {
  memory_id: string;
  status: MemoryEntry["status"];
  budget_after: { active_entries: number; active_chars: number; topic_chars: Record<string, number>; index_chars: number };
  warnings: PreparedRemember["budget"]["warnings"];
};

export type WriteContext = {
  store: SQLiteMemoryStore;
  defaultActor: string;
  /** Returns the configured project scope (or creates one with default budget). */
  configureProjectBudget: (
    project_id: string,
    budget: MemoryBudget,
    canonical_path: string,
    display_name: string
  ) => ProjectScope;
};

export class MemoryWriteService {
  constructor(private readonly ctx: WriteContext) {}

  configureProjectBudget(
    project_id: string,
    budget: MemoryBudget,
    canonical_path: string,
    display_name: string
  ): ProjectScope {
    const now = nowIso();
    const existing = this.ctx.store.getProjectScope(project_id);
    const scope: ProjectScope = {
      project_id,
      canonical_path,
      display_name,
      budget,
      created_at: existing?.created_at ?? now,
      updated_at: now
    };
    this.ctx.store.upsertProjectScope(scope);
    return scope;
  }

  remember(input: RememberInput): Result<RememberResult, RememberError> {
    const prepared = this.prepareRemember(input, true);
    if (!prepared.ok) {
      return prepared;
    }
    if (input.confirm_write !== true) {
      const matchingIds = prepared.value.budget.warnings
        .filter((w) => w.code === "duplicate_candidate")
        .map((w) => w.memory_id);
      if (matchingIds.length > 0) {
        auditRejected(
          this.ctx.store,
          this.ctx.defaultActor,
          input,
          "duplicate_candidate",
          { matching_ids: matchingIds }
        );
        return err(
          "duplicate_candidate",
          "existing active memory has the same title or body; pass confirm_write: true to proceed",
          { matching_ids: matchingIds }
        );
      }
    }
    const suppressed = input.confirm_write === true ? [] : prepared.value.budget.warnings;
    return this.ctx.store.transaction(() =>
      ok(this.commitPreparedRemember(prepared.value, suppressed))
    );
  }

  updateMemory(
    id: string,
    input: UpdateInput
  ): Result<{ memory_id: string }, UpdateError> {
    // Stage 9: peek the current entry first so every rejection
    // path (invalid_state, secret_detected, invalid_schema) can
    // attach a write_rejected audit to the memory_id. This
    // matches the pre-split behavior and the test expectations.
    const current = this.ctx.store.peekEntry(id);
    if (current === undefined) {
      return err("not_found", "memory not found");
    }
    if (current.status !== "active" && current.status !== "archived") {
      auditRejectedForEntry(this.ctx.store, this.ctx.defaultActor, current, "invalid_state", {
        memory_id: id,
        status: current.status
      });
      return err("invalid_state", "only active or archived memories can be updated", {
        memory_id: id,
        status: current.status
      });
    }

    const validated = validateUpdateInput(input);
    if (!validated.ok) {
      auditRejectedForEntry(this.ctx.store, this.ctx.defaultActor, current, validated.error, validated.details);
      return err(validated.error, validated.message, validated.details);
    }

    const patch: Record<string, unknown> = { ...validated.value };
    if (validated.value.body !== undefined || validated.value.tags !== undefined) {
      const size = computeEntrySize(
        current.title,
        validated.value.body ?? current.body,
        validated.value.tags ?? current.tags
      );
      patch.char_count = size.char_count;
      patch.token_estimate = size.token_estimate;
    }
    patch.updated_at = nowIso();

    const next: MemoryEntry = { ...current, ...patch, id: current.id } as MemoryEntry;
    const existingEntries = activeEntriesFor(this.ctx.store, next).filter((entry) => entry.id !== id);
    const budget = budgetFor(this.ctx.store, next);
    const budgetResult = evaluateEntryBudget(this.ctx.store, next, budget, {
      excludedActiveMemoryIds: new Set([id])
    });
    if (!budgetResult.ok) {
      auditRejectedForEntry(this.ctx.store, this.ctx.defaultActor, current, "capacity_exceeded", budgetResult.details);
      return err("capacity_exceeded", "capacity exceeded", budgetResult.details);
    }
    const event = current.status === "active" && patch.status === "archived" ? "archived" : "updated";
    return this.ctx.store.transaction(() => {
      this.ctx.store.updateEntry(id, patch as Parameters<SQLiteMemoryStore["updateEntry"]>[1]);
      appendAudit(this.ctx.store, this.ctx.defaultActor, {
        memory_id: id,
        scope: current.scope,
        ...(current.project_id !== undefined ? { project_id: current.project_id } : {}),
        event,
        metadata: { fields: Object.keys(validated.value).sort() }
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
      auditRejected(this.ctx.store, this.ctx.defaultActor, input.replacement, "invalid_schema", {
        old_memory_ids_count: oldIds.length
      });
      return err("invalid_schema", "supersede requires at least one old memory id");
    }

    const resolvedReplacement = this.resolveRememberInput(
      { ...input.replacement, supersedes: oldIds },
      true
    );
    if (!resolvedReplacement.ok) return resolvedReplacement;
    const replacement = resolvedReplacement.value.entry;

    const oldEntries: MemoryEntry[] = [];
    for (const oldId of oldIds) {
      const old = this.ctx.store.peekEntry(oldId);
      if (old === undefined) {
        auditRejectedForScope(
          this.ctx.store,
          this.ctx.defaultActor,
          replacement.scope,
          replacement.project_id,
          "not_found",
          { memory_id: oldId }
        );
        return err("not_found", "memory not found", { memory_id: oldId });
      }
      if (old.status !== "active" && old.status !== "archived") {
        auditRejectedForEntry(this.ctx.store, this.ctx.defaultActor, old, "invalid_state", {
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
      if (!matchesReplacementScope(old, replacement)) {
        auditRejectedForEntry(this.ctx.store, this.ctx.defaultActor, old, "invalid_scope", {
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
        auditRejectedForScope(
          this.ctx.store,
          this.ctx.defaultActor,
          replacement.scope,
          replacement.project_id,
          "invalid_scope",
          undefined
        );
        return err("invalid_scope", "project scope requires project_id or project_path");
      }
      budget = ensureProjectScope(
        this.ctx.store,
        this.ctx.configureProjectBudget,
        projectId,
        resolvedReplacement.value.project_path ?? "",
        resolvedReplacement.value.display_name ?? projectId
      ).budget;
    }
    const excludedActiveMemoryIds = new Set(
      oldEntries.filter((old) => old.status === "active").map((old) => old.id)
    );
    const budgetResult = evaluateEntryBudget(this.ctx.store, replacement, budget, { excludedActiveMemoryIds });
    if (!budgetResult.ok) {
      auditRejectedForScope(
        this.ctx.store,
        this.ctx.defaultActor,
        replacement.scope,
        replacement.project_id,
        "capacity_exceeded",
        budgetResult.details
      );
      return err(budgetResult.error, budgetResult.message, budgetResult.details);
    }
    const prepared: PreparedRemember = {
      entry: replacement,
      budget: { warnings: budgetResult.value.warnings }
    };

    return this.ctx.store.transaction(() => {
      const created = this.commitPreparedRemember(prepared);
      for (const old of oldEntries) {
        this.ctx.store.updateEntry(old.id, {
          status: "superseded",
          superseded_by: created.memory_id,
          updated_at: nowIso()
        });
        appendAudit(this.ctx.store, this.ctx.defaultActor, {
          memory_id: old.id,
          scope: old.scope,
          ...(old.project_id !== undefined ? { project_id: old.project_id } : {}),
          event: "superseded",
          reason: input.reason,
          metadata: {
            superseded_by: created.memory_id
          }
        });
      }
      return ok({ memory_id: created.memory_id });
    });
  }

  mergeMemories(input: {
    old_memory_ids: string[];
    replacement: RememberInput;
    reason: string;
    strategy?: "keep_first" | "keep_newest";
  }): Result<{ memory_id: string; merged_from?: string[] }, SupersedeError> {
    const oldIds = [...new Set(input.old_memory_ids)];
    if (oldIds.length < 2) {
      auditRejected(this.ctx.store, this.ctx.defaultActor, input.replacement, "invalid_schema", {
        old_memory_ids_count: oldIds.length
      });
      return err("invalid_schema", "merge requires at least two old memory ids");
    }
    const resolvedReplacement = this.resolveRememberInput(
      { ...input.replacement, supersedes: oldIds },
      true
    );
    if (!resolvedReplacement.ok) return resolvedReplacement;
    const replacement = resolvedReplacement.value.entry;

    const oldEntries: MemoryEntry[] = [];
    for (const oldId of oldIds) {
      const old = this.ctx.store.peekEntry(oldId);
      if (old === undefined) {
        auditRejectedForScope(
          this.ctx.store,
          this.ctx.defaultActor,
          replacement.scope,
          replacement.project_id,
          "not_found",
          { memory_id: oldId }
        );
        return err("not_found", "memory not found", { memory_id: oldId });
      }
      if (old.status !== "active" && old.status !== "archived") {
        auditRejectedForEntry(this.ctx.store, this.ctx.defaultActor, old, "invalid_state", {
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
      if (!matchesReplacementScope(old, replacement)) {
        auditRejectedForEntry(this.ctx.store, this.ctx.defaultActor, old, "invalid_scope", {
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
        return err("invalid_scope", "project scope requires project_id or project_path");
      }
      budget = ensureProjectScope(
        this.ctx.store,
        this.ctx.configureProjectBudget,
        projectId,
        resolvedReplacement.value.project_path ?? "",
        resolvedReplacement.value.display_name ?? projectId
      ).budget;
    }
    const excludedActiveMemoryIds = new Set(
      oldEntries.filter((old) => old.status === "active").map((old) => old.id)
    );
    const budgetResult = evaluateEntryBudget(this.ctx.store, replacement, budget, { excludedActiveMemoryIds });
    if (!budgetResult.ok) {
      auditRejectedForScope(
        this.ctx.store,
        this.ctx.defaultActor,
        replacement.scope,
        replacement.project_id,
        "capacity_exceeded",
        budgetResult.details
      );
      return err(budgetResult.error, budgetResult.message, budgetResult.details);
    }
    const prepared: PreparedRemember = {
      entry: replacement,
      budget: { warnings: budgetResult.value.warnings }
    };

    const canonicalId = input.strategy === "keep_newest"
      ? oldEntries.reduce((acc, e) => (acc === undefined || e.created_at > acc.created_at ? e : acc)).id
      : oldEntries.reduce((acc, e) => (acc === undefined || e.created_at < acc.created_at ? e : acc)).id;

    return this.ctx.store.transaction(() => {
      const created = this.commitPreparedRemember(prepared);
      for (const old of oldEntries) {
        this.ctx.store.updateEntry(old.id, {
          status: "superseded",
          superseded_by: created.memory_id,
          updated_at: nowIso()
        });
        appendAudit(this.ctx.store, this.ctx.defaultActor, {
          memory_id: old.id,
          scope: old.scope,
          ...(old.project_id !== undefined ? { project_id: old.project_id } : {}),
          event: "superseded",
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

  forgetMemory(
    id: string,
    reason: string
  ): Result<{ memory_id: string; released_chars: number }, ForgetError> {
    const current = this.ctx.store.peekEntry(id);
    if (current === undefined) {
      return err("not_found", "memory not found");
    }
    const released_chars = current.status === "active" ? current.char_count : 0;
    return this.ctx.store.transaction(() => {
      this.ctx.store.updateEntry(id, {
        status: "forgotten",
        body: "",
        tags: [],
        char_count: 0,
        token_estimate: 0,
        updated_at: nowIso()
      });
      appendAudit(this.ctx.store, this.ctx.defaultActor, {
        memory_id: id,
        scope: current.scope,
        ...(current.project_id !== undefined ? { project_id: current.project_id } : {}),
        event: "forgotten",
        reason,
        metadata: { released_chars }
      });
      return ok({ memory_id: id, released_chars });
    });
  }

  // ============================================================
  // Private write helpers
  // ============================================================

  private prepareRemember(
    input: RememberInput,
    auditRejections: boolean,
    options: PrepareRememberOptions = {}
  ): Result<PreparedRemember, RememberError> {
    const resolved = this.resolveRememberInput(input, auditRejections);
    if (!resolved.ok) return resolved;

    let budget = DEFAULT_GLOBAL_BUDGET;
    if (resolved.value.entry.scope === "project") {
      const projectId = resolved.value.entry.project_id;
      if (projectId === undefined) {
        if (auditRejections) auditRejected(this.ctx.store, this.ctx.defaultActor, input, "invalid_scope", undefined);
        return err("invalid_scope", "project scope requires project_id or project_path");
      }
      budget = ensureProjectScope(
        this.ctx.store,
        this.ctx.configureProjectBudget,
        projectId,
        resolved.value.project_path ?? "",
        resolved.value.display_name ?? projectId
      ).budget;
    }
    const budgetResult = evaluateEntryBudget(this.ctx.store, resolved.value.entry, budget, options);
    if (!budgetResult.ok) {
      if (auditRejections) auditRejected(this.ctx.store, this.ctx.defaultActor, input, "capacity_exceeded", budgetResult.details);
      return err(budgetResult.error, budgetResult.message, budgetResult.details);
    }
    return ok({
      entry: resolved.value.entry,
      budget: { warnings: budgetResult.value.warnings }
    });
  }

  private resolveRememberInput(
    input: RememberInput,
    auditRejections: boolean
  ): Result<ResolvedRemember, RememberError> {
    const validated = validateRememberInput(input);
    if (!validated.ok) {
      if (auditRejections) auditRejected(this.ctx.store, this.ctx.defaultActor, input, validated.error, validated.details);
      return validated;
    }
    const resolved = resolveMemoryScope(validated.value);
    if (!resolved.ok) {
      if (auditRejections) auditRejected(this.ctx.store, this.ctx.defaultActor, input, resolved.error, resolved.details);
      return resolved;
    }
    if (resolved.value.scope === "project" && resolved.value.project_id === undefined) {
      if (auditRejections) auditRejected(this.ctx.store, this.ctx.defaultActor, input, "invalid_scope", undefined);
      return err("invalid_scope", "project scope requires project_id or project_path");
    }
    return ok({
      entry: buildEntry(
        validated.value,
        resolved.value.scope,
        nowIso(),
        {
          ...(resolved.value.project_id !== undefined ? { project_id: resolved.value.project_id } : {}),
          ...(resolved.value.project_path !== undefined ? { project_path: resolved.value.project_path } : {})
        },
        createMemoryId()
      ),
      ...(resolved.value.project_path !== undefined ? { project_path: resolved.value.project_path } : {}),
      ...(resolved.value.display_name !== undefined ? { display_name: resolved.value.display_name } : {})
    });
  }

  private commitPreparedRemember(
    prepared: PreparedRemember,
    warnings?: PreparedRemember["budget"]["warnings"]
  ): RememberResult {
    const entry = prepared.entry;
    this.ctx.store.insertEntry(entry);
    // Omit `actor` so appendAudit falls back to this.defaultActor
    // (resolved through resolveActor). The "created" event is the
    // canonical writer record used by `actorForEntry` for trust
    // boost and near-duplicate advisory, so the actor here MUST
    // reflect the calling service's identity, not a hardcoded
    // "agent".
    appendAudit(this.ctx.store, this.ctx.defaultActor, {
      memory_id: entry.id,
      scope: entry.scope,
      ...(entry.project_id !== undefined ? { project_id: entry.project_id } : {}),
      event: "created",
      metadata: {
        topic: entry.topic,
        type: entry.type,
        importance: entry.importance,
        confidence: entry.confidence
      }
    });
    const usage = this.ctx.store.getBudgetUsage({
      scope: entry.scope,
      ...(entry.project_id !== undefined ? { project_id: entry.project_id } : {})
    });
    return {
      memory_id: entry.id,
      status: entry.status,
      budget_after: usage,
      warnings: warnings ?? prepared.budget.warnings
    };
  }
}
