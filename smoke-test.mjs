// smoke-test.mjs
//
// Standalone smoke test for the agent-recall MCP server. Spawns the
// built server, sends a few JSON-RPC requests, and verifies the new
// Stage 3 features (near_duplicate advisory, actor + last_accessed_by
// enrichment) surface correctly through the wire protocol.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const SERVER = "G:\\Projects\\MetronX\\local-memory-mcp\\dist\\src\\index.js";
const ENV = {
  ...process.env,
  AGENT_RECALL_HOME: `G:\\Memory\\AgentRecall-smoke-${Date.now()}`,
  AGENT_RECALL_ACTOR: "agent:smoke-test"
};

function send(child, msg) {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

function readResponses(child) {
  let buffer = "";
  const out = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.length === 0) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // not JSON, skip
      }
    }
  });
  return out;
}

async function awaitResponse(responses, id, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = responses.find((x) => x.id === id);
    if (r) return r;
    await sleep(50);
  }
  throw new Error(`timeout waiting for id=${id}`);
}

const child = spawn("node", [SERVER], {
  env: ENV,
  stdio: ["pipe", "pipe", "pipe"]
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => {
  // ignore stderr noise; the MCP server prints a deprecation banner
});

const responses = readResponses(child);

// 1) initialize
send(child, {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.1" }
  }
});
const initResult = await awaitResponse(responses, 1);
console.log("initialize:", initResult.result?.serverInfo?.name ?? "FAIL");

// 2) initialized notification (no response expected)
send(child, { jsonrpc: "2.0", method: "notifications/initialized" });

// 3) tools/list — verify the surface (should be 12 tools)
send(child, { jsonrpc: "2.0", id: 2, method: "tools/list" });
const listResult = await awaitResponse(responses, 2);
const toolNames = (listResult.result?.tools ?? []).map((t) => t.name);
console.log("tool count:", toolNames.length, "expected 12");
console.log("tools:", toolNames.sort().join(", "));

// 4) tools/call remember (write 1) — actor A writes
const write1 = {
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: {
    name: "remember",
    arguments: {
      scope: "global",
      type: "fact",
      topic: "stack",
      title: "smoke-test-p1",
      body: "primary datastore is postgres",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 4
    }
  }
};
send(child, write1);
const write1Result = await awaitResponse(responses, 3);
const w1 = JSON.parse(write1Result.result?.content?.[0]?.text ?? "{}");
console.log("write 1 ok:", w1.ok, "id:", w1.value?.memory_id);
const memory1Id = w1.value?.memory_id;
if (!memory1Id) {
  console.error("write 1 failed:", w1);
  process.exit(1);
}

// 5) tools/call get_memory to populate last_accessed_by for memory1
send(child, {
  jsonrpc: "2.0",
  id: 4,
  method: "tools/call",
  params: { name: "get_memory", arguments: { memory_id: memory1Id, accessed_by: "agent:smoke-test" } }
});
const readResult = await awaitResponse(responses, 4);
const r1 = JSON.parse(readResult.result?.content?.[0]?.text ?? "{}");
// get_memory returns the entry+audit pair directly (not wrapped in Result).
console.log("read 1 entry.last_accessed_by:", r1.entry?.last_accessed_by);

// 6) tools/call remember (write 2) — REPHASES memory 1
//     actor B is implicit (server's default agent:mavis)
const write2 = {
  jsonrpc: "2.0",
  id: 5,
  method: "tools/call",
  params: {
    name: "remember",
    arguments: {
      scope: "global",
      type: "fact",
      topic: "stack",
      title: "smoke-test-p2",
      body: "primary datastore is postgres for the api",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 4
    }
  }
};
send(child, write2);
const write2Result = await awaitResponse(responses, 5);
const w2 = JSON.parse(write2Result.result?.content?.[0]?.text ?? "{}");
console.log("write 2 ok:", w2.ok);
console.log("write 2 warnings:", JSON.stringify(w2.value?.warnings ?? []));

// 7) tools/call maintain_memories with find_duplicates to verify similar_title_and_body
send(child, {
  jsonrpc: "2.0",
  id: 6,
  method: "tools/call",
  params: { name: "maintain_memories", arguments: { action: "find_duplicates", scope: "global" } }
});
const dupResult = await awaitResponse(responses, 6);
const dup = JSON.parse(dupResult.result?.content?.[0]?.text ?? "{}");
// maintain_memories returns MaintainMemoriesResult directly (not a Result wrapper).
const dupGroups = dup.details?.groups ?? [];
const similar = dupGroups.filter((g) => g.reason === "similar_title_and_body");
console.log("find_duplicates groups:", dupGroups.map((g) => g.reason));
console.log("similar_title_and_body:", similar.length, "groups", "details:", JSON.stringify(similar[0]?.details ?? null));

// Assertions
const errors = [];
if (toolNames.length !== 12) errors.push(`expected 12 tools, got ${toolNames.length}`);
if (!toolNames.includes("merge_memories")) errors.push("missing merge_memories tool");
if (!w2.ok) errors.push(`write 2 expected ok=true, got ${JSON.stringify(w2)}`);
const nearWarns = (w2.value?.warnings ?? []).filter((w) => w.code === "near_duplicate");
if (nearWarns.length !== 1) errors.push(`expected 1 near_duplicate warning, got ${nearWarns.length}`);
else {
  if (nearWarns[0].similarity < 0.7) errors.push(`similarity ${nearWarns[0].similarity} < 0.7`);
  if (nearWarns[0].actor !== "agent:smoke-test") errors.push(`actor should be agent:smoke-test, got ${nearWarns[0].actor}`);
  if (!nearWarns[0].last_accessed_by) errors.push("last_accessed_by should be populated");
}
if (similar.length === 0) errors.push("expected at least 1 similar_title_and_body group");

if (errors.length > 0) {
  console.error("SMOKE TEST FAILED:");
  for (const e of errors) console.error("  -", e);
  child.kill();
  process.exit(1);
}
console.log("\nSMOKE TEST PASSED ✓");
child.kill();
process.exit(0);
