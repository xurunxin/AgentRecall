// test/memory-service-actor-filter.test.ts
//
// Stage 4: MemoryService.listMemories and searchMemories must
// forward the optional actor filter from their typed input through
// to the store, so the per-agent view works end-to-end.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryService } from "../src/memory-service.js";
import { SQLiteMemoryStore } from "../src/sqlite-store.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-svc-actor-"));
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

describe("MemoryService forwards the actor filter (stage 4)", () => {
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

  it("listMemories forwards the actor field to store.listEntries", () => {
    const spy = vi.spyOn(store, "listEntries");
    const r1 = service.remember(baseInput({ title: "uses postgres a", body: "first fact about postgres" }));
    if (!r1.ok) throw new Error(`setup1: ${r1.error}`);
    const r2 = service.remember(baseInput({ title: "uses postgres b", body: "second fact about postgres" }));
    if (!r2.ok) throw new Error(`setup2: ${r2.error}`);

    service.listMemories({ scope: "global", actor: "agent:test" });
    const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
    expect(lastCall?.[0]?.actor).toBe("agent:test");
  });

  it("searchMemories forwards the actor field to store.searchEntries", () => {
    const spy = vi.spyOn(store, "searchEntries");
    const r1 = service.remember(baseInput({ title: "uses postgres here" }));
    if (!r1.ok) throw new Error("setup");

    service.searchMemories({ query: "postgres", scope: "global", actor: "agent:test" });
    const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
    expect(lastCall?.[0]?.actor).toBe("agent:test");
  });

  it("listMemories returns the filtered subset end-to-end", () => {
    // Write 2 memories; the service actor is "agent:test" for both.
    const r1 = service.remember(baseInput({ title: "first a", body: "first fact" }));
    if (!r1.ok) throw new Error(`setup1: ${r1.error}`);
    const r2 = service.remember(baseInput({ title: "second b", body: "second fact" }));
    if (!r2.ok) throw new Error(`setup2: ${r2.error}`);

    // Re-open with a different actor and check we get nothing (since
    // both memories were created by "agent:test").
    const otherService = new MemoryService(store, undefined, "agent:other", dataHome);
    const otherResult = otherService.listMemories({ scope: "global", actor: "agent:other" });
    expect(Array.isArray(otherResult.items)).toBe(true);
    expect(otherResult.items.length).toBe(0);

    // And the original actor sees both.
    const ours = service.listMemories({ scope: "global", actor: "agent:test" });
    expect(Array.isArray(ours.items)).toBe(true);
    expect(ours.items.length).toBe(2);
  });
});
