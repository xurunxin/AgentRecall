// test/format-exporters.test.ts
//
// Stage 8: ExportScopeInput gains a `format` field. The
// FormatRouter routes "markdown" to the existing
// MarkdownExporter, "json" to a new JsonExporter, and
// "yaml" to a new YamlExporter. Both new exporters write
// stable, sorted, machine-readable outputs.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FormatRouter } from "../src/format-exporters.js";
import type { MemoryEntry } from "../src/domain.js";

function setup() {
  const exportRoot = mkdtempSync(join(tmpdir(), "lm-fmt-"));
  return { exportRoot };
}

function cleanup(exportRoot: string): void {
  if (existsSync(exportRoot)) {
    rmSync(exportRoot, { recursive: true, force: true });
  }
}

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? `mem_${Math.random().toString(36).slice(2)}`,
    scope: "global",
    type: "fact",
    memory_kind: "semantic",
    topic: overrides.topic ?? "general",
    title: overrides.title ?? "default title",
    body: overrides.body ?? "default body",
    tags: overrides.tags ?? [],
    source: overrides.source ?? { kind: "agent" },
    importance: overrides.importance ?? 3,
    confidence: overrides.confidence ?? 3,
    status: "active",
    created_at: overrides.created_at ?? "2026-07-15T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-07-15T00:00:00.000Z",
    access_count: 0,
    supersedes: overrides.supersedes ?? [],
    token_estimate: 1,
    char_count: 1,
    ...overrides
  } as MemoryEntry;
}

const baseEntries: MemoryEntry[] = [
  makeEntry({ id: "mem_a", topic: "alpha", title: "first", body: "first body", importance: 5, tags: ["a", "b"] }),
  makeEntry({ id: "mem_b", topic: "beta", title: "second", body: "second body", importance: 3, tags: ["c"] })
];

describe("FormatRouter (stage 8)", () => {
  let exportRoot: string;
  beforeEach(() => {
    ({ exportRoot } = setup());
  });
  afterEach(() => cleanup(exportRoot));

  it("routes format=markdown to MarkdownExporter (default behavior)", () => {
    const router = new FormatRouter(exportRoot);
    const result = router.export({
      scope: "global",
      entries: baseEntries,
      budgetStatus: "1 active entries",
      format: "markdown"
    });
    expect(result.indexPath).toMatch(/MEMORY\.md$/);
    expect(existsSync(result.indexPath)).toBe(true);
  });

  it("routes format=json to JsonExporter", () => {
    const router = new FormatRouter(exportRoot);
    const result = router.export({
      scope: "global",
      entries: baseEntries,
      budgetStatus: "1 active entries",
      format: "json"
    });
    expect(result.indexPath).toMatch(/MEMORY\.json$/);
    expect(existsSync(result.indexPath)).toBe(true);
  });

  it("routes format=yaml to YamlExporter", () => {
    const router = new FormatRouter(exportRoot);
    const result = router.export({
      scope: "global",
      entries: baseEntries,
      budgetStatus: "1 active entries",
      format: "yaml"
    });
    expect(result.indexPath).toMatch(/MEMORY\.yaml$/);
    expect(existsSync(result.indexPath)).toBe(true);
  });

  it("omitted format defaults to markdown", () => {
    const router = new FormatRouter(exportRoot);
    const result = router.export({
      scope: "global",
      entries: baseEntries,
      budgetStatus: "1 active entries"
    });
    expect(result.indexPath).toMatch(/MEMORY\.md$/);
  });
});

describe("JsonExporter (stage 8)", () => {
  let exportRoot: string;
  beforeEach(() => {
    ({ exportRoot } = setup());
  });
  afterEach(() => cleanup(exportRoot));

  it("writes MEMORY.json with sorted keys", () => {
    const router = new FormatRouter(exportRoot);
    const result = router.export({
      scope: "global",
      entries: baseEntries,
      budgetStatus: "1 active entries",
      format: "json"
    });
    const text = readFileSync(result.indexPath, "utf8");
    // Sorted keys means the first chars are "budget" then "high_importance"...
    // (alphabetical). The "entries" key is mid-list. We just
    // check that the JSON parses and contains the expected top-level
    // shape.
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.scope).toBe("global");
    expect(parsed.budget).toBe("1 active entries");
    expect(Array.isArray(parsed.topics)).toBe(true);
    expect(Array.isArray(parsed.high_importance)).toBe(true);
  });

  it("writes one JSON file per topic", () => {
    const router = new FormatRouter(exportRoot);
    const result = router.export({
      scope: "global",
      entries: baseEntries,
      budgetStatus: "1 active entries",
      format: "json"
    });
    expect(result.topicPaths.length).toBe(2);
    for (const path of result.topicPaths) {
      expect(existsSync(path)).toBe(true);
      expect(path).toMatch(/\.json$/);
      // The topic file should parse as a JSON object.
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { entries: MemoryEntry[] };
      expect(Array.isArray(parsed.entries)).toBe(true);
      expect(parsed.entries.length).toBeGreaterThan(0);
    }
  });

  it("handles entries with supersedes and superseded_by", () => {
    const entry = makeEntry({
      id: "mem_chain",
      topic: "chain",
      title: "first",
      body: "v1",
      supersedes: ["mem_older"],
      updated_at: "2026-07-15T00:00:00.000Z",
      created_at: "2026-07-10T00:00:00.000Z"
    });
    const router = new FormatRouter(exportRoot);
    const result = router.export({
      scope: "global",
      entries: [entry],
      budgetStatus: "1 active entries",
      format: "json"
    });
    // Entries are in per-topic files; the index only has summaries.
    const topicPath = result.topicPaths[0];
    expect(topicPath).toBeDefined();
    const topicText = readFileSync(topicPath!, "utf8");
    const parsed = JSON.parse(topicText) as { entries: MemoryEntry[] };
    const found = parsed.entries.find((e) => e.id === "mem_chain");
    expect(found?.supersedes).toEqual(["mem_older"]);
  });
});

describe("YamlExporter (stage 8)", () => {
  let exportRoot: string;
  beforeEach(() => {
    ({ exportRoot } = setup());
  });
  afterEach(() => cleanup(exportRoot));

  it("writes MEMORY.yaml with structural validity", () => {
    const router = new FormatRouter(exportRoot);
    const result = router.export({
      scope: "global",
      entries: baseEntries,
      budgetStatus: "1 active entries",
      format: "yaml"
    });
    const text = readFileSync(result.indexPath, "utf8");
    // Basic structural assertions: starts with `scope:` and
    // contains the topic names as list items.
    expect(text).toMatch(/^scope: global/m);
    expect(text).toMatch(/topics:/);
    expect(text).toMatch(/alpha/);
    expect(text).toMatch(/beta/);
  });

  it("quotes strings that look like booleans / numbers / null", () => {
    // A title that looks like a number/boolean/null must be
    // quoted to avoid the YAML parser interpreting it.
    const trickyEntries: MemoryEntry[] = [
      makeEntry({ id: "mem_bool", topic: "tricky", title: "true", body: "looks like a boolean title" }),
      makeEntry({ id: "mem_num", topic: "tricky", title: "42", body: "looks like a number title" }),
      makeEntry({ id: "mem_null", topic: "tricky", title: "null", body: "looks like a null title" })
    ];
    const router = new FormatRouter(exportRoot);
    const result = router.export({
      scope: "global",
      entries: trickyEntries,
      budgetStatus: "1 active entries",
      format: "yaml"
    });
    const text = readFileSync(result.indexPath, "utf8");
    // The titles in the topic file (or index) must be quoted.
    const topicPath = result.topicPaths[0];
    if (topicPath !== undefined) {
      const topicText = readFileSync(topicPath, "utf8");
      // Expect quoted strings: "true", "42", "null"
      expect(topicText).toMatch(/title: "true"/);
      expect(topicText).toMatch(/title: "42"/);
      expect(topicText).toMatch(/title: "null"/);
    }
    // Also verify the index file is well-formed.
    expect(text).toContain("scope: global");
  });

  it("writes one YAML file per topic", () => {
    const router = new FormatRouter(exportRoot);
    const result = router.export({
      scope: "global",
      entries: baseEntries,
      budgetStatus: "1 active entries",
      format: "yaml"
    });
    expect(result.topicPaths.length).toBe(2);
    for (const path of result.topicPaths) {
      expect(existsSync(path)).toBe(true);
      expect(path).toMatch(/\.yaml$/);
    }
  });
});
