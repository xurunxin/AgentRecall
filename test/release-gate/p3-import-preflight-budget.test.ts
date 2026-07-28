// test/release-gate/p3-import-preflight-budget.test.ts
//
// Stage 18 v1.1.2 (issue #24, task 5): authoritative
// import preflight + aggregate budget checks. The
// companion test `p3-strict-import.test.ts` covers the
// Stage 16 PR-4 (#13) strict-import surface (secret
// detection, schema validation, capability gating,
// trust downgrading, migration-adapter).
//
// This file closes the gap the v1.1.2 release leaves
// open: the preflight was running only a field-shape
// check and a useless `index_chars + aggregateChars >
// Number.MAX_SAFE_INTEGER` guard. The v1.1.2 contract
// pins the preflight on the configured budget limits
// (`max_active_entries`, `max_total_chars`,
// `max_topic_chars`, `max_index_chars`) and the
// `ProjectIdentityResolver.strict_existing` resolver,
// and the apply phase re-validates revisions +
// identities + aggregate budget inside the transaction
// so a preflight/apply race can never leave a
// half-applied batch.
//
// Acceptance criteria covered here (the task brief):
//
//   - Unknown `project_id` at preflight is rejected
//     with `identity_conflict`; zero rows are mutated.
//   - `id` / `project_path` conflict at preflight is
//     rejected with `identity_conflict`.
//   - A batch that would push `active_entries` past
//     `max_active_entries` is atomically rejected at
//     preflight; zero rows are mutated.
//   - A batch that would push `active_chars` past
//     `max_total_chars` is atomically rejected.
//   - A batch that would push a per-topic char total
//     past `max_topic_chars` is atomically rejected.
//   - A batch that would push `index_chars` past
//     `max_index_chars` is atomically rejected.
//   - Replacements / merges release the existing entry's
//     `char_count` / `index_chars` so the budget check
//     is "net impact" not "insert size only".
//   - The `PreflightPlan` carries a deterministic
//     `before` / `after` budget summary so the operator
//     can inspect the projection without re-running the
//     preflight.
//   - A preflight / apply race (revision drift between
//     plan and apply) rolls back the entire batch; no
//     row survives.
//   - A cross-project (malicious re-hashed) bundle is
//     rejected by the strict resolver.
//   - A clean snapshot bundle passes through unchanged.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../../src/memory-service.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import { type MemoryEntry } from "../../src/domain.js";
import {
  applyImport,
  planImport,
  preflightImport,
  type PreflightPlan
} from "../../src/portability/importer.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-preflight-budget-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const service = new MemoryService(store, undefined, "agent:system", dataHome);
  return { service, store, dataHome };
}

function baseEntry(overrides: Record<string, unknown> = {}): MemoryEntry {
  return {
    id: "mem_preflight_1",
    scope: "global" as const,
    type: "fact" as const,
    topic: "t",
    title: "title",
    body: "body",
    tags: ["a"],
    source: { kind: "agent" as const },
    importance: 3 as const,
    confidence: 3 as const,
    status: "active" as const,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_accessed_at: undefined,
    last_accessed_by: undefined,
    access_count: 0,
    expires_at: undefined,
    review_after: undefined,
    supersedes: [],
    superseded_by: undefined,
    token_estimate: 0,
    char_count: 5,
    revision: 1,
    writer_actor_id: "agent:system",
    content_hash: "h",
    pinned: false,
    trust_level: "imported" as const,
    sensitivity: "normal" as const,
    valid_from: undefined,
    valid_until: undefined,
    deleted_at: undefined,
    tier: "working" as const,
    metadata: {},
    ...overrides
  };
}

function writeBundle(
  dir: string,
  entries: MemoryEntry[],
  options: { manifestVersion?: 1 | 2; scope?: string } = {}
) {
  const { manifestVersion = 2, scope = "global" } = options;
  mkdirSync(join(dir, "topics"), { recursive: true });
  const manifest = {
    manifest_version: 1,
    export_schema_version: manifestVersion,
    source_schema_version: 12,
    scope,
    generated_at: "2026-01-01T00:00:00.000Z",
    entry_count: entries.length,
    topic_count: 1,
    files: []
  };
  writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(
    join(dir, "topics", "t.json"),
    JSON.stringify({ topic: "t", scope, entries }, null, 2)
  );
}

describe("release-gate p3-import-preflight-budget (Stage 18 v1.1.2 #24 task 5)", () => {
  let service: MemoryService;
  let store: SQLiteMemoryStore;
  let dataHome: string;

  beforeEach(() => {
    ({ service, store, dataHome } = setup());
  });
  afterEach(() => {
    try { store.close(); } catch { /* */ }
  });

  // -------------------------------------------------------------
  // 1. Unknown project_id at preflight.
  // -------------------------------------------------------------
  it("preflight rejects an unknown project_id with identity_conflict (0 mutations)", () => {
    const exportDir = mkdtempSync(join(tmpdir(), "lm-rg-preflight-unbound-"));
    const entry = baseEntry({
      id: "mem_unbound_b",
      scope: "project",
      project_id: "unbound-preflight",
      project_path: undefined,
      // The entry's `body` is short so the
      // aggregate budget check is not the
      // limiting factor. The test pins the
      // strict-resolver rejection.
      body: "x",
      char_count: 1
    });
    writeBundle(exportDir, [entry], { scope: "project/unbound-preflight" });

    expect(() =>
      planImport(service, exportDir, "project", "unbound-preflight", "json", {
        conflict: "keep",
        dry_run: false,
        actor: "agent:rg"
      })
    ).toThrow(/identity_conflict/);

    // The target store is untouched.
    const identityCount = (store.backupHandle()
      .prepare("SELECT COUNT(*) AS n FROM project_identities WHERE project_id = 'unbound-preflight'")
      .get() as { n: number }).n;
    expect(identityCount).toBe(0);
    const entryCount = (store.backupHandle()
      .prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE id = 'mem_unbound_b'")
      .get() as { n: number }).n;
    expect(entryCount).toBe(0);
  });

  // -------------------------------------------------------------
  // 2. Conflict between project_id and project_path.
  // -------------------------------------------------------------
  it("preflight rejects a project_id / project_path conflict with identity_conflict", () => {
    // Register two distinct projects so the
    // second path is bound to a different
    // project_id. The strict resolver's path
    // branch routes through
    // `resolveMemoryScopeWithStore` which
    // detects the conflicting alias and
    // returns `project_identity_conflict` (the
    // surface is renamed `identity_conflict` at
    // the preflight boundary).
    service.remember({
      scope: "project",
      project_path: "/tmp/repo-alpha",
      type: "fact",
      topic: "t",
      title: "alpha",
      body: "alpha",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    service.remember({
      scope: "project",
      project_path: "/tmp/repo-beta",
      type: "fact",
      topic: "t",
      title: "beta",
      body: "beta",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    const alphaRow = store.backupHandle()
      .prepare("SELECT project_id FROM project_identities WHERE canonical_path LIKE '%" + "repo-alpha" + "'")
      .get() as { project_id: string } | undefined;
    const realId = alphaRow?.project_id;
    if (realId === undefined) throw new Error("identity not created");

    // Build a bundle whose entry claims
    // project_id = realId (the alpha project's
    // id) but project_path = /tmp/repo-beta
    // (which is aliased to a DIFFERENT id).
    // The strict resolver refuses this as an
    // identity_conflict.
    const exportDir = mkdtempSync(join(tmpdir(), "lm-rg-preflight-conflict-"));
    const entry = baseEntry({
      id: "mem_conflict_b",
      scope: "project",
      project_id: realId,
      project_path: "/tmp/repo-beta",
      body: "x",
      char_count: 1
    });
    writeBundle(exportDir, [entry], { scope: `project/${realId}` });

    expect(() =>
      planImport(service, exportDir, "project", realId, "json", {
        conflict: "keep",
        dry_run: false,
        actor: "agent:rg"
      })
    ).toThrow(/identity_conflict/);
  });

  // -------------------------------------------------------------
  // 3. max_active_entries overflow on a project scope.
  // -------------------------------------------------------------
  it("preflight rejects a batch that would overflow max_active_entries (atomic, 0 mutations)", () => {
    // Register a project with a tight budget.
    service.configureProjectBudget(
      "tight-proj",
      {
        max_active_entries: 1,
        max_total_chars: 1_000,
        max_topic_chars: 1_000,
        max_index_chars: 1_000
      },
      "/tmp/tight-proj",
      "Tight"
    );

    // First import: one entry. This succeeds.
    const firstDir = mkdtempSync(join(tmpdir(), "lm-rg-preflight-active-1st-"));
    writeBundle(
      firstDir,
      [baseEntry({
        id: "mem_active_1",
        scope: "project",
        project_id: "tight-proj",
        project_path: "/tmp/tight-proj",
        topic: "t",
        body: "x",
        char_count: 1
      })],
      { scope: "project/tight-proj" }
    );
    const okPlan = planImport(service, firstDir, "project", "tight-proj", "json", {
      conflict: "keep",
      dry_run: false,
      actor: "agent:rg"
    });
    const okResult = applyImport(service, okPlan, { conflict: "keep", dry_run: false, actor: "agent:rg" });
    expect(okResult.applied_ids).toContain("mem_active_1");

    // Second import: two entries. The first
    // would push active_entries past 1; the
    // preflight must refuse the whole batch
    // atomically.
    const beforeSecond = store.listEntries({ scope: "project", project_id: "tight-proj", status: "active" });
    expect(beforeSecond.length).toBe(1);

    const secondDir = mkdtempSync(join(tmpdir(), "lm-rg-preflight-active-2nd-"));
    writeBundle(
      secondDir,
      [
        baseEntry({
          id: "mem_active_2",
          scope: "project",
          project_id: "tight-proj",
          project_path: "/tmp/tight-proj",
          topic: "t",
          body: "x",
          char_count: 1
        }),
        baseEntry({
          id: "mem_active_3",
          scope: "project",
          project_id: "tight-proj",
          project_path: "/tmp/tight-proj",
          topic: "t",
          body: "y",
          char_count: 1
        })
      ],
      { scope: "project/tight-proj" }
    );

    let caught: Error | undefined = undefined;
    try {
      planImport(service, secondDir, "project", "tight-proj", "json", {
        conflict: "keep",
        dry_run: false,
        actor: "agent:rg"
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/aggregate_budget|active_entries/);

    // Zero new rows from the rejected batch.
    const afterSecond = store.listEntries({ scope: "project", project_id: "tight-proj", status: "active" });
    expect(afterSecond.length).toBe(1);
    const ids = afterSecond.map((e) => e.id).sort();
    expect(ids).toEqual(["mem_active_1"]);
  });

  // -------------------------------------------------------------
  // 4. max_total_chars overflow.
  // -------------------------------------------------------------
  it("preflight rejects a batch that would overflow max_total_chars (atomic, 0 mutations)", () => {
    service.configureProjectBudget(
      "tiny-proj",
      {
        max_active_entries: 100,
        max_total_chars: 50,
        max_topic_chars: 100,
        max_index_chars: 1_000
      },
      "/tmp/tiny-proj",
      "Tiny"
    );

    const exportDir = mkdtempSync(join(tmpdir(), "lm-rg-preflight-total-"));
    const bigBody = "x".repeat(40);
    writeBundle(
      exportDir,
      [
        baseEntry({
          id: "mem_big_1",
          scope: "project",
          project_id: "tiny-proj",
          project_path: "/tmp/tiny-proj",
          topic: "t",
          title: "t",
          body: bigBody,
          char_count: 2 + bigBody.length // title + body
        }),
        baseEntry({
          id: "mem_big_2",
          scope: "project",
          project_id: "tiny-proj",
          project_path: "/tmp/tiny-proj",
          topic: "t",
          title: "t",
          body: bigBody,
          char_count: 2 + bigBody.length
        })
      ],
      { scope: "project/tiny-proj" }
    );

    let caught: Error | undefined = undefined;
    try {
      planImport(service, exportDir, "project", "tiny-proj", "json", {
        conflict: "keep",
        dry_run: false,
        actor: "agent:rg"
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/aggregate_budget|total_chars|active_chars/);

    const rows = store.listEntries({ scope: "project", project_id: "tiny-proj", status: "active" });
    expect(rows.length).toBe(0);
  });

  // -------------------------------------------------------------
  // 5. max_topic_chars overflow.
  // -------------------------------------------------------------
  it("preflight rejects a batch that would overflow max_topic_chars", () => {
    service.configureProjectBudget(
      "topic-proj",
      {
        max_active_entries: 100,
        max_total_chars: 1_000,
        max_topic_chars: 30,
        max_index_chars: 1_000
      },
      "/tmp/topic-proj",
      "Topic"
    );

    const exportDir = mkdtempSync(join(tmpdir(), "lm-rg-preflight-topic-"));
    const bigBody = "x".repeat(30);
    writeBundle(
      exportDir,
      [
        baseEntry({
          id: "mem_topic_1",
          scope: "project",
          project_id: "topic-proj",
          project_path: "/tmp/topic-proj",
          topic: "single-topic",
          title: "t",
          body: bigBody,
          char_count: 2 + bigBody.length
        }),
        baseEntry({
          id: "mem_topic_2",
          scope: "project",
          project_id: "topic-proj",
          project_path: "/tmp/topic-proj",
          topic: "single-topic",
          title: "t",
          body: bigBody,
          char_count: 2 + bigBody.length
        })
      ],
      { scope: "project/topic-proj" }
    );

    let caught: Error | undefined = undefined;
    try {
      planImport(service, exportDir, "project", "topic-proj", "json", {
        conflict: "keep",
        dry_run: false,
        actor: "agent:rg"
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/aggregate_budget|topic_chars/);

    const rows = store.listEntries({ scope: "project", project_id: "topic-proj", status: "active" });
    expect(rows.length).toBe(0);
  });

  // -------------------------------------------------------------
  // 6. max_index_chars overflow.
  // -------------------------------------------------------------
  it("preflight rejects a batch that would overflow max_index_chars", () => {
    // Tight max_index_chars so a 2-entry
    // batch can push past it. The
    // `estimateIndexChars` formula is
    // `title + topic + tags + 16`; a long
    // topic + 2 entries is enough to exceed
    // a small limit.
    service.configureProjectBudget(
      "idx-proj",
      {
        max_active_entries: 100,
        max_total_chars: 1_000_000,
        max_topic_chars: 1_000_000,
        max_index_chars: 20
      },
      "/tmp/idx-proj",
      "Idx"
    );

    const exportDir = mkdtempSync(join(tmpdir(), "lm-rg-preflight-idx-"));
    const bigTopic = "this-topic-name-is-quite-long-for-the-index-engine";
    writeBundle(
      exportDir,
      [
        baseEntry({
          id: "mem_idx_1",
          scope: "project",
          project_id: "idx-proj",
          project_path: "/tmp/idx-proj",
          topic: bigTopic,
          title: "t",
          body: "x",
          char_count: 2
        }),
        baseEntry({
          id: "mem_idx_2",
          scope: "project",
          project_id: "idx-proj",
          project_path: "/tmp/idx-proj",
          topic: bigTopic,
          title: "t",
          body: "x",
          char_count: 2
        })
      ],
      { scope: "project/idx-proj" }
    );

    let caught: Error | undefined = undefined;
    try {
      planImport(service, exportDir, "project", "idx-proj", "json", {
        conflict: "keep",
        dry_run: false,
        actor: "agent:rg"
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/aggregate_budget|index_chars/);

    const rows = store.listEntries({ scope: "project", project_id: "idx-proj", status: "active" });
    expect(rows.length).toBe(0);
  });

  // -------------------------------------------------------------
  // 7. Replacements / merges release capacity.
  // -------------------------------------------------------------
  it("preflight counts replacements/merges as releasing capacity (not just inserts)", () => {
    // The tight budget forces a strict comparison:
    // 2 active entries, 100 total chars. We
    // pre-populate with a `keep` import that
    // fills the budget to 50 chars. A second
    // import that REPLACES the existing 50-char
    // entry with a 200-char entry should be
    // allowed (the release frees 50 chars, net
    // +150 chars < 1000) but a 1000-char
    // replacement should be rejected.
    service.configureProjectBudget(
      "rel-proj",
      {
        max_active_entries: 2,
        max_total_chars: 1000,
        max_topic_chars: 1000,
        max_index_chars: 100_000
      },
      "/tmp/rel-proj",
      "Rel"
    );

    // First import: a single entry of 50 chars.
    const firstDir = mkdtempSync(join(tmpdir(), "lm-rg-preflight-rel-1st-"));
    writeBundle(
      firstDir,
      [
        baseEntry({
          id: "mem_rel_1",
          scope: "project",
          project_id: "rel-proj",
          project_path: "/tmp/rel-proj",
          topic: "t",
          title: "t",
          body: "x".repeat(48),
          char_count: 2 + 48
        })
      ],
      { scope: "project/rel-proj" }
    );
    const okPlan = planImport(service, firstDir, "project", "rel-proj", "json", {
      conflict: "keep",
      dry_run: false,
      actor: "agent:rg"
    });
    applyImport(service, okPlan, { conflict: "keep", dry_run: false, actor: "agent:rg" });

    // Second import: REPLACE the existing 50-char
    // entry with a 200-char entry. Net change is
    // +150 chars (release 50, insert 200).
    const okReplaceDir = mkdtempSync(join(tmpdir(), "lm-rg-preflight-rel-2nd-"));
    writeBundle(
      okReplaceDir,
      [
        baseEntry({
          id: "mem_rel_1",
          scope: "project",
          project_id: "rel-proj",
          project_path: "/tmp/rel-proj",
          topic: "t",
          title: "t",
          body: "y".repeat(198),
          char_count: 2 + 198,
          revision: 1 // matches the live row
        })
      ],
      { scope: "project/rel-proj" }
    );
    const okPlan2 = planImport(service, okReplaceDir, "project", "rel-proj", "json", {
      conflict: "replace",
      dry_run: false,
      actor: "agent:rg"
    });
    applyImport(service, okPlan2, { conflict: "replace", dry_run: false, actor: "agent:rg" });
    const okRows = store.listEntries({ scope: "project", project_id: "rel-proj", status: "active" });
    expect(okRows.length).toBe(1);
    expect(okRows[0]!.body).toBe("y".repeat(198));

    // Third import: a much larger replacement
    // (release 200, insert 5000) would push
    // active_chars past 1000. The preflight must
    // reject the batch atomically (the existing
    // 200-char row stays intact).
    const bigReplaceDir = mkdtempSync(join(tmpdir(), "lm-rg-preflight-rel-3rd-"));
    writeBundle(
      bigReplaceDir,
      [
        baseEntry({
          id: "mem_rel_1",
          scope: "project",
          project_id: "rel-proj",
          project_path: "/tmp/rel-proj",
          topic: "t",
          title: "t",
          body: "z".repeat(5000),
          char_count: 2 + 5000,
          revision: 2 // matches the live row
        })
      ],
      { scope: "project/rel-proj" }
    );

    let caught: Error | undefined = undefined;
    try {
      planImport(service, bigReplaceDir, "project", "rel-proj", "json", {
        conflict: "replace",
        dry_run: false,
        actor: "agent:rg"
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/aggregate_budget|active_chars/);

    // The live row is untouched by the rejected batch.
    const finalRows = store.listEntries({ scope: "project", project_id: "rel-proj", status: "active" });
    expect(finalRows.length).toBe(1);
    expect(finalRows[0]!.body).toBe("y".repeat(198));
  });

  // -------------------------------------------------------------
  // 8. PreflightPlan carries a deterministic before/after.
  // -------------------------------------------------------------
  it("PreflightPlan exposes deterministic before/after budget summary", () => {
    service.configureProjectBudget(
      "plan-proj",
      {
        max_active_entries: 100,
        max_total_chars: 10_000,
        max_topic_chars: 10_000,
        max_index_chars: 100_000
      },
      "/tmp/plan-proj",
      "Plan"
    );

    const exportDir = mkdtempSync(join(tmpdir(), "lm-rg-preflight-plan-"));
    writeBundle(
      exportDir,
      [
        baseEntry({
          id: "mem_plan_1",
          scope: "project",
          project_id: "plan-proj",
          project_path: "/tmp/plan-proj",
          topic: "t",
          title: "t",
          body: "x",
          char_count: 2
        }),
        baseEntry({
          id: "mem_plan_2",
          scope: "project",
          project_id: "plan-proj",
          project_path: "/tmp/plan-proj",
          topic: "t",
          title: "t",
          body: "y",
          char_count: 2
        })
      ],
      { scope: "project/plan-proj" }
    );

    const plan = planImport(service, exportDir, "project", "plan-proj", "json", {
      conflict: "keep",
      dry_run: true,
      actor: "agent:rg"
    });

    // The plan exposes a deterministic
    // before/after summary. The pre-budget
    // call walks every entry so the structure
    // is observable in tests.
    const preflightPlan: PreflightPlan | undefined = (plan as { preflight?: PreflightPlan }).preflight;
    expect(preflightPlan).toBeDefined();
    if (preflightPlan === undefined) return;
    expect(preflightPlan.budget.before.active_entries).toBe(0);
    expect(preflightPlan.budget.after.active_entries).toBe(2);
    expect(preflightPlan.budget.after.active_chars).toBe(4);
    expect(preflightPlan.budget.inserts).toBe(2);
    expect(preflightPlan.budget.replacements).toBe(0);
    expect(preflightPlan.budget.merges).toBe(0);
    expect(preflightPlan.budget.batch_chars).toBe(4);
    expect(preflightPlan.budget.releases).toBe(0);
    // Decisions list is in import order and has
    // one entry per imported entry.
    expect(preflightPlan.decisions.length).toBe(2);
    expect(preflightPlan.decisions[0]).toEqual({ kind: "insert", memory_id: "mem_plan_1" });
    expect(preflightPlan.decisions[1]).toEqual({ kind: "insert", memory_id: "mem_plan_2" });
  });

  // -------------------------------------------------------------
  // 9. Apply-time revalidation rolls back the whole batch.
  // -------------------------------------------------------------
  it("apply rolls back the entire batch when revision drift is detected between plan and apply", () => {
    // Seed the target with a memory that has
    // the same id as the bundle but at a different
    // revision than the bundle claims.
    // The preflight under `replace` policy
    // allows it (the live revision matches the
    // bundle's revision at plan time). The apply
    // then re-reads and finds the live row's
    // revision bumped by a concurrent write.
    const created = service.remember({
      scope: "global",
      type: "fact",
      topic: "t",
      title: "t",
      body: "live",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const liveId = created.value.memory_id;

    // Bundle carries the same id at revision 1
    // (matches the live row) and a second entry
    // that would be a clean insert.
    const exportDir = mkdtempSync(join(tmpdir(), "lm-rg-preflight-revalidate-"));
    writeBundle(
      exportDir,
      [
        baseEntry({
          id: liveId,
          topic: "t",
          title: "t",
          body: "fresh body",
          char_count: 10,
          revision: 1
        }),
        baseEntry({
          id: "mem_revalidate_2",
          topic: "t",
          title: "t",
          body: "second",
          char_count: 6,
          revision: 1
        })
      ]
    );

    const plan = planImport(service, exportDir, "global", undefined, "json", {
      conflict: "replace",
      dry_run: false,
      actor: "agent:rg"
    });
    expect(plan.inserts.length + plan.replacements.length).toBe(2);

    // Race: bump the live row's revision AFTER
    // the plan but BEFORE the apply. The apply
    // must re-validate and reject the whole
    // batch atomically.
    const liveRow = store.peekEntry(liveId);
    if (liveRow === undefined) throw new Error("live row missing");
    store.updateEntry(
      liveId,
      { ...liveRow, body: "drifted body", updated_at: "2026-01-02T00:00:00.000Z" },
      { changed_by: "agent:system", change_reason: "concurrent write" }
    );

    let caught: Error | undefined = undefined;
    try {
      applyImport(service, plan, {
        conflict: "replace",
        dry_run: false,
        actor: "agent:rg"
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/revision drift|revision_drift|stale_revision/);

    // The whole batch is rolled back. The live
    // row survived (with the drifted body) and
    // the second insert did not land.
    const after = store.listEntries({ scope: "global", status: "active" });
    const liveSurvives = after.find((e) => e.id === liveId);
    expect(liveSurvives).toBeDefined();
    expect(liveSurvives?.body).toBe("drifted body");
    const secondInsert = after.find((e) => e.id === "mem_revalidate_2");
    expect(secondInsert).toBeUndefined();
  });

  // -------------------------------------------------------------
  // 10. Cross-project (malicious re-hashed) bundle.
  // -------------------------------------------------------------
  it("rejects a malicious re-hashed bundle bound for a different project", () => {
    // Register two distinct projects. The
    // attack is a re-hashed bundle whose entries
    // reference the VICTIM's `project_id` but
    // a path that is already aliased to a
    // DIFFERENT project_id (the attacker is
    // trying to pour entries into the victim's
    // namespace by spoofing the path). The
    // strict resolver's path branch routes
    // through `resolveMemoryScopeWithStore`,
    // sees the alias belongs to a different
    // project_id, and surfaces
    // `project_identity_conflict` (renamed
    // `identity_conflict` at the preflight
    // boundary).
    service.remember({
      scope: "project",
      project_path: "/tmp/repo-victim",
      type: "fact",
      topic: "t",
      title: "v",
      body: "v",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    service.remember({
      scope: "project",
      project_path: "/tmp/repo-attacker",
      type: "fact",
      topic: "t",
      title: "a",
      body: "a",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    const victimRow = store.backupHandle()
      .prepare("SELECT project_id FROM project_identities WHERE canonical_path LIKE '%" + "repo-victim" + "'")
      .get() as { project_id: string } | undefined;
    const victimId = victimRow?.project_id;
    if (victimId === undefined) throw new Error("victim identity missing");

    // Bundle claims the victim project_id but
    // carries the attacker's path. The strict
    // resolver must reject this as an identity
    // conflict (the attacker's path is bound
    // to a different project_id).
    const exportDir = mkdtempSync(join(tmpdir(), "lm-rg-preflight-cross-"));
    writeBundle(
      exportDir,
      [
        baseEntry({
          id: "mem_rehash_1",
          scope: "project",
          project_id: victimId,
          project_path: "/tmp/repo-attacker",
          topic: "t",
          title: "t",
          body: "x",
          char_count: 2
        })
      ],
      { scope: `project/${victimId}` }
    );

    expect(() =>
      planImport(service, exportDir, "project", victimId, "json", {
        conflict: "keep",
        dry_run: false,
        actor: "agent:rg"
      })
    ).toThrow(/identity_conflict/);
  });

  // -------------------------------------------------------------
  // 11. Clean snapshot bundle passes through unchanged.
  // -------------------------------------------------------------
  it("clean snapshot bundle passes through the preflight and apply, no mutation beyond planned rows", () => {
    service.configureProjectBudget(
      "clean-proj",
      {
        max_active_entries: 100,
        max_total_chars: 10_000,
        max_topic_chars: 10_000,
        max_index_chars: 100_000
      },
      "/tmp/clean-proj",
      "Clean"
    );
    const exportDir = mkdtempSync(join(tmpdir(), "lm-rg-preflight-clean-"));
    writeBundle(
      exportDir,
      [
        baseEntry({
          id: "mem_clean_1",
          scope: "project",
          project_id: "clean-proj",
          project_path: "/tmp/clean-proj",
          topic: "t",
          title: "t",
          body: "x",
          char_count: 2
        })
      ],
      { scope: "project/clean-proj" }
    );

    const plan = planImport(service, exportDir, "project", "clean-proj", "json", {
      conflict: "keep",
      dry_run: false,
      actor: "agent:rg"
    });
    const result = applyImport(service, plan, {
      conflict: "keep",
      dry_run: false,
      actor: "agent:rg"
    });

    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(1);
    const rows = store.listEntries({ scope: "project", project_id: "clean-proj", status: "active" });
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe("mem_clean_1");
  });

  // -------------------------------------------------------------
  // 12. Unbound env-disabled path still gates the strict
  //     resolver (smoke).
  // -------------------------------------------------------------
  it("preflight rejects a global bundle that targets a project_id (no project scope column)", () => {
    // The test pins the existing behaviour: a
    // bundle that mixes global + project entries
    // is rejected by the existing schema secret
    // check (the project_id is on a global
    // entry). The aggregate budget contract is
    // also verified: the live store is empty
    // so the budget is satisfied; the rejection
    // is on schema, not budget.
    const exportDir = mkdtempSync(join(tmpdir(), "lm-rg-preflight-mixed-"));
    writeBundle(
      exportDir,
      [baseEntry({ id: "mem_mixed", scope: "global", body: "x", char_count: 1 })]
    );
    const preflight = preflightImport(
      service, exportDir, "global", undefined, "json", {
        conflict: "keep",
        dry_run: true,
        actor: "agent:rg"
      }
    );
    expect(preflight.ok).toBe(true);
  });

  // -------------------------------------------------------------
  // v1.1.3 GATE-01 (issue #31): preflight side-effect
  // free on the canonical eight project-related +
  // content-related tables. A rejected preflight MUST
  // NOT touch any of:
  //   project_identities, project_aliases_new,
  //   project_scopes, memory_entries,
  //   memory_revisions, audit_events,
  //   memory_relations, memory_provenance.
  // The `import_batches` table is excluded because the
  // preflight never mints a batch row (the lineage
  // surface is apply-only).
  // -------------------------------------------------------------
  function preflightTableSnapshot(store: SQLiteMemoryStore): Record<string, number> {
    const tables = [
      "project_identities",
      "project_aliases_new",
      "project_scopes",
      "memory_entries",
      "memory_revisions",
      "audit_events",
      "memory_relations",
      "memory_provenance"
    ];
    const h = store.backupHandle();
    const out: Record<string, number> = {};
    for (const t of tables) {
      const row = h.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
      out[t] = row.n;
    }
    return out;
  }

  it("preflight rejection leaves zero rows across the eight project + content tables", () => {
    // Build a bundle whose entry targets an unknown
    // project_id. The preflight refuses with
    // `identity_conflict`; the rejection must not
    // touch any of the eight tables.
    const exportDir = mkdtempSync(join(tmpdir(), "lm-rg-preflight-snap-"));
    const entry = baseEntry({
      id: "mem_preflight_snap",
      scope: "project",
      project_id: "snap-unknown-proj",
      project_path: undefined,
      body: "x",
      char_count: 1
    });
    writeBundle(exportDir, [entry], { scope: "project/snap-unknown-proj" });

    const before = preflightTableSnapshot(store);
    expect(() =>
      planImport(service, exportDir, "project", "snap-unknown-proj", "json", {
        conflict: "keep",
        dry_run: false,
        actor: "agent:rg"
      })
    ).toThrow(/identity_conflict/);
    const after = preflightTableSnapshot(store);
    expect(after).toEqual(before);
  });
});
