import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { searchCommand } from "../../src/cli/commands/search.js";
import { parseArgs } from "../../src/cli/arg-parser.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-search-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  store.insertEntry({
    id: "mem_s",
    scope: "global",
    type: "fact",
    memory_kind: "semantic",
    topic: "postgres",
    title: "Local database setup",
    body: "Run pg_ctl start before tests",
    tags: ["postgres"],
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

describe("searchCommand", () => {
  it("finds by full-text query", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["search", "postgres"]);
    const result = searchCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("mem_s");
    store.close();
  });

  it("returns exit 1 when no query", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-search-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const args = parseArgs(["search"]);
    const result = searchCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(1);
    store.close();
  });

  it("emits JSON with --json", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["search", "postgres", "--json"]);
    const result = searchCommand({ dataHome, args, store });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.items[0].id).toBe("mem_s");
    store.close();
  });

  it("returns 'no matches' for empty result", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-search-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const args = parseArgs(["search", "absolutely-no-match"]);
    const result = searchCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no matches");
    store.close();
  });

  it("filters by --actor (stage 4)", () => {
    const { dataHome, store } = setup();
    store.appendAudit({
      id: "aud_search_1",
      memory_id: "mem_s",
      scope: "global",
      event: "created",
      actor: "agent:claude-code",
      metadata: {},
      created_at: "2026-07-19T00:00:00.000Z"
    });
    // Add a second matching memory written by a different actor
    store.insertEntry({
      id: "mem_s2",
      scope: "global",
      type: "fact",
      memory_kind: "semantic",
      topic: "postgres",
      title: "Postgres tuning",
      body: "shared_buffers for postgres workloads",
      tags: ["postgres"],
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
      id: "aud_search_2",
      memory_id: "mem_s2",
      scope: "global",
      event: "created",
      actor: "agent:cursor",
      metadata: {},
      created_at: "2026-07-19T00:00:00.000Z"
    });

    // No filter: both rows
    const all = searchCommand({ dataHome, args: parseArgs(["search", "postgres"]), store });
    expect(all.stdout).toContain("2 matches");

    // Filter to claude-code: only mem_s
    const claudeOnly = searchCommand({
      dataHome, store, args: parseArgs(["search", "postgres", "--actor", "agent:claude-code"])
    });
    expect(claudeOnly.stdout).toContain("mem_s");
    expect(claudeOnly.stdout).not.toContain("mem_s2");
    expect(claudeOnly.stdout).toContain("1 matches");
    store.close();
  });
});
