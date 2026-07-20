import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../src/memory-service.js";
import { SQLiteMemoryStore } from "../src/sqlite-store.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-confirm-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const service = new MemoryService(store, undefined, "user:cli", dataHome);
  return { service, store };
}

describe("remember forced-confirm", () => {
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

  it("accepts the first write", () => {
    const result = service.remember({
      scope: "global",
      type: "fact",
      topic: "tooling",
      title: "use pnpm",
      body: "the project uses pnpm, not npm",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 4
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a second write with the same title without confirm_write", () => {
    const input = {
      scope: "global" as const,
      type: "fact" as const,
      topic: "tooling",
      title: "use pnpm",
      body: "the project uses pnpm, not npm",
      tags: [] as string[],
      source: { kind: "agent" as const },
      importance: 3,
      confidence: 4
    };
    const first = service.remember(input);
    expect(first.ok).toBe(true);
    const result = service.remember({
      ...input,
      body: "the project uses pnpm, not npm. install with pnpm i."
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("duplicate_candidate");
      const details = result.details as { matching_ids: string[] };
      expect(details.matching_ids.length).toBe(1);
    }
  });

  it("accepts the second write when confirm_write is true", () => {
    const input = {
      scope: "global" as const,
      type: "fact" as const,
      topic: "tooling",
      title: "use pnpm",
      body: "the project uses pnpm, not npm",
      tags: [] as string[],
      source: { kind: "agent" as const },
      importance: 3,
      confidence: 4
    };
    service.remember(input);
    const result = service.remember({
      ...input,
      body: "the project uses pnpm, not npm. install with pnpm i.",
      confirm_write: true
    });
    expect(result.ok).toBe(true);
  });

  it("does not reject when no duplicate exists even without confirm_write", () => {
    const result = service.remember({
      scope: "global",
      type: "fact",
      topic: "tooling",
      title: "use eslint",
      body: "lint before commit",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 4
    });
    expect(result.ok).toBe(true);
  });

  it("rejects duplicate_candidate on body match too, not just title", () => {
    const input = {
      scope: "global" as const,
      type: "fact" as const,
      topic: "tooling",
      title: "use pnpm",
      body: "the project uses pnpm",
      tags: [] as string[],
      source: { kind: "agent" as const },
      importance: 3,
      confidence: 4
    };
    service.remember(input);
    const result = service.remember({
      ...input,
      title: "different title"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("duplicate_candidate");
    }
  });
});

describe("remember near-duplicate detection (stage 3)", () => {
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

  const baseInput = (overrides: Record<string, unknown> = {}) => ({
    scope: "global" as const,
    type: "fact" as const,
    topic: "stack",
    title: "project uses postgres",
    body: "primary datastore is postgres",
    tags: [] as string[],
    source: { kind: "agent" as const },
    importance: 3,
    confidence: 4,
    ...overrides
  });

  it("surfaces a near_duplicate warning in the success result when the body is a moderate rephrasing", () => {
    const first = service.remember(baseInput({ title: "p1" }));
    if (!first.ok) throw new Error("setup");
    // body adds "for the api" — share 3/4 content tokens => jaccard 0.75
    // title is unrelated so the exact-match path doesn't fire.
    const result = service.remember(
      baseInput({ title: "p2", body: "primary datastore is postgres for the api" })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const nearWarns = result.value.warnings.filter((w) => w.code === "near_duplicate");
    expect(nearWarns.map((w) => w.memory_id)).toEqual([first.value.memory_id]);
  });

  it("does not surface any near_duplicate warning when no near-duplicate exists", () => {
    const result = service.remember(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const nearWarns = result.value.warnings.filter((w) => w.code === "near_duplicate");
    expect(nearWarns).toEqual([]);
  });

  it("does not flag completely-different phrasings", () => {
    service.remember(baseInput());
    const result = service.remember(baseInput({ title: "user prefers tabs", body: "indent with tabs not spaces" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const nearWarns = result.value.warnings.filter((w) => w.code === "near_duplicate");
    expect(nearWarns).toEqual([]);
  });

  it("still blocks exact duplicates with confirm_write required", () => {
    service.remember(baseInput());
    const result = service.remember(baseInput()); // exact same title+body
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("duplicate_candidate");
    }
  });

  it("bypasses near-duplicate advisory on confirm_write: true (no error, no warning)", () => {
    service.remember(baseInput({ title: "p1" }));
    const result = service.remember(
      baseInput({ title: "p2", body: "primary datastore is postgres for the api", confirm_write: true })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const nearWarns = result.value.warnings.filter((w) => w.code === "near_duplicate");
    expect(nearWarns).toEqual([]);
  });

  it("includes the matching memory's writer actor on the near_duplicate warning", () => {
    // Write the first memory with a different actor
    const dataHome = mkdtempSync(join(tmpdir(), "lm-actor-"));
    const sharedStore = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const claude = new MemoryService(sharedStore, undefined, "agent:claude-code", dataHome);
    const cursor = new MemoryService(sharedStore, undefined, "agent:cursor", dataHome);

    const first = claude.remember(baseInput({ title: "p1" }));
    if (!first.ok) throw new Error("setup");
    const result = cursor.remember(baseInput({ title: "p2", body: "primary datastore is postgres for the api" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const nearWarns = result.value.warnings.filter((w) => w.code === "near_duplicate");
    expect(nearWarns.length).toBe(1);
    expect(nearWarns[0]?.actor).toBe("agent:claude-code");
    sharedStore.close();
  });

  it("includes the matching memory's last_accessed_by map on the near_duplicate warning", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-accessed-"));
    const sharedStore = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const claude = new MemoryService(sharedStore, undefined, "agent:claude-code", dataHome);
    const cursor = new MemoryService(sharedStore, undefined, "agent:cursor", dataHome);

    const first = claude.remember(baseInput({ title: "p1" }));
    if (!first.ok) throw new Error("setup");
    // claude reads its own memory (populates last_accessed_by)
    claude.getMemory(first.value.memory_id, "agent:claude-code");
    // cursor writes a similar memory
    const result = cursor.remember(baseInput({ title: "p2", body: "primary datastore is postgres for the api" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const nearWarns = result.value.warnings.filter((w) => w.code === "near_duplicate");
    expect(nearWarns.length).toBe(1);
    expect(nearWarns[0]?.last_accessed_by?.["agent:claude-code"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    sharedStore.close();
  });
});
