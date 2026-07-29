// test/maintenance-dry-run.test.ts
//
// Stage 8: maintain_memories gains a `dry_run` flag. For
// `archive_low_value`, `expire_due`, and `merge_duplicates`,
// dry_run returns the would-be changes without mutating.
// Read-only actions (`find_duplicates`, `rebuild_markdown_index`,
// `vacuum_fts`) ignore the flag.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../src/memory-service.js";
import { SQLiteMemoryStore } from "../src/sqlite-store.js";
import { InMemoryCapabilityStore } from "../src/admin/capability.js";
import type { MemoryEntry } from "../src/domain.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-dry-run-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  // v1.1.3 GATE-03 (issue #33): the dry-run
  // surface for `merge_duplicates` is restricted
  // to the Admin profile (the destructive
  // path is Admin-only; the dry-run reports
  // the would_supersede plan but does not
  // actually mutate). The other dry-run actions
  // (`archive_low_value`, `expire_due`) remain
  // safe on Core. The service is constructed
  // with the Admin profile + a loaded
  // capability so the `merge_duplicates`
  // dry-run path is authorized.
  const knownToken = "b".repeat(64);
  const capStore = new InMemoryCapabilityStore({
    token: knownToken,
    created_at: new Date().toISOString(),
    label: "maintenance-dry-run"
  });
  const service = new MemoryService(
    store,
    undefined,
    "agent:test",
    dataHome,
    capStore as never,
    "admin"
  );
  return { service, store, dataHome };
}

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? `mem_${Math.random().toString(36).slice(2)}`,
    scope: "global",
    type: "fact",
    memory_kind: "semantic",
    topic: "t",
    title: overrides.title ?? "default",
    body: overrides.body ?? "default",
    tags: [],
    source: { kind: "agent" },
    importance: overrides.importance ?? 1,
    confidence: overrides.confidence ?? 1,
    status: "active",
    created_at: overrides.created_at ?? "2026-07-15T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-07-15T00:00:00.000Z",
    access_count: 0,
    supersedes: [],
    token_estimate: 1,
    char_count: 1,
    ...overrides
  } as MemoryEntry;
}

describe("maintainMemories dry_run (stage 8)", () => {
  let service: MemoryService;
  let store: SQLiteMemoryStore;

  beforeEach(() => {
    ({ service, store } = setup());
  });
  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
  });

  it("archive_low_value with dry_run returns would_archive_count + sample; no state change", () => {
    // Three low-importance (1) memories that the budget governor
    // would normally flag as cleanup candidates.
    for (let i = 0; i < 3; i += 1) {
      store.insertEntry(makeEntry({
        id: `mem_low_${i}`,
        title: `low ${i}`,
        body: `low importance body ${i}`,
        importance: 1,
        confidence: 1
      }));
    }

    const result = service.maintainMemories({
      action: "archive_low_value",
      scope: "global",
      dry_run: true
    });

    // The result reports what would have happened.
    const details = result.details as { would_archive_count?: number; would_archive_sample?: Array<{ id: string }> };
    expect(details.would_archive_count).toBe(3);
    expect(details.would_archive_sample?.length).toBeGreaterThan(0);
    // changed is reported as 0 because dry_run doesn't actually
    // archive anything.
    expect(result.changed).toBe(0);
    // No state change.
    for (let i = 0; i < 3; i += 1) {
      expect(store.peekEntry(`mem_low_${i}`)?.status).toBe("active");
    }
  });

  it("expire_due with dry_run returns would_expire_count + sample; no body clears", () => {
    // Insert an entry with expires_at in the past.
    const pastExpiry = "2026-01-01T00:00:00.000Z";
    store.insertEntry(makeEntry({
      id: "mem_expired",
      title: "expired memory",
      body: "this should be expired",
      expires_at: pastExpiry
    }));

    const result = service.maintainMemories({
      action: "expire_due",
      scope: "global",
      dry_run: true
    });

    const details = result.details as { would_expire_count?: number; would_expire_sample?: Array<{ id: string }> };
    expect(details.would_expire_count).toBe(1);
    expect(details.would_expire_sample?.map((s) => s.id)).toContain("mem_expired");
    // No state change: the entry is still active with body intact.
    const stillActive = store.peekEntry("mem_expired");
    expect(stillActive?.status).toBe("active");
    expect(stillActive?.body).toBe("this should be expired");
  });

  it("merge_duplicates with dry_run returns per-group would_supersede; no audit events", () => {
    // Three same-title entries -> one group of size 3.
    const e1 = makeEntry({ id: "mem_aaa", title: "exact", body: "exact body", created_at: "2026-07-01T00:00:00.000Z" });
    const e2 = makeEntry({ id: "mem_bbb", title: "exact", body: "exact body", created_at: "2026-07-02T00:00:00.000Z" });
    const e3 = makeEntry({ id: "mem_ccc", title: "exact", body: "exact body", created_at: "2026-07-03T00:00:00.000Z" });
    for (const e of [e1, e2, e3]) store.insertEntry(e);

    const result = service.maintainMemories({
      action: "merge_duplicates",
      scope: "global",
      dry_run: true,
      strategy: "keep_first"
    });

    const details = result.details as {
      groups?: Array<{ keep_id: string; superseded_ids: string[] }>;
      dry_run?: boolean;
    };
    expect(details.dry_run).toBe(true);
    // The three entries share title and body, so findDuplicateGroups
    // returns multiple groups (same_title_and_body, same_title,
    // same_body, similar_title_and_body). All collapse to the
    // same set of would-be supersedes. We just assert that the
    // size-3 group exists with the expected keep + supersede set.
    const sizeThreeGroup = details.groups?.find((g) => g.keep_id === "mem_aaa" && g.superseded_ids.length === 2);
    expect(sizeThreeGroup).toBeDefined();
    expect(sizeThreeGroup?.superseded_ids.sort()).toEqual(["mem_bbb", "mem_ccc"]);
    // No state change.
    expect(store.peekEntry("mem_aaa")?.status).toBe("active");
    expect(store.peekEntry("mem_bbb")?.status).toBe("active");
    expect(store.peekEntry("mem_ccc")?.status).toBe("active");
    // No audit events.
    expect(store.getAuditEvents("mem_bbb").filter((a) => a.event === "superseded").length).toBe(0);
    expect(store.getAuditEvents("mem_ccc").filter((a) => a.event === "superseded").length).toBe(0);
  });

  it("dry_run: false (default) actually mutates; state matches dry-run report", () => {
    // Use archive_low_value; the dry-run reports the same set
    // that the real run actually archives.
    for (let i = 0; i < 3; i += 1) {
      store.insertEntry(makeEntry({
        id: `mem_low_${i}`,
        title: `low ${i}`,
        body: `low importance body ${i}`,
        importance: 1,
        confidence: 1
      }));
    }

    // First: dry-run to see what would change.
    const dryResult = service.maintainMemories({
      action: "archive_low_value",
      scope: "global",
      dry_run: true
    });
    const dryDetails = dryResult.details as { would_archive_count?: number };
    expect(dryDetails.would_archive_count).toBe(3);

    // Second: actually run it.
    const realResult = service.maintainMemories({
      action: "archive_low_value",
      scope: "global"
    });
    // changed reports the actual count mutated.
    expect(realResult.changed).toBe(3);
    // All three are now archived.
    for (let i = 0; i < 3; i += 1) {
      expect(store.peekEntry(`mem_low_${i}`)?.status).toBe("archived");
    }
  });
});
