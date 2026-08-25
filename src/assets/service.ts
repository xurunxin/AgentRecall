// src/assets/service.ts
//
// v1.2.0-alpha.1 (issue #51): the additive asset
// registry service. The public surface is a small
// set of verbs that map 1:1 to the CLI / MCP
// inspector:
//
//   createMemoryRef   -- append a `memory_ref` asset
//   appendMemoryRefVersion -- new version pointing
//                              at a different
//                              (memory_id, revision)
//   list              -- filter + cap
//   show              -- envelope + current head + payload
//   history           -- all version rows
//   activate / deprecate / archive -- lifecycle
//   delete            -- remove the envelope (cascade
//                        deletes versions + bindings)
//
// Phase 1 ships only the `memory_ref` type. The
// `skill` / `context_pack` / `external_reference`
// type-specific tables land with their owning
// Phase 2 issues (#53 / #54) and will plug in
// here as additional branches in the
// `appendXxxVersion` verbs.

import { createHash, randomUUID } from "node:crypto";

import type {
  AssetLifecycleState,
  AssetRow,
  AssetType,
  AssetVersionRow,
  MemoryRefBindingRow,
  SQLiteMemoryStore
} from "../sqlite-store.js";
import { nowIso } from "../domain.js";

export type MemoryRefCreateInput = {
  scope: "global" | "project";
  project_id?: string;
  owner_actor_id: string;
  trust_level: "user_confirmed" | "agent_observed" | "inferred";
  sensitivity: "normal" | "private" | "restricted";
  memory_id: string;
  memory_revision: number;
  binding_rule?: string;
  note?: string;
};

export type AssetInspection = {
  asset: AssetRow;
  current_version: AssetVersionRow | null;
  payload: MemoryRefBindingRow | null;
};

export type CreateResult = {
  asset_id: string;
  version: number;
  content_hash: string;
};

export type StableErrorCode =
  | "asset_not_found"
  | "asset_already_terminal"
  | "cas_mismatch"
  | "memory_ref_must_have_binding"
  | "binding_invalid";

export class AssetService {
  /**
   * Stable schema version stamped on every
   * `asset_versions.schema_version` row. Bumped
   * when the canonical payload shape changes.
   */
  static readonly ASSET_SCHEMA_VERSION = "1";

  constructor(private readonly store: SQLiteMemoryStore) {}

  /**
   * Create a new `memory_ref` asset. The first
   * version is appended atomically with the
   * envelope row; the binding points at the
   * `(memory_id, memory_revision)` tuple in the
   * authoritative `memory_entries` table.
   */
  createMemoryRef(input: MemoryRefCreateInput): CreateResult {
    if (input.scope === "project" && input.project_id === undefined) {
      throw bindingInvalid("scope=project requires project_id");
    }
    if (input.memory_id.length === 0 || input.memory_revision <= 0) {
      throw bindingInvalid("memory_id and memory_revision are required");
    }
    const now = nowIso();
    const asset_id = `asset_${randomUUID()}`;
    const content_hash = canonicalMemoryRefContentHash(input);
    const manifest = JSON.stringify({
      kind: "memory_ref",
      binding_rule: input.binding_rule ?? null,
      note: input.note ?? null
    });
    const envelope: AssetRow = {
      asset_id,
      asset_type: "memory_ref",
      scope: input.scope,
      project_id: input.project_id ?? null,
      owner_actor_id: input.owner_actor_id,
      lifecycle_state: "draft",
      current_version: 0,
      trust_level: input.trust_level,
      sensitivity: input.sensitivity,
      metadata_json: "{}",
      created_at: now,
      updated_at: now,
      archived_at: null
    };
    const inserted = this.store.insertAsset(envelope);
    if (!inserted) {
      throw new Error(
        `asset_id_collision: insert failed for ${asset_id} (should not happen for a fresh UUID)`
      );
    }
    const updated = this.store.appendAssetVersion({
      asset_id,
      expected_previous_version: 0,
      new_version: 1,
      schema_version: AssetService.ASSET_SCHEMA_VERSION,
      content_hash,
      manifest_json: manifest,
      created_by_actor_id: input.owner_actor_id,
      provenance_kind: "manual",
      provenance_ref: null,
      now
    });
    if (updated === undefined) {
      throw new Error(
        `cas_mismatch: failed to advance current_version to 1 for ${asset_id}`
      );
    }
    this.store.insertMemoryRefBinding({
      asset_id,
      version: 1,
      memory_id: input.memory_id,
      memory_revision: input.memory_revision,
      binding_rule: input.binding_rule ?? null,
      note: input.note ?? null
    });
    return { asset_id, version: 1, content_hash };
  }

  /**
   * List assets, newest-first. The filter
   * arguments are all optional.
   */
  list(filter: {
    asset_type?: AssetType;
    lifecycle_state?: AssetLifecycleState;
    scope?: "global" | "project";
    project_id?: string;
    limit?: number;
  }): AssetRow[] {
    return this.store.listAssets({
      ...(filter.asset_type !== undefined ? { asset_type: filter.asset_type } : {}),
      ...(filter.lifecycle_state !== undefined ? { lifecycle_state: filter.lifecycle_state } : {}),
      ...(filter.scope !== undefined ? { scope: filter.scope } : {}),
      ...(filter.project_id !== undefined ? { project_id: filter.project_id } : {}),
      limit: filter.limit ?? 50
    });
  }

  /**
   * Read the envelope + the current head + the
   * type-specific payload (memory_ref binding
   * for now; other types will plug in here).
   */
  show(assetId: string): AssetInspection | undefined {
    const asset = this.store.getAsset(assetId);
    if (asset === undefined) return undefined;
    const versions = this.store.listAssetVersions(assetId);
    const head = versions[versions.length - 1] ?? null;
    const payload =
      head === null
        ? null
        : this.store.getMemoryRefBinding(assetId, head.version) ?? null;
    return { asset, current_version: head, payload };
  }

  /**
   * List all version rows for an asset, oldest
   * first.
   */
  history(assetId: string): AssetVersionRow[] {
    return this.store.listAssetVersions(assetId);
  }

  /**
   * Flip the envelope's lifecycle. The CAS on
   * `expected_state` makes concurrent lifecycle
   * mutations safe — the second writer receives
   * `cas_mismatch` and can retry.
   */
  setLifecycle(
    assetId: string,
    newState: AssetLifecycleState
  ): AssetRow {
    const asset = this.store.getAsset(assetId);
    if (asset === undefined) {
      const err: Error & { code?: string } = new Error(
        `asset_not_found: no asset with id ${assetId}`
      );
      err.code = "asset_not_found";
      throw err;
    }
    if (asset.lifecycle_state === "archived" && newState !== "archived") {
      const err: Error & { code?: string } = new Error(
        `asset_already_terminal: ${assetId} is archived; archive is a one-way transition in v1.2`
      );
      err.code = "asset_already_terminal";
      throw err;
    }
    const updated = this.store.setAssetLifecycle({
      asset_id: assetId,
      expected_state: asset.lifecycle_state,
      new_state: newState,
      now: nowIso()
    });
    if (updated === undefined) {
      const err: Error & { code?: string } = new Error(
        `cas_mismatch: ${assetId} lifecycle moved from ${asset.lifecycle_state} since read`
      );
      err.code = "cas_mismatch";
      throw err;
    }
    return updated;
  }
}

function bindingInvalid(message: string): Error {
  const err: Error & { code?: string } = new Error(`binding_invalid: ${message}`);
  err.code = "binding_invalid";
  return err;
}

function canonicalMemoryRefContentHash(input: MemoryRefCreateInput): string {
  const canonical = JSON.stringify({
    schema_version: AssetService.ASSET_SCHEMA_VERSION,
    asset_type: "memory_ref",
    scope: input.scope,
    project_id: input.project_id ?? null,
    memory_id: input.memory_id,
    memory_revision: input.memory_revision,
    binding_rule: input.binding_rule ?? null,
    note: input.note ?? null
  });
  return "sha256:" + createHash("sha256").update(canonical).digest("hex");
}
