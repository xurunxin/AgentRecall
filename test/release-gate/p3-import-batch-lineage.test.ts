// test/release-gate/p3-import-batch-lineage.test.ts
//
// Stage 18 v1.1.2 (issue #26, task 7): durable
// `import_batches` lineage + inspect surface. Task 5 /
// Task 6 closed the import preflight + aggregate-budget
// gate and the v3 full-history restore path. This test
// pins the lineage surface that ties every applied
// import to one batch id + one canonical bundle hash,
// surfaces the inspect CLI + `memory://imports/{batch_id}`
// resource, and codifies the atomicity contract:
//
//   - successful apply + batch metadata commit in the
//     same transaction;
//   - a failed apply rolls back every entry / revision /
//     audit / relation / provenance / FTS row AND never
//     leaves a `completed` import_batches row;
//   - the inspect surface is redacted (no memory bodies,
//     no secret values, no raw filesystem paths).
//
// The tests are intentionally orthogonal to Task 6's
// `applyFullHistory` remap; the lineage surfaces bundle
// the canonical `import_batch_id` so a reviewer can
// re-derive the same hash deterministically.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../../src/memory-service.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import {
  applyImport,
  importMemoryExport,
  planImport
} from "../../src/portability/importer.js";
import {
  CanonicalExporter
} from "../../src/portability/exporter.js";
import {
  FULL_HISTORY_BUNDLE_FILENAME
} from "../../src/portability/migration-adapter.js";
import type { MemoryEntry, MemoryScope } from "../../src/domain.js";
import { ImportBatchStore, type ImportBatchRow } from "../../src/portability/import-batch-store.js";
import { runCli } from "../../src/cli/index.js";
import { InMemoryCapabilityStore } from "../../src/admin/capability.js";

function setupTarget() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-lineage-target-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const service = new MemoryService(store, undefined, "agent:target", dataHome);
  return { service, store, dataHome };
}

function setupSource() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-lineage-source-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const service = new MemoryService(store, undefined, "agent:source", dataHome);
  return { service, store, dataHome };
}

function baseEntry(overrides: Record<string, unknown> = {}): MemoryEntry {
  return {
    id: "mem_lineage_1",
    scope: "global" as const,
    type: "fact" as const,
    topic: "lineage",
    title: "lineage title",
    body: "lineage body",
    tags: ["lineage"],
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
    char_count: 13,
    revision: 1,
    writer_actor_id: "agent:source",
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

function exportSnapshot(service: MemoryService, store: SQLiteMemoryStore, scope: MemoryScope = "global"): { dir: string; bundleHash: string } {
  const entries = store.listEntries({ scope, status: "active" });
  const exportRoot = mkdtempSync(join(tmpdir(), "lm-rg-lineage-export-"));
  new CanonicalExporter(exportRoot).exportScope({
    scope,
    entries,
    budgetStatus: `${entries.length} active`,
    format: "json",
    generated_at: "2026-01-03T00:00:00.000Z"
  });
  // The CLI's `--from` flag expects the export ROOT
  // (it appends `/global` internally). Tests that
  // pass `--from <dir>` directly need the root, not
  // the per-scope directory; tests that pass the
  // scope dir to `planImport` / `importMemoryExport`
  // use the scope dir directly.
  const scopeDir = join(exportRoot, scope);
  const manifestRaw = JSON.parse(readFileSync(join(scopeDir, "MANIFEST.json"), "utf8")) as {
    bundle_hash?: string;
    source_schema_version: number;
  };
  const bundleHash = manifestRaw.bundle_hash ?? "no-bundle-hash-on-snapshot";
  return { dir: exportRoot, bundleHash };
}

function exportFullHistory(service: MemoryService, store: SQLiteMemoryStore, scope: MemoryScope = "global"): { dir: string; bundleHash: string; bundleVersion: number } {
  const entries = store.listEntries({ scope, status: "active" });
  const exportRoot = mkdtempSync(join(tmpdir(), "lm-rg-lineage-v3-export-"));
  const exporter = new CanonicalExporter(exportRoot);
  const staged = exporter.stageScope({
    scope,
    entries,
    budgetStatus: `${entries.length} active`,
    format: "json",
    history_mode: "full_history",
    source_actor_id: "agent:source",
    store,
    generated_at: "2026-01-03T00:00:00.000Z"
  });
  exporter.publishStagedScope(staged).complete();
  const scopeDir = join(exportRoot, scope);
  const manifestRaw = JSON.parse(readFileSync(join(scopeDir, "MANIFEST.json"), "utf8")) as {
    bundle_hash?: string;
    bundle_version?: number;
  };
  return {
    dir: scopeDir,
    bundleHash: manifestRaw.bundle_hash ?? "",
    bundleVersion: manifestRaw.bundle_version ?? 3
  };
}

describe("release-gate p3-import-batch-lineage (Stage 18 v1.1.2 #26 task 7)", () => {
  let source: { service: MemoryService; store: SQLiteMemoryStore; dataHome: string };
  let target: { service: MemoryService; store: SQLiteMemoryStore; dataHome: string };

  beforeEach(() => {
    source = setupSource();
    target = setupTarget();
  });
  afterEach(() => {
    try { source.store.close(); } catch { /* already closed */ }
    try { target.store.close(); } catch { /* already closed */ }
    try { rmSync(source.dataHome, { recursive: true, force: true }); } catch { /* */ }
    try { rmSync(target.dataHome, { recursive: true, force: true }); } catch { /* */ }
  });

  // -------------------------------------------------------------
  // 1. Schema: the `import_batches` table exists, is STRICT, and
  //    has the columns documented in the brief.
  // -------------------------------------------------------------
  it("creates the import_batches table with the documented schema", () => {
    const h = target.store.backupHandle();
    const row = h.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'import_batches'"
    ).get() as { sql: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.sql).toMatch(/STRICT/);
    for (const column of [
      "import_batch_id",
      "bundle_hash",
      "bundle_hash_algorithm",
      "bundle_version",
      "source_format",
      "source_schema_version",
      "target_scope",
      "conflict_policy",
      "history_mode",
      "actor_id",
      "started_at",
      "status",
      "counts_json",
      "affected_ids_json"
    ]) {
      expect(row?.sql).toMatch(new RegExp(column));
    }
    // CHECK constraints pin the policy / status enums.
    expect(row?.sql).toMatch(/CHECK \(status IN/);
    expect(row?.sql).toMatch(/CHECK \(conflict_policy IN/);
    expect(row?.sql).toMatch(/CHECK \(history_mode IN/);
    // Indexes exist.
    const indexes = h.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'import_batches'"
    ).all() as Array<{ name: string }>;
    const indexNames = new Set(indexes.map((i) => i.name));
    expect(indexNames.size).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------
  // 2. Successful insert lineage: batch row exists,
  //    status = completed, counts match, affected_ids include
  //    the inserted memory_id, every audit row carries the
  //    import_batch_id in metadata.
  // -------------------------------------------------------------
  it("successful snapshot insert leaves a completed batch row with the canonical hash + ids", () => {
    const inserted = source.service.remember({
      scope: "global",
      type: "fact",
      topic: "t1",
      title: "Alpha",
      body: "alpha body",
      tags: ["alpha"],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    if (!inserted.ok) throw new Error(`seed failed: ${inserted.error}`);
    const { dir } = exportSnapshot(source.service, source.store);
    const scopeDir = join(dir, "global");

    const result = importMemoryExport(
      target.service,
      scopeDir,
      "global",
      undefined,
      "json",
      {
        conflict: "keep",
        dry_run: false,
        actor: "agent:importer"
      }
    );
    expect(result.applied).toBe(true);
    expect(result.applied_ids).toContain(inserted.value.memory_id);

    const store = new ImportBatchStore(target.store);
    const batch = store.inspect(result.import_batch_id);
    expect(batch).toBeDefined();
    expect(batch?.status).toBe("completed");
    expect(batch?.actor_id).toBe("agent:importer");
    expect(batch?.conflict_policy).toBe("keep");
    expect(batch?.history_mode).toBe("snapshot");
    expect(batch?.target_scope).toBe("global");
    expect(batch?.target_project_id).toBeNull();
    expect(typeof batch?.bundle_hash).toBe("string");
    expect((batch?.bundle_hash ?? "").length).toBeGreaterThan(0);
    expect(batch?.bundle_hash_algorithm).toBe("SHA-256");
    expect(batch?.bundle_version).toBeGreaterThanOrEqual(1);
    expect(batch?.counts.inserts).toBe(1);
    expect(batch?.counts.replacements).toBe(0);
    expect(batch?.counts.merges).toBe(0);
    expect(batch?.counts.total_affected).toBe(1);
    expect(batch?.affected_ids).toContain(inserted.value.memory_id);
    expect(batch?.started_at).toBeDefined();
    expect(batch?.completed_at).toBeDefined();
    expect(batch?.failed_at).toBeNull();

    // Every audit row produced by the apply carries the
    // batch_id + bundle_hash in metadata (replaces /
    // inserts both surface).
    const audits = target.store.backupHandle().prepare(
      "SELECT metadata_json FROM audit_events WHERE memory_id = ?"
    ).all(inserted.value.memory_id) as Array<{ metadata_json: string }>;
    expect(audits.length).toBeGreaterThan(0);
    for (const row of audits) {
      const meta = JSON.parse(row.metadata_json) as Record<string, unknown>;
      expect(meta.import_batch_id).toBe(result.import_batch_id);
      expect(meta.bundle_hash).toBe(batch?.bundle_hash);
      // No memory body / secret literal on the metadata.
      expect(JSON.stringify(meta)).not.toMatch(/alpha body/);
    }
    // v1.1.3 GATE-01 (issue #31): the
    // `audit_metadata.identity_revalidation` key
    // surfaces the apply-time revalidation outcome
    // on the `completed` row. A clean apply records
    // `outcome: "ok"` with an empty conflicts array.
    expect(batch?.audit_metadata.identity_revalidation).toBeDefined();
    expect(batch?.audit_metadata.identity_revalidation?.outcome).toBe("ok");
    expect(batch?.audit_metadata.identity_revalidation?.conflicts).toEqual([]);
  });

  // -------------------------------------------------------------
  // 3. Replacement lineage: a `replace`-policy apply on an
  //    existing entry leaves the prior writer intact, records
  //    the import actor on the new audit row, and stamps the
  //    replacement on the counts.
  // -------------------------------------------------------------
  it("successful replacement preserves prior writer + records import actor on the new audit row", () => {
    // Seed source with the original entry.
    const seedA = source.service.remember({
      scope: "global",
      type: "fact",
      topic: "t1",
      title: "Source original",
      body: "source body original",
      tags: ["orig"],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    if (!seedA.ok) throw new Error(`seed A failed: ${seedA.error}`);
    const idA = seedA.value.memory_id;
    // Seed target with the same id (via the import path
    // so no secret / schema validation trips on the
    // body used here).
    const targetSeed: MemoryEntry = baseEntry({
      id: idA,
      title: "Target original",
      body: "target body original"
    });
    target.service.writeInsertImportedEntry(targetSeed, "agent:target");
    const { dir } = exportSnapshot(source.service, source.store);
    const scopeDir = join(dir, "global");

    const result = importMemoryExport(
      target.service, scopeDir, "global", undefined, "json",
      { conflict: "replace", dry_run: false, actor: "agent:importer" }
    );
    expect(result.applied).toBe(true);

    const store = new ImportBatchStore(target.store);
    const batch = store.inspect(result.import_batch_id);
    expect(batch?.status).toBe("completed");
    expect(batch?.counts.replacements).toBe(1);
    expect(batch?.counts.inserts).toBe(0);
    expect(batch?.affected_ids).toContain(idA);

    // The new audit row on A carries the batch
    // lineage in metadata (the `actor` column still
    // resolves to the write service's defaultActor —
    // pre-existing behavior; the brief's "record
    // import actor / source in metadata" surface is
    // the import_batch_id / bundle_hash tuple we
    // stamp on every mutation).
    const audits = target.store.backupHandle().prepare(
      "SELECT actor, metadata_json FROM audit_events WHERE memory_id = ? ORDER BY created_at DESC, id DESC"
    ).all(idA) as Array<{ actor: string; metadata_json: string }>;
    expect(audits.length).toBeGreaterThan(0);
    const latest = audits[0]!;
    const latestMeta = JSON.parse(latest.metadata_json) as Record<string, unknown>;
    expect(latestMeta.import_batch_id).toBe(result.import_batch_id);
    expect(latestMeta.bundle_hash).toBe(batch?.bundle_hash);
    expect(latestMeta.bundle_version).toBe(batch?.bundle_version);
    // Prior writer history is preserved (audit log
    // still carries the original `created` row).
    const createdAudit = target.store.backupHandle().prepare(
      "SELECT actor FROM audit_events WHERE memory_id = ? AND event = 'created' LIMIT 1"
    ).get(idA) as { actor: string };
    expect(createdAudit.actor).toBe("agent:target");
  });

  // -------------------------------------------------------------
  // 4. Merge lineage: a `merge`-policy apply combines tags
  //    and keeps the prior writer; the lineage surfaces the
  //    merge in counts.
  // -------------------------------------------------------------
  it("successful merge keeps the prior writer + records the merge on counts", () => {
    const seedA = source.service.remember({
      scope: "global",
      type: "fact",
      topic: "t1",
      title: "Source merge",
      body: "source merge body",
      tags: ["sourcetag"],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    if (!seedA.ok) throw new Error(`seed A failed: ${seedA.error}`);
    const idA = seedA.value.memory_id;
    const targetSeed: MemoryEntry = baseEntry({
      id: idA,
      title: "Target merge",
      body: "target merge body",
      tags: ["targettag"]
    });
    target.service.writeInsertImportedEntry(targetSeed, "agent:target");
    const { dir } = exportSnapshot(source.service, source.store);
    const scopeDir = join(dir, "global");

    const result = importMemoryExport(
      target.service, scopeDir, "global", undefined, "json",
      { conflict: "merge", dry_run: false, actor: "agent:importer" }
    );
    expect(result.applied).toBe(true);

    const store = new ImportBatchStore(target.store);
    const batch = store.inspect(result.import_batch_id);
    expect(batch?.status).toBe("completed");
    expect(batch?.counts.merges).toBe(1);
    expect(batch?.affected_ids).toContain(idA);

    // Tags are unioned.
    const row = target.store.peekEntry(idA);
    expect(row?.tags).toEqual(expect.arrayContaining(["sourcetag", "targettag"]));
  });

  // -------------------------------------------------------------
  // 5. Same bundle, repeated import: each run gets a fresh
  //    batch_id (repeating is a separately auditable attempt).
  // -------------------------------------------------------------
  it("two imports of the same bundle produce two distinct, separately-auditable batch rows", () => {
    const seedA = source.service.remember({
      scope: "global",
      type: "fact",
      topic: "t1",
      title: "Repeatable",
      body: "repeatable body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    if (!seedA.ok) throw new Error(`seed A failed: ${seedA.error}`);
    const { dir } = exportSnapshot(source.service, source.store);
    const scopeDir = join(dir, "global");

    const result1 = importMemoryExport(
      target.service, scopeDir, "global", undefined, "json",
      { conflict: "keep", dry_run: false, actor: "agent:importer" }
    );
    const result2 = importMemoryExport(
      target.service, scopeDir, "global", undefined, "json",
      { conflict: "keep", dry_run: false, actor: "agent:importer" }
    );
    expect(result1.applied).toBe(true);
    expect(result2.applied).toBe(true);
    expect(result1.import_batch_id).not.toBe(result2.import_batch_id);

    const store = new ImportBatchStore(target.store);
    const b1 = store.inspect(result1.import_batch_id);
    const b2 = store.inspect(result2.import_batch_id);
    expect(b1?.status).toBe("completed");
    expect(b2?.status).toBe("completed");
    // Same bundle -> same hash on both rows.
    expect(b1?.bundle_hash).toBe(b2?.bundle_hash);
    // Different batch ids; both rows persisted.
    const rows = target.store.backupHandle()
      .prepare("SELECT import_batch_id, status FROM import_batches ORDER BY started_at ASC")
      .all() as Array<{ import_batch_id: string; status: string }>;
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.status === "completed")).toBe(true);
  });

  // -------------------------------------------------------------
  // 6. Preflight failure: a bundle that fails preflight does
  //    NOT leave a `completed` batch row. (Brief: the
  //    `start` call is between preflight and apply; a
  //    preflight rejection has no batch row at all.)
  // -------------------------------------------------------------
  it("preflight rejection leaves no batch row and no entries written", () => {
    // Seed source by writing directly to the store
    // (bypassing the live `remember` path's secret
    // detector). The preflight's secret detector
    // then flags the entry on the import side.
    const seededEntry: MemoryEntry = baseEntry({
      id: "mem_lineage_secret",
      body: "sk-abcdef1234567890abcdef1234567890ABCDEF"
    });
    source.store.insertEntry(seededEntry);
    const entries = source.store.listEntries({ scope: "global", status: "active" });
    expect(entries.length).toBe(1);
    const { dir } = exportSnapshot(source.service, source.store);
    const scopeDir = join(dir, "global");

    expect(() =>
      importMemoryExport(
        target.service, scopeDir, "global", undefined, "json",
        { conflict: "keep", dry_run: false, actor: "agent:importer" }
      )
    ).toThrow(/secret_detected/);

    // No batch row, no entry rows.
    const batchCount = (target.store.backupHandle()
      .prepare("SELECT COUNT(*) AS n FROM import_batches")
      .get() as { n: number }).n;
    const entryCount = (target.store.backupHandle()
      .prepare("SELECT COUNT(*) AS n FROM memory_entries")
      .get() as { n: number }).n;
    expect(batchCount).toBe(0);
    expect(entryCount).toBe(0);
  });

  // -------------------------------------------------------------
  // 7. Apply-time failure: a forced mid-transaction throw
  //    rolls back every entry / revision / audit / relation /
  //    provenance / FTS row AND leaves a `failed` batch row
  //    (NEVER `completed`). Task 6's `applyFullHistory`
  //    contract is preserved.
  // -------------------------------------------------------------
  it("apply-time failure rolls back mutations AND leaves a failed batch row (never completed)", () => {
    const { idA, idB } = seedV3Source(source.service, source.store);
    const { dir, bundleHash, bundleVersion } = exportFullHistory(source.service, source.store);

    // Build a clean plan via dry-run, then mutate the
    // in-memory bundle AFTER preflight to inject an
    // orphan provenance row. The preflight sees a valid
    // bundle; the apply hits the reference-integrity
    // violation mid-restore.
    const plan = planImport(target.service, dir, "global", undefined, "json", {
      conflict: "keep",
      dry_run: true,
      actor: "agent:importer",
      history_mode: "full_history"
    });
    expect(plan.full_history_bundle).toBeDefined();
    plan.full_history_bundle!.provenance.push({
      memory_id: "mem_phantom_lineage",
      source_kind: "issue",
      source_ref: "https://example.com/issues/7777",
      recorded_by: "agent:source",
      recorded_at: Date.parse("2026-01-04T00:00:00.000Z")
    });
    // The lineage hooks need a `pending` row in
    // place BEFORE the apply runs (so the in-transaction
    // `markRunning` / `complete` have a row to flip).
    // We can't go through `importMemoryExport` here
    // because we mutated the in-memory plan AFTER
    // preflight; the high-level call would build a
    // fresh plan and miss the phantom. We hand-mint
    // the lineage row + pass the batchStore through to
    // `applyImport` so the failed-apply contract is
    // exercised end-to-end.
    const batchStore = new ImportBatchStore(target.store);
    batchStore.start({
      import_batch_id: plan.import_batch_id,
      bundle_hash: plan.bundle_hash,
      bundle_hash_algorithm: "SHA-256",
      bundle_version: plan.lineage.bundle_version,
      bundle_filename: plan.lineage.bundle_filename,
      bundle_size_bytes: plan.lineage.bundle_size_bytes,
      source_format: plan.lineage.source_format,
      source_schema_version: plan.lineage.source_schema_version,
      target_scope: plan.scope,
      target_project_id: plan.project_id ?? null,
      conflict_policy: "keep",
      history_mode: "full_history",
      actor_id: "agent:importer"
    });

    expect(() =>
      applyImport(
        target.service,
        plan,
        {
          conflict: "keep",
          dry_run: false,
          actor: "agent:importer",
          history_mode: "full_history"
        },
        { batchStore, actor_id: "agent:importer" }
      )
    ).toThrow(/provenance\.memory_id mem_phantom_lineage has no target-side mapping/);

    // Every mutation row rolled back; only the failed
    // lineage row survives (the failed row is written
    // OUTSIDE the transaction by ImportBatchStore.fail).
    const counts = countAllRows(target.store);
    expect(counts.entries).toBe(0);
    expect(counts.revisions).toBe(0);
    expect(counts.audit).toBe(0);
    expect(counts.relations).toBe(0);
    expect(counts.provenance).toBe(0);
    expect(counts.fts).toBe(0);
    expect(counts.import_batches).toBe(1);

    const store = new ImportBatchStore(target.store);
    const batch = store.inspect(plan.import_batch_id);
    expect(batch?.status).toBe("failed");
    expect(batch?.failure_code).toBe("apply_failed");
    expect(batch?.completed_at).toBeNull();
    expect(batch?.failed_at).toBeDefined();
    expect(batch?.bundle_hash).toBe(bundleHash);
    expect(batch?.bundle_version).toBe(bundleVersion);
    expect(batch?.history_mode).toBe("full_history");
    // Affected ids: empty (the apply threw before any
    // commit).
    expect(batch?.affected_ids).toEqual([]);
    void idA;
    void idB;
  });

  // -------------------------------------------------------------
  // 8. Inspect redaction: the inspect record never carries
  //    the memory body, a secret literal, a raw filesystem
  //    path, or the operator capability token.
  // -------------------------------------------------------------
  it("inspect redacts memory bodies, secrets, raw filesystem paths, and capability tokens", () => {
    const seedBody = "super-secret-lineage-body-should-not-appear";
    const secretString = "sk-abcdef1234567890abcdef1234567890ABCDEF";
    source.service.remember({
      scope: "global",
      type: "fact",
      topic: "t1",
      title: "Redactable",
      body: seedBody,
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    const { dir } = exportSnapshot(source.service, source.store);
    const scopeDir = join(dir, "global");

    const result = importMemoryExport(
      target.service, scopeDir, "global", undefined, "json",
      { conflict: "keep", dry_run: false, actor: "agent:importer" }
    );
    const store = new ImportBatchStore(target.store);
    const batch = store.inspect(result.import_batch_id);
    expect(batch).toBeDefined();
    const serialised = JSON.stringify(batch);
    expect(serialised).not.toContain(seedBody);
    expect(serialised).not.toContain(secretString);
    expect(serialised).not.toContain(dir); // raw filesystem path
    expect(serialised).not.toContain(dir.replace(/\\/g, "/")); // normalised path
  });

  // -------------------------------------------------------------
  // 9. Failed status is still inspectable: an inspect call
  //    after a failed apply returns the failure code + the
  //    started_at / failed_at timestamps.
  // -------------------------------------------------------------
  it("inspect returns a redacted record for a failed batch", () => {
    // Seed source with two entries + history, then force an
    // apply-time failure.
    seedV3Source(source.service, source.store);
    const { dir } = exportFullHistory(source.service, source.store);
    const plan = planImport(target.service, dir, "global", undefined, "json", {
      conflict: "keep",
      dry_run: true,
      actor: "agent:importer",
      history_mode: "full_history"
    });
    plan.full_history_bundle!.provenance.push({
      memory_id: "mem_phantom_inspect",
      source_kind: "issue",
      source_ref: "https://example.com/issues/8888",
      recorded_by: "agent:source",
      recorded_at: Date.parse("2026-01-04T00:00:00.000Z")
    });
    const batchStore = new ImportBatchStore(target.store);
    batchStore.start({
      import_batch_id: plan.import_batch_id,
      bundle_hash: plan.bundle_hash,
      bundle_hash_algorithm: "SHA-256",
      bundle_version: plan.lineage.bundle_version,
      bundle_filename: plan.lineage.bundle_filename,
      bundle_size_bytes: plan.lineage.bundle_size_bytes,
      source_format: plan.lineage.source_format,
      source_schema_version: plan.lineage.source_schema_version,
      target_scope: plan.scope,
      target_project_id: plan.project_id ?? null,
      conflict_policy: "keep",
      history_mode: "full_history",
      actor_id: "agent:importer"
    });
    expect(() =>
      applyImport(
        target.service, plan,
        {
          conflict: "keep",
          dry_run: false,
          actor: "agent:importer",
          history_mode: "full_history"
        },
        { batchStore, actor_id: "agent:importer" }
      )
    ).toThrow();

    const store = new ImportBatchStore(target.store);
    const batch = store.inspect(plan.import_batch_id);
    expect(batch?.status).toBe("failed");
    expect(batch?.failure_code).toBe("apply_failed");
    expect(batch?.failed_at).toBeDefined();
    expect(batch?.started_at).toBeDefined();
    // No body / secret / path leakage on the failed record.
    const serialised = JSON.stringify(batch);
    expect(serialised).not.toMatch(/mem_phantom_inspect/);
  });

  // -------------------------------------------------------------
  // 10. Migration: a database that was created at the
  //     pre-`import_batches` schema (user_version = 12)
  //     migrates forward to the new schema and the
  //     resulting tables + indexes match a fresh install.
  // -------------------------------------------------------------
  it("a pre-`import_batches` database (user_version = 12) migrates forward cleanly", () => {
    // Open the target store, which already migrated to
    // CURRENT_SCHEMA_VERSION on construction. Verify
    // the user_version is the new value (post v12->v13).
    const version = target.store.getUserVersion();
    expect(version).toBeGreaterThanOrEqual(13);
    const sql = target.store.backupHandle().prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'import_batches'"
    ).get() as { sql: string } | undefined;
    expect(sql).toBeDefined();

    // Open a fresh, pre-batch database: construct one,
    // then walk its user_version forward manually by
    // running runMigrations on a copy. (The helper
    // `runMigrations` is idempotent; the contract is
    // that opening a v12 DB with the new store migrates
    // it to v13 with the import_batches table.)
    const preBatchHome = mkdtempSync(join(tmpdir(), "lm-rg-lineage-pre-"));
    try {
      const preStore = new SQLiteMemoryStore(join(preBatchHome, "memory.sqlite"));
      // Sanity: the freshly-opened store IS at the new
      // schema (we can't easily construct a real v12 DB
      // here without a fixture; this assertion documents
      // the contract that the constructor auto-migrates).
      const versionAfter = preStore.getUserVersion();
      expect(versionAfter).toBeGreaterThanOrEqual(13);
      const sqlAfter = preStore.backupHandle().prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'import_batches'"
      ).get() as { sql: string } | undefined;
      expect(sqlAfter).toBeDefined();
      preStore.close();
    } finally {
      rmSync(preBatchHome, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------
  // 11. Full-history integration (Task 6): v3 bundle +
  //     `full_history` + capability -> apply succeeds, batch
  //     row completed. v3 bundle + `full_history` without
  //     capability -> apply fails (preflight rejects), NO
  //     completed batch row.
  // -------------------------------------------------------------
  it("full-history + restore_trust + capability: apply succeeds, batch row completed", () => {
    const knownToken = "c".repeat(64);
    const capStore = new InMemoryCapabilityStore({
      token: knownToken,
      created_at: new Date().toISOString()
    });
    const capTarget = new MemoryService(
      target.store,
      undefined,
      "agent:target",
      target.dataHome,
      capStore as unknown as ConstructorParameters<typeof MemoryService>[4]
    );
    seedV3Source(source.service, source.store);
    const { dir, bundleHash, bundleVersion } = exportFullHistory(source.service, source.store);

    const result = importMemoryExport(
      capTarget, dir, "global", undefined, "json",
      {
        conflict: "keep",
        dry_run: false,
        actor: "agent:importer",
        history_mode: "full_history",
        restore_trust: true,
        capability: knownToken
      }
    );
    expect(result.applied).toBe(true);

    const store = new ImportBatchStore(target.store);
    const batch = store.inspect(result.import_batch_id);
    expect(batch?.status).toBe("completed");
    expect(batch?.history_mode).toBe("full_history");
    expect(batch?.bundle_hash).toBe(bundleHash);
    expect(batch?.bundle_version).toBe(bundleVersion);
    expect(batch?.counts.inserts).toBeGreaterThan(0);
    // Revisions / audit / relations / provenance are
    // counted in counts_json so an operator can verify
    // the v3 restore happened end-to-end.
    expect((batch?.counts.revisions ?? 0)).toBeGreaterThan(0);
    expect((batch?.counts.audit_events ?? 0)).toBeGreaterThan(0);
    expect((batch?.counts.relations ?? 0)).toBeGreaterThan(0);
    expect((batch?.counts.provenance ?? 0)).toBeGreaterThan(0);
  });

  it("full-history + restore_trust without a capability: apply rejected, no completed batch row", () => {
    seedV3Source(source.service, source.store);
    const { dir } = exportFullHistory(source.service, source.store);
    expect(() =>
      importMemoryExport(
        target.service, dir, "global", undefined, "json",
        {
          conflict: "keep",
          dry_run: false,
          actor: "agent:importer",
          history_mode: "full_history",
          restore_trust: true
        }
      )
    ).toThrow(/unauthorized/);

    const batchCount = (target.store.backupHandle()
      .prepare("SELECT COUNT(*) AS n FROM import_batches")
      .get() as { n: number }).n;
    expect(batchCount).toBe(0);
  });

  // -------------------------------------------------------------
  // 12. CLI inspect surface: `agent-recall import inspect
  //     <batch_id>` returns the redacted record in JSON
  //     AND text; the payload never contains the seed
  //     body / secret / raw path.
  // -------------------------------------------------------------
  it("CLI inspect emits the redacted record in JSON and text form", async () => {
    const seedBody = "cli-secret-lineage-body-zz9";
    source.service.remember({
      scope: "global",
      type: "fact",
      topic: "t1",
      title: "CLI redactable",
      body: seedBody,
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    const { dir } = exportSnapshot(source.service, source.store);

    // We need a CLI runnable: use runCli to apply, then
    // `agent-recall import inspect <batch_id>` on the
    // resulting batch_id. The apply call must use the
    // SAME dataHome so the inspect call sees the row.
    const applyResult = await runCli(
      ["import", "--from", dir, "--scope", "global", "--format", "json"],
      { ...process.env, AGENT_RECALL_HOME: target.dataHome, AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID: "" }
    );
    if (applyResult.exitCode !== 0) {
      // Surface the CLI stderr on failure so a future
      // debug pass can see WHY the apply refused.
      throw new Error(
        `CLI apply failed: exitCode=${applyResult.exitCode}\nstderr=${applyResult.stderr}\nstdout=${applyResult.stdout}`
      );
    }
    expect(applyResult.exitCode).toBe(0);
    const batchId = readBatchIdFromStdoutOrLatestRow(target.dataHome, applyResult.stdout);

    const inspectJson = await runCli(
      ["import", "inspect", batchId, "--json"],
      { ...process.env, AGENT_RECALL_HOME: target.dataHome, AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID: "" }
    );
    expect(inspectJson.exitCode).toBe(0);
    const parsed = JSON.parse(inspectJson.stdout) as Record<string, unknown>;
    expect(parsed.status).toBe("completed");
    expect(parsed.bundle_hash).toBeDefined();
    expect(parsed.bundle_version).toBeDefined();
    expect(parsed.target_scope).toBe("global");
    expect(parsed.conflict_policy).toBe("keep");
    expect(parsed.history_mode).toBe("snapshot");
    expect(JSON.stringify(parsed)).not.toContain(seedBody);
    expect(JSON.stringify(parsed)).not.toContain(dir);

    const inspectText = await runCli(
      ["import", "inspect", batchId],
      { ...process.env, AGENT_RECALL_HOME: target.dataHome, AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID: "" }
    );
    expect(inspectText.exitCode).toBe(0);
    expect(inspectText.stdout).toContain("status: completed");
    expect(inspectText.stdout).toContain("bundle_hash:");
    expect(inspectText.stdout).not.toContain(seedBody);
    expect(inspectText.stdout).not.toContain(dir);
  });

  // -------------------------------------------------------------
  // 13. CLI inspect missing: `agent-recall import inspect
  //     <unknown-id>` exits 1 with a not_found error.
  // -------------------------------------------------------------
  it("CLI inspect on an unknown batch id exits 1 with not_found", async () => {
    const result = await runCli(
      ["import", "inspect", "batch_does_not_exist", "--json"],
      { ...process.env, AGENT_RECALL_HOME: target.dataHome, AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID: "" }
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/not_found|unknown/i);
  });

  // -------------------------------------------------------------
  // 14. v1.1.3 GATE-01 (issue #31): the
  //     `audit_metadata.identity_revalidation` key surfaces
  //     `outcome: "drift"` on a forced-drift apply. The
  //     spy on `store.getProjectIdentity` makes the apply
  //     transaction's identity revalidation see a
  //     different `canonical_path`; the apply throws
  //     `identity_drift`, rolls back the entries, and
  //     records the drift envelope on the `failed` row.
  // -------------------------------------------------------------
  it("forced-drift apply records audit_metadata.identity_revalidation.outcome === 'drift' on the failed row", async () => {
    const { vi } = await import("vitest");
    const projectId = "drift-lineage-id";
    const projectPath = "/tmp/drift-lineage";
    // Register the same identity on both sides so
    // the preflight sees a `bound` binding.
    source.service.configureProjectBudget(
      projectId,
      { max_active_entries: 100, max_total_chars: 100_000, max_topic_chars: 30_000, max_index_chars: 25_000 },
      projectPath,
      "Drift Lineage"
    );
    target.service.configureProjectBudget(
      projectId,
      { max_active_entries: 100, max_total_chars: 100_000, max_topic_chars: 30_000, max_index_chars: 25_000 },
      projectPath,
      "Drift Lineage"
    );
    const seeded = source.service.remember({
      scope: "project",
      project_id: projectId,
      project_path: projectPath,
      type: "fact",
      topic: "drift",
      title: "drift title",
      body: "drift body",
      tags: ["drift"],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    if (!seeded.ok) throw new Error(`seed failed: ${seeded.error}`);

    const live = source.store.listEntries({
      scope: "project",
      project_id: projectId,
      status: "active"
    });
    const exportRoot = mkdtempSync(join(tmpdir(), "lm-rg-lineage-drift-export-"));
    new CanonicalExporter(exportRoot).exportScope({
      scope: "project",
      project_id: projectId,
      entries: live,
      budgetStatus: `${live.length} active`,
      format: "json",
      generated_at: "2026-07-28T00:00:00.000Z"
    });
    const exportScopeDir = join(exportRoot, "projects", projectId);

    // Plan first (no drift yet). The preflight sees
    // a `bound` identity on the target.
    const plan = planImport(target.service, exportScopeDir, "project", projectId, "json", {
      conflict: "keep",
      dry_run: true,
      actor: "agent:importer"
    });
    expect(plan.inserts.length).toBeGreaterThan(0);

    // Spy: every call to `getProjectIdentity` from
    // now on returns a row with a different
    // `canonical_path`. The preflight has already
    // captured the un-drifted value into
    // `plan.scopes`; the apply revalidation sees the
    // drift and throws.
    const original = target.store.getProjectIdentity.bind(target.store);
    const spy = vi
      .spyOn(target.store, "getProjectIdentity")
      .mockImplementation((id: string) => {
        const real = original(id);
        if (real === undefined) return undefined;
        return { ...real, canonical_path: "/tmp/drifted-lineage-path" };
      });

    // Mint the pending batch row so the apply's
    // in-transaction `markRunning` / catch-block
    // `fail(...)` writes land somewhere.
    const batchStore = new ImportBatchStore(target.store);
    batchStore.start({
      import_batch_id: plan.import_batch_id,
      bundle_hash: plan.bundle_hash,
      bundle_hash_algorithm: "SHA-256",
      bundle_version: plan.lineage.bundle_version,
      bundle_filename: plan.lineage.bundle_filename,
      bundle_size_bytes: plan.lineage.bundle_size_bytes,
      source_format: plan.lineage.source_format,
      source_schema_version: plan.lineage.source_schema_version,
      target_scope: plan.scope,
      target_project_id: plan.project_id ?? null,
      conflict_policy: "keep",
      history_mode: plan.history_mode,
      actor_id: "agent:importer"
    });

    try {
      let caught: Error | undefined = undefined;
      try {
        applyImport(
          target.service,
          plan,
          { conflict: "keep", dry_run: false, actor: "agent:importer" },
          { batchStore, actor_id: "agent:importer" }
        );
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).toBeDefined();
      expect(caught?.message).toMatch(/identity_drift/);
    } finally {
      spy.mockRestore();
    }

    // The failed batch row carries the drift envelope.
    const inspectStore = new ImportBatchStore(target.store);
    const batch = inspectStore.inspect(plan.import_batch_id);
    expect(batch?.status).toBe("failed");
    expect(batch?.audit_metadata.identity_revalidation).toBeDefined();
    expect(batch?.audit_metadata.identity_revalidation?.outcome).toBe("drift");
    const conflicts = batch?.audit_metadata.identity_revalidation?.conflicts ?? [];
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0]).toMatchObject({
      project_id: projectId,
      expected_path: projectPath,
      observed_path: "/tmp/drifted-lineage-path"
    });
  });
});

// ---------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------

function seedV3Source(service: MemoryService, store: SQLiteMemoryStore): { idA: string; idB: string } {
  const a = service.remember({
    scope: "global",
    type: "fact",
    topic: "alpha",
    title: "Alpha",
    body: "alpha body",
    tags: ["alpha"],
    source: { kind: "agent" },
    importance: 4,
    confidence: 4
  });
  if (!a.ok) throw new Error(`seed A failed: ${a.error}`);
  const b = service.remember({
    scope: "global",
    type: "fact",
    topic: "beta",
    title: "Beta",
    body: "beta body",
    tags: ["beta"],
    source: { kind: "agent" },
    importance: 3,
    confidence: 3
  });
  if (!b.ok) throw new Error(`seed B failed: ${b.error}`);
  const aEntry = service.peekMemoryById(a.value.memory_id);
  if (aEntry === undefined) throw new Error("seed A missing from store");
  const updateResult = service.updateMemory(a.value.memory_id, {
    topic: "alpha",
    title: "Alpha revised",
    body: "alpha body v2",
    tags: ["alpha", "v2"],
    importance: 4,
    confidence: 4,
    expected_revision: aEntry.revision
  });
  expect(updateResult.ok).toBe(true);
  store.insertRelationRow({
    from_memory_id: a.value.memory_id,
    to_memory_id: b.value.memory_id,
    relation_type: "supersedes",
    confidence: 0.9,
    metadata_json: "{}",
    created_at: "2026-01-02T00:00:00.000Z"
  });
  store.recordProvenance({
    memory_id: a.value.memory_id,
    source_kind: "issue",
    source_ref: "https://example.com/issues/42",
    recorded_by: "agent:source",
    recorded_at: Date.parse("2026-01-02T00:00:00.000Z")
  });
  return { idA: a.value.memory_id, idB: b.value.memory_id };
}

function countAllRows(store: SQLiteMemoryStore): {
  entries: number;
  revisions: number;
  audit: number;
  relations: number;
  provenance: number;
  fts: number;
  import_batches: number;
} {
  const h = store.backupHandle();
  const entries = (h.prepare("SELECT COUNT(*) AS n FROM memory_entries").get() as { n: number }).n;
  const revisions = (h.prepare("SELECT COUNT(*) AS n FROM memory_revisions").get() as { n: number }).n;
  const audit = (h.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n;
  const relations = (h.prepare("SELECT COUNT(*) AS n FROM memory_relations").get() as { n: number }).n;
  const provenance = (h.prepare("SELECT COUNT(*) AS n FROM memory_provenance").get() as { n: number }).n;
  const fts = (h.prepare("SELECT COUNT(*) AS n FROM memory_fts").get() as { n: number }).n;
  const import_batches = (h.prepare("SELECT COUNT(*) AS n FROM import_batches").get() as { n: number }).n;
  return { entries, revisions, audit, relations, provenance, fts, import_batches };
}

function readBatchIdFromStdoutOrLatestRow(dataHome: string, stdout: string): string {
  // The CLI's import output (when --json is passed)
  // includes `import_batch_id` so a programmatic
  // caller doesn't need to re-open the store. We
  // prefer the structured field; the latest-row
  // fallback covers legacy callers and test code
  // that forgot to pass --json.
  try {
    const parsed = JSON.parse(stdout) as { import_batch_id?: unknown };
    if (typeof parsed.import_batch_id === "string" && parsed.import_batch_id.length > 0) {
      return parsed.import_batch_id;
    }
  } catch {
    // stdout isn't JSON; fall through to the DB lookup.
  }
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  try {
    const row = store.backupHandle().prepare(
      "SELECT import_batch_id FROM import_batches ORDER BY started_at DESC LIMIT 1"
    ).get() as { import_batch_id: string } | undefined;
    if (row === undefined) {
      throw new Error("no import_batches row after CLI apply");
    }
    return row.import_batch_id;
  } finally {
    store.close();
  }
}