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
import { hashRequest, lookupIdempotency, recordIdempotency } from "./idempotency.js";
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

type RememberError = "invalid_schema" | "invalid_scope" | "secret_detected" | "capacity_exceeded" | "duplicate_candidate" | "idempotency_mismatch";
type UpdateError = "not_found" | "invalid_state" | "invalid_schema" | "secret_detected" | "capacity_exceeded" | "stale_revision" | "idempotency_mismatch";
type SupersedeError = RememberError | "not_found" | "invalid_state";
type ForgetError = "not_found" | "idempotency_mismatch";

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
    // Stage 14 PR-B2 (spec § 5.6): when the caller provides
    // an idempotency_key, check the mutation_requests table
    // for a prior result. Same key + same body replays the
    // original outcome (the agent's retried request after a
    // network blip). Same key + different body surfaces
    // idempotency_mismatch so the caller can detect a
    // client-side bug.
    const idempotency = this.checkIdempotency<RememberResult>(
      input,
      "remember",
      ctx
    );
    if (idempotency.kind === "replay") return ok(idempotency.result);
    if (idempotency.kind === "rejected") {
      return err("idempotency_mismatch", "idempotency_key was reused with a different request body", {
        key: input.idempotency_key
      });
    }
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
    const result = this.ctx.store.transaction(() =>
      this.commitPreparedRemember(prepared.value, suppressed, ctx)
    );
    this.recordIdempotencyIfSet(input, result, ctx);
    return ok(result);
  }

  updateMemory(
    id: string,
    input: UpdateInput,
    ctx?: RequestContext
  ): Result<{ memory_id: string }, UpdateError> {
    // Stage 14 PR-B2 (spec § 5.6): idempotency replay /
    // mismatch check before any state change. Same key + same
    // body replays the prior outcome; same key + different
    // body surfaces idempotency_mismatch.
    const idempotency = this.checkIdempotency<{ memory_id: string }>(
      input,
      "update_memory",
      ctx
    );
    if (idempotency.kind === "replay") return ok(idempotency.result);
    if (idempotency.kind === "rejected") {
      return err("idempotency_mismatch", "idempotency_key was reused with a different request body", {
        key: input.idempotency_key
      });
    }
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
    // Stage 14 PR-B2 (spec § 6.5): every mutation that goes
    // through this service emits a `memory_revisions` row.
    const actor = ctx?.actor_id ?? this.ctx.defaultActor;
    const requestId = ctx?.request_id;
    const revisionContext = {
      changed_by: actor,
      ...(requestId !== undefined ? { request_id: requestId } : {}),
      change_reason: event
    };
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
        expected,
        revisionContext
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
      const result = { memory_id: id };
      this.recordIdempotencyIfSet(input, result, ctx);
      return ok(result);
    }
    const result = this.ctx.store.transaction(() => {
      this.ctx.store.updateEntry(id, patch as Parameters<SQLiteMemoryStore["updateEntry"]>[1], revisionContext);
      appendAudit(this.ctx.store, this.ctx.defaultActor, {
        memory_id: id,
        scope: current.scope,
        ...(current.project_id !== undefined ? { project_id: current.project_id } : {}),
        event,
        metadata: { fields: Object.keys(validated.value).sort() }
      }, ctx);
      return { memory_id: id };
    });
    this.recordIdempotencyIfSet(input, result, ctx);
    return ok(result);
  }

  supersedeMemory(input: {
    old_memory_ids: string[];
    replacement: RememberInput;
    reason: string;
    idempotency_key?: string;
  }, ctx?: RequestContext): Result<{ memory_id: string }, SupersedeError> {
    // Stage 14 PR-B2 (spec § 5.6): top-level idempotency check
    // on the supersede operation as a whole. The replacement's
    // own `idempotency_key` is the per-row key inside the
    // `mutation_requests` cache; the top-level key guards
    // against a network retry re-running the whole multi-row
    // transaction (which would otherwise create a second
    // replacement entry).
    const idempotency = this.checkIdempotency<{ memory_id: string }>(
      input as { idempotency_key?: string },
      "supersede",
      ctx
    );
    if (idempotency.kind === "replay") return ok(idempotency.result);
    if (idempotency.kind === "rejected") {
      return err("idempotency_mismatch", "idempotency_key was reused with a different request body", {
        key: input.idempotency_key
      });
    }
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

    const actor = ctx?.actor_id ?? this.ctx.defaultActor;
    const requestId = ctx?.request_id;
    const result = this.ctx.store.transaction(() => {
      const created = this.commitPreparedRemember(prepared, undefined, ctx);
      for (const old of oldEntries) {
        this.ctx.store.updateEntry(old.id, {
          status: "superseded",
          superseded_by: created.memory_id,
          updated_at: nowIso()
        }, {
          changed_by: actor,
          ...(requestId !== undefined ? { request_id: requestId } : {}),
          change_reason: "supersede"
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
      return { memory_id: created.memory_id };
    });
    this.recordIdempotencyIfSet(input as { idempotency_key?: string }, result, ctx);
    return ok(result);
  }

  mergeMemories(input: {
    old_memory_ids: string[];
    replacement: RememberInput;
    reason: string;
    strategy?: "keep_first" | "keep_newest";
    idempotency_key?: string;
  }, ctx?: RequestContext): Result<{ memory_id: string; merged_from?: string[] }, SupersedeError> {
    // Stage 14 PR-B2 (spec § 5.6): top-level idempotency on
    // the merge op. See `supersedeMemory` for the rationale.
    const idempotency = this.checkIdempotency<{ memory_id: string; merged_from?: string[] }>(
      input as { idempotency_key?: string },
      "merge",
      ctx
    );
    if (idempotency.kind === "replay") return ok(idempotency.result);
    if (idempotency.kind === "rejected") {
      return err("idempotency_mismatch", "idempotency_key was reused with a different request body", {
        key: input.idempotency_key
      });
    }
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

    const actor = ctx?.actor_id ?? this.ctx.defaultActor;
    const requestId = ctx?.request_id;
    const result = this.ctx.store.transaction(() => {
      const created = this.commitPreparedRemember(prepared, undefined, ctx);
      for (const old of oldEntries) {
        this.ctx.store.updateEntry(old.id, {
          status: "superseded",
          superseded_by: created.memory_id,
          updated_at: nowIso()
        }, {
          changed_by: actor,
          ...(requestId !== undefined ? { request_id: requestId } : {}),
          change_reason: "merge"
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
      return {
        memory_id: created.memory_id,
        merged_from: oldEntries.map((e) => e.id).sort()
      };
    });
    this.recordIdempotencyIfSet(input as { idempotency_key?: string }, result, ctx);
    return ok(result);
  }

  forgetMemory(
    id: string,
    reason: string,
    ctx?: RequestContext,
    options?: { idempotency_key?: string; expected_revision?: number }
  ): Result<{ memory_id: string; released_chars: number }, ForgetError> {
    // Stage 14 PR-B2 (spec § 5.6): top-level idempotency on
    // forget. CAS (expected_revision) is supported via the
    // store's `updateEntryWithRevision` so two agents
    // simultaneously forgetting the same entry see one win
    // and the other get `not_found` (the row's status is
    // already `forgotten` by the time the second writer
    // peeks, so the re-peeked entry is filtered out by the
    // CAS guard in the store).
    const idempotencyInput: { idempotency_key?: string } =
      options?.idempotency_key !== undefined
        ? { idempotency_key: options.idempotency_key }
        : {};
    const idempotency = this.checkIdempotency<{ memory_id: string; released_chars: number }>(
      idempotencyInput,
      "forget",
      ctx
    );
    if (idempotency.kind === "replay") return ok(idempotency.result);
    if (idempotency.kind === "rejected") {
      return err("idempotency_mismatch", "idempotency_key was reused with a different request body", {
        key: options?.idempotency_key
      });
    }
    const current = this.ctx.store.peekEntry(id);
    if (current === undefined) {
      return err("not_found", "memory not found");
    }
    const released_chars = current.status === "active" ? current.char_count : 0;
    const actor = ctx?.actor_id ?? this.ctx.defaultActor;
    const requestId = ctx?.request_id;
    const revisionContext = {
      changed_by: actor,
      ...(requestId !== undefined ? { request_id: requestId } : {}),
      change_reason: reason
    };
    let casMissed = false;
    const apply = (): { memory_id: string; released_chars: number } | undefined => {
      if (options?.expected_revision !== undefined) {
        const applied = this.ctx.store.updateEntryWithRevision(
          id,
          {
            status: "forgotten",
            body: "",
            tags: [],
            char_count: 0,
            token_estimate: 0,
            updated_at: nowIso()
          },
          options.expected_revision,
          revisionContext
        );
        if (!applied) {
          casMissed = true;
          return undefined;
        }
      } else {
        this.ctx.store.updateEntry(
          id,
          {
            status: "forgotten",
            body: "",
            tags: [],
            char_count: 0,
            token_estimate: 0,
            updated_at: nowIso()
          },
          revisionContext
        );
      }
      appendAudit(this.ctx.store, this.ctx.defaultActor, {
        memory_id: id,
        scope: current.scope,
        ...(current.project_id !== undefined ? { project_id: current.project_id } : {}),
        event: "forgotten",
        reason,
        metadata: { released_chars }
      }, ctx);
      return { memory_id: id, released_chars };
    };
    const txnResult = this.ctx.store.transaction(apply);
    if (casMissed) {
      return err("not_found", "memory not found", {
        memory_id: id,
        expected_revision: options?.expected_revision
      });
    }
    if (txnResult === undefined) {
      // Unreachable in practice — `apply` only returns
      // undefined when CAS misses, which sets
      // `casMissed` and returns early above. The guard
      // keeps TypeScript happy.
      return err("not_found", "memory not found", { memory_id: id });
    }
    this.recordIdempotencyIfSet(idempotencyInput, txnResult, ctx);
    return ok(txnResult);
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
      // Stage 15 PR-M1-2: the resolver may now surface
      // `project_identity_conflict`. The remember
      // contract accepts the new error code so the
      // cross-project write is refused at the entry
      // point.
      if (auditRejections) auditRejected(this.ctx.store, this.ctx.defaultActor, input, resolved.error, resolved.details, ctx);
      return resolved as Result<ResolvedRemember, RememberError>;
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
    // Stage 14 PR-B2 (spec § 6.5): record the pre-image as
    // the first revision row so the audit chain has a
    // "from nothing" baseline. We use a no-op pre-image
    // (only `id` and `revision: 0`) since this is the
    // creation event; downstream `update` / `supersede` /
    // `merge` / `forget` writes will append real pre-images
    // on the actual row revisions.
    this.ctx.store.insertEntry(entry);
    this.ctx.store.recordRevisionForCreate?.(entry.id, writer, ctx?.request_id);
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
        confidence: entry.confidence,
        // Stage 14 PR-C (spec § 9.1 audit_revision_gap):
        // every mutation event must carry the post-image
        // revision in its metadata so the audit consumer
        // can correlate the event with the matching
        // `memory_revisions` row.
        revision: entry.revision
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

  /**
   * Stage 14 PR-B2 (spec § 5.6): idempotency check for a
   * mutating method. Returns a discriminated union:
   *   - `{ kind: "fresh" }` — no prior result, the caller
   *     should run the mutation and call
   *     `recordIdempotencyIfSet` on success.
   *   - `{ kind: "replay", result }` — same key + same body
   *     was seen before, return the stored result without
   *     re-running the mutation.
   *   - `{ kind: "rejected" }` — same key with a different
   *     body, surface as `idempotency_mismatch`.
   */
  private checkIdempotency<T>(
    input: { idempotency_key?: string },
    toolName: string,
    ctx?: RequestContext
  ): { kind: "fresh" } | { kind: "replay"; result: T } | { kind: "rejected" } {
    const key = input.idempotency_key;
    if (key === undefined) {
      return { kind: "fresh" };
    }
    const actor = ctx?.actor_id ?? this.ctx.defaultActor;
    // Hash the body WITHOUT the idempotency_key itself so a
    // retry with the same body but a different key (or no
    // key) still produces a consistent fingerprint.
    const { idempotency_key: _ignored, ...body } = input as { idempotency_key?: string } & Record<string, unknown>;
    const hash = hashRequest(body);
    const hit = lookupIdempotency<T>(this.ctx.store, actor, key, hash);
    if (hit.kind === "replay") {
      return { kind: "replay", result: hit.result };
    }
    if (hit.kind === "rejected") {
      return { kind: "rejected" };
    }
    return { kind: "fresh" };
  }

  /**
   * Stage 14 PR-B2: persist the mutation result under the
   * caller's idempotency key. No-op when the caller did not
   * supply a key. The hash is recomputed from the body so
   * the stored row matches what the lookup would compare
   * against on the next retry.
   */
  private recordIdempotencyIfSet(
    input: { idempotency_key?: string },
    result: unknown,
    ctx?: RequestContext
  ): void {
    const key = input.idempotency_key;
    if (key === undefined) return;
    const actor = ctx?.actor_id ?? this.ctx.defaultActor;
    const { idempotency_key: _ignored, ...body } = input as { idempotency_key?: string } & Record<string, unknown>;
    const hash = hashRequest(body);
    recordIdempotency(this.ctx.store, actor, key, hash, result);
  }
}
