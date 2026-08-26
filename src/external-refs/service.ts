// src/external-refs/service.ts
//
// v1.2.0-alpha.2 (issue #54): the `external_reference`
// asset type's service. The reference is metadata; the
// actual retrieval is a separate explicit caller-driven
// step. There is no daemon and no background refresh —
// a re-`verify` only updates `last_verified_at`. Staleness
// is detected by comparing the timestamp against the
// `refresh_policy` and surfaced in the bootstrap plan as
// an `action: 'register_external_ref'` item with
// `risk: 'medium'`.

import { createHash, randomUUID } from "node:crypto";

import type {
  AssetRow,
  AssetType,
  AssetVersionRow,
  ExternalReferenceResourceKind,
  ExternalReferenceRow,
  SQLiteMemoryStore
} from "../sqlite-store.js";
import { nowIso } from "../domain.js";

const EXTERNAL_REFERENCE_ASSET_SCHEMA_VERSION = "1";

export type ExternalReferenceCapability =
  | "search"
  | "fetch"
  | "graph"
  | "symbols"
  | "citations";

export type ExternalReferenceRefreshPolicy = {
  kind: "manual" | "on_session_start" | "interval";
  interval_seconds?: number;
};

export type CreateExternalReferenceInput = {
  provider_kind: string;
  provider_instance_id: string;
  resource_kind: ExternalReferenceResourceKind;
  resource_ref: string;
  uri: string;
  source_version?: string;
  source_digest?: string;
  retrieval_contract_version: string;
  capabilities?: ReadonlyArray<ExternalReferenceCapability>;
  allowed_scope: "global" | "project";
  project_id?: string;
  sensitivity: "normal" | "private" | "restricted";
  refresh_policy?: ExternalReferenceRefreshPolicy;
  last_verified_at?: string;
  owner_actor_id: string;
  trust_level?: "user_confirmed" | "agent_observed" | "inferred";
  metadata?: Record<string, unknown>;
};

export type CreateExternalReferenceResult = {
  asset_id: string;
  version: number;
  content_hash: string;
  row: ExternalReferenceRow;
};

export type ListExternalReferenceFilter = {
  provider_kind?: string;
  allowed_scope?: "global" | "project";
  project_id?: string;
  limit?: number;
};

export type VerifyExternalReferenceResult = {
  asset_id: string;
  version: number;
  last_verified_at: string;
};

export type ExternalReferenceServiceErrorCode =
  | "scope_requires_project_id"
  | "invalid_resource_kind"
  | "asset_archived"
  | "asset_not_found"
  | "cas_mismatch"
  | "invalid_input";

export class ExternalReferenceService {
  constructor(private readonly store: SQLiteMemoryStore) {}

  /**
   * Create a fresh `external_reference` asset. The
   * envelope row in `assets` and the first version
   * in `asset_versions` are written through the
   * underlying store methods; the type-specific
   * payload row goes into `external_references`.
   * The whole flow is not a single transaction
   * (the SQLite store does not expose a wrapping
   * helper that covers the v20 DDL) — a partial
   * failure leaves the assets envelope behind
   * without a payload row, which the `show` verb
   * surfaces as a `null` payload (no crash).
   */
  create(input: CreateExternalReferenceInput): CreateExternalReferenceResult {
    if (input.allowed_scope === "project" && input.project_id === undefined) {
      throw invalidInput("allowed_scope='project' requires project_id");
    }
    if (input.allowed_scope === "global" && input.project_id !== undefined) {
      throw invalidInput("allowed_scope='global' forbids project_id");
    }
    if (input.provider_kind.length === 0) {
      throw invalidInput("provider_kind must be a non-empty string");
    }
    if (input.provider_instance_id.length === 0) {
      throw invalidInput("provider_instance_id must be a non-empty string");
    }
    if (input.resource_ref.length === 0) {
      throw invalidInput("resource_ref must be a non-empty string");
    }
    if (input.uri.length === 0) {
      throw invalidInput("uri must be a non-empty string");
    }
    if (input.retrieval_contract_version.length === 0) {
      throw invalidInput("retrieval_contract_version must be a non-empty string");
    }
    const now = nowIso();
    const asset_id = `asset_${randomUUID()}`;
    const trust_level = input.trust_level ?? "user_confirmed";
    const capabilities = input.capabilities ?? [];
    const refresh_policy: ExternalReferenceRefreshPolicy =
      input.refresh_policy ?? { kind: "manual" };
    const metadata = input.metadata ?? {};
    const content_hash = canonicalExternalReferenceContentHash(input, capabilities, refresh_policy);
    const envelope: AssetRow = {
      asset_id,
      asset_type: "external_reference",
      scope: input.allowed_scope,
      project_id: input.project_id ?? null,
      owner_actor_id: input.owner_actor_id,
      lifecycle_state: "draft",
      current_version: 0,
      trust_level,
      sensitivity: input.sensitivity,
      metadata_json: JSON.stringify(metadata),
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
      schema_version: EXTERNAL_REFERENCE_ASSET_SCHEMA_VERSION,
      content_hash,
      manifest_json: JSON.stringify({
        kind: "external_reference",
        provider_kind: input.provider_kind,
        resource_kind: input.resource_kind
      }),
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
    const extRow: ExternalReferenceRow = {
      asset_id,
      version: 1,
      provider_kind: input.provider_kind,
      provider_instance_id: input.provider_instance_id,
      resource_kind: input.resource_kind,
      resource_ref: input.resource_ref,
      uri: input.uri,
      source_version: input.source_version ?? null,
      source_digest: input.source_digest ?? null,
      retrieval_contract_version: input.retrieval_contract_version,
      capabilities_json: JSON.stringify(capabilities),
      allowed_scope: input.allowed_scope,
      project_id: input.project_id ?? null,
      sensitivity: input.sensitivity,
      refresh_policy_json: JSON.stringify(refresh_policy),
      last_verified_at: input.last_verified_at ?? null,
      metadata_json: JSON.stringify(metadata)
    };
    const ok = this.store.insertExternalReference(extRow);
    if (!ok) {
      throw new Error(
        `external_reference_already_exists: ${asset_id}@1 (should not happen for a fresh UUID)`
      );
    }
    return { asset_id, version: 1, content_hash, row: extRow };
  }

  /**
   * Read the head `external_references` row for an
   * asset. Returns `undefined` when the asset has
   * no `external_reference` payload (i.e. it is
   * some other asset type or the version row is
   * absent).
   */
  show(assetId: string): {
    envelope: AssetRow;
    head: AssetVersionRow;
    payload: ExternalReferenceRow;
  } | undefined {
    const envelope = this.store.getAsset(assetId);
    if (envelope === undefined) return undefined;
    if (envelope.asset_type !== ("external_reference" satisfies AssetType)) {
      return undefined;
    }
    const versions = this.store.listAssetVersions(assetId);
    const head = versions[versions.length - 1];
    if (head === undefined) return undefined;
    const payload = this.store.getLatestExternalReference(assetId);
    if (payload === undefined) return undefined;
    return { envelope, head, payload };
  }

  /**
   * List `external_references` payloads, newest
   * head first. The filter clauses are optional.
   */
  list(filter: ListExternalReferenceFilter): ExternalReferenceRow[] {
    return this.store.listExternalReferences({
      ...(filter.provider_kind !== undefined ? { provider_kind: filter.provider_kind } : {}),
      ...(filter.allowed_scope !== undefined ? { allowed_scope: filter.allowed_scope } : {}),
      ...(filter.project_id !== undefined ? { project_id: filter.project_id } : {}),
      limit: filter.limit ?? 50
    });
  }

  /**
   * Refresh the `last_verified_at` timestamp on the
   * head row. The CAS on `expected_version` makes
   * concurrent version appends detectable. The
   * caller must have already read the head (via
   * `show` or a fresh `list`) to obtain the
   * `expected_version`. Rejects when the asset is
   * archived.
   */
  verify(assetId: string, expectedVersion: number): VerifyExternalReferenceResult {
    const envelope = this.store.getAsset(assetId);
    if (envelope === undefined) {
      throw assetNotFound(assetId);
    }
    if (envelope.lifecycle_state === "archived") {
      throw assetArchived(assetId);
    }
    const head = this.store.getLatestExternalReference(assetId);
    if (head === undefined || head.version !== expectedVersion) {
      throw casMismatch(assetId);
    }
    const now = nowIso();
    const updated = this.store.refreshExternalReferenceLastVerified({
      asset_id: assetId,
      expected_version: expectedVersion,
      now
    });
    if (updated === undefined) {
      throw casMismatch(assetId);
    }
    return {
      asset_id: assetId,
      version: expectedVersion,
      last_verified_at: now
    };
  }
}

function canonicalExternalReferenceContentHash(
  input: CreateExternalReferenceInput,
  capabilities: ReadonlyArray<ExternalReferenceCapability>,
  refresh_policy: ExternalReferenceRefreshPolicy
): string {
  const canonical = JSON.stringify({
    schema_version: EXTERNAL_REFERENCE_ASSET_SCHEMA_VERSION,
    asset_type: "external_reference",
    provider_kind: input.provider_kind,
    provider_instance_id: input.provider_instance_id,
    resource_kind: input.resource_kind,
    resource_ref: input.resource_ref,
    uri: input.uri,
    source_version: input.source_version ?? null,
    source_digest: input.source_digest ?? null,
    retrieval_contract_version: input.retrieval_contract_version,
    capabilities,
    allowed_scope: input.allowed_scope,
    project_id: input.project_id ?? null,
    sensitivity: input.sensitivity,
    refresh_policy
  });
  return "sha256:" + createHash("sha256").update(canonical).digest("hex");
}

function invalidInput(message: string): Error {
  const err: Error & { code?: string } = new Error(`invalid_input: ${message}`);
  err.code = "invalid_input";
  return err;
}

function assetNotFound(assetId: string): Error {
  const err: Error & { code?: string } = new Error(`asset_not_found: ${assetId}`);
  err.code = "asset_not_found";
  return err;
}

function assetArchived(assetId: string): Error {
  const err: Error & { code?: string } = new Error(
    `asset_archived: ${assetId} is archived; verify is rejected for archived assets`
  );
  err.code = "asset_archived";
  return err;
}

function casMismatch(assetId: string): Error {
  const err: Error & { code?: string } = new Error(
    `cas_mismatch: ${assetId} head version moved between read and verify`
  );
  err.code = "cas_mismatch";
  return err;
}
