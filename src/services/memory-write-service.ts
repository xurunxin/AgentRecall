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

import { randomUUID } from "node:crypto";
import { nowIso, err, ok, type MemoryEntry, type MemoryBudget, type MemoryScope, type ProjectScope, type Result } from "../domain.js";
import type { SQLiteMemoryStore } from "../sqlite-store.js";
import {
  type RememberInput,
  type UpdateInput,
  type ValidatedRememberInput,
  type MemorySensitivity,
  type MemoryTrustLevel,
  validateRememberInput,
  validateUpdateInput
} from "../write-validator.js";
import { resolveMemoryScope, type ProjectIdentityResolver } from "../scope-resolver.js";
import { computeEntrySize, createMemoryId } from "../domain.js";
import type { RequestContext } from "../request-context.js";
import {
  hashRequest,
  runWithIdempotentMutation,
  tryReplayOnly
} from "./idempotency.js";
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
import {
  CapabilityStore,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type CapabilityRecord
} from "../admin/capability.js";

type RememberError = "invalid_schema" | "invalid_scope" | "invalid_state" | "secret_detected" | "unauthorized" | "capacity_exceeded" | "duplicate_candidate" | "idempotency_mismatch" | "idempotency_in_flight";
type UpdateError = "not_found" | "invalid_state" | "invalid_schema" | "secret_detected" | "unauthorized" | "capacity_exceeded" | "stale_revision" | "idempotency_mismatch" | "idempotency_in_flight";
type SupersedeError = RememberError | "not_found" | "invalid_state";
type MergeError = RememberError | "not_found" | "invalid_state";
type ForgetError = "not_found" | "idempotency_mismatch" | "idempotency_in_flight";

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
  /**
   * Stage 16 v1.1.1 PR-2 (#14): the project identity
   * resolver. Write paths use `register` mode; a
   * `project_path` may create a new identity, but
   * `project_id`-only calls must resolve an existing
   * identity (no implicit identity creation from an
   * id alone).
   */
  identityResolver: ProjectIdentityResolver;
  /**
   * Stage 18 v1.1.2 (issue #23, ADR-0001): the
   * operator capability store. The write service
   * calls `authorize(...)` on the
   * `trust_promotion` and `sensitivity_restricted`
   * capability types before accepting a privileged
   * write. The default (when this is omitted) is a
   * fail-closed store that always denies.
   */
  capabilityStore?: CapabilityStore | { authorize(input: AuthorizationRequest): AuthorizationDecision };
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

  /**
   * Stage 18 v1.1.2 (issue #23, ADR-0001):
   * `CapabilityStore` is the single source of truth
   * for trust / sensitivity authorization. The write
   * service consults the store whenever a privileged
   * transition is requested. The function fails
   * closed when the store is missing or denies.
   */
  private authorizeCapability(
    capabilityType: "trust_promotion" | "sensitivity_restricted",
    capability: string | undefined,
    ctx: RequestContext | undefined
  ): { ok: true } | { ok: false; reason: string; message: string; capability_type: string } {
    const store = this.ctx.capabilityStore;
    if (store === undefined) {
      return {
        ok: false,
        reason: "capability_missing",
        message: `${capabilityType} requires a CapabilityStore (admin profile not active)`,
        capability_type: capabilityType
      };
    }
    if (capability === undefined) {
      return {
        ok: false,
        reason: "capability_missing",
        message: `${capabilityType} requires a capability token on the request`,
        capability_type: capabilityType
      };
    }
    const decision = store.authorize({
      capability,
      capability_type: capabilityType,
      requestContext: ctx ?? buildEmptyRequestContext()
    });
    if (decision.ok) return { ok: true };
    return {
      ok: false,
      reason: decision.reason,
      message: authorizationDenialMessage(decision.reason, capabilityType),
      capability_type: capabilityType
    };
  }

  /**
   * Stage 18 v1.1.2 (issue #23, ADR-0001): the
   * privileged write gate. Returns `{ ok: true }`
   * when the request does NOT require authorization
   * OR when the supplied capability token matches
   * the on-disk store. Returns a structured
   * `unauthorized` decision otherwise. The gate is
   * the single source of truth for the two
   * privileged transitions; the validator does
   * NOT consult the gate.
   */
  private checkPrivilegedWriteAuthorization(
    input: { trust_level: MemoryTrustLevel | undefined; sensitivity: MemorySensitivity | undefined; capability: string | undefined },
    ctx: RequestContext | undefined
  ): { ok: true } | { ok: false; reason: string; message: string; capability_type: string } {
    const trustRequiresAuth = input.trust_level === "user_confirmed";
    const sensitivityRequiresAuth = input.sensitivity === "restricted";
    if (!trustRequiresAuth && !sensitivityRequiresAuth) {
      return { ok: true };
    }
    // Trust promotion takes priority over the
    // sensitivity escalation when both are
    // requested. The error message names the
    // actual operation the caller is performing.
    if (trustRequiresAuth) {
      return this.authorizeCapability("trust_promotion", input.capability, ctx);
    }
    return this.authorizeCapability("sensitivity_restricted", input.capability, ctx);
  }

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
    // v1.1.2 (issue #21): `configureProjectBudget` is
    // the canonical "register a project" call. It MUST
    // also create the corresponding `project_identities`
    // row so the strict resolver (`strict_existing` /
    // `register` mode) finds the identity and refuses
    // cross-project writes. Pre-v1.1.2 the v1.0
    // `project_scopes` table was the only place a
    // project was registered; the v1.1.2 contract
    // promotes `project_identities` to the source of
    // truth for the `(project_id, canonical_path)`
    // binding. `createProjectIdentity` is `INSERT OR
    // IGNORE` on `(project_id)`, so a re-register with
    // the same triple is a no-op; a re-register with a
    // different `canonical_path` is left untouched (the
    // existing row is the canonical binding; a path
    // change is a new alias, not a re-registration).
    this.ctx.store.createProjectIdentity({
      project_id,
      canonical_path,
      created_by: this.ctx.defaultActor,
      created_at: existing !== undefined ? existing.created_at : now
    });
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
   *
   * Stage 18 v1.1.2 (issue #26, task 7): the optional
   * `importLineage` argument threads the batch_id +
   * canonical bundle hash onto the audit event's
   * metadata so a reviewer can trace the row back to
   * the exact bundle / batch that produced it. The
   * keys (`import_batch_id`, `bundle_hash`) are the
   * documented lineage surface — see
   * `test/release-gate/p3-import-batch-lineage.test.ts`.
   */
  insertImportedEntry(
    entry: MemoryEntry,
    actor: string,
    importLineage?: { import_batch_id: string; bundle_hash: string; bundle_version: number }
  ): void {
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
        source_revision: entry.revision,
        ...(importLineage !== undefined
          ? {
              import_batch_id: importLineage.import_batch_id,
              bundle_hash: importLineage.bundle_hash,
              bundle_version: importLineage.bundle_version
            }
          : {})
      }
    });
  }

  remember(input: RememberInput, ctx?: RequestContext): Result<RememberResult, RememberError> {
    // Stage 16 v1.1.1 PR-3 (#10): the v2 reservation
    // happens FIRST, before any business work. A
    // `replay` short-circuits before `prepareRemember`
    // (no budget check, no duplicate scan, no DB
    // reads); a `rejected` short-circuits with
    // `idempotency_mismatch` before any other
    // validation. The fresh path runs the full
    // validation + commit inside the same
    // transaction as the v2 row.
    if (input.idempotency_key !== undefined) {
      // Stage 16 v1.1.1 PR-3 (#10): canonical operation
      // payload is the `RememberInput` minus the
      // idempotency key itself.
      const { idempotency_key: _key, ...body } = input;
      const requestHash = hashRequest(body);
      const actor = ctx?.actor_id ?? this.ctx.defaultActor;
      const requestId = ctx?.request_id ?? randomUUID();
      const earlyReplay = tryReplayOnly<Result<RememberResult, RememberError>>(
        this.ctx.store,
        { actor, tool: "remember", key: input.idempotency_key, requestHash, requestId }
      );
      if (earlyReplay.kind === "replay") {
        return earlyReplay.result;
      }
      if (earlyReplay.kind === "rejected") {
        return err(
          "idempotency_mismatch",
          "idempotency_key was reused with a different request body",
          { key: input.idempotency_key }
        );
      }
      if (earlyReplay.kind === "in_flight") {
        return err(
          "idempotency_in_flight",
          "a previous attempt reserved this key but did not complete; retry shortly",
          { key: input.idempotency_key }
        );
      }
      // `fresh` — fall through to the v2-in-transaction
      // helper below.
    }
    // Stage 18 v1.1.2 (issue #23, ADR-0001):
    // trust / sensitivity authorization gate. The
    // validator no longer enforces the
    // `user_confirmed: true` flag; the
    // `CapabilityStore.authorize(...)` call is
    // the only thing that authorises a privileged
    // write. The check runs BEFORE the resolver
    // and the budget evaluation so a denied
    // privileged call cannot burn an idempotency
    // reservation. The denial is audited under
    // the `write_rejected` event so the actor /
    // request_id / reason are visible.
    const capDecision = this.checkPrivilegedWriteAuthorization(
      {
        trust_level: input.trust_level,
        sensitivity: input.sensitivity,
        capability: input.capability
      },
      ctx
    );
    if (!capDecision.ok) {
      auditRejected(this.ctx.store, this.ctx.defaultActor, input, "unauthorized", {
        reason: capDecision.reason,
        capability_type: capDecision.capability_type,
        previous: { trust_level: undefined, sensitivity: undefined },
        next: { trust_level: input.trust_level, sensitivity: input.sensitivity }
      }, ctx);
      return err("unauthorized", capDecision.message, {
        reason: capDecision.reason,
        capability_type: capDecision.capability_type
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
    if (input.idempotency_key === undefined) {
      return ok(
        this.ctx.store.transaction(() =>
          this.commitPreparedRemember(prepared.value, suppressed, ctx)
        )
      );
    }
    // Fresh path: reserve + work + complete, all in one
    // transaction.
    const { idempotency_key: _key, ...body } = input;
    const requestHash = hashRequest(body);
    const actor = ctx?.actor_id ?? this.ctx.defaultActor;
    const requestId = ctx?.request_id ?? randomUUID();
    return runWithIdempotentMutation<Result<RememberResult, RememberError>>(
      this.ctx.store,
      {
        actor,
        tool: "remember",
        key: input.idempotency_key,
        requestHash,
        requestId
      },
      (hit) => {
        if (hit.kind === "replay") {
          return hit.result;
        }
        if (hit.kind === "rejected") {
          return err(
            "idempotency_mismatch",
            "idempotency_key was reused with a different request body",
            { key: input.idempotency_key }
          );
        }
        if (hit.kind === "in_flight") {
          return err(
            "idempotency_in_flight",
            "a previous attempt reserved this key but did not complete; retry shortly",
            { key: input.idempotency_key }
          );
        }
        return ok(this.commitPreparedRemember(prepared.value, suppressed, ctx));
      }
    );
  }

  updateMemory(
    id: string,
    input: UpdateInput,
    ctx?: RequestContext,
    /**
     * Stage 18 v1.1.2 (issue #26, task 7): optional
     * import-lineage metadata threaded onto the
     * `updated` / `archived` audit event. The keys
     * (`import_batch_id`, `bundle_hash`,
     * `bundle_version`) are the documented lineage
     * surface; a missing arg keeps the legacy audit
     * shape (no lineage keys on the metadata) so a
     * non-import `updateMemory` call is unchanged.
     */
    importLineage?: { import_batch_id: string; bundle_hash: string; bundle_version: number }
  ): Result<{ memory_id: string }, UpdateError> {
    // Stage 16 v1.1.1 PR-3 (#10): every public mutation
    // uses the v2 reservation in the same transaction
    // as the business write. The v2 namespace is
    // `(actor_id, tool_name, idempotency_key)`; same
    // key across different tools does not collide.
    //
    // The canonical operation payload is
    // `{ memory_id, patch, expected_revision }`. The
    // patch is the post-validation patch (after
    // schema, status, and budget checks).
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

    // Stage 18 v1.1.2 (issue #23, ADR-0001): the
    // trust / sensitivity authorization gate for
    // updates. An update that escalates
    // `trust_level` to `user_confirmed` or
    // `sensitivity` to `restricted` requires the
    // operator capability. The previous
    // `trust_level` / `sensitivity` is captured so
    // the audit event records the transition.
    const capDecision = this.checkPrivilegedWriteAuthorization(
      {
        trust_level: validated.value.trust_level,
        sensitivity: validated.value.sensitivity,
        capability: validated.value.capability
      },
      ctx
    );
    if (!capDecision.ok) {
      auditRejectedForEntry(this.ctx.store, this.ctx.defaultActor, current, "unauthorized", {
        reason: capDecision.reason,
        capability_type: capDecision.capability_type,
        previous: { trust_level: current.trust_level, sensitivity: current.sensitivity },
        next: {
          trust_level: validated.value.trust_level ?? current.trust_level,
          sensitivity: validated.value.sensitivity ?? current.sensitivity
        }
      }, ctx);
      return err("unauthorized", capDecision.message, {
        reason: capDecision.reason,
        capability_type: capDecision.capability_type
      });
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

    // Run the actual update inside the v2 transaction.
    const runUpdate = (): Result<{ memory_id: string }, UpdateError> => {
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
          metadata: {
            fields: Object.keys(validated.value).sort(),
            ...(importLineage !== undefined
              ? {
                  import_batch_id: importLineage.import_batch_id,
                  bundle_hash: importLineage.bundle_hash,
                  bundle_version: importLineage.bundle_version
                }
              : {})
          }
        }, ctx);
        return ok({ memory_id: id });
      }
      this.ctx.store.updateEntry(id, patch as Parameters<SQLiteMemoryStore["updateEntry"]>[1], revisionContext);
      appendAudit(this.ctx.store, this.ctx.defaultActor, {
        memory_id: id,
        scope: current.scope,
        ...(current.project_id !== undefined ? { project_id: current.project_id } : {}),
        event,
        metadata: {
          fields: Object.keys(validated.value).sort(),
          ...(importLineage !== undefined
            ? {
                import_batch_id: importLineage.import_batch_id,
                bundle_hash: importLineage.bundle_hash,
                bundle_version: importLineage.bundle_version
              }
            : {})
        }
      }, ctx);
      return ok({ memory_id: id });
    };

    if (input.idempotency_key === undefined) {
      return this.ctx.store.transaction(runUpdate);
    }
    // Stage 16 v1.1.1 PR-3 (#10): canonical operation
    // payload for `update_memory` is
    // `{ memory_id, patch, expected_revision }`. The
    // `idempotency_key` itself is excluded from the
    // hash.
    const { idempotency_key: _key, ...rest } = input as { idempotency_key?: string } & Record<string, unknown>;
    const payload = {
      memory_id: id,
      patch: validated.value,
      ...(validated.value.expected_revision !== undefined ? { expected_revision: validated.value.expected_revision } : {})
    };
    const requestHash = hashRequest(payload);
    return runWithIdempotentMutation<Result<{ memory_id: string }, UpdateError>>(
      this.ctx.store,
      {
        actor,
        tool: "update_memory",
        key: input.idempotency_key,
        requestHash,
        requestId: requestId ?? randomUUID()
      },
      (hit) => {
        if (hit.kind === "replay") return hit.result;
        if (hit.kind === "rejected") {
          return err("idempotency_mismatch", "idempotency_key was reused with a different request body", {
            key: input.idempotency_key
          });
        }
        if (hit.kind === "in_flight") {
          return err(
            "idempotency_in_flight",
            "a previous attempt reserved this key but did not complete; retry shortly",
            { key: input.idempotency_key }
          );
        }
        return runUpdate();
      }
    );
    void rest;
  }

  supersedeMemory(input: {
    old_memory_ids: string[];
    replacement: RememberInput;
    reason: string;
    idempotency_key?: string;
  }, ctx?: RequestContext): Result<{ memory_id: string }, SupersedeError> {
    // Stage 16 v1.1.1 PR-3 (#10): v2 reservation in the
    // same transaction as the multi-row supersede
    // apply. The top-level key guards against a network
    // retry re-running the whole multi-row transaction
    // (which would otherwise create a second
    // replacement entry).
    //
    // The early probe MUST run before any business
    // check (status / scope / budget). Otherwise a
    // retry that lands after the first apply has
    // already superseded the old row would be
    // short-circuited with `invalid_state` instead
    // of replaying the original `ok` result.
    const oldIds = [...new Set(input.old_memory_ids)];
    if (input.idempotency_key !== undefined) {
      const probePayload = {
        old_ids: oldIds,
        replacement: input.replacement,
        reason: input.reason
      };
      const requestHash = hashRequest(probePayload);
      const actor = ctx?.actor_id ?? this.ctx.defaultActor;
      const requestId = ctx?.request_id ?? randomUUID();
      const earlyReplay = tryReplayOnly<Result<{ memory_id: string }, SupersedeError>>(
        this.ctx.store,
        { actor, tool: "supersede_memory", key: input.idempotency_key, requestHash, requestId }
      );
      if (earlyReplay.kind === "replay") return earlyReplay.result;
      if (earlyReplay.kind === "rejected") {
        return err("idempotency_mismatch", "idempotency_key was reused with a different request body", {
          key: input.idempotency_key
        });
      }
      if (earlyReplay.kind === "in_flight") {
        return err("idempotency_in_flight", "a previous attempt reserved this key but did not complete; retry shortly", {
          key: input.idempotency_key
        });
      }
      // `fresh` — fall through.
    }
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
    const runApply = (): Result<{ memory_id: string }, SupersedeError> => {
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
      return ok({ memory_id: created.memory_id });
    };

    if (input.idempotency_key === undefined) {
      return this.ctx.store.transaction(runApply);
    }
    // Stage 16 v1.1.1 PR-3 (#10): canonical payload for
    // `supersede_memory` is
    // `{ old_ids, replacement, reason }`. The
    // `idempotency_key` is excluded from the hash.
    const payload = {
      old_ids: oldIds,
      replacement: input.replacement,
      reason: input.reason
    };
    const requestHash = hashRequest(payload);
    return runWithIdempotentMutation<Result<{ memory_id: string }, SupersedeError>>(
      this.ctx.store,
      {
        actor,
        tool: "supersede_memory",
        key: input.idempotency_key,
        requestHash,
        requestId: requestId ?? randomUUID()
      },
      (hit) => {
        if (hit.kind === "replay") return hit.result;
        if (hit.kind === "rejected") {
          return err("idempotency_mismatch", "idempotency_key was reused with a different request body", {
            key: input.idempotency_key
          });
        }
        if (hit.kind === "in_flight") {
          return err(
            "idempotency_in_flight",
            "a previous attempt reserved this key but did not complete; retry shortly",
            { key: input.idempotency_key }
          );
        }
        return runApply();
      }
    );
  }

  mergeMemories(input: {
    old_memory_ids: string[];
    replacement: RememberInput;
    reason: string;
    strategy?: "keep_first" | "keep_newest";
    idempotency_key?: string;
  }, ctx?: RequestContext): Result<{ memory_id: string; merged_from?: string[] }, MergeError> {
    // Stage 16 v1.1.1 PR-3 (#10): v2 reservation in the
    // same transaction as the multi-row merge apply.
    //
    // Early-probe before any business check (count,
    // scope, status, budget). Otherwise a retry that
    // lands after the first apply has already merged
    // the old rows would be short-circuited with
    // `invalid_state` instead of replaying the
    // original `ok` result.
    const oldIds = [...new Set(input.old_memory_ids)];
    if (input.idempotency_key !== undefined) {
      const probePayload = {
        old_ids: oldIds,
        replacement: input.replacement,
        reason: input.reason,
        ...(input.strategy !== undefined ? { strategy: input.strategy } : {})
      };
      const requestHash = hashRequest(probePayload);
      const actor = ctx?.actor_id ?? this.ctx.defaultActor;
      const requestId = ctx?.request_id ?? randomUUID();
      const earlyReplay = tryReplayOnly<Result<{ memory_id: string; merged_from?: string[] }, MergeError>>(
        this.ctx.store,
        { actor, tool: "merge_memories", key: input.idempotency_key, requestHash, requestId }
      );
      if (earlyReplay.kind === "replay") return earlyReplay.result;
      if (earlyReplay.kind === "rejected") {
        return err("idempotency_mismatch", "idempotency_key was reused with a different request body", {
          key: input.idempotency_key
        });
      }
      if (earlyReplay.kind === "in_flight") {
        return err("idempotency_in_flight", "a previous attempt reserved this key but did not complete; retry shortly", {
          key: input.idempotency_key
        });
      }
      // `fresh` — fall through.
    }
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
    const runApply = (): Result<{ memory_id: string; merged_from?: string[] }, MergeError> => {
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
      return ok({
        memory_id: created.memory_id,
        merged_from: oldEntries.map((e) => e.id).sort()
      });
    };

    if (input.idempotency_key === undefined) {
      return this.ctx.store.transaction(runApply);
    }
    // Stage 16 v1.1.1 PR-3 (#10): canonical payload for
    // `merge_memories` is
    // `{ old_ids, replacement, reason, strategy }`.
    const payload = {
      old_ids: oldIds,
      replacement: input.replacement,
      reason: input.reason,
      ...(input.strategy !== undefined ? { strategy: input.strategy } : {})
    };
    const requestHash = hashRequest(payload);
    return runWithIdempotentMutation<Result<{ memory_id: string; merged_from?: string[] }, MergeError>>(
      this.ctx.store,
      {
        actor,
        tool: "merge_memories",
        key: input.idempotency_key,
        requestHash,
        requestId: requestId ?? randomUUID()
      },
      (hit) => {
        if (hit.kind === "replay") return hit.result;
        if (hit.kind === "rejected") {
          return err("idempotency_mismatch", "idempotency_key was reused with a different request body", {
            key: input.idempotency_key
          });
        }
        if (hit.kind === "in_flight") {
          return err(
            "idempotency_in_flight",
            "a previous attempt reserved this key but did not complete; retry shortly",
            { key: input.idempotency_key }
          );
        }
        return runApply();
      }
    );
  }

  forgetMemory(
    id: string,
    reason: string,
    ctx?: RequestContext,
    options?: { idempotency_key?: string; expected_revision?: number }
  ): Result<{ memory_id: string; released_chars: number }, ForgetError> {
    // Stage 16 v1.1.1 PR-3 (#10): v2 reservation in the
    // same transaction as the forget apply. The
    // canonical operation payload for `forget_memory`
    // is `{ memory_id, reason, expected_revision }` —
    // all three are part of the request hash so
    // re-using a key with a different memory_id,
    // reason, or expected_revision is rejected as
    // `idempotency_key_reuse` (`rejected`).
    //
    // Early-probe before any business check
    // (peekEntry, expected_revision CAS). A retry
    // that lands after the first apply has already
    // forgotten the row would otherwise be
    // short-circuited with `not_found` instead of
    // replaying the original `ok` result.
    if (options?.idempotency_key !== undefined) {
      const probePayload = {
        memory_id: id,
        reason,
        ...(options?.expected_revision !== undefined ? { expected_revision: options.expected_revision } : {})
      };
      const requestHash = hashRequest(probePayload);
      const actor = ctx?.actor_id ?? this.ctx.defaultActor;
      const requestId = ctx?.request_id ?? randomUUID();
      const earlyReplay = tryReplayOnly<Result<{ memory_id: string; released_chars: number }, ForgetError>>(
        this.ctx.store,
        { actor, tool: "forget_memory", key: options.idempotency_key, requestHash, requestId }
      );
      if (earlyReplay.kind === "replay") return earlyReplay.result;
      if (earlyReplay.kind === "rejected") {
        return err("idempotency_mismatch", "idempotency_key was reused with a different request body", {
          key: options.idempotency_key
        });
      }
      if (earlyReplay.kind === "in_flight") {
        return err("idempotency_in_flight", "a previous attempt reserved this key but did not complete; retry shortly", {
          key: options.idempotency_key
        });
      }
      // `fresh` — fall through.
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

    if (options?.idempotency_key === undefined) {
      const txnResult = this.ctx.store.transaction(apply);
      if (casMissed) {
        return err("not_found", "memory not found", {
          memory_id: id,
          expected_revision: options?.expected_revision
        });
      }
      if (txnResult === undefined) {
        return err("not_found", "memory not found", { memory_id: id });
      }
      return ok(txnResult);
    }

    // Stage 16 v1.1.1 PR-3 (#10): canonical payload for
    // `forget_memory` is
    // `{ memory_id, reason, expected_revision }`. The
    // `idempotency_key` is excluded.
    const payload = {
      memory_id: id,
      reason,
      ...(options?.expected_revision !== undefined ? { expected_revision: options.expected_revision } : {})
    };
    const requestHash = hashRequest(payload);
    const runApply = (): Result<{ memory_id: string; released_chars: number }, ForgetError> => {
      const txnResult = this.ctx.store.transaction(apply);
      if (casMissed) {
        return err("not_found", "memory not found", {
          memory_id: id,
          expected_revision: options?.expected_revision
        });
      }
      if (txnResult === undefined) {
        return err("not_found", "memory not found", { memory_id: id });
      }
      return ok(txnResult);
    };
    return runWithIdempotentMutation<Result<{ memory_id: string; released_chars: number }, ForgetError>>(
      this.ctx.store,
      {
        actor,
        tool: "forget_memory",
        key: options.idempotency_key,
        requestHash,
        requestId: requestId ?? randomUUID()
      },
      (hit) => {
        if (hit.kind === "replay") return hit.result;
        if (hit.kind === "rejected") {
          return err(
            "idempotency_mismatch",
            "idempotency_key was reused with a different request body",
            { key: options.idempotency_key }
          );
        }
        if (hit.kind === "in_flight") {
          return err(
            "idempotency_in_flight",
            "a previous attempt reserved this key but did not complete; retry shortly",
            { key: options.idempotency_key }
          );
        }
        return runApply();
      }
    );
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
    const resolved = this.ctx.identityResolver.resolve(validated.value, "register");
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
}

// ============================================================
// Stage 18 v1.1.2 (issue #23, ADR-0001) helpers.
// ============================================================

/**
 * Human-readable authorization denial
 * messages. The messages name the env var +
 * CLI command so an operator can recover
 * without reading the docs. The token value
 * is NEVER surfaced (the function takes
 * only the stable reason code).
 */
function authorizationDenialMessage(
  reason: string,
  capabilityType: "trust_promotion" | "sensitivity_restricted"
): string {
  const op =
    capabilityType === "trust_promotion"
      ? "trust promotion to user_confirmed"
      : "writing a memory with sensitivity=restricted";
  switch (reason) {
    case "capability_missing":
      return `${op} requires an operator capability; run \`agent-recall admin grant\` and supply the token on the request`;
    case "capability_malformed":
      return `the supplied capability token is malformed (expected 64 hex chars)`;
    case "permission_drift":
      return `the on-disk capability file no longer satisfies the owner-only permission contract; re-run \`agent-recall admin grant\``;
    case "token_mismatch":
      return `the supplied capability token does not match the on-disk token`;
    case "unsupported_capability_type":
      return `the requested capability type is not recognised`;
    default:
      return `${op} denied (${reason})`;
  }
}

/**
 * Build a placeholder `RequestContext` for
 * the case where the service is called
 * without one (legacy callers, the CLI
 * scripts). The `actor_id` is the
 * service's `defaultActor` so audit
 * attribution stays intact. The
 * `request_id` is a fresh UUID so audit
 * events emitted from the same call can be
 * tied to the same authorization decision.
 */
function buildEmptyRequestContext(): RequestContext {
  return {
    actor_id: "agent:unknown" as RequestContext["actor_id"],
    request_id: randomUUID()
  };
}
