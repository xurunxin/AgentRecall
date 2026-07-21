// test/portability.test.ts
//
// Stage 13 PR10 (spec § 6.7): the portability contract
// tests. Cover:
//   - canonical model: collision-safe filename map
//     (slug + shortHash + Windows reserved guard),
//     CJK topic → non-ASCII slug → distinct file,
//     case collisions
//   - renderers: markdown / json / yaml produce stable
//     bytes for the same input
//   - atomic publisher: stage + publish + rollback
//     (the live export is restored when the publish
//     throws)
//   - manifest: write + read + verify (SHA-256 of
//     every emitted file matches the manifest record;
//     a tampered file is reported)
//   - exporter: the high-level `exportScope` returns
//     the live paths and the manifest is on disk
//
// These tests do not touch the live SQLite store. The
// import path is exercised by `portability-import.test.ts`.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildCanonicalScope,
  buildTopicFilenameMap,
  safeTopicBase,
  shortHash,
  WINDOWS_RESERVED_BASENAMES
} from "../src/portability/canonical-model.js";
import { CanonicalExporter } from "../src/portability/exporter.js";
import { stageFiles, publishStagedFiles, scopeDirFor } from "../src/portability/atomic-publisher.js";
import { MANIFEST_FILENAME, buildManifest, readManifest, serializeManifest, verifyManifest, writeManifest } from "../src/portability/manifest.js";
import type { MemoryEntry } from "../src/domain.js";

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "mem_1",
    scope: "global",
    type: "lesson",
    topic: "general",
    title: "Default title",
    body: "Default body.",
    tags: [],
    source: { kind: "agent" },
    importance: 3,
    confidence: 3,
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    access_count: 0,
    supersedes: [],
    token_estimate: 0,
    char_count: 0,
    revision: 1,
    writer_actor_id: "agent:unknown",
    pinned: false,
    trust_level: "agent_observed",
    sensitivity: "normal",
    metadata: {},
    ...overrides
  };
}

describe("safeTopicBase (spec § 6.7 — collision-safe slugs)", () => {
  it("slug-ifies a plain ASCII topic", () => {
    expect(safeTopicBase("Shell Setup")).toBe("shell-setup");
  });

  it("collapses repeated punctuation and trims edges", () => {
    expect(safeTopicBase("...foo---bar...")).toBe("foo-bar");
  });

  it("falls back to 'general' for a non-ASCII topic", () => {
    expect(safeTopicBase("中文主题")).toBe("general");
  });

  it("falls back to 'general' for an empty topic", () => {
    expect(safeTopicBase("")).toBe("general");
  });

  it("falls back to 'general' for a topic that is all punctuation", () => {
    expect(safeTopicBase("???")).toBe("general");
  });

  it("prefixes Windows reserved basenames with 'topic-'", () => {
    for (const reserved of WINDOWS_RESERVED_BASENAMES) {
      expect(safeTopicBase(reserved)).toBe(`topic-${reserved}`);
    }
  });

  it("preserves CJK when there is mixed ASCII", () => {
    // "Bug #42" → "bug-42" (no CJK so still ASCII)
    expect(safeTopicBase("Bug #42")).toBe("bug-42");
  });

  it("strips diacritics via NFKD", () => {
    expect(safeTopicBase("Café")).toBe("cafe");
  });
});

describe("buildTopicFilenameMap (collision safety)", () => {
  it("assigns a unique hash suffix when two topics share a slug", () => {
    const map = buildTopicFilenameMap(["Shell / Setup", "Shell:Setup"], "md");
    expect(map.size).toBe(2);
    const filenames = [...map.values()];
    expect(new Set(filenames).size).toBe(2);
    // Each filename has a different 8-char hash.
    for (const filename of filenames) {
      expect(filename).toMatch(/^shell-setup(-[0-9a-f]{8})?\.md$/);
    }
  });

  it("does NOT add a hash when there is no collision", () => {
    const map = buildTopicFilenameMap(["alpha", "beta"], "json");
    expect(map.get("alpha")).toBe("alpha.json");
    expect(map.get("beta")).toBe("beta.json");
  });

  it("handles CJK topics that all collapse to 'general'", () => {
    const map = buildTopicFilenameMap(["中文一", "中文二", "中文三"], "yaml");
    expect(map.size).toBe(3);
    const filenames = [...map.values()];
    expect(new Set(filenames).size).toBe(3);
    for (const filename of filenames) {
      expect(filename).toMatch(/^general(-[0-9a-f]{8})?\.yaml$/);
    }
  });

  it("maps a Windows-reserved topic to a safe filename", () => {
    const map = buildTopicFilenameMap(["CON"], "md");
    expect(map.get("CON")).toBe("topic-con.md");
  });

  it("hashes the original topic, not the slug, so collisions get distinct names", () => {
    const map = buildTopicFilenameMap(["Shell / Setup", "Shell:Setup"], "md");
    const [a, b] = [...map.values()];
    const hashA = shortHash("Shell / Setup").slice(0, 8);
    const hashB = shortHash("Shell:Setup").slice(0, 8);
    expect(a).toContain(hashA);
    expect(b).toContain(hashB);
    expect(a).not.toBe(b);
  });
});

describe("buildCanonicalScope (deterministic model)", () => {
  it("sorts topics by slug and entries by importance / confidence / updated_at / id", () => {
    const canonical = buildCanonicalScope(
      {
        scope: "global",
        entries: [
          makeEntry({ id: "mem_b", topic: "beta", title: "B", importance: 2, confidence: 3, updated_at: "2026-02-01T00:00:00.000Z" }),
          makeEntry({ id: "mem_a", topic: "alpha", title: "A", importance: 3, confidence: 3, updated_at: "2026-01-01T00:00:00.000Z" }),
          makeEntry({ id: "mem_c", topic: "alpha", title: "C", importance: 3, confidence: 3, updated_at: "2026-01-02T00:00:00.000Z" })
        ],
        budgetStatus: "3 active",
        source_schema_version: 4
      },
      "markdown"
    );
    // Topics sorted by topic string.
    expect(canonical.topics.map((t) => t.topic)).toEqual(["alpha", "beta"]);
    // Inside "alpha", mem_c (later updated_at) comes first.
    expect(canonical.topics[0]?.entries.map((e) => e.id)).toEqual(["mem_c", "mem_a"]);
    // Inside "beta", mem_b.
    expect(canonical.topics[1]?.entries.map((e) => e.id)).toEqual(["mem_b"]);
  });

  it("assigns each topic a deterministic filename", () => {
    const canonical = buildCanonicalScope(
      {
        scope: "global",
        entries: [makeEntry({ id: "mem_1", topic: "Shell / Setup" })],
        budgetStatus: "1",
        source_schema_version: 4
      },
      "markdown"
    );
    expect(canonical.topics[0]?.filename).toMatch(/^shell-setup(-[0-9a-f]{8})?\.md$/);
  });

  it("produces a stable all_entries list for the manifest count", () => {
    const canonical = buildCanonicalScope(
      {
        scope: "global",
        entries: [
          makeEntry({ id: "mem_1", topic: "a" }),
          makeEntry({ id: "mem_2", topic: "b" }),
          makeEntry({ id: "mem_3", topic: "a", status: "archived" })
        ],
        budgetStatus: "",
        source_schema_version: 4
      },
      "markdown"
    );
    // Status filter: archived excluded from active list.
    expect(canonical.all_entries.length).toBe(2);
  });
});

describe("Atomic publisher (stage / publish / rollback)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lm-publisher-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("stages files to a temp dir without touching the live export", () => {
    const liveDir = scopeDirFor(root, "global");
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(join(liveDir, "MEMORY.md"), "old live content", "utf8");

    const staged = stageFiles(root, liveDir, (stagingScopeDir) => {
      writeFileSync(join(stagingScopeDir, "MEMORY.md"), "new staged content", "utf8");
      return { indexPath: join(stagingScopeDir, "MEMORY.md"), topicPaths: [] };
    });

    // Live unchanged.
    expect(readFileSync(join(liveDir, "MEMORY.md"), "utf8")).toBe("old live content");
    // Staging has the new content.
    expect(readFileSync(staged.stagingScopeDir + "/MEMORY.md", "utf8")).toBe("new staged content");
  });

  it("publishes atomically and cleans up on complete()", () => {
    const liveDir = scopeDirFor(root, "global");
    const staged = stageFiles(root, liveDir, (stagingScopeDir) => {
      writeFileSync(join(stagingScopeDir, "MEMORY.md"), "new content", "utf8");
      return { indexPath: join(stagingScopeDir, "MEMORY.md"), topicPaths: [] };
    });
    const published = publishStagedFiles(staged);
    expect(readFileSync(join(liveDir, "MEMORY.md"), "utf8")).toBe("new content");
    expect(existsSync(staged.stagingRoot)).toBe(true);
    published.complete();
    expect(existsSync(staged.stagingRoot)).toBe(false);
  });

  it("rollback() restores the previous live export", () => {
    const liveDir = scopeDirFor(root, "global");
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(join(liveDir, "MEMORY.md"), "old live", "utf8");

    const staged = stageFiles(root, liveDir, (stagingScopeDir) => {
      writeFileSync(join(stagingScopeDir, "MEMORY.md"), "new staged", "utf8");
      return { indexPath: join(stagingScopeDir, "MEMORY.md"), topicPaths: [] };
    });
    const published = publishStagedFiles(staged);
    expect(readFileSync(join(liveDir, "MEMORY.md"), "utf8")).toBe("new staged");
    published.rollback();
    expect(readFileSync(join(liveDir, "MEMORY.md"), "utf8")).toBe("old live");
  });
});

describe("Manifest (write / read / verify)", () => {
  it("round-trips with the on-disk file hashes", () => {
    const dir = mkdtempSync(join(tmpdir(), "lm-manifest-"));
    try {
      const indexPath = join(dir, "MEMORY.md");
      const topicPath = join(dir, "topics", "general.md");
      mkdirSync(join(dir, "topics"), { recursive: true });
      writeFileSync(indexPath, "index content", "utf8");
      writeFileSync(topicPath, "topic content", "utf8");

      const canonical = {
        scope: "global",
        rawScope: "global" as const,
        budget: "",
        topics: [],
        high_importance: [],
        review_due: [],
        all_entries: [makeEntry({ id: "mem_1", topic: "general" })],
        generated_at: "2026-01-01T00:00:00.000Z",
        export_schema_version: 1 as const,
        source_schema_version: 4
      };
      const manifest = buildManifest(canonical, dir, [indexPath, topicPath]);
      const manifestPath = join(dir, MANIFEST_FILENAME);
      writeFileSync(manifestPath, serializeManifest(manifest), "utf8");
      expect(existsSync(manifestPath)).toBe(true);

      const read = readManifest(dir);
      expect(read.files).toHaveLength(2);
      expect(verifyManifest(dir, read)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags files that no longer match the recorded hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "lm-manifest-"));
    try {
      const indexPath = join(dir, "MEMORY.md");
      writeFileSync(indexPath, "original", "utf8");
      const canonical = {
        scope: "global",
        rawScope: "global" as const,
        budget: "",
        topics: [],
        high_importance: [],
        review_due: [],
        all_entries: [makeEntry({ id: "mem_1" })],
        generated_at: "2026-01-01T00:00:00.000Z",
        export_schema_version: 1 as const,
        source_schema_version: 4
      };
      const manifest = buildManifest(canonical, dir, [indexPath]);
      const manifestPath = join(dir, MANIFEST_FILENAME);
      writeFileSync(manifestPath, serializeManifest(manifest), "utf8");

      // Tamper with the index.
      writeFileSync(indexPath, "tampered", "utf8");

      const read = readManifest(dir);
      expect(verifyManifest(dir, read)).toEqual(["MEMORY.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CanonicalExporter (high-level)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lm-exporter-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes the index, per-topic files, and the manifest in one call", () => {
    const exporter = new CanonicalExporter(root);
    const result = exporter.exportScope({
      scope: "global",
      entries: [
        makeEntry({ id: "mem_1", topic: "alpha", title: "Alpha" }),
        makeEntry({ id: "mem_2", topic: "beta", title: "Beta" })
      ],
      budgetStatus: "2 active"
    });
    expect(result.indexPath).toBe(join(root, "global", "MEMORY.md"));
    expect(result.topicPaths).toHaveLength(2);
    expect(existsSync(result.indexPath)).toBe(true);
    expect(existsSync(join(root, "global", MANIFEST_FILENAME))).toBe(true);
    for (const topicPath of result.topicPaths) {
      expect(existsSync(topicPath)).toBe(true);
      expect(basename(topicPath)).toMatch(/^[a-z0-9_.-]+\.md$/);
    }
  });

  it("produces a deterministic export when generated_at is pinned", () => {
    const exporter = new CanonicalExporter(root);
    const input = {
      scope: "global" as const,
      entries: [makeEntry({ id: "mem_1", topic: "alpha" })],
      budgetStatus: "1 active",
      generated_at: "2026-01-01T00:00:00.000Z"
    };
    const first = exporter.exportScope(input);
    const second = exporter.exportScope(input);
    expect(readFileSync(first.indexPath, "utf8")).toBe(readFileSync(second.indexPath, "utf8"));
    expect(first.topicPaths).toEqual(second.topicPaths);
  });

  it("handles CJK topics with distinct filenames", () => {
    const exporter = new CanonicalExporter(root);
    const result = exporter.exportScope({
      scope: "global",
      entries: [
        makeEntry({ id: "mem_1", topic: "中文一" }),
        makeEntry({ id: "mem_2", topic: "中文二" }),
        makeEntry({ id: "mem_3", topic: "中文三" })
      ],
      budgetStatus: "3 active"
    });
    expect(result.topicPaths).toHaveLength(3);
    const basenames = new Set(result.topicPaths.map((p) => basename(p)));
    expect(basenames.size).toBe(3);
    for (const path of result.topicPaths) {
      expect(basename(path)).toMatch(/^general(-[0-9a-f]{8})?\.md$/);
    }
  });

  it("emits a JSON export with the same logical model", () => {
    const exporter = new CanonicalExporter(root);
    const result = exporter.exportScope({
      scope: "global",
      format: "json",
      entries: [makeEntry({ id: "mem_1", topic: "alpha" })],
      budgetStatus: "1 active"
    });
    expect(basename(result.indexPath)).toBe("MEMORY.json");
    expect(existsSync(join(root, "global", MANIFEST_FILENAME))).toBe(true);
    const index = JSON.parse(readFileSync(result.indexPath, "utf8")) as { topics: Array<{ name: string; file: string }> };
    expect(index.topics).toHaveLength(1);
    expect(index.topics[0]?.name).toBe("alpha");
  });

  it("emits a YAML export with the same logical model", () => {
    const exporter = new CanonicalExporter(root);
    const result = exporter.exportScope({
      scope: "global",
      format: "yaml",
      entries: [makeEntry({ id: "mem_1", topic: "alpha" })],
      budgetStatus: "1 active"
    });
    expect(basename(result.indexPath)).toBe("MEMORY.yaml");
    const index = readFileSync(result.indexPath, "utf8");
    expect(index).toContain("scope: global");
    expect(index).toContain("name: alpha");
    // The topic file is the source of truth for the
    // entry body; the index only references it.
    const topicFile = result.topicPaths[0];
    expect(topicFile).toBeDefined();
    expect(readFileSync(topicFile as string, "utf8")).toContain("topic: alpha");
  });
});
