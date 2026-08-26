// test/unit/assets-service.test.ts
//
// v1.2.0-alpha.1 (issue #51): unit tests for the
// `AssetService` + envelope schema. The full type
// surface (memory_ref / skill / context_pack /
// external_reference) lands with its owning Phase 2
// issues (#53 / #54); v1.2-alpha.1 ships only the
// `memory_ref` type-specific branch.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AssetService } from "../../src/assets/service.js";
import { CURRENT_SCHEMA_VERSION, SQLiteMemoryStore } from "../../src/sqlite-store.js";

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "lm-assets-")), "memory.sqlite");
}

function openStore(dbPath: string): SQLiteMemoryStore {
  return new SQLiteMemoryStore(dbPath);
}

function seedMemory(store: SQLiteMemoryStore): string {
  // The memory_entries table is a v4+ shape; a
  // minimal entry is enough to satisfy the FK on
  // memory_ref_bindings.memory_id.
  const id = "mem_aaaaaaaaaaaaaaaaaaaaaaaa";
  const now = "2026-08-25T10:00:00.000Z";
  store.insertEntry({
    id,
    scope: "global",
    project_id: null,
    project_path: null,
    type: "fact",
    topic: "test",
    title: "seed",
    body: "seed body",
    tags: [],
    source: { kind: "user", ref: "test" },
    importance: 3,
    confidence: 5,
    status: "active",
    created_at: now,
    updated_at: now,
    last_accessed_at: null,
    last_accessed_by: undefined,
    access_count: 0,
    expires_at: null,
    review_after: null,
    supersedes: [],
    superseded_by: null,
    token_estimate: 1,
    char_count: 9,
    revision: 1,
    writer_actor_id: "user:test",
    content_hash: null,
    pinned: 0,
    trust_level: "agent_observed",
    sensitivity: "normal",
    valid_from: null,
    valid_until: null,
    deleted_at: null,
    tier: "working",
    metadata: {}
  });
  return id;
}

describe("AssetService (v1.2.0-alpha.1, issue #51)", () => {
  let dbPath: string;
  let store: SQLiteMemoryStore;
  let assets: AssetService;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = openStore(dbPath);
    assets = new AssetService(store);
    expect(store.getUserVersion()).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(16);
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

  describe("createMemoryRef", () => {
    it("creates a v1 memory_ref asset bound to a real memory", () => {
      const memoryId = seedMemory(store);
      const result = assets.createMemoryRef({
        scope: "global",
        owner_actor_id: "user:dev",
        trust_level: "user_confirmed",
        sensitivity: "normal",
        memory_id: memoryId,
        memory_revision: 1
      });
      expect(result.version).toBe(1);
      expect(result.content_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
      const inspection = assets.show(result.asset_id);
      expect(inspection?.asset.lifecycle_state).toBe("draft");
      expect(inspection?.asset.current_version).toBe(1);
      expect(inspection?.payload?.memory_id).toBe(memoryId);
      expect(inspection?.payload?.memory_revision).toBe(1);
    });

    it("rejects project scope without project_id", () => {
      expect(() =>
        assets.createMemoryRef({
          scope: "project",
          owner_actor_id: "user:dev",
          trust_level: "user_confirmed",
          sensitivity: "normal",
          memory_id: "mem_aaaaaaaaaaaaaaaaaaaaaaaa",
          memory_revision: 1
        })
      ).toThrow(/binding_invalid/);
    });

    it("rejects an invalid memory_revision", () => {
      expect(() =>
        assets.createMemoryRef({
          scope: "global",
          owner_actor_id: "user:dev",
          trust_level: "user_confirmed",
          sensitivity: "normal",
          memory_id: "mem_aaaaaaaaaaaaaaaaaaaaaaaa",
          memory_revision: 0
        })
      ).toThrow(/binding_invalid/);
    });
  });

  describe("list / show / history", () => {
    it("lists assets newest-first with the filter clauses", () => {
      const memoryId = seedMemory(store);
      const a = assets.createMemoryRef({
        scope: "global",
        owner_actor_id: "user:dev",
        trust_level: "user_confirmed",
        sensitivity: "normal",
        memory_id: memoryId,
        memory_revision: 1
      });
      const rows = assets.list({ asset_type: "memory_ref", limit: 10 });
      expect(rows.length).toBe(1);
      expect(rows[0]?.asset_id).toBe(a.asset_id);
    });

    it("returns history rows ordered oldest-first", () => {
      const memoryId = seedMemory(store);
      const a = assets.createMemoryRef({
        scope: "global",
        owner_actor_id: "user:dev",
        trust_level: "user_confirmed",
        sensitivity: "normal",
        memory_id: memoryId,
        memory_revision: 1
      });
      const history = assets.history(a.asset_id);
      expect(history.length).toBe(1);
      expect(history[0]?.version).toBe(1);
    });
  });

  describe("lifecycle", () => {
    it("transitions draft -> active -> archived", () => {
      const memoryId = seedMemory(store);
      const { asset_id } = assets.createMemoryRef({
        scope: "global",
        owner_actor_id: "user:dev",
        trust_level: "user_confirmed",
        sensitivity: "normal",
        memory_id: memoryId,
        memory_revision: 1
      });
      const active = assets.setLifecycle(asset_id, "active");
      expect(active.lifecycle_state).toBe("active");
      const archived = assets.setLifecycle(asset_id, "archived");
      expect(archived.lifecycle_state).toBe("archived");
      expect(archived.archived_at).not.toBeNull();
    });

    it("refuses to transition out of archived", () => {
      const memoryId = seedMemory(store);
      const { asset_id } = assets.createMemoryRef({
        scope: "global",
        owner_actor_id: "user:dev",
        trust_level: "user_confirmed",
        sensitivity: "normal",
        memory_id: memoryId,
        memory_revision: 1
      });
      assets.setLifecycle(asset_id, "archived");
      expect(() => assets.setLifecycle(asset_id, "active")).toThrow(/asset_already_terminal/);
    });

    it("throws asset_not_found for an unknown id", () => {
      expect(() => assets.setLifecycle("asset_does-not-exist", "active")).toThrow(/asset_not_found/);
    });
  });
});
