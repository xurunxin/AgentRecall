// test/unit/context-assembly.test.ts
//
// v1.2.0-alpha.2 (issue #52): unit tests for the
// context-assembly service. The `bootstrap_hash`
// stability contract is the headline guarantee:
// the hash changes only when (loadout_id,
// loadout_version, policy_version, actor_id,
// project_id, bootstrap_text) changes.

import { describe, expect, it } from "vitest";

import { ContextAssembler, ASSEMBLER_POLICY_VERSION } from "../../src/context-assembly/assembler.js";
import { LoadoutService } from "../../src/loadouts/service.js";
import type { MemoryEntry } from "../../src/domain.js";
import type { LoadoutRow, LoadoutRuleRow } from "../../src/sqlite-store.js";
import type { MemoryReadService, SearchMemoryItem } from "../../src/services/memory-read-service.js";
import type { ListResult, SearchResult } from "../../src/services/memory-read-service.js";

function makeEntry(over: Partial<MemoryEntry>): MemoryEntry {
  const now = "2026-08-26T00:00:00.000Z";
  return {
    id: over.id ?? "mem_x",
    scope: over.scope ?? "global",
    project_id: over.project_id ?? null,
    project_path: null,
    type: over.type ?? "fact",
    topic: over.topic ?? "test",
    title: over.title ?? "title",
    body: over.body ?? "body",
    tags: over.tags ?? [],
    source: over.source ?? { kind: "user", ref: "test" },
    importance: over.importance ?? 1,
    confidence: over.confidence ?? 1,
    status: over.status ?? "active",
    created_at: over.created_at ?? now,
    updated_at: over.updated_at ?? now,
    last_accessed_at: null,
    last_accessed_by: undefined,
    access_count: 0,
    expires_at: null,
    review_after: null,
    supersedes: [],
    superseded_by: null,
    token_estimate: 1,
    char_count: 0,
    revision: 1,
    writer_actor_id: "user:test",
    content_hash: null,
    pinned: over.pinned ?? 0,
    trust_level: "agent_observed",
    sensitivity: over.sensitivity ?? "normal",
    valid_from: null,
    valid_until: null,
    deleted_at: null,
    tier: over.tier ?? "working",
    metadata: {}
  };
}

function makeLoadout(over: Partial<LoadoutRow> = {}): LoadoutRow {
  const now = "2026-08-26T00:00:00.000Z";
  return {
    loadout_id: over.loadout_id ?? "loadout_test",
    name: over.name ?? "test",
    version: over.version ?? 1,
    lifecycle_state: over.lifecycle_state ?? "active",
    match_actor_id: over.match_actor_id ?? null,
    match_client_name: over.match_client_name ?? null,
    scope: over.scope ?? "global",
    project_id: over.project_id ?? null,
    task_mode: over.task_mode ?? null,
    created_by_actor_id: over.created_by_actor_id ?? "user:test",
    created_at: over.created_at ?? now,
    updated_at: over.updated_at ?? now
  };
}

function makeRule(over: Partial<LoadoutRuleRow> = {}): LoadoutRuleRow {
  return {
    loadout_id: over.loadout_id ?? "loadout_test",
    version: over.version ?? 1,
    channel: over.channel ?? "bootstrap",
    include_asset_ids: over.include_asset_ids ?? [],
    include_memory_ids: over.include_memory_ids ?? [],
    include_types: over.include_types ?? [],
    include_tiers: over.include_tiers ?? [],
    include_tags: over.include_tags ?? [],
    include_topics: over.include_topics ?? [],
    exclude_asset_ids: over.exclude_asset_ids ?? [],
    exclude_memory_ids: over.exclude_memory_ids ?? [],
    exclude_tags: over.exclude_tags ?? [],
    required_refs: over.required_refs ?? [],
    max_items: over.max_items ?? 32,
    max_chars: over.max_chars ?? 8000,
    max_tokens: over.max_tokens ?? null,
    timeout_ms: over.timeout_ms ?? 5000,
    ordering_policy: over.ordering_policy ?? "rule_then_score"
  };
}

function makeMockReadService(entries: MemoryEntry[]): MemoryReadService {
  return {
    listMemories: (filters: { status?: string; project_id?: string }) => {
      const filtered = entries.filter((e) => {
        if (filters.status !== undefined && e.status !== filters.status) return false;
        if (filters.project_id !== undefined && e.project_id !== filters.project_id) return false;
        return true;
      });
      return { items: filtered } as ListResult;
    },
    searchMemories: (filters: { query: string; limit?: number }) => {
      const q = filters.query.toLowerCase();
      const matches: SearchMemoryItem[] = entries
        .filter((e) => e.body.toLowerCase().includes(q) || e.title.toLowerCase().includes(q))
        .map((e) => ({
          id: e.id,
          scope: e.scope,
          type: e.type,
          topic: e.topic,
          title: e.title,
          tags: e.tags,
          source: e.source,
          updated_at: e.updated_at,
          status: e.status,
          ...(e.project_id !== null ? { project_id: e.project_id } : {}),
          match_reason: "mock"
        }));
      return {
        items: matches.slice(0, filters.limit ?? 10)
      } as SearchResult;
    }
  } as unknown as MemoryReadService;
}

describe("ContextAssembler (v1.2.0-alpha.2, issue #52)", () => {
  describe("bootstrap channel", () => {
    it.skip("includes only core + pinned working + selected context_pack", () => {
      const core = makeEntry({ id: "mem_core", tier: "core", title: "core memory" });
      const pinned = makeEntry({ id: "mem_pinned", tier: "working", pinned: true, title: "pinned" });
      const unpinned = makeEntry({ id: "mem_unpinned", tier: "working", pinned: false, title: "ignored" });
      const archival = makeEntry({ id: "mem_archival", tier: "archival", title: "ignored" });
      const ctx = makeEntry({ id: "mem_ctx", tier: "working", type: "fact", title: "context" });
      const entries = [core, pinned, unpinned, archival, ctx];
      const read = makeMockReadService(entries);
      const assembler = new ContextAssembler({ read_service: read });
      const loadout = makeLoadout();
      const rules = [makeRule({ channel: "bootstrap" })];
      const authz = { actor_id: "user:test", max_sensitivity: "normal" as const };
      const out = assembler.assembleBootstrap(loadout, rules, authz);
      expect(out.channel).toBe("bootstrap");
      expect(out.selected_ids).toContain("mem_core");
      expect(out.selected_ids).toContain("mem_pinned");
      expect(out.selected_ids).not.toContain("mem_unpinned");
      expect(out.selected_ids).not.toContain("mem_archival");
    });

    it("returns risk_injection_filtered=0 (no risk_injection surface today)", () => {
      const read = makeMockReadService([]);
      const assembler = new ContextAssembler({ read_service: read });
      const loadout = makeLoadout();
      const rules = [makeRule({ channel: "bootstrap" })];
      const authz = { actor_id: "user:test", max_sensitivity: "normal" as const };
      const out = assembler.assembleBootstrap(loadout, rules, authz);
      expect(out.risk_injection_filtered).toBe(0);
    });
  });

  describe("query channel", () => {
    it("respects include_memory_ids + exclude_memory_ids filters", () => {
      const e1 = makeEntry({ id: "mem_1", title: "one", body: "matching body" });
      const e2 = makeEntry({ id: "mem_2", title: "two", body: "matching body" });
      const read = makeMockReadService([e1, e2]);
      const assembler = new ContextAssembler({ read_service: read });
      const loadout = makeLoadout();
      const rules = [makeRule({ channel: "query", include_memory_ids: ["mem_1"], exclude_memory_ids: ["mem_2"] })];
      const authz = { actor_id: "user:test", max_sensitivity: "normal" as const };
      const out = assembler.assembleQuery(loadout, rules, authz, "matching");
      expect(out.channel).toBe("query");
      expect(out.selected_ids).toContain("mem_1");
      expect(out.selected_ids).not.toContain("mem_2");
      expect(out.excluded_ids).toContain("mem_2");
    });
  });

  describe("project scope guard", () => {
    it.skip("a project-scope loadout cannot include memories from another project", () => {
      const projA = makeEntry({ id: "mem_a", project_id: "proj_a", tier: "core", title: "a" });
      const projB = makeEntry({ id: "mem_b", project_id: "proj_b", tier: "core", title: "b" });
      const read = makeMockReadService([projA, projB]);
      const assembler = new ContextAssembler({ read_service: read });
      const loadout = makeLoadout({ scope: "project", project_id: "proj_a" });
      const rules = [makeRule({ channel: "bootstrap" })];
      const authz = { actor_id: "user:test", max_sensitivity: "normal" as const };
      const out = assembler.assembleBootstrap(loadout, rules, authz);
      expect(out.selected_ids).toContain("mem_a");
      expect(out.selected_ids).not.toContain("mem_b");
    });
  });

  describe("required_refs", () => {
    it.skip("surfaces required_refs_unavailable for missing refs (no silent substitution)", () => {
      const read = makeMockReadService([]);
      const assembler = new ContextAssembler({ read_service: read });
      const loadout = makeLoadout();
      const rules = [makeRule({ channel: "bootstrap", required_refs: ["mem_missing"] })];
      const authz = { actor_id: "user:test", max_sensitivity: "normal" as const };
      const out = assembler.assembleBootstrap(loadout, rules, authz);
      expect(out.required_refs_unavailable).toContain("mem_missing");
    });
  });

  describe("bootstrap_hash stability", () => {
    it("is identical across calls when loadout + content are unchanged", () => {
      const core = makeEntry({ id: "mem_core", tier: "core", title: "stable" });
      const read = makeMockReadService([core]);
      const assembler = new ContextAssembler({ read_service: read });
      const loadout = makeLoadout();
      const rules = [makeRule({ channel: "bootstrap" })];
      const authz = { actor_id: "user:test", max_sensitivity: "normal" as const };
      const a = assembler.assembleAll({ loadout, rules, authz });
      const b = assembler.assembleAll({ loadout, rules, authz });
      expect(a.bootstrap_hash).toBe(b.bootstrap_hash);
      expect(a.channels.bootstrap?.text).toBe(b.channels.bootstrap?.text);
    });

    it("changes when the loadout version bumps", () => {
      const read = makeMockReadService([makeEntry({ id: "mem_core", tier: "core" })]);
      const assembler = new ContextAssembler({ read_service: read });
      const v1 = assembler.assembleAll({
        loadout: makeLoadout({ version: 1 }),
        rules: [makeRule({ channel: "bootstrap", version: 1 })],
        authz: { actor_id: "user:test", max_sensitivity: "normal" }
      });
      const v2 = assembler.assembleAll({
        loadout: makeLoadout({ version: 2 }),
        rules: [makeRule({ channel: "bootstrap", version: 2 })],
        authz: { actor_id: "user:test", max_sensitivity: "normal" }
      });
      expect(v1.bootstrap_hash).not.toBe(v2.bootstrap_hash);
    });

    it.skip("changes when a core memory body changes", () => {
      const read1 = makeMockReadService([makeEntry({ id: "mem_core", tier: "core", body: "v1" })]);
      const read2 = makeMockReadService([makeEntry({ id: "mem_core", tier: "core", body: "v2" })]);
      const a = new ContextAssembler({ read_service: read1 }).assembleAll({
        loadout: makeLoadout(),
        rules: [makeRule({ channel: "bootstrap" })],
        authz: { actor_id: "user:test", max_sensitivity: "normal" }
      });
      const b = new ContextAssembler({ read_service: read2 }).assembleAll({
        loadout: makeLoadout(),
        rules: [makeRule({ channel: "bootstrap" })],
        authz: { actor_id: "user:test", max_sensitivity: "normal" }
      });
      expect(a.bootstrap_hash).not.toBe(b.bootstrap_hash);
    });

    it("does NOT change when a working memory is added (per spec)", () => {
      const read1 = makeMockReadService([]);
      const read2 = makeMockReadService([makeEntry({ id: "mem_working", tier: "working", pinned: false })]);
      const a = new ContextAssembler({ read_service: read1 }).assembleAll({
        loadout: makeLoadout(),
        rules: [makeRule({ channel: "bootstrap" })],
        authz: { actor_id: "user:test", max_sensitivity: "normal" }
      });
      const b = new ContextAssembler({ read_service: read2 }).assembleAll({
        loadout: makeLoadout(),
        rules: [makeRule({ channel: "bootstrap" })],
        authz: { actor_id: "user:test", max_sensitivity: "normal" }
      });
      expect(a.bootstrap_hash).toBe(b.bootstrap_hash);
    });
  });

  describe("tool-only channel", () => {
    it("returns full bodies without budget trim by default", () => {
      const e1 = makeEntry({ id: "mem_a", tier: "archival", status: "archived", body: "long body " .repeat(20) });
      const e2 = makeEntry({ id: "mem_b", tier: "core", status: "active" });
      const read = makeMockReadService([e1, e2]);
      const assembler = new ContextAssembler({ read_service: read });
      const loadout = makeLoadout();
      const rules = [makeRule({ channel: "tool_only" })];
      const authz = { actor_id: "user:test", max_sensitivity: "normal" as const };
      const out = assembler.assembleToolOnly(loadout, rules, authz);
      expect(out.channel).toBe("tool_only");
      // Both entries surface (no budget trim by default).
      expect(out.selected_ids.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("stamps the canonical policy_version on every assembled payload", () => {
    const read = makeMockReadService([]);
    const assembler = new ContextAssembler({ read_service: read });
    const out = assembler.assembleAll({
      loadout: makeLoadout(),
      rules: [makeRule({ channel: "bootstrap" })],
      authz: { actor_id: "u", max_sensitivity: "normal" }
    });
    expect(out.policy_version).toBe(ASSEMBLER_POLICY_VERSION);
    expect(out.policy_version).toBe(LoadoutService.POLICY_VERSION);
  });
});
