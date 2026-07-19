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
});
