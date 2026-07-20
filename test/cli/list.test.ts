import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listCommand } from "../../src/cli/commands/list.js";
import { parseArgs } from "../../src/cli/arg-parser.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-list-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  store.insertEntry({
    id: "mem_a",
    scope: "global",
    type: "fact",
    memory_kind: "semantic",
    topic: "general",
    title: "hello",
    body: "world",
    tags: ["greeting"],
    source: { kind: "agent" },
    importance: 3,
    confidence: 3,
    status: "active",
    created_at: "2026-07-19T00:00:00.000Z",
    updated_at: "2026-07-19T00:00:00.000Z",
    access_count: 0,
    supersedes: [],
    token_estimate: 1,
    char_count: 2
  });
  return { dataHome, store };
}

describe("listCommand", () => {
  it("returns a table with one row", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["list"]);
    const result = listCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("mem_a");
    expect(result.stdout).toContain("hello");
    store.close();
  });

  it("emits JSON when --json", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["list", "--json"]);
    const result = listCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.items.length).toBe(1);
    expect(parsed.items[0].id).toBe("mem_a");
    store.close();
  });

  it("returns empty message when no memories", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-list-empty-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const args = parseArgs(["list"]);
    const result = listCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no memories");
    store.close();
  });

  it("respects --no-color", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["list", "--no-color"]);
    const result = listCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("\x1b[");
    store.close();
  });

  it("filters by --actor (stage 4)", () => {
    const { dataHome, store } = setup();
    store.appendAudit({
      id: "aud_test_1",
      memory_id: "mem_a",
      scope: "global",
      event: "created",
      actor: "agent:claude-code",
      metadata: {},
      created_at: "2026-07-19T00:00:00.000Z"
    });
    // Add a second memory written by a different actor
    store.insertEntry({
      id: "mem_b",
      scope: "global",
      type: "fact",
      memory_kind: "semantic",
      topic: "general",
      title: "world",
      body: "again",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      status: "active",
      created_at: "2026-07-19T00:00:00.000Z",
      updated_at: "2026-07-19T00:00:00.000Z",
      access_count: 0,
      supersedes: [],
      token_estimate: 1,
      char_count: 2
    });
    store.appendAudit({
      id: "aud_test_2",
      memory_id: "mem_b",
      scope: "global",
      event: "created",
      actor: "agent:cursor",
      metadata: {},
      created_at: "2026-07-19T00:00:00.000Z"
    });

    // No filter: both rows
    const all = listCommand({ dataHome, args: parseArgs(["list"]), store });
    expect(all.stdout).toContain("2 entries");

    // Filter to claude-code: only mem_a
    const claudeOnly = listCommand({ dataHome, args: parseArgs(["list", "--actor", "agent:claude-code"]), store });
    expect(claudeOnly.stdout).toContain("mem_a");
    expect(claudeOnly.stdout).not.toContain("mem_b");
    expect(claudeOnly.stdout).toContain("1 entries");
    store.close();
  });

  it("filters by --since / --until / --last-accessed-since (stage 6)", () => {
    const { dataHome, store } = setup();
    // The setup() helper inserts mem_a with created_at=2026-07-19. Add
    // a second memory with an older created_at and a read timestamp.
    store.insertEntry({
      id: "mem_old",
      scope: "global",
      type: "fact",
      memory_kind: "semantic",
      topic: "general",
      title: "old",
      body: "older",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      status: "active",
      created_at: "2026-07-10T00:00:00.000Z",
      updated_at: "2026-07-10T00:00:00.000Z",
      access_count: 0,
      supersedes: [],
      token_estimate: 1,
      char_count: 2
    });
    // Mark mem_a as read recently
    store.getEntry("mem_a", "agent:claude-code");

    // --since keeps only mem_a (created 2026-07-19, since 2026-07-15)
    const recent = listCommand({
      dataHome,
      args: parseArgs(["list", "--since", "2026-07-15T00:00:00.000Z"]),
      store
    });
    expect(recent.stdout).toContain("mem_a");
    expect(recent.stdout).not.toContain("mem_old");
    expect(recent.stdout).toContain("1 entries");

    // --last-accessed-since keeps only mem_a (was read, mem_old was not)
    const recentlyRead = listCommand({
      dataHome,
      args: parseArgs(["list", "--last-accessed-since", "2026-07-19T00:00:00.000Z"]),
      store
    });
    expect(recentlyRead.stdout).toContain("mem_a");
    expect(recentlyRead.stdout).not.toContain("mem_old");
    store.close();
  });

  it("filters by --updated-since / --updated-until (stage 7)", () => {
    const { dataHome, store } = setup();
    // The setup() helper inserts mem_a with updated_at=2026-07-19. Add
    // a second memory with an older updated_at.
    store.insertEntry({
      id: "mem_old",
      scope: "global",
      type: "fact",
      memory_kind: "semantic",
      topic: "general",
      title: "old",
      body: "older",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      status: "active",
      created_at: "2026-07-10T00:00:00.000Z",
      updated_at: "2026-07-10T00:00:00.000Z",
      access_count: 0,
      supersedes: [],
      token_estimate: 1,
      char_count: 2
    });

    // --updated-since keeps only mem_a (updated 2026-07-19, since 2026-07-15)
    const recentlyUpdated = listCommand({
      dataHome,
      args: parseArgs(["list", "--updated-since", "2026-07-15T00:00:00.000Z"]),
      store
    });
    expect(recentlyUpdated.stdout).toContain("mem_a");
    expect(recentlyUpdated.stdout).not.toContain("mem_old");
    expect(recentlyUpdated.stdout).toContain("1 entries");

    // --updated-until keeps only mem_old
    const onlyOld = listCommand({
      dataHome,
      args: parseArgs(["list", "--updated-until", "2026-07-15T00:00:00.000Z"]),
      store
    });
    expect(onlyOld.stdout).toContain("mem_old");
    expect(onlyOld.stdout).not.toContain("mem_a");
    store.close();
  });
});
