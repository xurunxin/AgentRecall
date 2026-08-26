// test/unit/external-refs-service.test.ts
//
// v1.2.0-alpha.2 (issue #54): unit tests for the
// `ExternalReferenceService` + the underlying
// `external_references` v20 table. The tests
// exercise the create / list / verify /
// archive-reject path; a future release will
// extend them to the v1.2-alpha.3 appendVersion
// surface.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExternalReferenceService } from "../../src/external-refs/service.js";
import { CURRENT_SCHEMA_VERSION, SQLiteMemoryStore } from "../../src/sqlite-store.js";

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "lm-external-refs-")), "memory.sqlite");
}

function openStore(dbPath: string): SQLiteMemoryStore {
  return new SQLiteMemoryStore(dbPath);
}

describe("ExternalReferenceService (v1.2.0-alpha.2, issue #54)", () => {
  let dbPath: string;
  let store: SQLiteMemoryStore;
  let service: ExternalReferenceService;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = openStore(dbPath);
    service = new ExternalReferenceService(store);
    expect(store.getUserVersion()).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(20);
  });
  afterEach(() => {
    if (store !== undefined) {
      try {
        store.close();
      } catch {
        // already closed
      }
    }
    try {
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  describe("create + list + verify", () => {
    it("creates, lists and verifies an external_reference", () => {
      const created = service.create({
        provider_kind: "fastcontext",
        provider_instance_id: "fc-prod-1",
        resource_kind: "code_index",
        resource_ref: "src/",
        uri: "fastcontext://proj/src",
        retrieval_contract_version: "1",
        capabilities: ["search", "fetch"],
        allowed_scope: "project",
        project_id: "proj_alpha",
        sensitivity: "normal",
        refresh_policy: { kind: "manual" },
        owner_actor_id: "user:dev"
      });
      expect(created.asset_id.startsWith("asset_")).toBe(true);
      expect(created.version).toBe(1);
      expect(created.content_hash).toMatch(/^sha256:[a-f0-9]{64}$/);

      const rows = service.list({ provider_kind: "fastcontext" });
      expect(rows.length).toBe(1);
      expect(rows[0]?.asset_id).toBe(created.asset_id);
      expect(rows[0]?.resource_kind).toBe("code_index");

      const verify = service.verify(created.asset_id, 1);
      expect(verify.version).toBe(1);
      expect(verify.last_verified_at).not.toBeNull();

      // A second verify call should also succeed
      // (last_verified_at is overwritten, not appended).
      const verify2 = service.verify(created.asset_id, 1);
      expect(verify2.version).toBe(1);
    });

    it("rejects project scope without project_id", () => {
      expect(() =>
        service.create({
          provider_kind: "fastcontext",
          provider_instance_id: "fc-prod-1",
          resource_kind: "code_index",
          resource_ref: "src/",
          uri: "fastcontext://proj/src",
          retrieval_contract_version: "1",
          allowed_scope: "project",
          sensitivity: "normal",
          owner_actor_id: "user:dev"
        })
      ).toThrow(/invalid_input/);
    });

    it("rejects global scope with a project_id", () => {
      expect(() =>
        service.create({
          provider_kind: "wiki",
          provider_instance_id: "wiki-prod-1",
          resource_kind: "wiki",
          resource_ref: "team-handbook",
          uri: "wiki://handbook",
          retrieval_contract_version: "1",
          allowed_scope: "global",
          project_id: "proj_alpha",
          sensitivity: "normal",
          owner_actor_id: "user:dev"
        })
      ).toThrow(/invalid_input/);
    });
  });

  describe("verify on archived asset", () => {
    it("rejects verify on an archived asset", () => {
      const created = service.create({
        provider_kind: "wiki",
        provider_instance_id: "wiki-1",
        resource_kind: "wiki",
        resource_ref: "team-handbook",
        uri: "wiki://handbook",
        retrieval_contract_version: "1",
        allowed_scope: "global",
        sensitivity: "normal",
        owner_actor_id: "user:dev"
      });
      // archive via the underlying asset API
      store.setAssetLifecycle({
        asset_id: created.asset_id,
        expected_state: "draft",
        new_state: "archived",
        now: "2026-08-25T10:00:00.000Z"
      });
      expect(() => service.verify(created.asset_id, 1)).toThrow(/asset_archived/);
    });
  });

  describe("capabilities + refresh_policy persistence", () => {
    it("persists capabilities and refresh_policy with interval", () => {
      const created = service.create({
        provider_kind: "agentic-rag",
        provider_instance_id: "rag-1",
        resource_kind: "repository_context",
        resource_ref: "repo:foo",
        uri: "rag://foo",
        retrieval_contract_version: "1",
        capabilities: ["search", "graph", "citations"],
        allowed_scope: "project",
        project_id: "proj_alpha",
        sensitivity: "private",
        refresh_policy: { kind: "interval", interval_seconds: 3600 },
        owner_actor_id: "user:dev"
      });
      const row = store.getLatestExternalReference(created.asset_id);
      expect(row).toBeDefined();
      expect(JSON.parse(row!.capabilities_json)).toEqual([
        "search",
        "graph",
        "citations"
      ]);
      const policy = JSON.parse(row!.refresh_policy_json) as { kind: string; interval_seconds?: number };
      expect(policy.kind).toBe("interval");
      expect(policy.interval_seconds).toBe(3600);
      expect(row!.sensitivity).toBe("private");
    });
  });
});
