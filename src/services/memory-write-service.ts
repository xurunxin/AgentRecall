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
//
// Stage 14 PR-B1 (spec § 5.2 AR-P0-002): every public method
// takes an optional `RequestContext` as its last parameter.
// When present, it (a) replaces the `WriteContext.defaultActor`
// for the audit `actor` field and (b) attaches the request's
// trace fields (request_id, session_id, tool_call_id, etc.) to
// the audit `metadata`. When absent, the legacy behaviour
// (process-wide `defaultActor`) is preserved so pre-PR-B1
// callers and tests keep working.

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
import type { RequestContext } from "../request-context.js";
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
type UpdateError = "not_found" | "invalid_state" | "invalid_schema" | "secret_detected" | "capacity_exceeded" | "stale_revision";
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

  /**
   * Stage 13 PR10 (spec § 6.7): insert an entry from a
   * prior export, preserving the original id. Used by
   * the import path. The entry's scope / secret /
   * revision / project fields are assumed to be valid
   * (the exporter produced them from a validated live
   * entry). The function still emits the standard
   * `created` audit event so the actor chain stays
   * intact.
   */
  insertImportedEntry(entry: MemoryEntry, actor: string): void {
    this.ctx.store.insertEntry(entry);
    appendAudit(this.ctx.store, actor, {
      memory_id: entry.id,
      scope: entry.scope,
      ...(entry.project_id !== undefined ? { project_id: entry.project_id } : {}),
      event: "created",
      reason: "imported",
      metadata: {
        topic: entry.topic,
        type: entry.type,
        importance: entry.importance,
        confidence: entry.confidence,
        imported_from: "export",
        source_revision: entry.revision
      }
    });
  }

  remember(input: RememberInput, ctx?: RequestContext): Result<RememberResult, RememberError> {
    const prepared = this.prepareRemember(input, true, ctx);
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
          { matching_ids: matchingIds },
          ctx
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
      ok(this.commitPreparedRemember(prepared.value, suppressed, ctx))
    );
  }

  updateMemory(
    id: string,
    input: UpdateInput,
    ctx?: RequestContext
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
      }, ctx);
      return err("invalid_state", "only active or archived memories can be updated", {
        memory_id: id,
        status: current.status
      });
    }

    const validated = validateUpdateInput(input);
    if (!validated.ok) {
      auditRejectedForEntry(this.ctx.store, this.ctx.defaultActor, current, validated.error, validated.details, ctx);
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
      auditRejectedForEntry(this.ctx.store, this.ctx.defaultActor, current, "capacity_exceeded", budgetResult.details, ctx);
      return err("capacity_exceeded", "capacity exceeded", budgetResult.details);
    }
    const event = current.status === "active" && patch.status === "archived" ? "archived" : "updated";
    // Stage 12 PR9: optimistic-concurrency control. When
    // the caller passes `expected_revision`, route the
    // write through `updateEntryWithRevision` so a
    // concurrent writer wins the race and we surface
    // `stale_revision` instead of silently overwriting.
    if (validated.value.expected_revision !== undefined) {
      const expected = validated.value.expected_revision;
      const applied = this.ctx.store.updateEntryWithRevision(
        id,
        patch as Parameters<SQLiteMemoryStore["updateEntry"]>[1],
        expected
      );
      if (!applied) {
        const currentRevision = this.ctx.store.peekEntry(id)?.revision;
        auditRejectedForEntry(
          this.ctx.store,
          this.ctx.defaultActor,
          current,
          "stale_revision",
          { memory_id: id, expected_revision: expected, current_revision: currentRevision },
          ctx
        );
        return err("stale_revision", "memory revision has changed; re-read and retry", {
          memory_id: id,
          expected_revision: expected,
          current_revision: currentRevision
        });
      }
      appendAudit(this.ctx.store, this.ctx.defaultActor, {
        memory_id: id,
        scope: current.scope,
        ...(current.project_id !== undefined ? { project_id: current.project_id } : {}),
        event,
        metadata: { fields: Object.keys(validated.value).sort() }
      }, ctx);
      return ok({ memory_id: id });
    }
    return this.ctx.store.transaction(() => {
      this.ctx.store.updateEntry(id, patch as Parameters<SQLiteMemoryStore["updateEntry"]>[1]);
      appendAudit(this.ctx.store, this.ctx.defaultActor, {
        memory_id: id,
        scope: current.scope,
        ...(current.project_id !== undefined ? { project_id: current.project_id } : {}),
        event,
        metadata: { fields: Object.keys(validated.value).sort() }
      }, ctx);
      return ok({ memory_id: id });
    });
  }

  supersedeMemory(input: {
    old_memory_ids: string[];
    replacement: RememberInput;
    reason: string;
  }, ctx?: RequestContext): Result<{ memory_id: string }, SupersedeError> {
    const oldIds = [...new Set(input.old_memory_ids)];
    if (oldIds.length === 0 || oldIds.some((id) => id.trim().length === 0)) {
      auditRejected(this.ctx.store, this.ctx.defaultActor, input.replacement, "invalid_schema", {
        old_memory_ids_count: oldIds.length
      }, ctx);
      return err("invalid_schema", "supersede requires at least one old memory id");
    }

    const resolvedReplacement = this.resolveRememberInput(
      { ...input.replacement, supersedes: oldIds },
      true,
      ctx
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
          { memory_id: oldId },
          ctx
        );
        return err("not_found", "memory not found", { memory_id: oldId });
      }
      if (old.status !== "active" && old.status !== "archived") {
        auditRejectedForEntry(this.ctx.store, this.ctx.defaultActor, old, "invalid_state", {
          memory_id: oldId,
          status: old.status
        }, ctx);
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
        }, ctx);
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
          undefined,
          ctx
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
        budgetResult.details,
        ctx
      );
      return err(budgetResult.error, budgetResult.message, budgetResult.details);
    }
    const prepared: PreparedRemember = {
      entry: replacement,
      budget: { warnings: budgetResult.value.warnings }
    };

    return this.ctx.store.transaction(() => {
      const created = this.commitPreparedRemember(prepared, undefined, ctx);
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
        }, ctx);
      }
      return ok({ memory_id: created.memory_id });
    });
  }

  mergeMemories(input: {
    old_memory_ids: string[];
    replacement: RememberInput;
    reason: string;
    strategy?: "keep_first" | "keep_newest";
  }, ctx?: RequestContext): Result<{ memory_id: string; merged_from?: string[] }, SupersedeError> {
    const oldIds = [...new Set(input.old_memory_ids)];
    if (oldIds.length < 2) {
      auditRejected(this.ctx.store, this.ctx.defaultActor, input.replacement, "invalid_schema", {
        old_memory_ids_count: oldIds.length
      }, ctx);
      return err("invalid_schema", "merge requires at least two old memory ids");
    }
    const resolvedReplacement = this.resolveRememberInput(
      { ...input.replacement, supersedes: oldIds },
      true,
      ctx
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
          { memory_id: oldId },
          ctx
        );
        return err("not_found", "memory not found", { memory_id: oldId });
      }
      if (old.status !== "active" && old.status !== "archived") {
        auditRejectedForEntry(this.ctx.store, this.ctx.defaultActor, old, "invalid_state", {
          memory_id: oldId,
          status: old.status
        }, ctx);
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
        }, ctx);
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
        budgetResult.details,
        ctx
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
      const created = this.commitPreparedRemember(prepared, undefined, ctx);
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
        }, ctx);
      }
      return ok({
        memory_id: created.memory_id,
        merged_from: oldEntries.map((e) => e.id).sort()
      });
    });
  }

  forgetMemory(
    id: string,
    reason: string,
    ctx?: RequestContext
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
      }, ctx);
      return ok({ memory_id: id, released_chars });
    });
  }

  // ============================================================
  // Private write helpers
  // ============================================================

  private prepareRemember(
    input: RememberInput,
    auditRejections: boolean,
    ctx?: RequestContext,
    options: PrepareRememberOptions = {}
  ): Result<PreparedRemember, RememberError> {
    const resolved = this.resolveRememberInput(input, auditRejections, ctx);
    if (!resolved.ok) return resolved;

    let budget = DEFAULT_GLOBAL_BUDGET;
    if (resolved.value.entry.scope === "project") {
      const projectId = resolved.value.entry.project_id;
      if (projectId === undefined) {
        if (auditRejections) auditRejected(this.ctx.store, this.ctx.defaultActor, input, "invalid_scope", undefined, ctx);
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
      if (auditRejections) auditRejected(this.ctx.store, this.ctx.defaultActor, input, "capacity_exceeded", budgetResult.details, ctx);
      return err(budgetResult.error, budgetResult.message, budgetResult.details);
    }
    return ok({
      entry: resolved.value.entry,
      budget: { warnings: budgetResult.value.warnings }
    });
  }

  private resolveRememberInput(
    input: RememberInput,
    auditRejections: boolean,
    ctx?: RequestContext
  ): Result<ResolvedRemember, RememberError> {
    const validated = validateRememberInput(input);
    if (!validated.ok) {
      if (auditRejections) auditRejected(this.ctx.store, this.ctx.defaultActor, input, validated.error, validated.details, ctx);
      return validated;
    }
    const resolved = resolveMemoryScope(validated.value);
    if (!resolved.ok) {
      if (auditRejections) auditRejected(this.ctx.store, this.ctx.defaultActor, input, resolved.error, resolved.details, ctx);
      return resolved;
    }
    if (resolved.value.scope === "project" && resolved.value.project_id === undefined) {
      if (auditRejections) auditRejected(this.ctx.store, this.ctx.defaultActor, input, "invalid_scope", undefined, ctx);
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
    warnings?: PreparedRemember["budget"]["warnings"],
    ctx?: RequestContext
  ): RememberResult {
    // Stage 14 PR-B1 (spec § 5.2 #5): stamp writer_actor_id on
    // the entry from the resolved caller. Pre-PR-B1 the column
    // was left at the `agent:pending` default and the actor
    // filter on listEntries / searchEntries walked the audit log
    // (N+1) to recover the writer. Post-PR-B1 the writer lives
    // on the row and the filter is a single equality predicate.
    const writer = ctx?.actor_id ?? this.ctx.defaultActor;
    const entry: MemoryEntry = { ...prepared.entry, writer_actor_id: writer };
    this.ctx.store.insertEntry(entry);
    // The "created" event is the canonical audit record used by
    // `actorForEntry` (with audit-log fallback) for trust boost
    // and near-duplicate advisory. Its actor must match the
    // stamped `writer_actor_id` on the row.
    appendAudit(this.ctx.store, writer, {
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
    }, ctx);
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
