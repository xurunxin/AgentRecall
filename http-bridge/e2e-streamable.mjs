#!/usr/bin/env node
//
// e2e-streamable.mjs - 模拟一个真实 MCP 客户端,完整走通 Streamable HTTP 协议
//
// 验证步骤(对应 MCP spec 2025-03-26):
//   1. POST /mcp  initialize       -> 拿 mcp-session-id
//   2. POST /mcp  notifications/initialized  -> 202
//   3. POST /mcp  tools/list       -> 20 个工具
//   4. POST /mcp  tools/call remember
//   5. POST /mcp  resources/read   memory://health
//   6. POST /mcp  (无效 session header) -> 404
//   7. DELETE /mcp                 -> 200
//   8. POST /mcp  (用已关 session)  -> 404
//
// 用法: node e2e-streamable.mjs [baseUrl]
//   默认 http://127.0.0.1:7781

import { randomUUID } from "node:crypto";

const BASE = (process.argv[2] ?? process.env.BRIDGE_URL ?? "http://127.0.0.1:7781").replace(/\/+$/, "");

let pass = 0, fail = 0;
const log = (sym, msg) => console.log(`  ${sym} ${msg}`);
const ok = (msg) => { pass++; log("\u2713", msg); };
const bad = (msg) => { fail++; log("\u2717", msg); };

function parseSSEResponse(text) {
  const dataLines = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^data:\s?(.*)$/);
    if (m) dataLines.push(m[1]);
  }
  if (dataLines.length === 0) return null;
  return JSON.parse(dataLines.join("\n"));
}

async function mcpPost(sessionId, body) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream"
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  return { status: r.status, headers: r.headers, text: await r.text() };
}

async function mcpDelete(sessionId) {
  const r = await fetch(`${BASE}/mcp`, {
    method: "DELETE",
    headers: sessionId ? { "Mcp-Session-Id": sessionId } : {}
  });
  return { status: r.status, text: await r.text() };
}

async function main() {
  console.log(`\n=== MCP Streamable HTTP e2e (base: ${BASE}) ===\n`);

  // 1. initialize
  console.log("[1] initialize");
  const r1 = await mcpPost(null, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "e2e-streamable", version: "0.1.0" }
    }
  });
  let sessionId;
  if (r1.status === 200 && r1.headers.get("mcp-session-id")) {
    sessionId = r1.headers.get("mcp-session-id");
    const body = parseSSEResponse(r1.text);
    const sv = body?.result?.serverInfo;
    if (sv?.name === "agent-recall") {
      ok(`initialize -> 200, session=${sessionId.slice(0, 8)}..., server=${sv.name}@${sv.version}`);
    } else {
      bad(`initialize: unexpected serverInfo ${JSON.stringify(sv)}`);
    }
  } else {
    bad(`initialize: status=${r1.status} sid=${r1.headers.get("mcp-session-id")}`);
    return;
  }

  // 2. notifications/initialized
  console.log("\n[2] notifications/initialized");
  const r2 = await mcpPost(sessionId, { jsonrpc: "2.0", method: "notifications/initialized" });
  r2.status === 202 ? ok(`notifications/initialized -> 202`)
                    : bad(`expected 202, got ${r2.status} body=${r2.text.slice(0, 100)}`);

  // 3. tools/list
  console.log("\n[3] tools/list");
  const r3 = await mcpPost(sessionId, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  if (r3.status === 200) {
    const body = parseSSEResponse(r3.text);
    const tools = body?.result?.tools;
    if (Array.isArray(tools) && tools.length === 20) {
      ok(`tools/list -> 20 tools, sample: ${tools.slice(0, 3).map(t => t.name).join(", ")}...`);
    } else {
      bad(`tools/list: expected 20 tools, got ${tools?.length ?? "n/a"}`);
    }
  } else {
    bad(`tools/list: status=${r3.status}`);
  }

  // 4. tools/call remember
  console.log("\n[4] tools/call remember");
  const r4 = await mcpPost(sessionId, {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: {
      name: "remember",
      arguments: {
        scope: "global", type: "fact", topic: "e2e",
        title: `e2e-streamable-${Date.now()}`,
        body: "written by e2e-streamable test",
        tags: ["e2e"], source: { kind: "agent" },
        importance: 3, confidence: 4
      }
    }
  });
  if (r4.status === 200) {
    const body = parseSSEResponse(r4.text);
    const inner = JSON.parse(body.result.content[0].text);
    if (inner.ok && inner.value?.memory_id) {
      ok(`remember -> ok, memory_id=${inner.value.memory_id}`);
    } else {
      bad(`remember: ${JSON.stringify(inner).slice(0, 200)}`);
    }
  } else {
    bad(`remember: status=${r4.status} body=${r4.text.slice(0, 200)}`);
  }

  // 5. resources/read memory://health
  console.log("\n[5] resources/read memory://health");
  const r5 = await mcpPost(sessionId, {
    jsonrpc: "2.0", id: 5, method: "resources/read",
    params: { uri: "memory://health" }
  });
  if (r5.status === 200) {
    const body = parseSSEResponse(r5.text);
    const text = body?.result?.contents?.[0]?.text;
    if (text) {
      const health = JSON.parse(text);
      ok(`memory://health: server_version=${health.server_version} schema=${health.schema_version} profile=${health.active_profile}`);
    } else {
      bad(`resources/read: no contents`);
    }
  } else {
    bad(`resources/read: status=${r5.status} body=${r5.text.slice(0, 200)}`);
  }

  // 6. POST with stale session
  console.log("\n[6] POST with bad session id");
  const r6 = await mcpPost("not-a-real-session", {
    jsonrpc: "2.0", id: 6, method: "tools/list"
  });
  if (r6.status === 404 || r6.status === 400) {
    ok(`bad session -> ${r6.status}`);
  } else {
    bad(`expected 4xx for bad session, got ${r6.status}`);
  }

  // 7. DELETE session
  console.log("\n[7] DELETE /mcp");
  const r7 = await mcpDelete(sessionId);
  r7.status === 200 ? ok(`DELETE -> 200`) : bad(`DELETE: status=${r7.status}`);

  // 8. POST after delete (should 404)
  console.log("\n[8] POST after session closed");
  const r8 = await mcpPost(sessionId, { jsonrpc: "2.0", id: 8, method: "tools/list" });
  if (r8.status === 404) {
    ok(`closed session -> 404`);
  } else {
    bad(`expected 404 for closed session, got ${r8.status} body=${r8.text.slice(0, 200)}`);
  }

  console.log(`\n=== summary: ${pass} pass / ${fail} fail ===\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(2); });
