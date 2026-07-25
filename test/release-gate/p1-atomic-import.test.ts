// test/release-gate/p1-atomic-import.test.ts
//
// Stage 15 PR-M0-3 (issue #4, spec § 6.7): strict import
// pipeline release-gate. Locks down the five acceptance
// criteria from the issue body:
//
//   1. Default import is all-or-nothing. A failure on
//      entry N rolls back entries 1..N-1.
//   2. Failed import leaves the database unchanged.
//   3. Partial failures return non-zero exit code
//      (the CLI throw path is verified by the
//      `test/cli/import.test.ts` suite; here we
//      verify the underlying `applyImport` throws
//      and never returns a partial `applied` count).
//   4. Export/import round-trip preserves ids,
//      revisions, audit metadata, and scopes.
//   5. Unsupported formats (YAML) are removed.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../../src/memory-service.js";
import { MarkdownExporter } from "../../src/markdown-exporter.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import { CanonicalExporter } from "../../src/portability/exporter.js";
import {
  applyImport,
  planImport,
  type ImportOptions
} from "../../src/portability/importer.js";
import type { MemoryEntry } from "../../src/domain.js";

function makeService(dataHome: string): { service: MemoryService; store: SQLiteMemoryStore } {
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const exporter = new MarkdownExporter(join(dataHome, "exports"));
  const service = new MemoryService(store, exporter, "agent:test", dataHome);
  return { service, store };
}

describe("release-gate p1-atomic-import (issue #4)", () => {
  let dataHome: string;
  let sourceDataHome: string;
  let targetDataHome: string;
  let exportRoot: string;
  let source: MemoryService;
  let target: MemoryService;
  let sourceStore: SQLiteMemoryStore;
  let targetStore: SQLiteMemoryStore;

  beforeEach(() => {
    dataHome = mkdtempSync(join(tmpdir(), "lm-atomic-imp-"));
    sourceDataHome = mkdtempSync(join(tmpdir(), "lm-atomic-imp-src-"));
    targetDataHome = mkdtempSync(join(tmpdir(), "lm-atomic-imp-dst-"));
    exportRoot = mkdtempSync(join(tmpdir(), "lm-atomic-imp-export-"));
    source = makeService(sourceDataHome).service;
    target = makeService(targetDataHome).service;
    sourceStore = source.store;
    targetStore = target.store;
  });

  afterEach(() => {
    sourceStore.close();
    targetStore.close();
    try {
      rmSync(dataHome, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    try {
      rmSync(sourceDataHome, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    try {
      rmSync(targetDataHome, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    try {
      rmSync(exportRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  function seedAndExport(
    source: MemoryService,
    sourceStore: SQLiteMemoryStore,
    exportRoot: string
  ): { idA: string; idB: string; exportScopeDir: string } {
    const a = source.remember({
      scope: "global",
      type: "fact",
      topic: "tools",
      title: "alpha",
      body: "alpha body",
      tags: ["a"],
      source: { kind: "agent" },
      importance: 4,
      confidence: 3
    }, { actor_id: "agent:test" });
    const b = source.remember({
      scope: "global",
      type: "fact",
      topic: "tools",
      title: "beta",
      body: "beta body",
      tags: ["b"],
      source: { kind: "agent" },
      importance: 3,
      confidence: 5
    }, { actor_id: "agent:test" });
    if (!a.ok || !b.ok) throw new Error("seed failed");
    const live = sourceStore.listEntries({ scope: "global", status: "active" });
    new CanonicalExporter(exportRoot).exportScope({
      scope: "global",
      format: "json",
      entries: live,
      budgetStatus: "1 active"
    });
    return {
      idA: a.value.memory_id,
      idB: b.value.memory_id,
      exportScopeDir: join(exportRoot, "global")
    };
  }

  it("round-trip export -> import preserves ids, revisions, and scope", () => {
    const { idA, idB, exportScopeDir } = seedAndExport(source, sourceStore, exportRoot);

    const options: ImportOptions = {
      conflict: "fail",
      dry_run: false,
      actor: "agent:test"
    };
    const plan = planImport(target, exportScopeDir, "global", undefined, "json", options);
    const result = applyImport(target, plan, options);
    expect(result.applied).toBe(2);
    expect(result.errors).toEqual([]);

    const restored = targetStore.listEntries({ scope: "global", status: "active" });
    expect(restored.length).toBe(2);
    const restoredIds = restored.map((e) => e.id).sort();
    expect(restoredIds).toEqual([idA, idB].sort());
    for (const entry of restored) {
      expect(entry.revision).toBe(1);
    }
  });

  it("applyImport rolls back on revision-drift (all-or-nothing)", () => {
    // Seed the target with an entry that shares the
    // source's id but is on a different revision
    // than the export. The apply must throw on the
    // CAS guard and roll back — no partial writes
    // survive.
    const { idA, idB, exportScopeDir } = seedAndExport(source, sourceStore, exportRoot);
    // Pre-populate the target with the SAME id as
    // `idA` so the import will see a `replace` slot.
    const sourceA = sourceStore.peekEntry(idA);
    if (!sourceA) throw new Error("source idA not found");
    target.writeInsertImportedEntry(
      { ...sourceA, id: idA, body: "stale body" } as MemoryEntry,
      "agent:test"
    );

    const before = targetStore.listEntries({ scope: "global", status: "active" });
    expect(before.length).toBe(1);
    expect(before[0]!.id).toBe(idA);

    const options: ImportOptions = {
      conflict: "replace",
      dry_run: false,
      actor: "agent:test"
    };
    const plan = planImport(target, exportScopeDir, "global", undefined, "json", options);
    // Plan classifies idA as a replace (existing live
    // row, replace policy) and idB as an insert.
    expect(plan.inserts.length).toBe(1);
    expect(plan.replacements.length).toBe(1);

    // Bump the live idA's revision to force a drift
    // between the export's revision (1) and the live
    // row's revision (2). We update the row's
    // `body` via a full-entry round-trip: peek the
    // existing row, mutate `body`, and call
    // `updateEntry` with the full entry shape.
    const liveA = targetStore.peekEntry(idA);
    if (!liveA) throw new Error("live idA missing");
    targetStore.updateEntry(
      idA,
      { ...liveA, body: "live v2" },
      {
        changed_by: "agent:test",
        change_reason: "drift setup"
      }
    );

    // The apply must throw and roll back. The DB
    // must still have the live idA row (not the
    // exported body) and must NOT have the new idB
    // row.
    // Note: the importer's `applyImport` checks the
    // pre-import revision against the live row at the
    // top of the apply (a "revision drift" error),
    // but the v2 `entryToUpdateInput` helper also
    // passes `expected_revision` to the service's
    // CAS guard. When the live row was bumped
    // between planImport and applyImport, the
    // service CAS check is the one that fires —
    // the row's revision is now 2 but the import
    // claims 1, so the service returns
    // `stale_revision`. Either error counts as
    // "the apply refused to clobber a moved row";
    // the test accepts both.
    expect(() => applyImport(target, plan, options)).toThrow(/(revision drift|stale_revision)/);
    const after = targetStore.listEntries({ scope: "global", status: "active" });
    expect(after.length).toBe(1);
    expect(after[0]!.id).toBe(idA);
    expect(after[0]!.body).toBe("live v2");
    // idB was not inserted (the transaction rolled
    // back before reaching it).
    expect(after.find((e) => e.id === idB)).toBeUndefined();
  });

  it("require_clean_manifest defaults to true", () => {
    // The v1 contract treated `require_clean_manifest`
    // as opt-in; the v2 contract makes it the
    // default. Verify by triggering a manifest
    // mismatch (delete one of the emitted files) and
    // asserting the planImport throws WITHOUT the
    // caller passing `require_clean_manifest: true`.
    const { exportScopeDir } = seedAndExport(source, sourceStore, exportRoot);
    // Tamper with one of the topic files so its
    // hash no longer matches the manifest.
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    const tamperedPath = join(exportScopeDir, "topics", "tools.json");
    writeFileSync(tamperedPath, '{"tampered":true}');

    const options: ImportOptions = {
      conflict: "keep",
      dry_run: true,
      actor: "agent:test"
      // require_clean_manifest: omitted — must default
      // to true.
    };
    expect(() => planImport(target, exportScopeDir, "global", undefined, "json", options)).toThrow(/manifest hash mismatch/);
  });

  it("YAML is no longer accepted as an import format", () => {
    // The v1 contract's `--format yaml` path is gone;
    // passing it to the importer must fail with a
    // helpful error. The CLI's exit-code check is
    // in test/cli/import.test.ts; here we verify the
    // type-level contract.
    const { exportScopeDir } = seedAndExport(source, sourceStore, exportRoot);
    type ImportFormat = Parameters<typeof planImport>[4];
    const yamlFormat: ImportFormat = "yaml" as never;
    expect(() =>
      planImport(target, exportScopeDir, "global", undefined, yamlFormat, {
        conflict: "keep",
        dry_run: true,
        actor: "agent:test"
      })
    ).toThrow();
  });
});
