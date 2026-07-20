// test/memory-service-updated-at.test.ts
//
// Stage 7: MemoryService.listMemories and searchMemories must
// forward the optional updated_since / updated_until filter
// from their typed input through to the store.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryService } from "../src/memory-service.js";
import { SQLiteMemoryStore } from "../src/sqlite-store.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-svc-updated-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const service = new MemoryService(store, undefined, "agent:test", dataHome);
  return { service, store, dataHome };
}

const baseInput = (overrides: Record<string, unknown> = {}) => ({
  scope: "global" as const,
  type: "fact" as const,
  topic: "stack",
  title: "uses postgres",
  body: "the project uses postgres for the primary datastore",
  tags: [] as string[],
  source: { kind: "agent" as const },
  importance: 3,
  confidence: 4,
  ...overrides
});

describe("MemoryService forwards the updated_at filter (stage 7)", () => {
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

  it("listMemories forwards updated_since to store.listEntries", () => {
    const spy = vi.spyOn(store, "listEntries");
    const r1 = service.remember(baseInput({ title: "first a" }));
    if (!r1.ok) throw new Error(`setup1: ${r1.error}`);

    service.listMemories({ scope: "global", updated_since: "2026-07-13T00:00:00.000Z" });
    const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
    expect(lastCall?.[0]?.updated_since).toBe("2026-07-13T00:00:00.000Z");
  });

  it("listMemories forwards updated_until to store.listEntries", () => {
    const spy = vi.spyOn(store, "listEntries");
    const r1 = service.remember(baseInput({ title: "first a" }));
    if (!r1.ok) throw new Error(`setup1: ${r1.error}`);

    service.listMemories({ scope: "global", updated_until: "2026-07-20T00:00:00.000Z" });
    const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
    expect(lastCall?.[0]?.updated_until).toBe("2026-07-20T00:00:00.000Z");
  });

  it("searchMemories forwards updated_since to store.searchEntries", () => {
    const spy = vi.spyOn(store, "searchEntries");
    const r1 = service.remember(baseInput({ title: "uses postgres here" }));
    if (!r1.ok) throw new Error("setup");

    service.searchMemories({
      query: "postgres",
      scope: "global",
      updated_since: "2026-07-13T00:00:00.000Z"
    });
    const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
    expect(lastCall?.[0]?.updated_since).toBe("2026-07-13T00:00:00.000Z");
  });

  it("omitted updated_at filters do not pass the field through", () => {
    const spy = vi.spyOn(store, "listEntries");
    const r1 = service.remember(baseInput({ title: "first a" }));
    if (!r1.ok) throw new Error(`setup1: ${r1.error}`);

    service.listMemories({ scope: "global" });
    const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
    expect(lastCall?.[0]?.updated_since).toBeUndefined();
    expect(lastCall?.[0]?.updated_until).toBeUndefined();
  });
});
