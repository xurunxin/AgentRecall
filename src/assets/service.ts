// src/assets/service.ts
//
// v1.2.0-alpha.1 (issue #51) + v1.2.0-alpha.2
// (issue #53): the additive asset registry
// service. The public surface is a small set of
// verbs that map 1:1 to the CLI / MCP inspector:
//
//   createMemoryRef       -- append a `memory_ref` asset
//   createSkillVersion    -- append a v1 `skill` asset envelope
//   appendSkillVersion    -- CAS-style new version of a `skill`
//   list                  -- filter + cap
//   show                  -- envelope + current head + payload
//   history               -- all version rows
//   activate / deprecate / archive -- lifecycle
//   delete                -- remove the envelope (cascade
//                            deletes versions + bindings)
//
// Phase 1 ships only the `memory_ref` type. The
// `skill` envelope plumbing lands with v1.2-alpha.2
// (issue #53) — the type-specific `skills` row
// is written by `SkillService` (in `src/skills/`).
// The `context_pack` / `external_reference`
// envelopes land with their owning Phase 2 issues
// (#54).

import { createHash, randomUUID } from "node:crypto";

import type {
  AssetLifecycleState,
  AssetRow,
  AssetType,
  AssetVersionRow,
  MemoryRefBindingRow,
  SkillRow,
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

/**
 * v1.2.0-alpha.2 (issue #53): the input to
 * `createSkillVersion`. The caller is the
 * `SkillService` (which has already parsed +
 * canonicalised the SKILL.md). The
 * `body_hash` MUST equal
 * `sha256:hex64` over the canonical SKILL.md
 * bytes.
 */
export type SkillVersionCreateInput = {
  scope: "global" | "project";
  project_id?: string;
  owner_actor_id: string;
  trust_level?: "user_confirmed" | "agent_observed" | "inferred";
  sensitivity?: "normal" | "private" | "restricted";
  name: string;
  body_hash: string;
  source: "manual" | "derived" | "imported";
  provenance_kind: "manual" | "derivation_run" | "import_batch" | "external";
  provenance_ref: string | null;
};

/**
 * v1.2.0-alpha.2 (issue #53): the input to
 * `appendSkillVersion`. The CAS on
 * `expected_previous_version` makes concurrent
 * appends safe.
 */
export type SkillVersionAppendInput = {
  asset_id: string;
  expected_previous_version: number;
  body_hash: string;
  name: string;
  created_by_actor_id: string;
  change_summary?: string | null;
  provenance_kind?: "manual" | "derivation_run" | "import_batch" | "external";
  provenance_ref?: string | null;
};

export type AssetInspection = {
  asset: AssetRow;
  current_version: AssetVersionRow | null;
  /**
   * The type-specific payload for the head
   * version. `memory_ref` assets surface a
   * `MemoryRefBindingRow`; `skill` assets
   * surface a `SkillRow`. Other types return
   * `null` (the envelope is the only data).
   * The shape is intentionally a union so a
   * caller that knows the type can switch on
   * `asset.asset_type` to narrow.
   */
  payload: MemoryRefBindingRow | SkillRow | null;
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
   * v1.2.0-alpha.2 (issue #53): mint the
   * envelope for a new `skill` asset and append
   * v1 atomically. The type-specific `skills`
   * row is the caller's responsibility
   * (`SkillService` writes it under the same
   * logical transaction). The `body_hash` MUST
   * be `sha256:hex64` over the canonical SKILL.md
   * bytes; the `asset_versions.content_hash` row
   * is set to the same value.
   */
  createSkillVersion(input: SkillVersionCreateInput): CreateResult {
    if (input.scope === "project" && input.project_id === undefined) {
      throw bindingInvalid("scope=project requires project_id");
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(input.body_hash)) {
      throw bindingInvalid(
        "body_hash must be 'sha256:' + 64 lowercase hex digits"
      );
    }
    const now = nowIso();
    const asset_id = `asset_${randomUUID()}`;
    const envelope: AssetRow = {
      asset_id,
      asset_type: "skill",
      scope: input.scope,
      project_id: input.project_id ?? null,
      owner_actor_id: input.owner_actor_id,
      lifecycle_state: "draft",
      current_version: 0,
      trust_level: input.trust_level ?? "user_confirmed",
      sensitivity: input.sensitivity ?? "normal",
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
    const manifest = JSON.stringify({
      kind: "skill",
      name: input.name,
      body_hash: input.body_hash
    });
    const updated = this.store.appendAssetVersion({
      asset_id,
      expected_previous_version: 0,
      new_version: 1,
      schema_version: AssetService.ASSET_SCHEMA_VERSION,
      content_hash: input.body_hash,
      manifest_json: manifest,
      created_by_actor_id: input.owner_actor_id,
      provenance_kind: input.provenance_kind,
      provenance_ref: input.provenance_ref,
      now
    });
    if (updated === undefined) {
      throw new Error(
        `cas_mismatch: failed to advance current_version to 1 for ${asset_id}`
      );
    }
    return { asset_id, version: 1, content_hash: input.body_hash };
  }

  /**
   * v1.2.0-alpha.2 (issue #53): CAS-style
   * append a new version to an existing
   * `skill` asset. The caller has already
   * read the current head; the append only
   * succeeds when the envelope's
   * `current_version` is exactly
   * `expected_previous_version`. On a
   * concurrent append, the second writer
   * receives `cas_mismatch`.
   */
  appendSkillVersion(input: SkillVersionAppendInput): CreateResult {
    if (!/^sha256:[a-f0-9]{64}$/.test(input.body_hash)) {
      throw bindingInvalid(
        "body_hash must be 'sha256:' + 64 lowercase hex digits"
      );
    }
    if (input.expected_previous_version < 0) {
      throw bindingInvalid("expected_previous_version must be >= 0");
    }
    const asset = this.store.getAsset(input.asset_id);
    if (asset === undefined) {
      const err: Error & { code?: string } = new Error(
        `asset_not_found: no asset with id ${input.asset_id}`
      );
      err.code = "asset_not_found";
      throw err;
    }
    if (asset.asset_type !== "skill") {
      throw bindingInvalid(
        `asset ${input.asset_id} is type '${asset.asset_type}', not 'skill'`
      );
    }
    if (asset.current_version !== input.expected_previous_version) {
      const err: Error & { code?: string } = new Error(
        `cas_mismatch: ${input.asset_id} is at version ${asset.current_version}, not ${input.expected_previous_version}`
      );
      err.code = "cas_mismatch";
      throw err;
    }
    const newVersion = asset.current_version + 1;
    const now = nowIso();
    const manifest = JSON.stringify({
      kind: "skill",
      name: input.name,
      body_hash: input.body_hash,
      change_summary: input.change_summary ?? null
    });
    const updated = this.store.appendAssetVersion({
      asset_id: input.asset_id,
      expected_previous_version: input.expected_previous_version,
      new_version: newVersion,
      schema_version: AssetService.ASSET_SCHEMA_VERSION,
      content_hash: input.body_hash,
      manifest_json: manifest,
      created_by_actor_id: input.created_by_actor_id,
      provenance_kind: input.provenance_kind ?? "manual",
      provenance_ref: input.provenance_ref ?? null,
      now
    });
    if (updated === undefined) {
      const err: Error & { code?: string } = new Error(
        `cas_mismatch: ${input.asset_id} advanced past ${input.expected_previous_version} during the append`
      );
      err.code = "cas_mismatch";
      throw err;
    }
    return { asset_id: input.asset_id, version: newVersion, content_hash: input.body_hash };
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
   * type-specific payload. The `payload` field
   * is the binding (for `memory_ref`) or the
   * type-specific row (for `skill`); other
   * types return `null`.
   */
  show(assetId: string): AssetInspection | undefined {
    const asset = this.store.getAsset(assetId);
    if (asset === undefined) return undefined;
    const versions = this.store.listAssetVersions(assetId);
    const head = versions[versions.length - 1] ?? null;
    let payload: MemoryRefBindingRow | SkillRow | null = null;
    if (head !== null) {
      if (asset.asset_type === "memory_ref") {
        payload = this.store.getMemoryRefBinding(assetId, head.version) ?? null;
      } else if (asset.asset_type === "skill") {
        payload = this.store.getSkillRow(assetId, head.version) ?? null;
      }
    }
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
