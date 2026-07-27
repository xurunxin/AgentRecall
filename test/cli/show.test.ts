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

  // Stage 18 v1.1.2 follow-up (review by ora-9):
  // the CLI `show` command MUST apply the
  // SQL-boundary sensitivity filter. A
  // `sensitivity: "restricted"` row returns a
  // stable `forbidden_visibility` error WITHOUT
  // leaking title / body / tags / source /
  // `sensitivity` literal. The fail-closed
  // default (`actorMaxSensitivity: "normal"`)
  // covers the operator-facing CLI; an
  // admin-profile path is documented but out
  // of scope here. The previous follow-up
  // (review by ora-8) printed
  // `${raw.sensitivity}` on stderr — the
  // follow-up closes that leak.
  it("returns forbidden_visibility for a restricted row (fail-closed CLI default, text surface)", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-show-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    // Pre-seed a `restricted` row directly via
    // the store so the test does not depend on
    // an operator capability. The row id is
    // intentionally neutral (no forbidden
    // substrings) so the deny-path assertions
    // can use strict `.not.toContain` checks
    // without false positives on the id.
    store.insertEntry({
      id: "mem_deny_seed",
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
    const args = parseArgs(["show", "mem_deny_seed"]);
    const result = showCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("forbidden_visibility");
    // Stage 18 v1.1.2 follow-up (review by
    // ora-9): the error message MUST NOT
    // leak title / body / tags / source /
    // the `sensitivity` literal. The
    // previous follow-up (review by ora-8)
    // printed `${raw.sensitivity}` on
    // stderr — the follow-up closes the
    // leak by routing through
    // `classifyEntryVisibility` and
    // removing the sensitivity literal
    // from the deny path.
    expect(result.stderr).not.toContain("secret title");
    expect(result.stderr).not.toContain("secret body");
    expect(result.stderr).not.toContain("secret");
    // The `restricted` literal MUST NOT
    // appear on stderr (the brief forbids
    // the sensitivity tier literal on the
    // deny path).
    expect(result.stderr).not.toContain("restricted");
    // The `sensitivity` substring MUST NOT
    // appear on stderr (the brief forbids
    // the `sensitivity` key on the deny
    // path).
    expect(result.stderr).not.toContain("sensitivity");
    expect(result.stdout).toBe("");
    store.close();
  });

  // Stage 18 v1.1.2 follow-up (review by ora-9):
  // the `--json` mode of the CLI `show`
  // command must produce the same
  // structured envelope as the MCP
  // resource layer: a `forbidden_visibility`
  // JSON payload with `memory_id` and a
  // stable error code, but NO
  // `entry_sensitivity` / `sensitivity` /
  // `restricted` literal / title / body /
  // tags / source on stdout.
  it("returns structured forbidden_visibility for a restricted row (--json surface)", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-show-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    store.insertEntry({
      id: "mem_deny_json",
      scope: "global",
      type: "fact",
      topic: "follow-up",
      title: "json secret title",
      body: "json secret body",
      tags: ["json-secret"],
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
    const args = parseArgs(["show", "mem_deny_json", "--json"]);
    const result = showCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    // The --json mode surfaces the
    // structured envelope on stdout (NOT
    // stderr). The envelope is a single
    // JSON object.
    expect(result.stdout).not.toBe("");
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      error: string;
      message: string;
      memory_id: string;
      [key: string]: unknown;
    };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("forbidden_visibility");
    expect(payload.memory_id).toBe("mem_deny_json");
    // The structured envelope MUST NOT
    // contain `entry_sensitivity` /
    // `sensitivity` keys (the brief
    // explicitly forbids them).
    expect(Object.prototype.hasOwnProperty.call(payload, "entry_sensitivity")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(payload, "sensitivity")).toBe(false);
    // The structured envelope MUST NOT
    // contain the seed title / body / tags
    // / source.
    const text = JSON.stringify(payload);
    expect(text).not.toContain("json secret title");
    expect(text).not.toContain("json secret body");
    expect(text).not.toContain("json-secret");
    // The structured envelope MUST NOT
    // contain the `restricted` literal or
    // the `sensitivity` substring.
    expect(text).not.toContain("restricted");
    expect(text).not.toContain("sensitivity");
    store.close();
  });

  // Stage 18 v1.1.2 follow-up (review by ora-9):
  // the CLI `show` command for a
  // non-existent id MUST surface a
  // structured `not_found` envelope in
  // `--json` mode (matching the MCP
  // resource layer's contract).
  it("returns structured not_found for an unknown id (--json surface)", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-show-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const args = parseArgs(["show", "mem_does_not_exist", "--json"]);
    const result = showCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      error: string;
      memory_id: string;
      [key: string]: unknown;
    };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("not_found");
    expect(payload.memory_id).toBe("mem_does_not_exist");
    store.close();
  });
});
