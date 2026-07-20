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
