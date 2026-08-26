// src/loadouts/service.ts
//
// v1.2.0-alpha.2 (issue #52): the agent loadout
// service. The contract is documented in the
// `docs/adr/0009-derivation-job-lifecycle.md` style
// block; the short version:
//
//   1. `create(input)`        -- append a new loadout
//                                row at `version: 1`,
//                                `lifecycle_state: 'draft'`.
//   2. `updateRules(...)`     -- CAS-update the rules;
//                                must read current
//                                `version`, then in a
//                                single transaction
//                                insert new `loadout_rules`
//                                rows with
//                                `version = current + 1` and
//                                bump `agent_loadouts.version`.
//                                Concurrent updates throw
//                                `cas_mismatch`.
//   3. `bind(input) / unbind(binding_id)` -- attach /
//                                detach a binding row.
//   4. `resolve(...)`         -- 5-step precedence lookup
//                                returning the matched
//                                `LoadoutRow` + `LoadoutRuleRow[]`
//                                for the caller (the
//                                context-assembly service
//                                is a pure module; it
//                                consumes the result of
//                                `resolve`).
//
// The service is a thin wrapper over the new
// `SQLiteMemoryStore` methods (`insertLoadout`,
// `getLoadout`, `listLoadouts`, `insertLoadoutRule`,
// `updateLoadoutVersion`, `insertLoadoutBinding`,
// `removeLoadoutBinding`, `resolveLoadout`).
// All multi-statement transitions are wrapped in a
// single `BEGIN IMMEDIATE` transaction so the
// rule-update lifecycle is consistent across crash
// boundaries.

import { createHash, randomUUID } from "node:crypto";

import type {
  LoadoutBindingRow,
  LoadoutChannel,
  LoadoutLifecycleState,
  LoadoutOrderingPolicy,
  LoadoutRow,
  LoadoutRuleRow,
  LoadoutScope,
  LoadoutTier,
  SQLiteMemoryStore
} from "../sqlite-store.js";
import { nowIso } from "../domain.js";

/**
 * Stable error codes the CLI / MCP / runner can
 * surface on the wire. Each code is intentionally
 * machine-readable; human-readable text belongs on
 * stderr or in the `explanation` array of the
 * assembled context payload.
 */
export type LoadoutErrorCode =
  | "loadout_not_found"
  | "cas_mismatch"
  | "binding_ambiguous"
  | "invalid_scope"
  | "project_id_required"
  | "project_id_must_be_null"
  | "duplicate_loadout"
  | "duplicate_binding";

/**
 * Caller-supplied input for `create`. `name`,
 * `scope`, and `created_by_actor_id` are required.
 * `match_actor_id` / `match_client_name` /
 * `task_mode` are the binding match attributes that
 * the resolve path will key on. `version` is
 * always 1 (the service mints it) and
 * `lifecycle_state` is always `draft` (the operator
 * promotes to `active` via a separate verb that
 * Phase 2 does not yet ship).
 */
export type CreateLoadoutInput = {
  name: string;
  scope: LoadoutScope;
  project_id?: string;
  match_actor_id?: string;
  match_client_name?: string;
  task_mode?: string;
  created_by_actor_id: string;
};

/**
 * Per-channel rule patch. The full set of fields
 * is replaced on update; the service does not
 * merge partial updates (the rule row is keyed on
 * `(loadout_id, version, channel)` so a "patch" is
 * a new immutable row at `version + 1`).
 */
export type LoadoutRulePatch = {
  channel: LoadoutChannel;
  include_asset_ids?: string[];
  include_memory_ids?: string[];
  include_types?: string[];
  include_tiers?: LoadoutTier[];
  include_tags?: string[];
  include_topics?: string[];
  exclude_asset_ids?: string[];
  exclude_memory_ids?: string[];
  exclude_tags?: string[];
  required_refs?: string[];
  max_items?: number;
  max_chars?: number;
  max_tokens?: number | null;
  timeout_ms?: number;
  ordering_policy?: LoadoutOrderingPolicy;
};

/**
 * Caller-supplied input for `bind`. The four match
 * columns are nullable: a `NULL` value means
 * "any value" (the binding matches every caller's
 * `actor_id` when `actor_id` is unset, etc.). The
 * `priority` is the tie-breaker within a single
 * precedence level; ties surface as
 * `binding_ambiguous` (fail-closed).
 */
export type BindInput = {
  loadout_id: string;
  actor_id?: string;
  client_name?: string;
  project_id?: string;
  task_mode?: string;
  priority?: number;
};

/**
 * The result of `resolve`. `binding` is the matched
 * binding row (NULL only when the resolved loadout
 * is the built-in `legacy-inject-all-active`
 * fallback). `loadout` is the canonical
 * `LoadoutRow`; `rules` is the per-channel set
 * already projected to the loadout's current
 * `version`. `matched_rule` is the precedence
 * level that won.
 */
export type ResolveResult = {
  loadout: LoadoutRow;
  rules: LoadoutRuleRow[];
  binding: LoadoutBindingRow | null;
  matched_rule:
    | "explicit_loadout_id"
    | "actor_project_task"
    | "actor_project"
    | "project_default"
    | "global_default"
    | "built_in_legacy_fallback";
};

export class LoadoutService {
  /**
   * Stable policy version stamped on every
   * context-assembly output. Bumped only when
   * the context-assembly policy itself changes
   * (e.g. new filter field, new channel rule).
   * Memory writes that do not affect the policy
   * MUST NOT bump this value (the
   * `bootstrap_hash stability` guarantee in spec).
   */
  static readonly POLICY_VERSION = "v1.2.0-alpha.2";

  /**
   * The canonical built-in fallback. Used when
   * the resolve path finds no matching binding.
   * The rules are empty (no `include_*` /
   * `exclude_*` filters), with a default 32-item
   * 8000-char budget, and an `all-active` material
   * set (the assembler reads every `active` memory
   * the caller is authorised to see). The
   * `loadout_id` is the well-known literal
   * `legacy-inject-all-active` so callers can
   * detect the fallback by id.
   */
  static readonly LEGACY_FALLBACK_LOADOUT_ID = "legacy-inject-all-active";

  constructor(private readonly store: SQLiteMemoryStore) {}

  /**
   * Create a new loadout. The row is inserted with
   * `version: 1`, `lifecycle_state: 'draft'`.
   * `scope === 'project'` requires a `project_id`;
   * `scope === 'global'` MUST have `project_id`
   * unset. Returns the freshly-minted loadout_id
   * (a UUID-shaped `loadout_<uuid>` token).
   */
  create(input: CreateLoadoutInput): string {
    if (input.scope === "project" && input.project_id === undefined) {
      throw loadoutError("project_id_required", "scope=project requires project_id");
    }
    if (input.scope === "global" && input.project_id !== undefined) {
      throw loadoutError("project_id_must_be_null", "scope=global must not carry project_id");
    }
    const loadoutId = `loadout_${randomUUID()}`;
    const now = nowIso();
    const row: LoadoutRow = {
      loadout_id: loadoutId,
      name: input.name,
      version: 1,
      lifecycle_state: "draft",
      match_actor_id: input.match_actor_id ?? null,
      match_client_name: input.match_client_name ?? null,
      scope: input.scope,
      project_id: input.project_id ?? null,
      task_mode: input.task_mode ?? null,
      created_by_actor_id: input.created_by_actor_id,
      created_at: now,
      updated_at: now
    };
    const inserted = this.store.insertLoadout(row);
    if (!inserted) {
      throw loadoutError("duplicate_loadout", `loadout ${loadoutId} already exists`);
    }
    return loadoutId;
  }

  /**
   * Read a single loadout. Returns the row, or
   * `undefined` when the id is unknown.
   */
  get(loadoutId: string): LoadoutRow | undefined {
    return this.store.getLoadout(loadoutId);
  }

  /**
   * List loadout rows with optional filters.
   */
  list(filter: {
    scope?: LoadoutScope;
    project_id?: string;
    lifecycle_state?: LoadoutLifecycleState;
    limit?: number;
  } = {}): LoadoutRow[] {
    return this.store.listLoadouts(filter);
  }

  /**
   * CAS-update the rules. The service reads the
   * current `version`, then in a single
   * `BEGIN IMMEDIATE` transaction:
   *
   *   1. inserts new `loadout_rules` rows at
   *      `version = current + 1` for every channel
   *      in the patch list
   *   2. bumps `agent_loadouts.version` to
   *      `current + 1`
   *
   * Concurrent updates between the read and the
   * transaction surface as `cas_mismatch` (the
   * store's `updateLoadoutVersion` predicate
   * matches zero rows). The caller can retry the
   * read + update sequence.
   *
   * When `expected_previous_version` is provided,
   * the CAS guard compares the read `version`
   * against that value (rather than the implicit
   * "any current version"); a mismatch throws
   * `cas_mismatch` immediately. The CLI uses this
   * to let operators pin a known-good version.
   *
   * The returned row carries the new `version`.
   */
  updateRules(
    loadoutId: string,
    patches: LoadoutRulePatch[],
    options?: { expected_previous_version?: number }
  ): LoadoutRow {
    if (patches.length === 0) {
      throw loadoutError("invalid_scope", "updateRules requires at least one channel patch");
    }
    const current = this.store.getLoadout(loadoutId);
    if (current === undefined) {
      throw loadoutError("loadout_not_found", `loadout ${loadoutId} not found`);
    }
    if (
      options?.expected_previous_version !== undefined &&
      current.version !== options.expected_previous_version
    ) {
      throw loadoutError(
        "cas_mismatch",
        `loadout ${loadoutId} version changed under us (expected ${options.expected_previous_version}, found ${current.version}); retry`
      );
    }
    const newVersion = current.version + 1;
    const now = nowIso();
    // The store's `updateLoadoutVersion` runs
    // its own BEGIN IMMEDIATE / COMMIT block.
    // We need the rule inserts to land in the
    // same transaction as the version bump;
    // `node:sqlite` does not support nested
    // transactions, so we open the transaction
    // here and call the underlying statements
    // directly through the store's `db` handle
    // (a small refactor vs. calling
    // `store.updateLoadoutVersion` from inside a
    // transaction). The CAS guard is preserved
    // by checking the affected row count.
    this.store.transaction(() => {
      for (const patch of patches) {
        const rule: LoadoutRuleRow = {
          loadout_id: loadoutId,
          version: newVersion,
          channel: patch.channel,
          include_asset_ids: patch.include_asset_ids ?? [],
          include_memory_ids: patch.include_memory_ids ?? [],
          include_types: patch.include_types ?? [],
          include_tiers: patch.include_tiers ?? [],
          include_tags: patch.include_tags ?? [],
          include_topics: patch.include_topics ?? [],
          exclude_asset_ids: patch.exclude_asset_ids ?? [],
          exclude_memory_ids: patch.exclude_memory_ids ?? [],
          exclude_tags: patch.exclude_tags ?? [],
          required_refs: patch.required_refs ?? [],
          max_items: patch.max_items ?? 32,
          max_chars: patch.max_chars ?? 8000,
          max_tokens: patch.max_tokens ?? null,
          timeout_ms: patch.timeout_ms ?? 5000,
          ordering_policy: patch.ordering_policy ?? "rule_then_score"
        };
        this.store.insertLoadoutRule(rule);
      }
      // CAS-bump the version in the same
      // transaction. The store exposes a public
      // method that does this with its own
      // BEGIN/COMMIT; we re-implement the
      // CAS-equivalent here to keep the rule
      // inserts + version bump in one
      // transaction.
      const result = (this.store as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => { changes: number } } };
      }).db
        .prepare(
          `UPDATE agent_loadouts
              SET version = ?, updated_at = ?
            WHERE loadout_id = ?
              AND version = ?`
        )
        .run(newVersion, now, loadoutId, current.version);
      if (result.changes === 0) {
        // CAS mismatch: surface as the
        // `cas_mismatch` error code via the
        // `transaction` wrapper's ROLLBACK.
        throw loadoutError(
          "cas_mismatch",
          `loadout ${loadoutId} version changed under us (expected ${current.version}); retry`
        );
      }
    });
    const updated = this.store.getLoadout(loadoutId);
    if (updated === undefined) {
      throw loadoutError("loadout_not_found", `loadout ${loadoutId} not found after update`);
    }
    return updated;
  }

  /**
   * Attach a binding row. Returns the freshly-minted
   * `binding_id`. The `loadout_version` recorded on
   * the binding is the loadout's head at the time of
   * the call; the resolver re-pins the version when
   * the binding matches a resolve call (the rules
   * for the current head `version` are the
   * canonical surface).
   */
  bind(input: BindInput): string {
    const loadout = this.store.getLoadout(input.loadout_id);
    if (loadout === undefined) {
      throw loadoutError("loadout_not_found", `loadout ${input.loadout_id} not found`);
    }
    const bindingId = `binding_${randomUUID()}`;
    const row: LoadoutBindingRow = {
      binding_id: bindingId,
      loadout_id: input.loadout_id,
      loadout_version: loadout.version,
      actor_id: input.actor_id ?? null,
      client_name: input.client_name ?? null,
      project_id: input.project_id ?? null,
      task_mode: input.task_mode ?? null,
      priority: input.priority ?? 0,
      created_at: nowIso()
    };
    const inserted = this.store.insertLoadoutBinding(row);
    if (!inserted) {
      throw loadoutError("duplicate_binding", `binding ${bindingId} already exists`);
    }
    return bindingId;
  }

  /**
   * Remove a binding. Returns `true` when the
   * binding was removed, `false` when the id is
   * unknown (idempotent no-op for re-issued unbinds).
   */
  unbind(bindingId: string): boolean {
    return this.store.removeLoadoutBinding(bindingId);
  }

  /**
   * Resolve the loadout for the given call tuple.
   * The precedence is locked:
   *
   *   1. `explicit_loadout_id` (when `explicit_loadout_id`
   *      is supplied and points at an active loadout)
   *   2. `(actor + project + task_mode)` max priority
   *   3. `(actor + project)` max priority
   *   4. project default
   *   5. global default
   *   6. built-in `legacy-inject-all-active` fallback
   *      (always succeeds)
   *
   * Same priority multiple bindings throw
   * `binding_ambiguous` (fail-closed).
   */
  resolve(input: {
    actor_id?: string;
    client_name?: string;
    project_id?: string;
    task_mode?: string;
    explicit_loadout_id?: string;
  }): ResolveResult {
    if (input.explicit_loadout_id !== undefined) {
      const explicit = this.store.getLoadout(input.explicit_loadout_id);
      if (explicit !== undefined && explicit.lifecycle_state === "active") {
        const ruleRows = this.getRulesForHead(explicit);
        return {
          loadout: explicit,
          rules: ruleRows,
          binding: null,
          matched_rule: "explicit_loadout_id"
        };
      }
    }
    const resolved = this.store.resolveLoadout({
      ...(input.actor_id !== undefined ? { actor_id: input.actor_id } : {}),
      ...(input.client_name !== undefined ? { client_name: input.client_name } : {}),
      ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
      ...(input.task_mode !== undefined ? { task_mode: input.task_mode } : {})
    });
    if (resolved === undefined) {
      return this.legacyFallback();
    }
    return {
      loadout: resolved.loadout,
      rules: resolved.rules,
      binding: resolved.binding,
      matched_rule: resolved.matched_rule
    };
  }

  /**
   * The built-in `legacy-inject-all-active` row. The
   * assembler treats this row as "no filters" and
   * injects every `active` memory the caller is
   * authorised to see, capped at 32 items / 8000
   * chars. The row is synthesised in-memory; nothing
   * is written to the database.
   */
  private legacyFallback(): ResolveResult {
    const now = nowIso();
    const channels: LoadoutChannel[] = ["bootstrap", "query", "tool_only"];
    const rules: LoadoutRuleRow[] = channels.map((channel) => ({
      loadout_id: LoadoutService.LEGACY_FALLBACK_LOADOUT_ID,
      version: 1,
      channel,
      include_asset_ids: [],
      include_memory_ids: [],
      include_types: [],
      include_tiers: [],
      include_tags: [],
      include_topics: [],
      exclude_asset_ids: [],
      exclude_memory_ids: [],
      exclude_tags: [],
      required_refs: [],
      max_items: 32,
      max_chars: 8000,
      max_tokens: null,
      timeout_ms: 5000,
      ordering_policy: "rule_then_score"
    }));
    const loadout: LoadoutRow = {
      loadout_id: LoadoutService.LEGACY_FALLBACK_LOADOUT_ID,
      name: "Built-in legacy fallback (legacy-inject-all-active)",
      version: 1,
      lifecycle_state: "active",
      match_actor_id: null,
      match_client_name: null,
      scope: "global",
      project_id: null,
      task_mode: null,
      created_by_actor_id: "system",
      created_at: now,
      updated_at: now
    };
    return {
      loadout,
      rules,
      binding: null,
      matched_rule: "built_in_legacy_fallback"
    };
  }

  private getRulesForHead(loadout: LoadoutRow): LoadoutRuleRow[] {
    return this.store.loadoutRulesForVersion(loadout.loadout_id, loadout.version);
  }
}

/**
 * Internal helper to mint a `LoadoutError` with a
 * stable error code on `code`, a human-readable
 * `message`, and a `details` object for the wire.
 */
function loadoutError(
  code: LoadoutErrorCode,
  message: string,
  details?: Record<string, unknown>
): Error {
  const err = new Error(message) as Error & {
    code: LoadoutErrorCode;
    details?: Record<string, unknown>;
  };
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

/**
 * SHA-256 over a canonical byte sequence. Used by
 * the context-assembly service to compute
 * `channel.hash` and `bootstrap_hash`; re-exported
 * here so the loadout service can produce stable
 * `policy_version`-tagged hashes for the resource
 * layer.
 */
export function sha256Hex(input: string): string {
  return "sha256:" + createHash("sha256").update(input, "utf8").digest("hex");
}
