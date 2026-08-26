// packages/contracts/tests/bootstrap.test.ts
//
// v1.2.0-alpha.2 (issue #54): schema tests for the
// cold-start bootstrap surface + the
// `external_reference` payload contract.

import { describe, it, expect } from "vitest";

import {
  BootstrapSourceV1Schema,
  BootstrapPlanV1Schema,
  BootstrapPlanItemV1Schema,
  ExternalReferenceV1Schema,
  ExternalReferenceRefreshPolicySchema,
  BootstrapScanResultV1Schema
} from "../src/bootstrap.js";

const baseSource = {
  schema_version: "1" as const,
  source_id: "bsrc-1",
  source_kind: "file" as const,
  scope: "project" as const,
  project_id: "proj_alpha",
  canonical_ref: "AGENTS.md",
  source_version: null,
  content_digest: "sha256:" + "a".repeat(64),
  sensitivity: "normal" as const,
  configured_by_actor_id: "user:dev",
  created_at: "2026-08-25T10:00:00.000Z",
  last_scanned_at: null,
  size_bytes: 1024
};

const basePlan = {
  schema_version: "1" as const,
  plan_id: "bplan-1",
  project_id: "proj_alpha",
  creator_actor_id: "user:dev",
  state: "plan_ready" as const,
  config_digest: "sha256:" + "b".repeat(64),
  source_set_digest: "sha256:" + "c".repeat(64),
  created_at: "2026-08-25T10:00:00.000Z",
  expires_at: "2026-09-01T10:00:00.000Z",
  completed_at: null,
  job_id: null
};

const basePlanItem = {
  schema_version: "1" as const,
  plan_id: "bplan-1",
  source_id: "bsrc-1",
  item_seq: 1,
  action: "propose_memory" as const,
  target_ref: "AGENTS.md",
  proposed_payload: { title: "AGENTS" },
  evidence_digest: "sha256:" + "d".repeat(64),
  expected_revision_or_version: null,
  risk: "low" as const,
  rationale: "bootstrap auto-proposal"
};

const baseExternalReference = {
  schema_version: "1" as const,
  asset_id: "asset-1",
  version: 1,
  provider_kind: "fastcontext",
  provider_instance_id: "fc-prod-1",
  resource_kind: "code_index" as const,
  resource_ref: "src/",
  uri: "fastcontext://proj_alpha/src",
  source_version: "v1",
  source_digest: null,
  retrieval_contract_version: "1",
  capabilities: ["search" as const, "fetch" as const],
  allowed_scope: "project" as const,
  project_id: "proj_alpha",
  sensitivity: "normal" as const,
  refresh_policy: { kind: "manual" as const },
  last_verified_at: null,
  metadata: {}
};

const baseScanResult = {
  schema_version: "1" as const,
  plan_id: "bplan-1",
  state: "plan_ready" as const,
  config_digest: "sha256:" + "b".repeat(64),
  source_set_digest: "sha256:" + "c".repeat(64),
  item_count: 1,
  sources_scanned: 1,
  sources_skipped: 0
};

describe("Bootstrap contracts (v1.2.0-alpha.2, issue #54)", () => {
  describe("BootstrapSourceV1Schema", () => {
    it("accepts the happy path", () => {
      const parsed = BootstrapSourceV1Schema.parse(baseSource);
      expect(parsed.source_kind).toBe("file");
    });

    it("rejects scope=project without project_id", () => {
      const result = BootstrapSourceV1Schema.safeParse({
        ...baseSource,
        project_id: null
      });
      expect(result.success).toBe(false);
    });

    it("rejects an unknown source_kind", () => {
      const result = BootstrapSourceV1Schema.safeParse({
        ...baseSource,
        source_kind: "tarball"
      });
      expect(result.success).toBe(false);
    });

    it("rejects a malformed content_digest", () => {
      const result = BootstrapSourceV1Schema.safeParse({
        ...baseSource,
        content_digest: "not-a-digest"
      });
      expect(result.success).toBe(false);
    });
  });

  describe("BootstrapPlanV1Schema", () => {
    it("accepts the happy path", () => {
      const parsed = BootstrapPlanV1Schema.parse(basePlan);
      expect(parsed.state).toBe("plan_ready");
    });

    it("rejects an unknown state", () => {
      const result = BootstrapPlanV1Schema.safeParse({
        ...basePlan,
        state: "queued"
      });
      expect(result.success).toBe(false);
    });

    it("rejects a malformed config_digest", () => {
      const result = BootstrapPlanV1Schema.safeParse({
        ...basePlan,
        config_digest: "garbage"
      });
      expect(result.success).toBe(false);
    });
  });

  describe("BootstrapPlanItemV1Schema", () => {
    it("accepts the happy path", () => {
      const parsed = BootstrapPlanItemV1Schema.parse(basePlanItem);
      expect(parsed.action).toBe("propose_memory");
    });

    it("rejects an unknown action", () => {
      const result = BootstrapPlanItemV1Schema.safeParse({
        ...basePlanItem,
        action: "register_loader"
      });
      expect(result.success).toBe(false);
    });

    it("rejects a malformed risk", () => {
      const result = BootstrapPlanItemV1Schema.safeParse({
        ...basePlanItem,
        risk: "extreme"
      });
      expect(result.success).toBe(false);
    });
  });

  describe("ExternalReferenceV1Schema", () => {
    it("accepts the happy path", () => {
      const parsed = ExternalReferenceV1Schema.parse(baseExternalReference);
      expect(parsed.provider_kind).toBe("fastcontext");
    });

    it("rejects allowed_scope=project without project_id", () => {
      const result = ExternalReferenceV1Schema.safeParse({
        ...baseExternalReference,
        project_id: null
      });
      expect(result.success).toBe(false);
    });

    it("rejects an unknown resource_kind", () => {
      const result = ExternalReferenceV1Schema.safeParse({
        ...baseExternalReference,
        resource_kind: "web_page"
      });
      expect(result.success).toBe(false);
    });
  });

  describe("ExternalReferenceRefreshPolicySchema", () => {
    it("accepts a manual policy", () => {
      const parsed = ExternalReferenceRefreshPolicySchema.parse({ kind: "manual" });
      expect(parsed.kind).toBe("manual");
    });

    it("rejects interval without interval_seconds", () => {
      const result = ExternalReferenceRefreshPolicySchema.safeParse({ kind: "interval" });
      expect(result.success).toBe(false);
    });

    it("accepts an interval with interval_seconds", () => {
      const parsed = ExternalReferenceRefreshPolicySchema.parse({
        kind: "interval",
        interval_seconds: 3600
      });
      expect(parsed.interval_seconds).toBe(3600);
    });
  });

  describe("BootstrapScanResultV1Schema", () => {
    it("accepts the happy path", () => {
      const parsed = BootstrapScanResultV1Schema.parse(baseScanResult);
      expect(parsed.item_count).toBe(1);
    });

    it("rejects a negative item_count", () => {
      const result = BootstrapScanResultV1Schema.safeParse({
        ...baseScanResult,
        item_count: -1
      });
      expect(result.success).toBe(false);
    });
  });
});
