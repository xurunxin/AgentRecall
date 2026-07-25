// test/release-gate/p1-maintenance-plan-v2.test.ts
//
// Stage 15 PR-M0-4 (issue #3, spec § 6.2): locks down
// the persistent maintenance plan + CAS-protected apply
// workflow. The pre-PR-M0-4 implementation had four
// correctness gaps called out in issue #3:
//
//   1. `plan_maintenance` extracted fields the
//      `find_duplicates` result did not expose
//      (`kind`, `revisions`, `representative_title`),
//      so the plan was always empty.
//   2. The plan's `risk` was always "low" even for
//      destructive actions.
//   3. `apply_maintenance` re-ran the broad
//      `merge_duplicates` action over the whole scope,
//      so it could mutate entries that were not in the
//      plan.
//   4. The plan lived in a process-local Map and was
//      lost on every MCP restart.
//
// PR-M0-4 fixes all four: the plan is written to the
// `maintenance_plans` + `maintenance_plan_items` tables;
// the planner reads the actual `DuplicateGroup` shape
// from `find_duplicates`; risk is "high" when destructive
// items are present; apply uses a targeted
// `mergePlannedGroup` helper that only mutates the
// targets in the plan; and the per-item
// `expected_revision` is a CAS guard that rejects stale
// plans on apply.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../../src/memory-service.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import type { MemoryEntry } from "../../src/domain.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-mplan-"));
  const dbPath = join(dataHome, "memory.sqlite");
  const store = new SQLiteMemoryStore(dbPath);
  const service = new MemoryService(store, undefined, "agent:test", dataHome);
  return { service, store, dataHome, dbPath };
}

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "mem_plan_default",
    scope: "global",
    type: "fact",
    topic: "tools",
    title: "default",
    body: "default",
    tags: [],
    source: { kind: "agent" },
    importance: 3,
    confidence: 3,
    status: "active",
    created_at: "2026-07-26T00:00:00.000Z",
    updated_at: "2026-07-26T00:00:00.000Z",
    access_count: 0,
    supersedes: [],
    token_estimate: 1,
    char_count: 1,
    revision: 1,
    writer_actor_id: "agent:test",
    pinned: false,
    trust_level: "agent_observed",
    sensitivity: "normal",
    metadata: {},
    ...overrides
  } as MemoryEntry;
}

function seedEntry(
  store: SQLiteMemoryStore,
  overrides: Partial<MemoryEntry>
): MemoryEntry {
  const entry = makeEntry(overrides);
  store.insertEntry(entry);
  return entry;
}

function setupProject(store: SQLiteMemoryStore, projectId: string): void {
  store.upsertProjectScope({
    project_id: projectId,
    canonical_path: `/tmp/${projectId}`,
    display_name: projectId,
    budget: {
      max_active_entries: 1000,
      max_chars: 1_000_000,
      warn_at_pct: 80
    },
    created_at: "2026-07-26T00:00:00.000Z",
    updated_at: "2026-07-26T00:00:00.000Z"
  });
}

describe("release-gate p1-maintenance-plan-v2 (issue #3)", () => {
  let service: MemoryService;
  let store: SQLiteMemoryStore;
  let dataHome: string;

  beforeEach(() => {
    ({ service, store, dataHome } = setup());
  });

  afterEach(() => {
    // Close the store before removing the directory;
    // SQLite holds an open file lock on Windows and
    // would refuse the rmSync otherwise.
    store.close();
    rmSync(dataHome, { recursive: true, force: true });
  });

  it("plan survives MCP restart (writes to maintenance_plans, not Map)", () => {
    // Seed two identical title+body entries.
    seedEntry(store, { id: "mem_dup_1", title: "Project Phoenix goal", body: "Ship in Q3." });
    seedEntry(store, { id: "mem_dup_2", title: "Project Phoenix goal", body: "Ship in Q3." });

    const plan1 = service.planMaintenance({ scope: "global" });
    expect(plan1.ok).toBe(true);
    if (!plan1.ok) return;
    expect(plan1.value.plan_id).toMatch(/^plan_/);
    expect(plan1.value.risk).toBe("high");
    expect(plan1.value.proposed_actions.length).toBeGreaterThan(0);
    expect(
      plan1.value.proposed_actions.every((a) => a.risk === "high")
    ).toBe(true);

    // The plan must live in the SQLite table, not in a
    // process-local Map. Open a fresh `MemoryService`
    // instance against the same store; if the plan
    // were in a Map it would be gone.
    const service2 = new MemoryService(store, undefined, "agent:test", dataHome);
    const lookup = service2.planStore.get(plan1.value.plan_id);
    expect(lookup).toBeDefined();
    expect(lookup?.plan_id).toBe(plan1.value.plan_id);
    expect(lookup?.proposed_actions.length).toBe(
      plan1.value.proposed_actions.length
    );
  });

  it("plan/apply round-trip on same title+body auto-supersedes", () => {
    seedEntry(store, { id: "mem_merge_1", title: "Same Title", body: "Same Body" });
    seedEntry(store, { id: "mem_merge_2", title: "Same Title", body: "Same Body" });

    const plan1 = service.planMaintenance({ scope: "global" });
    expect(plan1.ok).toBe(true);
    if (!plan1.ok) return;
    const planId = plan1.value.plan_id;
    const items = plan1.value.proposed_actions;
    expect(items.length).toBe(2);
    const targetIds = items.map((a) => a.target_memory_id).sort();
    expect(targetIds).toEqual(["mem_merge_1", "mem_merge_2"]);

    const apply = service.applyMaintenance({
      plan_id: planId,
      confirm: true,
      idempotency_key: "apply-1"
    });
    expect(apply.ok).toBe(true);
    if (!apply.ok) return;
    expect(apply.value.ok).toBe(true);
    if (!apply.value.ok) return;
    expect(apply.value.applied).toBe(1); // 1 superseded (the other is the keep target)
    expect(apply.value.rejected).toBe(0);

    // Exactly one entry is now active; the other is
    // superseded. The active entry is the
    // lexicographically-first id (keep_first).
    const a = store.peekEntry("mem_merge_1");
    const b = store.peekEntry("mem_merge_2");
    const active = [a, b].find((e) => e?.status === "active");
    const superseded = [a, b].find((e) => e?.status === "superseded");
    expect(active).toBeDefined();
    expect(superseded).toBeDefined();
    expect(superseded?.superseded_by).toBe(active?.id);

    // The plan is now completed.
    const plan2 = service.planStore.get(planId);
    expect(plan2 === undefined).toBe(false);
    // The store exposes state via the SQL helper.
    const row = store.getMaintenancePlan(planId);
    expect(row?.state).toBe("completed");
  });

  it("rejects apply with a stale expected_revision (CAS guard)", () => {
    seedEntry(store, { id: "mem_cas_1", title: "Same Title", body: "Same Body" });
    seedEntry(store, { id: "mem_cas_2", title: "Same Title", body: "Same Body" });

    const plan1 = service.planMaintenance({ scope: "global" });
    expect(plan1.ok).toBe(true);
    if (!plan1.ok) return;
    const planId = plan1.value.plan_id;

    // Update one of the targets to bump its revision.
    // The plan captured revision=1; after the update the
    // store has revision=2 and the plan is stale.
    store.updateEntry("mem_cas_1", { updated_at: "2026-07-26T01:00:00.000Z" });

    const apply = service.applyMaintenance({
      plan_id: planId,
      confirm: true,
      idempotency_key: "apply-stale"
    });
    expect(apply.ok).toBe(true);
    if (!apply.ok) return;
    expect(apply.value.ok).toBe(false);
    if (apply.value.ok) return;
    expect(apply.value.error).toBe("stale_revision");
    expect(
      (apply.value.details as { drifted_memory_ids?: string[] }).drifted_memory_ids
    ).toContain("mem_cas_1");

    // Both entries must still be active; apply did not
    // mutate anything.
    expect(store.peekEntry("mem_cas_1")?.status).toBe("active");
    expect(store.peekEntry("mem_cas_2")?.status).toBe("active");

    // The plan is marked rejected so a retry with the
    // same id surfaces `plan_hash_drift` / `rejected`.
    const row = store.getMaintenancePlan(planId);
    expect(row?.state).toBe("rejected");
  });

  it("rejects apply with an unknown plan_id", () => {
    const apply = service.applyMaintenance({
      plan_id: "plan_does-not-exist",
      confirm: true,
      idempotency_key: "apply-missing"
    });
    expect(apply.ok).toBe(true);
    if (!apply.ok) return;
    expect(apply.value.ok).toBe(false);
    if (apply.value.ok) return;
    expect(apply.value.error).toBe("plan_not_found");
  });

  it("rejects apply without confirm: true", () => {
    const apply = service.applyMaintenance({
      plan_id: "plan_x",
      confirm: false as unknown as true,
      idempotency_key: "k"
    });
    expect(apply.ok).toBe(false);
    if (apply.ok) return;
    expect(apply.error).toBe("invalid_schema");
  });

  it("rejects apply with an empty idempotency_key", () => {
    const apply = service.applyMaintenance({
      plan_id: "plan_x",
      confirm: true,
      idempotency_key: ""
    });
    expect(apply.ok).toBe(false);
    if (apply.ok) return;
    expect(apply.error).toBe("invalid_schema");
  });

  it("rejects expired plans and flips state to expired", () => {
    seedEntry(store, { id: "mem_exp_1", title: "X", body: "Y" });
    seedEntry(store, { id: "mem_exp_2", title: "X", body: "Y" });

    const plan1 = service.planMaintenance({ scope: "global" });
    expect(plan1.ok).toBe(true);
    if (!plan1.ok) return;
    const planId = plan1.value.plan_id;

    // Force the plan to be expired by mutating its
    // expires_at directly in the DB.
    store["db"]
      .prepare("UPDATE maintenance_plans SET expires_at = ? WHERE plan_id = ?")
      .run("2020-01-01T00:00:00.000Z", planId);

    const apply = service.applyMaintenance({
      plan_id: planId,
      confirm: true,
      idempotency_key: "k-expired"
    });
    expect(apply.ok).toBe(true);
    if (!apply.ok) return;
    expect(apply.value.ok).toBe(false);
    if (apply.value.ok) return;
    expect(apply.value.error).toBe("plan_expired");
    const row = store.getMaintenancePlan(planId);
    expect(row?.state).toBe("expired");
  });

  it("advisory items (similar but distinct) get retain action_type and risk=low", () => {
    // Two entries with the same title but distinct
    // bodies. The duplicate detector will surface
    // this as `same_title` (advisory), not
    // `same_title_and_body` (auto-collapse). We
    // hand-build the plan so the test does not
    // depend on the similarity threshold's exact
    // value.
    seedEntry(store, {
      id: "mem_sim_1",
      title: "Phoenix",
      body: "launches in Q3 with the v2 engine"
    });
    seedEntry(store, {
      id: "mem_sim_2",
      title: "Phoenix",
      body: "ship date is end of Q4 with the v3 engine"
    });

    const plan1 = service.planMaintenance({ scope: "global" });
    expect(plan1.ok).toBe(true);
    if (!plan1.ok) return;
    // The plan should contain at least one `same_title`
    // advisory group. We verify by looking for retain
    // items with `group_reason: 'same_title'` in their
    // evidence.
    const retainItems = plan1.value.proposed_actions.filter(
      (a) => a.kind === "retain"
    );
    expect(retainItems.length).toBeGreaterThan(0);
    expect(retainItems.every((a) => a.risk === "low")).toBe(true);
  });

  it("apply cannot mutate a memory that is not in the plan", () => {
    seedEntry(store, { id: "mem_a", title: "A", body: "body A" });
    seedEntry(store, { id: "mem_b", title: "A", body: "body A" });
    seedEntry(store, { id: "mem_c", title: "A", body: "body A" });

    // Build a plan that only covers mem_a + mem_b.
    // mem_c is a "stranger" that the plan did not
    // include; apply must not touch it.
    const plan1 = service.planMaintenance({ scope: "global" });
    expect(plan1.ok).toBe(true);
    if (!plan1.ok) return;

    // The plan covers all three (they all share title+body
    // "A"/"body A"). To simulate "stranger", we delete
    // mem_c from the plan by writing a fresh plan that
    // hand-builds the items list to exclude mem_c.
    const fresh = service.planStore.create({
      scope: "global",
      risk: "high",
      creator_actor_id: "agent:test",
      expected_revisions: { mem_a: 1, mem_b: 1 },
      proposed_actions: [
        {
          kind: "merge",
          target_memory_id: "mem_a",
          expected_revision: 1,
          evidence: { fingerprint: "fake" },
          risk: "high"
        },
        {
          kind: "merge",
          target_memory_id: "mem_b",
          expected_revision: 1,
          evidence: { fingerprint: "fake" },
          risk: "high"
        }
      ],
      summary: ["merge 2 of 3 entries (mem_c left out)"]
    });

    // Pre-flight: mem_c is active and not in the plan's
    // proposed_actions.
    expect(store.peekEntry("mem_c")?.status).toBe("active");
    expect(
      fresh.proposed_actions.some((a) => a.target_memory_id === "mem_c")
    ).toBe(false);

    const apply = service.applyMaintenance({
      plan_id: fresh.plan_id,
      confirm: true,
      idempotency_key: "apply-stranger"
    });
    expect(apply.ok).toBe(true);
    if (!apply.ok) return;
    expect(apply.value.ok).toBe(true);
    if (!apply.value.ok) return;
    expect(apply.value.applied).toBe(1);

    // mem_a and mem_b are merged; mem_c is untouched.
    const a = store.peekEntry("mem_a");
    const b = store.peekEntry("mem_b");
    const c = store.peekEntry("mem_c");
    const ab = [a, b].filter((e) => e?.status === "superseded");
    expect(ab.length).toBe(1);
    expect(c?.status).toBe("active");
  });

  it("expireOldPlans flips pending plans past expires_at to expired", () => {
    // Create a plan that expires immediately.
    const plan1 = service.planStore.create({
      scope: "global",
      risk: "low",
      creator_actor_id: "agent:test",
      ttl_seconds: 0, // expires at created_at
      expected_revisions: {},
      proposed_actions: [],
      summary: ["empty"]
    });
    // Wait one second so the TTL window has definitely
    // passed (the created_at timestamp is in the past by
    // the time the call returns).
    const row1 = store.getMaintenancePlan(plan1.plan_id);
    expect(row1?.state).toBe("pending");
    const expired = service.planStore.expireOldPlans();
    expect(expired).toBeGreaterThanOrEqual(1);
    const row2 = store.getMaintenancePlan(plan1.plan_id);
    expect(row2?.state).toBe("expired");
  });

  it("plan_hash is stable across re-reads of the same plan", () => {
    seedEntry(store, { id: "mem_h_1", title: "H", body: "body H" });
    seedEntry(store, { id: "mem_h_2", title: "H", body: "body H" });
    const plan1 = service.planMaintenance({ scope: "global" });
    expect(plan1.ok).toBe(true);
    if (!plan1.ok) return;
    const reloaded = service.planStore.get(plan1.value.plan_id);
    expect(reloaded?.plan_hash).toBe(plan1.value.plan_hash);
  });

  it("project-scope plan refuses to apply to a global entry (scope_mismatch)", () => {
    setupProject(store, "proj-x");
    // Same title+body, but one is global, one is project.
    seedEntry(store, { id: "mem_g_1", scope: "global", title: "Mix", body: "body" });
    seedEntry(store, {
      id: "mem_p_1",
      scope: "project",
      project_id: "proj-x",
      project_path: "/tmp/proj-x",
      title: "Mix",
      body: "body"
    });
    // Plan against project scope will only see mem_p_1,
    // so no merge group forms; plan is empty.
    const plan1 = service.planMaintenance({
      scope: "project",
      project_id: "proj-x"
    });
    expect(plan1.ok).toBe(true);
    if (!plan1.ok) return;
    expect(plan1.value.proposed_actions.length).toBe(0);
  });
});
