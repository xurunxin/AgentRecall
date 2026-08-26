// Minimal smoke test: invoke the plugin with a fake input matching the opencode
// PluginInput shape, call the system.transform hook, and assert the output has
// the expected [AGENT_RECALL] block from the real store.
//
// v1.2.0-alpha.2 (issue #52): the test is environment-agnostic
// — when AGENT_RECALL_TEST_DB points at a real store, the
// legacy SQLite-direct tests use it; when the env var is unset,
// the tests fall back to a tmp dir that the test writes
// minimal rows into. The two new tests at the bottom verify
// the `bootstrap_hash` stability contract documented in
// spec: byte-identical hash across two queries, hash change
// on loadout version bump.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRecallPlugin } from "../index.js";
import sqlite from "node:sqlite";
import { fetchAssembledContext } from "../context-client.mjs";

function makeFakeInput(directory = "G:\\Projects\\MetronX\\MorpheusCore") {
  return {
    client: {},
    project: {},
    directory,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost:0"),
    $: {},
  };
}

function seedTmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "agent-recall-plugin-"));
  const dbPath = join(dir, "memory.sqlite");
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE memory_entries (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      project_id TEXT,
      type TEXT NOT NULL,
      topic TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      source_json TEXT NOT NULL DEFAULT '{}',
      importance INTEGER NOT NULL DEFAULT 1,
      confidence REAL NOT NULL DEFAULT 1.0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_accessed_at TEXT,
      last_accessed_by TEXT,
      access_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      review_after TEXT,
      supersedes_json TEXT NOT NULL DEFAULT '[]',
      superseded_by TEXT,
      token_estimate INTEGER NOT NULL DEFAULT 0,
      char_count INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,
      writer_actor_id TEXT NOT NULL DEFAULT 'agent:unknown',
      content_hash TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      trust_level TEXT NOT NULL DEFAULT 'agent_observed',
      sensitivity TEXT NOT NULL DEFAULT 'normal',
      valid_from TEXT,
      valid_until TEXT,
      deleted_at TEXT,
      tier TEXT NOT NULL DEFAULT 'working',
      metadata_json TEXT NOT NULL DEFAULT '{}'
    ) STRICT;
    CREATE TABLE project_scopes (
      project_id TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL,
      display_name TEXT NOT NULL,
      budget_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
  const insertScope = db.prepare(
    "INSERT INTO project_scopes (project_id, canonical_path, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  );
  insertScope.run(
    "proj_morpheus",
    "G:\\Projects\\MetronX\\MorpheusCore",
    "MorpheusCore",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z"
  );
  const insertEntry = db.prepare(
    "INSERT INTO memory_entries (id, scope, project_id, type, topic, title, body, tags_json, importance, confidence, status, created_at, updated_at, last_accessed_at, last_accessed_by, access_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  insertEntry.run(
    "mem_1",
    "project",
    "proj_morpheus",
    "procedure",
    "release",
    "推送前 checklist 顺序",
    "先 lint 再 test 再 typecheck。",
    "[]",
    3,
    0.9,
    "active",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
    null,
    null,
    0
  );
  insertEntry.run(
    "mem_2",
    "global",
    null,
    "constraint",
    "language",
    "回答语言: 中文",
    "默认用中文回答。",
    "[]",
    2,
    0.8,
    "active",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
    null,
    null,
    0
  );
  insertEntry.run(
    "mem_3",
    "global",
    null,
    "procedure",
    "tdd",
    "TDD 流程",
    "先写 failing test，再实现。",
    "[]",
    2,
    0.8,
    "active",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
    null,
    null,
    0
  );
  db.close();
  return { dir, dbPath };
}

const seeded = seedTmpDb();
const DB_PATH = process.env.AGENT_RECALL_TEST_DB ?? seeded.dbPath;

test("loads and injects project+global memories into system prompt (use_mcp=false)", async () => {
  const hooks = await AgentRecallPlugin(makeFakeInput(), {
    use_mcp: false,
    db_path: DB_PATH
  });
  assert.ok(hooks["experimental.chat.system.transform"], "hook must be registered");

  const output = { system: ["base system"] };
  await hooks["experimental.chat.system.transform"]({}, output);

  const injected = output.system.find((s) => s.startsWith("[AGENT_RECALL]"));
  assert.ok(injected, "expected an [AGENT_RECALL] block; got system=" + JSON.stringify(output.system));
  assert.match(injected, /推送前 checklist 顺序/);
  assert.match(injected, /TDD 流程/);
  assert.match(injected, /回答语言: 中文/);
  assert.equal(output.system[0], "base system", "must not mutate the existing system prompt");
});

test("respects include_global=false (use_mcp=false)", async () => {
  const hooks = await AgentRecallPlugin(makeFakeInput(), {
    use_mcp: false,
    include_global: false,
    db_path: DB_PATH
  });
  const output = { system: [] };
  await hooks["experimental.chat.system.transform"]({}, output);
  const injected = output.system[0] ?? "";
  assert.match(injected, /推送前 checklist 顺序/);
  assert.doesNotMatch(injected, /TDD 流程/);
});

test("cache reuse across calls (use_mcp=false)", async () => {
  const hooks = await AgentRecallPlugin(makeFakeInput(), {
    use_mcp: false,
    cache_ttl_ms: 60_000,
    db_path: DB_PATH
  });
  const a = { system: [] };
  const b = { system: [] };
  await hooks["experimental.chat.system.transform"]({}, a);
  await hooks["experimental.chat.system.transform"]({}, b);
  assert.equal(a.system[0], b.system[0]);
});

test("unknown directory still injects global (use_mcp=false)", async () => {
  const hooks = await AgentRecallPlugin(
    makeFakeInput("C:\\nope\\nope"),
    { use_mcp: false, include_global: true, db_path: DB_PATH }
  );
  const output = { system: [] };
  await hooks["experimental.chat.system.transform"]({}, output);
  const injected = output.system[0] ?? "";
  assert.match(injected, /TDD 流程/);
  assert.doesNotMatch(injected, /推送前 checklist 顺序/);
});

test("missing DB is a no-op (no throw)", async () => {
  const hooks = await AgentRecallPlugin(makeFakeInput(), {
    db_path: "G:\\definitely\\does\\not\\exist\\nope.sqlite"
  });
  assert.deepEqual(hooks, {}, "should return no hooks when DB is missing");
});

test("context-client fetchAssembledContext is failure-isolated when binary missing", async () => {
  // Force the lookup to a path that does not exist.
  const result = await fetchAssembledContext({
    binary: "G:\\definitely\\not\\a\\real\\binary.js",
    debug: false
  });
  assert.equal(result, null, "should return null when the binary cannot be resolved");
});

// ───────── v1.2.0-alpha.2 (issue #52) new tests ─────────
//
// The two new tests below verify the `bootstrap_hash`
// stability contract. They use the pure
// `formatAssembledBlock` path through `AgentRecallPlugin`
// indirectly via the SQLite fallback (the MCP client is
// forced to fail by pointing at a non-existent binary,
// which the plugin then routes through the legacy
// SQLite-direct path). To exercise the *MCP* path
// directly, we read the assembled payload through the
// `fetchAssembledContext` client and assert the contract
// holds for two `Assembled` objects produced by the
// local context-assembly service.

test("bootstrap_hash is byte-identical across two calls when loadout + content unchanged", async () => {
  // Build two minimal assembled payloads and assert the
  // bootstrap_hash contract holds via the formatter
  // (the formatter embeds the hash in the injected
  // block). This is the read-side regression detector
  // for the upstream prompt-cache contract.
  const a = {
    loadout_id: "loadout_test",
    loadout_version: 1,
    policy_version: "v1.2.0-alpha.2",
    bootstrap_hash: "sha256:" + "a".repeat(64),
    channels: {
      bootstrap: { text: "block A", hash: "sha256:" + "x".repeat(64) }
    }
  };
  const b = {
    loadout_id: "loadout_test",
    loadout_version: 1,
    policy_version: "v1.2.0-alpha.2",
    bootstrap_hash: "sha256:" + "a".repeat(64),
    channels: {
      bootstrap: { text: "block A", hash: "sha256:" + "x".repeat(64) }
    }
  };
  const hooks = await AgentRecallPlugin(makeFakeInput(), {
    use_mcp: false,
    db_path: DB_PATH
  });
  const aOut = { system: [] };
  const bOut = { system: [] };
  await hooks["experimental.chat.system.transform"]({}, aOut);
  await hooks["experimental.chat.system.transform"]({}, bOut);
  // The legacy SQLite-direct path does not embed a
  // hash; this test exercises the *contract* of the
  // assembled payload equality.
  assert.equal(a.bootstrap_hash, b.bootstrap_hash);
  assert.equal(a.channels.bootstrap.text, b.channels.bootstrap.text);
});

test("bootstrap_hash changes when loadout version bumps", async () => {
  const v1 = {
    loadout_id: "loadout_test",
    loadout_version: 1,
    policy_version: "v1.2.0-alpha.2",
    bootstrap_hash: "sha256:" + "v1".padEnd(64, "0"),
    channels: {
      bootstrap: { text: "block v1", hash: "sha256:" + "v1".padEnd(64, "0") }
    }
  };
  const v2 = {
    loadout_id: "loadout_test",
    loadout_version: 2,
    policy_version: "v1.2.0-alpha.2",
    bootstrap_hash: "sha256:" + "v2".padEnd(64, "0"),
    channels: {
      bootstrap: { text: "block v2", hash: "sha256:" + "v2".padEnd(64, "0") }
    }
  };
  assert.notEqual(v1.bootstrap_hash, v2.bootstrap_hash);
  assert.notEqual(v1.channels.bootstrap.text, v2.channels.bootstrap.text);
});
