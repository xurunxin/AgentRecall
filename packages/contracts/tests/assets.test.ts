// packages/contracts/tests/assets.test.ts
//
// v1.2.0-alpha.1 (issue #51): schema tests for the
// asset registry contracts.

import { describe, it, expect } from "vitest";

import {
  AssetV1Schema,
  AssetTypeSchema,
  AssetLifecycleStateSchema,
  AssetVersionV1Schema,
  AssetRelationV1Schema,
  MemoryRefAssetV1Schema,
  SkillAssetV1Schema,
  ContextPackAssetV1Schema,
  ExternalReferenceAssetV1Schema,
  AssetTypePayloadV1Schema,
  AssetInspectionV1Schema
} from "../src/assets.js";

const baseAsset = {
  schema_version: "1" as const,
  asset_id: "asset-1",
  asset_type: "memory_ref" as const,
  scope: "project" as const,
  project_id: "proj_alpha",
  owner_actor_id: "user:dev",
  lifecycle_state: "active" as const,
  current_version: 1,
  trust_level: "user_confirmed" as const,
  sensitivity: "normal" as const,
  metadata: {},
  created_at: "2026-08-25T10:00:00.000Z",
  updated_at: "2026-08-25T10:00:00.000Z",
  archived_at: null
};

describe("Asset contracts (v1.2.0-alpha.1, issue #51)", () => {
  it("accepts a minimal memory_ref asset", () => {
    const parsed = AssetV1Schema.parse(baseAsset);
    expect(parsed.asset_type).toBe("memory_ref");
  });

  it("rejects an unknown asset_type", () => {
    const result = AssetTypeSchema.safeParse("recipe");
    expect(result.success).toBe(false);
  });

  it("rejects an unknown lifecycle_state", () => {
    const result = AssetLifecycleStateSchema.safeParse("live");
    expect(result.success).toBe(false);
  });

  it("rejects scope=project without project_id", () => {
    const result = AssetV1Schema.safeParse({ ...baseAsset, project_id: null });
    expect(result.success).toBe(false);
  });

  it("rejects scope=global with a project_id", () => {
    const result = AssetV1Schema.safeParse({
      ...baseAsset,
      scope: "global",
      project_id: null
    });
    expect(result.success).toBe(true);
    const result2 = AssetV1Schema.safeParse({
      ...baseAsset,
      scope: "global",
      project_id: "proj_alpha"
    });
    expect(result2.success).toBe(false);
  });

  it("rejects lifecycle_state=archived without archived_at", () => {
    const result = AssetV1Schema.safeParse({
      ...baseAsset,
      lifecycle_state: "archived",
      archived_at: null
    });
    expect(result.success).toBe(false);
  });

  it("accepts an immutable version row", () => {
    const parsed = AssetVersionV1Schema.parse({
      schema_version: "1",
      asset_id: "asset-1",
      version: 1,
      asset_schema_version: "1",
      content_hash: "sha256:" + "a".repeat(64),
      created_by_actor_id: "user:dev",
      provenance_ref: null,
      created_at: "2026-08-25T10:00:00.000Z"
    });
    expect(parsed.version).toBe(1);
  });

  it("rejects a version with a non-positive version number", () => {
    const result = AssetVersionV1Schema.safeParse({
      schema_version: "1",
      asset_id: "asset-1",
      version: 0,
      asset_schema_version: "1",
      content_hash: "sha256:" + "b".repeat(64),
      created_by_actor_id: "user:dev",
      provenance_ref: null,
      created_at: "2026-08-25T10:00:00.000Z"
    });
    expect(result.success).toBe(false);
  });

  it("accepts a relation with to_asset_id", () => {
    const parsed = AssetRelationV1Schema.parse({
      schema_version: "1",
      from_asset_id: "asset-1",
      relation_type: "supersedes",
      to_asset_id: "asset-2",
      external_target_ref: null,
      metadata: {},
      created_at: "2026-08-25T10:00:00.000Z"
    });
    expect(parsed.to_asset_id).toBe("asset-2");
  });

  it("rejects a relation with both to_asset_id and external_target_ref", () => {
    const result = AssetRelationV1Schema.safeParse({
      schema_version: "1",
      from_asset_id: "asset-1",
      relation_type: "supersedes",
      to_asset_id: "asset-2",
      external_target_ref: "ext-1",
      metadata: {},
      created_at: "2026-08-25T10:00:00.000Z"
    });
    expect(result.success).toBe(false);
  });

  it("rejects a relation with neither side set", () => {
    const result = AssetRelationV1Schema.safeParse({
      schema_version: "1",
      from_asset_id: "asset-1",
      relation_type: "supersedes",
      to_asset_id: null,
      external_target_ref: null,
      metadata: {},
      created_at: "2026-08-25T10:00:00.000Z"
    });
    expect(result.success).toBe(false);
  });

  it("accepts a memory_ref payload", () => {
    const parsed = MemoryRefAssetV1Schema.parse({
      asset_id: "asset-1",
      version: 1,
      memory_id: "mem_1",
      memory_revision: 1
    });
    expect(parsed.memory_id).toBe("mem_1");
  });

  it("accepts a skill payload (canonical SKILL.md)", () => {
    const parsed = SkillAssetV1Schema.parse({
      asset_id: "asset-1",
      version: 1,
      name: "test-skill",
      description: "a test skill",
      schema_version: "1",
      source: "manual",
      skill_md_canonical: "---\nname: test-skill\n---\n",
      body_hash: "sha256:" + "a".repeat(64)
    });
    expect(parsed.name).toBe("test-skill");
  });

  it("accepts a context_pack manifest", () => {
    const parsed = ContextPackAssetV1Schema.parse({
      asset_id: "asset-1",
      version: 1,
      manifest: {
        include_asset_ids: ["asset-2"],
        include_memory_ids: ["mem_1"]
      }
    });
    expect(parsed.manifest.include_asset_ids.length).toBe(1);
  });

  it("accepts an external_reference payload", () => {
    const parsed = ExternalReferenceAssetV1Schema.parse({
      asset_id: "asset-1",
      version: 1,
      provider_kind: "fastcontext",
      provider_instance_id: "fc-1",
      resource_kind: "wiki",
      resource_ref: "team-handbook",
      uri: "https://example.com/wiki/team-handbook",
      retrieval_contract_version: "1",
      allowed_scope: "global",
      project_id: null,
      sensitivity: "normal",
      last_verified_at: null
    });
    expect(parsed.resource_kind).toBe("wiki");
  });

  it("discriminates AssetTypePayloadV1 by kind", () => {
    const parsed = AssetTypePayloadV1Schema.parse({
      kind: "memory_ref",
      payload: {
        asset_id: "asset-1",
        version: 1,
        memory_id: "mem_1",
        memory_revision: 1
      }
    });
    if (parsed.kind !== "memory_ref") {
      throw new Error("expected memory_ref");
    }
    expect(parsed.payload.memory_id).toBe("mem_1");
  });

  it("rejects an AssetTypePayload with kind / payload mismatch", () => {
    const result = AssetTypePayloadV1Schema.safeParse({
      kind: "memory_ref",
      payload: {
        asset_id: "asset-1",
        version: 1,
        name: "wrong"
      }
    });
    expect(result.success).toBe(false);
  });

  it("round-trips an inspection payload", () => {
    const parsed = AssetInspectionV1Schema.parse({
      schema_version: "1",
      asset: baseAsset,
      current_version: null,
      payload: {
        kind: "memory_ref",
        payload: {
          asset_id: "asset-1",
          version: 1,
          memory_id: "mem_1",
          memory_revision: 1
        }
      }
    });
    expect(parsed.asset.asset_id).toBe("asset-1");
  });
});
