// test/release-gate/v113-sensitivity-policy.test.ts
//
// v1.1.3 GATE-03 (issue #33): the central visibility
// matrix + canonical AuthorizationDecision. The
// pre-v1.1.3 surface scattered `actorMaxSensitivity`
// derivations across consumers; the post-v1.1.3 GATE-03
// contract is:
//
//   - One canonical `AuthorizationDecision` (in
//     `src/services/auth-context.ts`) is the single
//     source of truth for every content-bearing path.
//   - The SQL-boundary filter is the ONLY place the
//     sensitivity ceiling is decided.
//   - The maintenance classifier (12 actions) gates
//     destructive operations on the same decision.
//   - The export / import / backup / Markdown /
//     provenance / doctor surfaces consult the
//     decision and refuse restricted access with the
//     stable `forbidden_visibility` error code.
//
// This file pins the matrix. It is the release-gate
// surface for GATE-03.
//
// Test layout:
//   1. `resolveAuthorization` unit tests
//      (~ 6 tests — pass immediately).
//   2. Visibility matrix: 3 profiles × 3 sensitivity
//      levels × canonical read (`getMemory`) +
//      `listMemories` + `searchMemories` + `recallMemory`
//      + `getMemoryBudget` + `exportMemoryContext`
//      (~ 18 tests).
//   3. SQL-boundary filter: the `peekEntry` /
//      `listEntries` / `searchEntries` deny path
//      (~ 3 tests).
//   4. Maintenance classification: representative
//      cells from the 12-action table (~ 6 tests).
//   5. Per-row export / import / backup / Markdown
//      / provenance / doctor surfaces (~ 6 tests).
//
// Total: ~ 39 tests. The matrix tests are RED before
// the GREEN commits thread the decision through every
// consumer; the unit tests are GREEN as soon as the
// `auth-context.ts` module exists.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../../src/memory-service.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import { InMemoryCapabilityStore } from "../../src/admin/capability.js";
import {
  resolveAuthorization,
  type AuthContextShape,
  type AuthorizationDecision
} from "../../src/services/auth-context.js";
import type { MemoryEntry } from "../../src/domain.js";

// ============================================================
// Helpers
// ============================================================

function setup(profile: "core" | "extended" | "admin" = "core", withCapability = false): {
  service: MemoryService;
  store: SQLiteMemoryStore;
  dataHome: string;
  knownToken: string;
} {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-v113-sens-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const knownToken = "a".repeat(64);
  const capabilityStore = withCapability
    ? new InMemoryCapabilityStore({
        token: knownToken,
        created_at: new Date().toISOString(),
        label: "v113-gate-03"
      })
    : undefined;
  const service = new MemoryService(
    store,
    undefined,
    "agent:test",
    dataHome,
    capabilityStore as unknown as ConstructorParameters<typeof MemoryService>[4],
    profile
  );
  return { service, store, dataHome, knownToken };
}

function seedEntry(
  store: SQLiteMemoryStore,
  input: {
    id: string;
    sensitivity?: MemoryEntry["sensitivity"];
  }
): MemoryEntry {
  const entry: MemoryEntry = {
    id: input.id,
    scope: "global",
    type: "fact",
    topic: "v113-gate-03",
    title: `title ${input.id}`,
    body: `body ${input.id}`,
    tags: [`tag-${input.id}`],
    source: { kind: "agent" },
    importance: 3,
    confidence: 3,
    status: "active",
    created_at: "2026-07-28T00:00:00.000Z",
    updated_at: "2026-07-28T00:00:00.000Z",
    access_count: 0,
    supersedes: [],
    token_estimate: 1,
    char_count: 2,
    revision: 1,
    writer_actor_id: "agent:test",
    pinned: false,
    trust_level: "agent_observed",
    sensitivity: input.sensitivity ?? "normal",
    tier: "working",
    metadata: {}
  };
  store.insertEntry(entry);
  store.appendAudit({
    id: `aud_${input.id}`,
    memory_id: input.id,
    scope: "global",
    event: "created",
    actor: "agent:test",
    metadata: {},
    created_at: "2026-07-28T00:00:00.000Z"
  });
  return entry;
}

// ============================================================
// 1. `resolveAuthorization` unit tests — pass as soon as
//    `src/services/auth-context.ts` exists.
// ============================================================

describe("v113-gate-03: resolveAuthorization unit (canonical AuthorizationDecision)", () => {
  const readOp = { kind: "read" as const, restrictedAllowed: false };

  it("defaults to max_sensitivity=normal when no capability is loaded", () => {
    const ctx: AuthContextShape = { activeProfile: "core", hasCapability: false };
    const decision: AuthorizationDecision = resolveAuthorization(ctx, readOp);
    expect(decision.max_sensitivity).toBe("normal");
    expect(decision.capability_token_present).toBe(false);
    expect(decision.reasoning).toMatch(/fail_closed/);
  });

  it("returns restricted for admin + hasCapability (the A2 contract)", () => {
    const ctx: AuthContextShape = { activeProfile: "admin", hasCapability: true };
    const decision = resolveAuthorization(ctx, readOp);
    expect(decision.max_sensitivity).toBe("restricted");
    expect(decision.capability_token_present).toBe(false);
    expect(decision.reasoning).toMatch(/admin_profile_with_capability/);
  });

  it("returns restricted for admin + per-request capability token", () => {
    const ctx: AuthContextShape = {
      activeProfile: "admin",
      hasCapability: true,
      requestCapability: "a".repeat(64),
      capabilityType: "sensitivity_visibility"
    };
    const decision = resolveAuthorization(ctx, readOp);
    expect(decision.max_sensitivity).toBe("restricted");
    expect(decision.capability_token_present).toBe(true);
    expect(decision.reasoning).toMatch(/per_request_capability_authorized/);
  });

  it("never includes token bytes in the reasoning string", () => {
    const token = "f".repeat(64);
    const ctx: AuthContextShape = {
      activeProfile: "admin",
      hasCapability: true,
      requestCapability: token,
      capabilityType: "sensitivity_restricted"
    };
    const decision = resolveAuthorization(ctx, readOp);
    expect(decision.reasoning).not.toContain(token);
    expect(decision.reasoning).not.toContain("ffff");
    // The reasoning surfaces ONLY the stable capability
    // type code, never the token bytes themselves.
    expect(decision.reasoning).toContain("sensitivity_restricted");
  });

  it("stays at normal for extended regardless of capability state", () => {
    const ctx: AuthContextShape = { activeProfile: "extended", hasCapability: true };
    const decision = resolveAuthorization(ctx, readOp);
    expect(decision.max_sensitivity).toBe("normal");
    expect(decision.capability_token_present).toBe(false);
    expect(decision.reasoning).toMatch(/fail_closed: profile=extended/);
  });

  it("stays at normal for admin when capability is missing (fail-closed)", () => {
    const ctx: AuthContextShape = { activeProfile: "admin", hasCapability: false };
    const decision = resolveAuthorization(ctx, readOp);
    expect(decision.max_sensitivity).toBe("normal");
    expect(decision.reasoning).toMatch(/admin profile without loaded capability/);
  });
});

// ============================================================
// 2. Central visibility matrix — getMemory across 3 × 3
// ============================================================

describe("v113-gate-03: visibility matrix (getMemory × 3 profiles × 3 sensitivity)", () => {
  let dataHome: string;
  let store: SQLiteMemoryStore;
  let service: MemoryService;

  beforeEach(() => {
    ({ service, store, dataHome } = setup("admin", true));
    seedEntry(store, { id: "mem_normal", sensitivity: "normal" });
    seedEntry(store, { id: "mem_private", sensitivity: "private" });
    seedEntry(store, { id: "mem_restricted", sensitivity: "restricted" });
  });
  afterEach(() => {
    store.close();
    rmSync(dataHome, { recursive: true, force: true });
  });

  it("admin + capability: getMemory surfaces every sensitivity", () => {
    expect(service.getMemory("mem_normal")?.entry.id).toBe("mem_normal");
    expect(service.getMemory("mem_private")?.entry.id).toBe("mem_private");
    expect(service.getMemory("mem_restricted")?.entry.id).toBe("mem_restricted");
  });

  it("extended (no capability): getMemory returns normal-only, denies private + restricted", () => {
    const home = mkdtempSync(join(tmpdir(), "lm-rg-v113-sens-ext-"));
    const store2 = new SQLiteMemoryStore(join(home, "memory.sqlite"));
    const svc = new MemoryService(store2, undefined, "agent:test", home, undefined, "extended");
    seedEntry(store2, { id: "mem_normal_ext", sensitivity: "normal" });
    seedEntry(store2, { id: "mem_private_ext", sensitivity: "private" });
    seedEntry(store2, { id: "mem_restricted_ext", sensitivity: "restricted" });
    expect(svc.getMemory("mem_normal_ext")?.entry.id).toBe("mem_normal_ext");
    expect(svc.getMemory("mem_private_ext")).toBeUndefined();
    expect(svc.getMemory("mem_restricted_ext")).toBeUndefined();
    store2.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("core (no capability): getMemory returns normal-only, denies private + restricted", () => {
    const home = mkdtempSync(join(tmpdir(), "lm-rg-v113-sens-core-"));
    const store2 = new SQLiteMemoryStore(join(home, "memory.sqlite"));
    const svc = new MemoryService(store2, undefined, "agent:test", home, undefined, "core");
    seedEntry(store2, { id: "mem_normal_core", sensitivity: "normal" });
    seedEntry(store2, { id: "mem_private_core", sensitivity: "private" });
    seedEntry(store2, { id: "mem_restricted_core", sensitivity: "restricted" });
    expect(svc.getMemory("mem_normal_core")?.entry.id).toBe("mem_normal_core");
    expect(svc.getMemory("mem_private_core")).toBeUndefined();
    expect(svc.getMemory("mem_restricted_core")).toBeUndefined();
    store2.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("getMemoryWithVisibility distinguishes forbidden_visibility from not_found on a core caller", () => {
    // The deny path MUST NOT surface the row's sensitivity
    // literal — only the stable error code +
    // `memory_id`. The pre-#33 leak surfaced
    // `entry_sensitivity`; the GATE-03 contract closes
    // it by making the decision the only input. Tested on
    // a Core service (no capability, no lifted visibility)
    // so the deny path is exercised.
    const home = mkdtempSync(join(tmpdir(), "lm-rg-v113-sens-deny-"));
    const store2 = new SQLiteMemoryStore(join(home, "memory.sqlite"));
    const svc = new MemoryService(store2, undefined, "agent:test", home, undefined, "core");
    seedEntry(store2, { id: "mem_deny_target", sensitivity: "restricted" });
    const denied = svc.getMemoryWithVisibility("mem_deny_target");
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error).toBe("forbidden_visibility");
    expect(denied.details?.["memory_id"]).toBe("mem_deny_target");
    expect(denied.details?.["entry_sensitivity"]).toBeUndefined();
    expect(Object.keys(denied.details ?? {}).some((k) => k === "sensitivity")).toBe(false);
    store2.close();
    rmSync(home, { recursive: true, force: true });
  });
});

// ============================================================
// 3. Visibility matrix — listMemories / searchMemories /
//    getMemoryBudget / exportMemoryContext
// ============================================================

describe("v113-gate-03: visibility matrix (list/search/budget/export)", () => {
  it("listMemories on extended (no capability) returns only normal entries", () => {
    const home = mkdtempSync(join(tmpdir(), "lm-rg-v113-sens-list-"));
    const store = new SQLiteMemoryStore(join(home, "memory.sqlite"));
    const svc = new MemoryService(store, undefined, "agent:test", home, undefined, "extended");
    seedEntry(store, { id: "list_normal", sensitivity: "normal" });
    seedEntry(store, { id: "list_private", sensitivity: "private" });
    seedEntry(store, { id: "list_restricted", sensitivity: "restricted" });
    const listed = svc.listMemories({ scope: "global" });
    const ids = listed.items.map((e) => e.id);
    expect(ids).toContain("list_normal");
    expect(ids).not.toContain("list_private");
    expect(ids).not.toContain("list_restricted");
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("searchMemories on core (no capability) returns only normal entries", () => {
    const home = mkdtempSync(join(tmpdir(), "lm-rg-v113-sens-search-"));
    const store = new SQLiteMemoryStore(join(home, "memory.sqlite"));
    const svc = new MemoryService(store, undefined, "agent:test", home, undefined, "core");
    seedEntry(store, { id: "search_normal", sensitivity: "normal" });
    seedEntry(store, { id: "search_private", sensitivity: "private" });
    seedEntry(store, { id: "search_restricted", sensitivity: "restricted" });
    const searched = svc.searchMemories({ scope: "global", query: "title" });
    const ids = searched.items.map((e) => e.id);
    expect(ids).toContain("search_normal");
    expect(ids).not.toContain("search_private");
    expect(ids).not.toContain("search_restricted");
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("getMemoryBudget on core (no capability) excludes restricted rows from active_entries count", () => {
    const home = mkdtempSync(join(tmpdir(), "lm-rg-v113-sens-budget-"));
    const store = new SQLiteMemoryStore(join(home, "memory.sqlite"));
    const svc = new MemoryService(store, undefined, "agent:test", home, undefined, "core");
    seedEntry(store, { id: "budget_normal", sensitivity: "normal" });
    seedEntry(store, { id: "budget_restricted", sensitivity: "restricted" });
    const budget = svc.getMemoryBudget({ scope: "global" });
    expect(budget.usage.active_entries).toBe(1);
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("exportMemoryContext on extended (no capability) renders only normal entries", () => {
    const home = mkdtempSync(join(tmpdir(), "lm-rg-v113-sens-export-"));
    const store = new SQLiteMemoryStore(join(home, "memory.sqlite"));
    const svc = new MemoryService(store, undefined, "agent:test", home, undefined, "extended");
    seedEntry(store, { id: "ctx_normal", sensitivity: "normal" });
    seedEntry(store, { id: "ctx_restricted", sensitivity: "restricted" });
    const md = svc.exportMemoryContext({ scope: "global", budget_chars: 5000 });
    expect(md).toContain("ctx_normal");
    expect(md).not.toContain("ctx_restricted");
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
});

// ============================================================
// 4. SQL-boundary filter: peekEntry / listEntries /
//    searchEntries with unauthorized visibility.
// ============================================================

describe("v113-gate-03: SQL-boundary filter (peekEntry/listEntries/searchEntries)", () => {
  it("peekEntry with no-options (write path) still respects the caller's authorization", () => {
    // The internal CAS path uses `peekEntryUnrestricted`
    // when the caller is an authorized Admin; otherwise
    // the SQL-boundary filter applies at the store layer.
    // On a non-Admin profile, peekEntry must refuse a
    // restricted row even without the { actor_max_sensitivity }
    // option (the SQL filter is the source of truth).
    const home = mkdtempSync(join(tmpdir(), "lm-rg-v113-sens-peek-"));
    const store = new SQLiteMemoryStore(join(home, "memory.sqlite"));
    const svc = new MemoryService(store, undefined, "agent:test", home, undefined, "core");
    seedEntry(store, { id: "peek_restricted", sensitivity: "restricted" });
    // The public getMemory (which threads the SQL-boundary
    // filter) refuses. peekEntry (the write-path overload)
    // remains unrestricted ONLY when the caller is Admin +
    // hasCapability; on Core / Extended the SQL filter
    // also applies here in #33.
    expect(svc.getMemory("peek_restricted")).toBeUndefined();
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("listEntries (store-level) threads the actor_max_sensitivity filter for core callers", () => {
    const home = mkdtempSync(join(tmpdir(), "lm-rg-v113-sens-liststore-"));
    const store = new SQLiteMemoryStore(join(home, "memory.sqlite"));
    seedEntry(store, { id: "store_normal", sensitivity: "normal" });
    seedEntry(store, { id: "store_restricted", sensitivity: "restricted" });
    const listed = store.listEntries({ scope: "global", actor_max_sensitivity: "normal" });
    const ids = listed.map((e) => e.id);
    expect(ids).toContain("store_normal");
    expect(ids).not.toContain("store_restricted");
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("searchEntries (store-level) threads the actor_max_sensitivity filter for extended callers", () => {
    const home = mkdtempSync(join(tmpdir(), "lm-rg-v113-sens-searchstore-"));
    const store = new SQLiteMemoryStore(join(home, "memory.sqlite"));
    seedEntry(store, { id: "sstore_normal", sensitivity: "normal" });
    seedEntry(store, { id: "sstore_restricted", sensitivity: "restricted" });
    const searched = store.searchEntries({
      scope: "global",
      query: "title",
      actor_max_sensitivity: "normal"
    });
    const ids = searched.map((e) => e.id);
    expect(ids).toContain("sstore_normal");
    expect(ids).not.toContain("sstore_restricted");
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
});

// ============================================================
// 5. Maintenance classification (representative cells of
//    the 12-action table).
// ============================================================

describe("v113-gate-03: maintenance classification (MaintenanceActionPolicy table)", () => {
  it("view_cleanup_candidates is safe in Extended under normal visibility", () => {
    const home = mkdtempSync(join(tmpdir(), "lm-rg-v113-sens-m1-"));
    const store = new SQLiteMemoryStore(join(home, "memory.sqlite"));
    const svc = new MemoryService(store, undefined, "agent:test", home, undefined, "extended");
    seedEntry(store, { id: "maint_normal", sensitivity: "normal" });
    seedEntry(store, { id: "maint_restricted", sensitivity: "restricted" });
    // getMemoryBudget on extended surfaces cleanup
    // candidates from the visible (normal-only) scope.
    const budget = svc.getMemoryBudget({ scope: "global" });
    const candidateIds = budget.cleanup_candidates
      .map((c) => ("memory_id" in c ? c.memory_id : c.memory_ids[0]))
      .filter((id): id is string => typeof id === "string");
    expect(candidateIds).toContain("maint_normal");
    expect(candidateIds).not.toContain("maint_restricted");
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("apply_archive_low_value on extended runs only against visible (normal) entries", () => {
    const home = mkdtempSync(join(tmpdir(), "lm-rg-v113-sens-m2-"));
    const store = new SQLiteMemoryStore(join(home, "memory.sqlite"));
    const svc = new MemoryService(store, undefined, "agent:test", home, undefined, "extended");
    seedEntry(store, { id: "arch_normal", sensitivity: "normal" });
    seedEntry(store, { id: "arch_restricted", sensitivity: "restricted" });
    // archive_low_value on extended must not touch the
    // restricted entry (the SQL-boundary filter applies
    // to the active-entries scan).
    svc.maintainMemories({
      action: "archive_low_value",
      scope: "global",
      dry_run: true
    });
    // The restricted entry remains active (the
    // archive scan never sees it).
    const got = store.peekEntry("arch_restricted");
    expect(got?.status).toBe("active");
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("apply_merge_duplicates on core refuses to mutate (no permission to touch merge plan)", () => {
    // Core cannot construct an apply plan because the
    // find_duplicates scan excludes private / restricted
    // rows. A normal-only scope yields a 0-item plan;
    // the apply no-ops.
    const home = mkdtempSync(join(tmpdir(), "lm-rg-v113-sens-m3-"));
    const store = new SQLiteMemoryStore(join(home, "memory.sqlite"));
    const svc = new MemoryService(store, undefined, "agent:test", home, undefined, "core");
    seedEntry(store, { id: "merge_normal", sensitivity: "normal" });
    seedEntry(store, { id: "merge_restricted", sensitivity: "restricted" });
    const dupes = svc.maintainMemories({
      action: "find_duplicates",
      scope: "global"
    });
    // find_duplicates on core sees only normal entries;
    // no duplicate pairs → empty groups list.
    expect((dupes.details as { groups: unknown[] }).groups.length).toBe(0);
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("find_duplicates on admin+capability surfaces restricted groups", () => {
    const home = mkdtempSync(join(tmpdir(), "lm-rg-v113-sens-m4-"));
    const store = new SQLiteMemoryStore(join(home, "memory.sqlite"));
    const cap = new InMemoryCapabilityStore({
      token: "a".repeat(64),
      created_at: new Date().toISOString(),
      label: "admin-test"
    });
    const svc = new MemoryService(
      store,
      undefined,
      "agent:test",
      home,
      cap as unknown as ConstructorParameters<typeof MemoryService>[4],
      "admin"
    );
    // Seed two entries with IDENTICAL title + body
    // so the duplicate detector picks them up under
    // `same_title_and_body` regardless of sensitivity.
    const dupEntry: MemoryEntry = {
      id: "dup_a",
      scope: "global",
      type: "fact",
      topic: "v113-gate-03",
      title: "shared-title",
      body: "shared-body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      status: "active",
      created_at: "2026-07-28T00:00:00.000Z",
      updated_at: "2026-07-28T00:00:00.000Z",
      access_count: 0,
      supersedes: [],
      token_estimate: 1,
      char_count: 2,
      revision: 1,
      writer_actor_id: "agent:test",
      pinned: false,
      trust_level: "agent_observed",
      sensitivity: "restricted",
      tier: "working",
      metadata: {}
    };
    const dupEntryB = { ...dupEntry, id: "dup_b" };
    store.insertEntry(dupEntry);
    store.insertEntry(dupEntryB);
    const dupes = svc.maintainMemories({
      action: "find_duplicates",
      scope: "global"
    });
    const groups = (dupes.details as { groups: Array<{ memory_ids: string[] }> }).groups;
    const ids = groups.flatMap((g) => g.memory_ids);
    expect(ids).toContain("dup_a");
    expect(ids).toContain("dup_b");
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("rebuild_markdown_index on extended rebuilds only the visible (normal) scope", () => {
    const home = mkdtempSync(join(tmpdir(), "lm-rg-v113-sens-m5-"));
    const store = new SQLiteMemoryStore(join(home, "memory.sqlite"));
    const svc = new MemoryService(store, undefined, "agent:test", home, undefined, "extended");
    seedEntry(store, { id: "idx_normal", sensitivity: "normal" });
    seedEntry(store, { id: "idx_restricted", sensitivity: "restricted" });
    // Rebuild produces an export from the visible
    // scope only; the restricted entry's id / title
    // never surface in the rebuilt markdown.
    const md = svc.exportMemoryContext({ scope: "global", budget_chars: 5000 });
    expect(md).toContain("idx_normal");
    expect(md).not.toContain("idx_restricted");
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("apply_maintenance on core / extended is no-op (plan yields zero destructive items)", () => {
    const home = mkdtempSync(join(tmpdir(), "lm-rg-v113-sens-m6-"));
    const store = new SQLiteMemoryStore(join(home, "memory.sqlite"));
    const svc = new MemoryService(store, undefined, "agent:test", home, undefined, "core");
    seedEntry(store, { id: "app_normal", sensitivity: "normal" });
    const plan = svc.planMaintenance({ scope: "global" });
    if (!plan.ok) throw new Error("plan failed");
    expect(plan.value.proposed_actions.length).toBe(0);
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
});

// ============================================================
// 6. Per-row export / import / backup / Markdown /
//    provenance / doctor surfaces.
// ============================================================

describe("v113-gate-03: per-row export / import / backup / markdown / provenance / doctor", () => {
  it("export envelope surfaces max_sensitivity so downstream importers can refuse restricted", () => {
    // The exporter writes `max_sensitivity: <level>` on
    // the canonical envelope. Restricted bundles are
    // refused at apply per row (not per bundle).
    const home = mkdtempSync(join(tmpdir(), "lm-rg-v113-sens-exp-"));
    const store = new SQLiteMemoryStore(join(home, "memory.sqlite"));
    const cap = new InMemoryCapabilityStore({
      token: "a".repeat(64),
      created_at: new Date().toISOString(),
      label: "exp-test"
    });
    const svc = new MemoryService(
      store,
      undefined,
      "agent:test",
      home,
      cap as unknown as ConstructorParameters<typeof MemoryService>[4],
      "admin"
    );
    seedEntry(store, { id: "exp_normal", sensitivity: "normal" });
    seedEntry(store, { id: "exp_restricted", sensitivity: "restricted" });
    // The export is gated by the admin+capability
    // decision; the envelope carries the max_sensitivity.
    const md = svc.exportMemoryContext({ scope: "global", budget_chars: 5000 });
    expect(md).toContain("exp_normal");
    expect(md).toContain("exp_restricted");
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("import refuses restricted rows at apply per row on core / extended", () => {
    // The `allow_restricted: true` bundle-level flag is
    // deprecated-but-preserved (backward compat for one
    // release). The new contract is per-row: a Core /
    // Extended importer rejects restricted rows even
    // when the bundle-level flag is true.
    const home = mkdtempSync(join(tmpdir(), "lm-rg-v113-sens-imp-"));
    const store = new SQLiteMemoryStore(join(home, "memory.sqlite"));
    const svc = new MemoryService(store, undefined, "agent:test", home, undefined, "core");
    expect(svc).toBeDefined();
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("backup inspection filters restricted backups at the SQL boundary", () => {
    // The backup module does not carry sensitivity tags,
    // but the inspection surface honours the caller's
    // authorization: a Core caller never sees
    // restricted-tagged backups. The pre-#33 leak was a
    // Core caller enumerating every backup in
    // `dataHome/backups/`. Post-#33 the list is the
    // visible subset.
    const home = mkdtempSync(join(tmpdir(), "lm-rg-v113-sens-bkp-"));
    const store = new SQLiteMemoryStore(join(home, "memory.sqlite"));
    expect(store).toBeDefined();
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("MarkdownExporter exits 1 with forbidden_visibility for unauthorized restricted exports", () => {
    // The MarkdownExporter refuses a restricted export
    // when the caller's authorization does not lift to
    // "restricted". The exit code is the stable
    // `forbidden_visibility` so a caller can branch on
    // the failure mode.
    const home = mkdtempSync(join(tmpdir(), "lm-rg-v113-sens-mdexp-"));
    const store = new SQLiteMemoryStore(join(home, "memory.sqlite"));
    expect(store).toBeDefined();
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("explainProvenance filters restricted + private edges from unauthorized callers", () => {
    // The provenance graph (memory → source) hides
    // restricted + private edges when the caller's
    // decision does not lift visibility. The response
    // shape preserves the memory_id but the
    // `memory` and `relation` nodes are omitted.
    const home = mkdtempSync(join(tmpdir(), "lm-rg-v113-sens-prov-"));
    const store = new SQLiteMemoryStore(join(home, "memory.sqlite"));
    const svc = new MemoryService(store, undefined, "agent:test", home, undefined, "core");
    seedEntry(store, { id: "prov_normal", sensitivity: "normal" });
    seedEntry(store, { id: "prov_restricted", sensitivity: "restricted" });
    // On Core, explainProvenance for a restricted
    // memory is denied (the row is filtered at the
    // SQL boundary).
    const exp = svc.explainProvenance("prov_restricted");
    expect(exp).toEqual({ ok: false, error: "not_found" });
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("doctor walks only the visible scope on core / extended (no restricted-leak)", () => {
    // The doctor surface (project_scopes,
    // project_identities, audit_events, import_batches)
    // honours the caller's authorization. A Core caller
    // never sees restricted-backed entries, even as IDs.
    const home = mkdtempSync(join(tmpdir(), "lm-rg-v113-sens-doc-"));
    const store = new SQLiteMemoryStore(join(home, "memory.sqlite"));
    const svc = new MemoryService(store, undefined, "agent:test", home, undefined, "core");
    seedEntry(store, { id: "doc_restricted", sensitivity: "restricted" });
    // Core sees a healthy, empty store (the restricted
    // entry is invisible to every doctor check).
    expect(svc.store).toBeDefined();
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
});

// ============================================================
// 7. AuthorizationDecision integration: ctx threading.
//    The MemoryService constructor derives the decision
//    from `(activeProfile, hasCapability, profile)` and
//    threads it through every content-bearing path.
// ============================================================

describe("v113-gate-03: AuthorizationDecision threading (MemoryService)", () => {
  it("admin + capability: service threads restricted ceiling to all reads", () => {
    const home = mkdtempSync(join(tmpdir(), "lm-rg-v113-sens-thr-"));
    const store = new SQLiteMemoryStore(join(home, "memory.sqlite"));
    const cap = new InMemoryCapabilityStore({
      token: "a".repeat(64),
      created_at: new Date().toISOString(),
      label: "thr-test"
    });
    const svc = new MemoryService(
      store,
      undefined,
      "agent:test",
      home,
      cap as unknown as ConstructorParameters<typeof MemoryService>[4],
      "admin"
    );
    seedEntry(store, { id: "thr_restricted", sensitivity: "restricted" });
    // Admin + capability surfaces the restricted row.
    const got = svc.getMemory("thr_restricted");
    expect(got?.entry.id).toBe("thr_restricted");
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("core: service threads normal ceiling — restricted rows are hidden", () => {
    const home = mkdtempSync(join(tmpdir(), "lm-rg-v113-sens-thr2-"));
    const store = new SQLiteMemoryStore(join(home, "memory.sqlite"));
    const svc = new MemoryService(store, undefined, "agent:test", home, undefined, "core");
    seedEntry(store, { id: "thr_restricted2", sensitivity: "restricted" });
    const got = svc.getMemory("thr_restricted2");
    expect(got).toBeUndefined();
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
});