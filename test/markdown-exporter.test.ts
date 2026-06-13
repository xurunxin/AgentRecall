import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "../src/domain.js";
import { MarkdownExporter, safeTopicFilename } from "../src/markdown-exporter.js";

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? "mem_001",
    scope: overrides.scope ?? "global",
    ...(overrides.project_id !== undefined ? { project_id: overrides.project_id } : {}),
    ...(overrides.project_path !== undefined ? { project_path: overrides.project_path } : {}),
    type: overrides.type ?? "preference",
    topic: overrides.topic ?? "shell",
    title: overrides.title ?? "Use rtk",
    body: overrides.body ?? "Prefix shell commands with rtk.",
    tags: overrides.tags ?? ["shell"],
    source: overrides.source ?? { kind: "user" },
    importance: overrides.importance ?? 5,
    confidence: overrides.confidence ?? 5,
    status: overrides.status ?? "active",
    created_at: overrides.created_at ?? "2026-06-13T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-06-13T00:00:00.000Z",
    access_count: overrides.access_count ?? 0,
    ...(overrides.expires_at !== undefined ? { expires_at: overrides.expires_at } : {}),
    ...(overrides.review_after !== undefined ? { review_after: overrides.review_after } : {}),
    supersedes: overrides.supersedes ?? [],
    ...(overrides.superseded_by !== undefined ? { superseded_by: overrides.superseded_by } : {}),
    token_estimate: overrides.token_estimate ?? 8,
    char_count: overrides.char_count ?? 32
  };
}

describe("MarkdownExporter", () => {
  it("builds bounded context with metadata, deterministic ordering, and no forgotten bodies", () => {
    const exporter = new MarkdownExporter(join(mkdtempSync(join(tmpdir(), "lm-export-")), "exports"));
    const markdown = exporter.buildContextPack({
      title: "Context",
      budget_chars: 700,
      entries: [
        entry({
          id: "mem_low",
          title: "Low priority",
          body: "This should sort after the high priority memory.",
          importance: 1,
          confidence: 1,
          updated_at: "2026-06-13T00:02:00.000Z"
        }),
        entry({
          id: "mem_hidden",
          status: "forgotten",
          title: "Forgotten",
          body: "hidden secret body"
        }),
        entry({
          id: "mem_high",
          scope: "project",
          project_id: "repo-123",
          title: "High priority",
          body: "Important project context.",
          tags: ["project", "tests"],
          importance: 5,
          confidence: 5,
          updated_at: "2026-06-13T00:01:00.000Z"
        })
      ]
    });

    expect(markdown.length).toBeLessThanOrEqual(700);
    expect(markdown).toContain("memory_id: mem_high");
    expect(markdown).toContain("scope: project/repo-123");
    expect(markdown).toContain("type: preference");
    expect(markdown).toContain("topic: shell");
    expect(markdown).toContain("tags: project, tests");
    expect(markdown.indexOf("mem_high")).toBeLessThan(markdown.indexOf("mem_low"));
    expect(markdown).not.toContain("hidden secret body");
  });

  it("stops before adding an entry that would exceed the context budget", () => {
    const exporter = new MarkdownExporter(join(mkdtempSync(join(tmpdir(), "lm-export-")), "exports"));
    const markdown = exporter.buildContextPack({
      title: "Tiny Context",
      budget_chars: 420,
      entries: [
        entry({ id: "mem_001", title: "Included", body: "Short body." }),
        entry({ id: "mem_002", title: "Excluded", body: "This body should not fit after the first memory.".repeat(10) })
      ]
    });

    expect(markdown.length).toBeLessThanOrEqual(420);
    expect(markdown).toContain("mem_001");
    expect(markdown).not.toContain("mem_002");
  });

  it("writes deterministic global index and collision-safe topic files", () => {
    const root = join(mkdtempSync(join(tmpdir(), "lm-export-")), "exports");
    const exporter = new MarkdownExporter(root);
    const result = exporter.exportScope({
      scope: "global",
      entries: [
        entry({ id: "mem_002", topic: "Shell / Setup", title: "Shell setup", updated_at: "2026-06-13T00:02:00.000Z" }),
        entry({ id: "mem_001", topic: "Shell:Setup", title: "Shell setup duplicate slug" }),
        entry({ id: "mem_hidden", topic: "secrets", status: "forgotten", body: "forgotten body must not export" })
      ],
      budgetStatus: "2 active entries, 64 active chars"
    });
    const firstIndex = readFileSync(result.indexPath, "utf8");
    const firstTopics = result.topicPaths.map((path) => [path, readFileSync(path, "utf8")] as const);
    const second = exporter.exportScope({
      scope: "global",
      entries: [
        entry({ id: "mem_001", topic: "Shell:Setup", title: "Shell setup duplicate slug" }),
        entry({ id: "mem_002", topic: "Shell / Setup", title: "Shell setup", updated_at: "2026-06-13T00:02:00.000Z" }),
        entry({ id: "mem_hidden", topic: "secrets", status: "forgotten", body: "forgotten body must not export" })
      ],
      budgetStatus: "2 active entries, 64 active chars"
    });

    expect(readFileSync(second.indexPath, "utf8")).toBe(firstIndex);
    expect(second.topicPaths).toEqual(result.topicPaths);
    expect(result.indexPath).toBe(join(root, "global", "MEMORY.md"));
    expect(firstIndex).toContain("SQLite is authoritative");
    expect(firstIndex).toContain("manual edits may be overwritten");
    expect(firstIndex).toContain("2 active entries, 64 active chars");
    expect(result.topicPaths).toHaveLength(2);
    expect(new Set(result.topicPaths.map((path) => basename(path))).size).toBe(2);
    for (const path of result.topicPaths) {
      expect(basename(path)).toMatch(/^[a-z0-9_.-]+\.md$/);
      expect(existsSync(path)).toBe(true);
    }
    expect(firstTopics.map(([, content]) => content).join("\n")).toContain("mem_001");
    expect(firstTopics.map(([, content]) => content).join("\n")).toContain("mem_002");
    expect(firstIndex).not.toContain("forgotten body must not export");
    expect(firstTopics.map(([, content]) => content).join("\n")).not.toContain("forgotten body must not export");
  });

  it("writes project exports under projects/project_id and sanitizes reserved topic names", () => {
    const root = join(mkdtempSync(join(tmpdir(), "lm-export-")), "exports");
    const exporter = new MarkdownExporter(root);
    const result = exporter.exportScope({
      scope: "project",
      project_id: "repo-123",
      entries: [entry({ scope: "project", project_id: "repo-123", topic: "CON", title: "Reserved topic" })],
      budgetStatus: "1 active entries, 32 active chars"
    });

    expect(result.indexPath).toBe(join(root, "projects", "repo-123", "MEMORY.md"));
    expect(result.topicPaths).toEqual([join(root, "projects", "repo-123", "topics", safeTopicFilename("CON"))]);
    expect(basename(result.topicPaths[0] ?? "")).not.toBe("con.md");
  });
});
