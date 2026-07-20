// test/release-gate/p0-backup.test.ts
//
// Stage 10 PR1: Release-gate P0 regressions for destructive
// maintenance backup safety (AR-P0-005).
//
// The current main branch has two intertwined bugs:
//
//   1. `memory-maintenance-service.ts` calls `maybeBackup`
//      *inside* the `transaction()` closure. SQLite refuses
//      `VACUUM INTO` against a connection holding an open
//      transaction, so the backup silently fails on every
//      `expire_due` / `archive_low_value` / `merge_duplicates`
//      run.
//   2. `maybeBackup` catches the failure with `catch {}` and
//      emits an `backup_created` audit event anyway, lying to
//      the operator about a backup that does not exist.
//
// Stage 10 PR5 fixes both: backup moves outside the
// transaction, is verified with an independent read-only
// `quick_check`, and any failure raises `backup_failed`
// *before* the destructive action is taken.
//
// These tests lock down the post-PR5 invariants:
//
//   1. A failed pre-mutation backup causes the destructive
//      action to return `changed=0` (no state change).
//   2. The audit log never reports `backup_created` for a
//      backup that did not actually happen.
//
// Reference: spec § 5.5 AR-P0-005 "破坏性操作的备份与恢复协议".

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../../src/memory-service.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import type { MemoryEntry } from "../../src/domain.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-bk-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const service = new MemoryService(store, undefined, "agent:test", dataHome);
  return { service, store, dataHome };
}

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? `mem_${Math.random().toString(36).slice(2)}`,
    scope: "global",
    type: "fact",
    memory_kind: "semantic",
    topic: "t",
    title: overrides.title ?? "expire me",
    body: overrides.body ?? "expire me body",
    tags: [],
    source: { kind: "agent" },
    importance: 3,
    confidence: 3,
    status: "active",
    created_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z",
    access_count: 0,
    supersedes: [],
    token_estimate: 1,
    char_count: 1,
    ...overrides
  } as MemoryEntry;
}

describe("release-gate p0-backup (AR-P0-005)", () => {
  let service: MemoryService;
  let store: SQLiteMemoryStore;
  let dataHome: string;

  beforeEach(() => {
    ({ service, store, dataHome } = setup());
  });
  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
  });

  it("a pre-mutation backup failure leaves the destructive action with changed=0", () => {
    // Arrange: an expired entry that the maintenance would
    // normally forget.
    store.insertEntry(makeEntry({
      id: "mem_rg_expire_1",
      expires_at: "2026-01-01T00:00:00.000Z"
    }));

    // Arrange: make the backup directory non-creatable. We
    // block `dataHome/backups` by writing a file with that
    // name; `mkdirSync(..., {recursive:true})` on Windows /
    // Linux refuses when a non-directory occupies the path.
    const blockedPath = join(dataHome, "backups");
    if (!existsSync(blockedPath)) {
      mkdirSync(dataHome, { recursive: true });
      writeFileSync(blockedPath, "blocks the backup directory");

      // Sanity check: confirm mkdirSync would fail.
      let mkdirFailed = false;
      try {
        mkdirSync(blockedPath, { recursive: true });
      } catch {
        mkdirFailed = true;
      }
      expect(mkdirFailed).toBe(true);
    }

    // Act + assert: the maintenance call must surface the
    // backup failure (throw or return changed=0) and must
    // not have actually forgotten the entry.
    let thrown: unknown = undefined;
    let result: { changed: number; details: unknown } | undefined = undefined;
    try {
      result = service.maintainMemories({ action: "expire_due", scope: "global" });
    } catch (error) {
      thrown = error;
    }

    // The entry must still be active.
    const stillActive = store.peekEntry("mem_rg_expire_1");
    expect(stillActive?.status).toBe("active");

    // The result, if returned, must report zero changes.
    if (result !== undefined) {
      expect(result.changed).toBe(0);
    }
    // Either path is acceptable: throw, or a changed=0 result.
    // The forbidden outcome is: the entry was forgotten AND
    // there is no exception AND changed > 0.
    expect(thrown !== undefined || (result !== undefined && result.changed === 0)).toBe(true);
  });

  it("audit log never reports backup_created when no backup file exists", () => {
    // Arrange: an expired entry + a blocked backup path.
    store.insertEntry(makeEntry({
      id: "mem_rg_audit_bk_1",
      expires_at: "2026-01-01T00:00:00.000Z"
    }));
    const blockedPath = join(dataHome, "backups");
    if (!existsSync(blockedPath)) {
      mkdirSync(dataHome, { recursive: true });
      writeFileSync(blockedPath, "blocks the backup directory");
    }

    // Act: try the maintenance call.
    try {
      service.maintainMemories({ action: "expire_due", scope: "global" });
    } catch {
      // expected
    }

    // Assert: the audit log must NOT claim a backup was
    // created. The pre-PR5 code emits a `backup_created`
    // event even when the actual file write failed.
    const audits = store.listAuditEvents({ event: "backup_created" });
    // If audits is non-empty, every reported path must
    // actually exist on disk.
    for (const a of audits) {
      const path = (a.metadata as { path?: string }).path;
      if (path !== undefined) {
        expect(existsSync(path)).toBe(true);
      }
    }
  });
});
