// Minimal smoke test: invoke the plugin with a fake input matching the opencode
// PluginInput shape, call the system.transform hook, and assert the output has
// the expected [AGENT_RECALL] block from the real store.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRecallPlugin } from "../index.js";

const DB_PATH = "G:\\Memory\\AgentRecall\\memory.sqlite";
const fakeInput = {
  client: {},
  project: {},
  directory: "G:\\Projects\\MetronX\\MorpheusCore",
  worktree: "G:\\Projects\\MetronX\\MorpheusCore",
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost:0"),
  $: {},
};

test("loads and injects project+global memories into system prompt", async () => {
  const hooks = await AgentRecallPlugin(fakeInput, { debug: true, db_path: DB_PATH });
  assert.ok(hooks["experimental.chat.system.transform"], "hook must be registered");

  const output = { system: ["base system"] };
  await hooks["experimental.chat.system.transform"]({}, output);

  // We expect 12 project memories for morpheus-core + 4 global = 16 entries.
  const injected = output.system.find((s) => s.startsWith("[AGENT_RECALL]"));
  assert.ok(injected, "expected an [AGENT_RECALL] block; got system=" + JSON.stringify(output.system));
  assert.match(injected, /推送前 checklist 顺序/);
  assert.match(injected, /TDD 流程/);
  assert.match(injected, /回答语言: 中文/);
  assert.equal(output.system[0], "base system", "must not mutate the existing system prompt");
});

test("respects include_global=false", async () => {
  const hooks = await AgentRecallPlugin(fakeInput, { include_global: false, db_path: DB_PATH });
  const output = { system: [] };
  await hooks["experimental.chat.system.transform"]({}, output);
  const injected = output.system[0] ?? "";
  assert.match(injected, /推送前 checklist 顺序/);
  assert.doesNotMatch(injected, /TDD 流程/);
});

test("cache reuse across calls", async () => {
  const hooks = await AgentRecallPlugin(fakeInput, { cache_ttl_ms: 60_000, db_path: DB_PATH });
  const a = { system: [] };
  const b = { system: [] };
  await hooks["experimental.chat.system.transform"]({}, a);
  await hooks["experimental.chat.system.transform"]({}, b);
  assert.equal(a.system[0], b.system[0]);
});

test("unknown directory still injects global", async () => {
  const hooks = await AgentRecallPlugin(
    { ...fakeInput, directory: "C:\\nope\\nope" },
    { include_global: true, db_path: DB_PATH },
  );
  const output = { system: [] };
  await hooks["experimental.chat.system.transform"]({}, output);
  const injected = output.system[0] ?? "";
  // Globals should still be there; project memories for morpheus-core should not.
  assert.match(injected, /TDD 流程/);
  assert.doesNotMatch(injected, /推送前 checklist 顺序/);
});

test("missing DB is a no-op (no throw)", async () => {
  const hooks = await AgentRecallPlugin(fakeInput, {
    db_path: "G:\\definitely\\does\\not\\exist\\nope.sqlite",
  });
  assert.deepEqual(hooks, {}, "should return no hooks when DB is missing");
});
