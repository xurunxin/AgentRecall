import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { showCommand } from "../../src/cli/commands/show.js";
import { parseArgs } from "../../src/cli/arg-parser.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-show-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  store.insertEntry({
    id: "mem_x",
    scope: "global",
    type: "fact",
    memory_kind: "semantic",
    topic: "t",
    title: "Title",
    body: "Body",
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
    id: "aud_x",
    memory_id: "mem_x",
    scope: "global",
    event: "created",
    actor: "agent:claude-code",
    metadata: {},
    created_at: "2026-07-19T00:00:00.000Z"
  });
  return { dataHome, store };
}

describe("showCommand", () => {
  it("renders the entry and its audit history", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["show", "mem_x"]);
    const result = showCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Title");
    expect(result.stdout).toContain("Body");
    expect(result.stdout).toContain("agent:claude-code");
    store.close();
  });

  it("returns exitCode 1 for unknown id", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-show-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const args = parseArgs(["show", "mem_missing"]);
    const result = showCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not found");
    store.close();
  });

  it("emits JSON with --json", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["show", "mem_x", "--json"]);
    const result = showCommand({ dataHome, args, store });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.entry.id).toBe("mem_x");
    expect(parsed.audit.length).toBe(1);
    store.close();
  });

  it("returns usage error when no id given", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-show-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const args = parseArgs(["show"]);
    const result = showCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("usage");
    store.close();
  });

  // Stage 18 v1.1.2 follow-up (review by ora-8):
  // the CLI `show` command MUST apply the
  // SQL-boundary sensitivity filter. A
  // `sensitivity: "restricted"` row returns a
  // stable `forbidden_visibility` error WITHOUT
  // leaking title / body / tags / source /
  // sensitivity. The fail-closed default
  // (`actorMaxSensitivity: "normal"`) covers the
  // operator-facing CLI; an admin-profile path
  // is documented but out of scope here.
  it("returns forbidden_visibility for a restricted row (fail-closed CLI default)", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-show-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    // Pre-seed a `restricted` row directly via
    // the store so the test does not depend on
    // an operator capability.
    store.insertEntry({
      id: "mem_restricted_cli",
      scope: "global",
      type: "fact",
      topic: "follow-up",
      title: "secret title",
      body: "secret body",
      tags: ["secret"],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      status: "active",
      created_at: "2026-07-27T00:00:00.000Z",
      updated_at: "2026-07-27T00:00:00.000Z",
      access_count: 0,
      supersedes: [],
      token_estimate: 1,
      char_count: 2,
      revision: 1,
      writer_actor_id: "agent:test",
      pinned: false,
      trust_level: "agent_observed",
      sensitivity: "restricted",
      tier: "working",
      metadata: {}
    });
    const args = parseArgs(["show", "mem_restricted_cli"]);
    const result = showCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("forbidden_visibility");
    // The error message MUST NOT leak the
    // title / body / tags / source /
    // sensitivity.
    expect(result.stderr).not.toContain("secret title");
    expect(result.stderr).not.toContain("secret body");
    expect(result.stdout).toBe("");
    store.close();
  });
});
