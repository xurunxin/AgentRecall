// test/portability-import.test.ts
//
// Stage 13 PR10 (spec § 6.7): the import contract.
// Round-trips an export from one store into a fresh
// store. Covers:
//   - dry-run plans the import without writing
//   - default `keep` policy inserts new entries and
//     skips existing ones
//   - `replace` policy overwrites and verifies the
//     revision (CAS guard)
//   - `fail` policy aborts on the first conflict
//   - manifest hash mismatch refuses the import
//
// The conflict tests (keep / replace / fail) use a
// shared helper `prePopulateTarget` that writes a
// target entry with the *same* id as the source entry.
// This makes the import-time conflict detection
// (`peekMemoryById(id)`) meaningful — otherwise the
// two `service.remember` calls would mint independent
// ids and the importer would never see a conflict.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CanonicalExporter } from "../src/portability/exporter.js";
import {
  importMemoryExport,
  planImport,
  applyImport
} from "../src/portability/importer.js";
import { readManifest } from "../src/portability/manifest.js";
import { MemoryService } from "../src/memory-service.js";
import { MarkdownExporter } from "../src/markdown-exporter.js";
import { SQLiteMemoryStore } from "../src/sqlite-store.js";
import type { MemoryEntry } from "../src/domain.js";

function makeService(dataHome: string): MemoryService {
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const exporter = new MarkdownExporter(join(dataHome, "exports"));
  return new MemoryService(store, exporter, "agent:test", dataHome);
}

describe("Import (spec § 6.7)", () => {
  let sourceDataHome: string;
  let targetDataHome: string;
  let exportRoot: string;
  let source: MemoryService;
  let target: MemoryService;
  let sourceStore: SQLiteMemoryStore;
  let targetStore: SQLiteMemoryStore;

  beforeEach(() => {
    sourceDataHome = mkdtempSync(join(tmpdir(), "lm-import-src-"));
    targetDataHome = mkdtempSync(join(tmpdir(), "lm-import-dst-"));
    exportRoot = mkdtempSync(join(tmpdir(), "lm-import-export-"));
    source = makeService(sourceDataHome);
    target = makeService(targetDataHome);
    sourceStore = source.store;
    targetStore = target.store;
  });

  afterEach(() => {
    sourceStore.close();
    targetStore.close();
    rmSync(sourceDataHome, { recursive: true, force: true });
    rmSync(targetDataHome, { recursive: true, force: true });
    rmSync(exportRoot, { recursive: true, force: true });
  });

  function insertAndGetId(input: Parameters<MemoryService["remember"]>[0]): string {
    const result = source.remember(input);
    if (!result.ok) throw new Error(`remember failed: ${result.error}`);
    return result.value.memory_id;
  }

  function exportSource(): void {
    const live = sourceStore.listEntries({ scope: "global", status: "active" });
    new CanonicalExporter(exportRoot).exportScope({
      scope: "global",
      format: "json",
      entries: live,
      budgetStatus: "1 active"
    });
  }

  /**
   * Pre-populate the target with an entry that shares
   * the source's id. The conflict tests need this so
   * the importer's `peekMemoryById` can find an
   * existing row.
   */
  function prePopulateTarget(sourceId: string, overrides: Partial<MemoryEntry>): void {
    const sourceEntry = source.peekMemoryById(sourceId);
    if (sourceEntry === undefined) {
      throw new Error(`source entry not found: ${sourceId}`);
    }
    const targetEntry: MemoryEntry = {
      ...sourceEntry,
      ...overrides,
      id: sourceId
    };
    target.writeInsertImportedEntry(targetEntry, "agent:test");
  }

  it("exports then imports the JSON bundle with dry-run first", () => {
    const sourceExporter = new CanonicalExporter(exportRoot);
    const id = insertAndGetId({
      scope: "global",
      type: "lesson",
      topic: "alpha",
      title: "Imported alpha",
      body: "alpha body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    expect(source.peekMemoryById(id)?.title).toBe("Imported alpha");

    const exportResult = sourceExporter.exportScope({
      scope: "global",
      format: "json",
      entries: [source.peekMemoryById(id) as MemoryEntry],
      budgetStatus: "1 active"
    });
    expect(exportResult.indexPath).toBeTruthy();

    // Dry-run on an empty target: all entries are inserts.
    const plan = planImport(
      target,
      join(exportRoot, "global"),
      "global",
      undefined,
      "json",
      { conflict: "keep", dry_run: true, actor: "agent:test" }
    );
    expect(plan.inserts).toHaveLength(1);
    expect(plan.replacements).toHaveLength(0);
    expect(plan.skipped).toHaveLength(0);
    // The target is untouched.
    expect(target.peekMemoryById(id)).toBeUndefined();
  });

  it("imports new entries under the default `keep` policy", () => {
    const id = insertAndGetId({
      scope: "global",
      type: "lesson",
      topic: "alpha",
      title: "Keep-inserted",
      body: "alpha body",
      tags: ["a"],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    exportSource();

    const result = importMemoryExport(
      target,
      join(exportRoot, "global"),
      "global",
      undefined,
      "json",
      { conflict: "keep", dry_run: false, actor: "agent:test" }
    );
    expect(result.applied).toBe(true);
    expect(result.plan.inserts).toHaveLength(1);
    expect(target.peekMemoryById(id)?.title).toBe("Keep-inserted");
  });

  it("`keep` policy skips existing entries without overwriting", () => {
    const id = insertAndGetId({
      scope: "global",
      type: "lesson",
      topic: "alpha",
      title: "Source title",
      body: "Source body",
      tags: ["src"],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    prePopulateTarget(id, { title: "Target title", body: "Target body", tags: ["tgt"] });
    expect(target.peekMemoryById(id)?.title).toBe("Target title");
    exportSource();

    const result = importMemoryExport(
      target,
      join(exportRoot, "global"),
      "global",
      undefined,
      "json",
      { conflict: "keep", dry_run: false, actor: "agent:test" }
    );
    expect(result.plan.skipped).toHaveLength(1);
    expect(result.plan.inserts).toHaveLength(0);
    expect(target.peekMemoryById(id)?.title).toBe("Target title");
  });

  it("`replace` policy overwrites when revisions match", () => {
    const id = insertAndGetId({
      scope: "global",
      type: "lesson",
      topic: "alpha",
      title: "Source title",
      body: "Source body",
      tags: ["src"],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    prePopulateTarget(id, { title: "Target title", body: "Target body", tags: ["tgt"] });
    expect(target.peekMemoryById(id)?.title).toBe("Target title");
    exportSource();

    const result = importMemoryExport(
      target,
      join(exportRoot, "global"),
      "global",
      undefined,
      "json",
      { conflict: "replace", dry_run: false, actor: "agent:test" }
    );
    expect(result.plan.replacements).toHaveLength(1);
    expect(target.peekMemoryById(id)?.title).toBe("Source title");
  });

  it("`fail` policy aborts on the first conflict", () => {
    const id = insertAndGetId({
      scope: "global",
      type: "lesson",
      topic: "alpha",
      title: "Source",
      body: "Source body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    prePopulateTarget(id, { title: "Target", body: "Target body", tags: [] });
    expect(target.peekMemoryById(id)?.title).toBe("Target");
    exportSource();

    expect(() =>
      importMemoryExport(
        target,
        join(exportRoot, "global"),
        "global",
        undefined,
        "json",
        { conflict: "fail", dry_run: false, actor: "agent:test" }
      )
    ).toThrow(/import conflict/);
    // The target is untouched.
    expect(target.peekMemoryById(id)?.title).toBe("Target");
  });

  it("v1.1.3 GATE-01 (#31): preflight rejection leaves zero rows across the eight project + content tables", () => {
    // The preflight failure path MUST be zero-write. The
    // contract pins the row counts across the canonical
    // eight tables (project_identities +
    // project_aliases_new + project_scopes + memory_entries
    // + memory_revisions + audit_events + memory_relations
    // + memory_provenance). The `import_batches` table is
    // excluded because the preflight never mints a batch
    // row (the lineage surface is apply-only).
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
    const h = target.store.backupHandle();
    const before: Record<string, number> = {};
    for (const t of tables) {
      const row = h.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
      before[t] = row.n;
    }
    // Seed a source entry that targets a known
    // project on the SOURCE (so the source can write
    // it) but is missing on the TARGET (so the
    // preflight refuses with `identity_conflict`).
    // This exercises the preflight rejection path
    // without going through the source-side
    // `remember` validation gate.
    const projectId = "fail-zero-rows-known-proj";
    const projectPath = "/tmp/fail-zero-rows-known-proj";
    source.configureProjectBudget(projectId, {
      max_active_entries: 100,
      max_total_chars: 1_000_000,
      max_topic_chars: 100_000,
      max_index_chars: 100_000
    }, projectPath, "Fail Zero Rows");
    insertAndGetId({
      scope: "project",
      project_id: projectId,
      project_path: projectPath,
      type: "lesson",
      topic: "alpha",
      title: "Source",
      body: "Source body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    // Export the project-scope entry (not the
    // global-only exportSource helper).
    const projectEntries = sourceStore.listEntries({
      scope: "project",
      project_id: projectId,
      status: "active"
    });
    new CanonicalExporter(exportRoot).exportScope({
      scope: "project",
      project_id: projectId,
      format: "json",
      entries: projectEntries,
      budgetStatus: "1 active",
      generated_at: "2026-07-28T00:00:00.000Z"
    });
    // Invoke the import targeting a DIFFERENT
    // (unregistered) project_id so the preflight
    // refuses with `identity_conflict`.
    expect(() =>
      importMemoryExport(
        target,
        join(exportRoot, "projects", projectId),
        "project",
        "fail-zero-rows-different-proj",
        "json",
        { conflict: "fail", dry_run: false, actor: "agent:test" }
      )
    ).toThrow(/identity_conflict/);
    // The preflight rejection is zero-write across all
    // eight canonical tables.
    const after: Record<string, number> = {};
    for (const t of tables) {
      const row = h.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
      after[t] = row.n;
    }
    expect(after).toEqual(before);
  });

  it("manifest hash mismatch refuses the import", () => {
    insertAndGetId({
      scope: "global",
      type: "lesson",
      topic: "alpha",
      title: "Source",
      body: "Source body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    exportSource();
    // Tamper with the on-disk index.
    const indexPath = join(exportRoot, "global", "MEMORY.json");
    writeFileSync(indexPath, `{ "tampered": true }`, "utf8");
    // The manifest still records the old hash; the
    // on-disk file is now different. planImport with
    // require_clean_manifest should refuse.
    const manifest = readManifest(join(exportRoot, "global"));
    expect(manifest.files.length).toBeGreaterThan(0);
    expect(() =>
      planImport(
        target,
        join(exportRoot, "global"),
        "global",
        undefined,
        "json",
        { conflict: "keep", dry_run: true, actor: "agent:test", require_clean_manifest: true }
      )
    ).toThrow(/hash mismatch/);
  });

  it("applyImport returns zero errors for an empty plan", () => {
    const plan = {
      manifest: undefined as never,
      scope: "global" as const,
      inserts: [],
      replacements: [],
      skipped: [],
      decisions: []
    };
    const apply = applyImport(target, plan, {
      conflict: "keep",
      dry_run: false,
      actor: "agent:test"
    });
    expect(apply.errors).toEqual([]);
    expect(apply.applied).toBe(0);
  });
});
