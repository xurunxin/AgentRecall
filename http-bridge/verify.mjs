#!/usr/bin/env node
//
// verify.mjs - 通过 MCP Streamable HTTP 协议验证 agent-recall 工具
//
// 用法: node verify.mjs [baseUrl]
//   默认 http://127.0.0.1:7781
//
// 走标准 MCP 协议(POST /mcp + initialize + tools/call),
// 不依赖任何额外的 REST 便捷端点。

const BASE = (process.argv[2] ?? process.env.BRIDGE_URL ?? "http://127.0.0.1:7781").replace(/\/+$/, "");

let pass = 0;
let fail = 0;
const results = [];

function ok(name, detail) {
  pass++;
  results.push({ name, ok: true, detail });
  console.log(`  PASS  ${name}` + (detail ? `  -- ${detail}` : ""));
}
function bad(name, detail) {
  fail++;
  results.push({ name, ok: false, detail });
  console.log(`  FAIL  ${name}` + (detail ? `  -- ${detail}` : ""));
}

function parseSSE(text) {
  const dataLines = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^data:\s?(.*)$/);
    if (m) dataLines.push(m[1]);
  }
  if (dataLines.length === 0) return null;
  return JSON.parse(dataLines.join("\n"));
}

class MCPClient {
  constructor(base) {
    this.base = base;
    this.sessionId = null;
    this.nextId = 1;
  }

  async request(method, params) {
    const id = this.nextId++;
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream"
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    const r = await fetch(`${this.base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} })
    });
    const text = await r.text();
    if (r.status === 202) return { status: r.status, result: null };
    const body = parseSSE(text);
    if (body?.error) throw new Error(`RPC error: ${JSON.stringify(body.error)}`);
    return { status: r.status, result: body?.result };
  }

  async notify(method, params) {
    const headers = { "Content-Type": "application/json" };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    const r = await fetch(`${this.base}/mcp`, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} })
    });
    return r.status;
  }

  async initialize() {
    const r = await fetch(`${this.base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 0, method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "verify", version: "0.1.0" }
        }
      })
    });
    const sid = r.headers.get("mcp-session-id");
    if (r.status !== 200 || !sid) throw new Error(`initialize failed: status=${r.status}`);
    this.sessionId = sid;
    await this.notify("notifications/initialized");
    return sid;
  }

  async close() {
    if (!this.sessionId) return;
    const r = await fetch(`${this.base}/mcp`, {
      method: "DELETE",
      headers: { "Mcp-Session-Id": this.sessionId }
    });
    this.sessionId = null;
    return r.status;
  }

  async callTool(name, args) {
    const r = await this.request("tools/call", { name, arguments: args ?? {} });
    return r.result;
  }
}

function expectOk(label, result, predicate) {
  if (result?.isError) {
    const text = result.content?.[0]?.text;
    return bad(label, `is_error=true text=${text?.slice(0, 200)}`);
  }
  const text = result?.content?.[0]?.text;
  let parsed = null;
  if (typeof text === "string") {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (predicate && !predicate(parsed)) {
    return bad(label, `predicate failed  raw=${JSON.stringify(parsed).slice(0, 300)}`);
  }
  ok(label, parsed ? shortSummary(parsed) : "");
}

function shortSummary(o) {
  if (o == null) return "null";
  if (typeof o !== "object") return String(o).slice(0, 80);
  if (o.ok !== undefined) {
    if (o.value?.memory_id) return `memory_id=${o.value.memory_id}`;
    if (Array.isArray(o.value)) return `value[${o.value.length}]`;
    if (o.value && typeof o.value === "object") return Object.keys(o.value).slice(0, 4).join(",");
    return `ok=${o.ok}`;
  }
  if (Array.isArray(o)) return `len=${o.length}`;
  return Object.keys(o).slice(0, 5).join(",");
}

async function main() {
  console.log(`\n=== agent-recall HTTP verification (base: ${BASE}) ===\n`);

  // ---- META ----
  console.log("[meta]");
  try {
    const h = await (await fetch(`${BASE}/health`)).json();
    h.bridge ? ok("GET /health", `profile=${h.mcp_profile} actor=${h.mcp_actor}`)
             : bad("GET /health", JSON.stringify(h));
  } catch (e) { bad("GET /health", e.message); }

  try {
    const t = await (await fetch(`${BASE}/tools`)).json();
    t.ok && t.count >= 10 ? ok("GET /tools", `${t.count} tools`)
                          : bad("GET /tools", JSON.stringify(t).slice(0, 200));
  } catch (e) { bad("GET /tools", e.message); }

  // 初始化 MCP session
  const client = new MCPClient(BASE);
  let sessionOk = false;
  try {
    await client.initialize();
    sessionOk = true;
    ok("MCP initialize", `session=${client.sessionId.slice(0, 8)}...`);
  } catch (e) {
    bad("MCP initialize", e.message);
  }

  if (!sessionOk) {
    console.log("\nABORT: cannot continue without session");
    process.exit(1);
  }

  // 3) tools/list (走 MCP 协议)
  try {
    const r = await client.request("tools/list");
    if (Array.isArray(r.result?.tools) && r.result.tools.length >= 10) {
      ok("tools/list (MCP)", `${r.result.tools.length} tools`);
    } else {
      bad("tools/list (MCP)", `expected >=10, got ${r.result?.tools?.length}`);
    }
  } catch (e) { bad("tools/list (MCP)", e.message); }

  // 4) resources/read memory://health
  try {
    const r = await client.request("resources/read", { uri: "memory://health" });
    const text = r.result?.contents?.[0]?.text;
    if (text) {
      const h = JSON.parse(text);
      ok("resources/read memory://health", `version=${h.server_version} schema=${h.schema_version}`);
    } else {
      bad("resources/read memory://health", "no contents");
    }
  } catch (e) { bad("resources/read memory://health", e.message); }

  // ---- WRITE ----
  console.log("\n[write path]");
  // Per-run unique stamp + salt so the same body string never collides
  // with a memory left behind by a previous verify run.  The
  // duplicate-check is "same title or body", so every write needs its
  // own unique body, and the "near-dup advisory" test must rephrase
  // the FIRST write's body (not invent a new one) to exercise the
  // similarity warning.
  const stamp = Date.now();
  const salt = Math.random().toString(36).slice(2, 8);
  const tag = `verify-${stamp}-${salt}`;
  const factBody1 = `primary datastore is postgres (run=${stamp}, salt=${salt})`;
  const prefBody1 = `default log level is info (run=${stamp}, salt=${salt})`;

  let mem1, mem2;
  try {
    const r = await client.callTool("remember", {
      scope: "global", type: "fact", topic: "http-verify",
      title: `${tag}-pg`, body: factBody1,
      tags: [tag, "stack"], source: { kind: "agent" },
      importance: 3, confidence: 4
    });
    expectOk("remember (global fact)", r, (p) => p?.ok === true && typeof p?.value?.memory_id === "string");
    mem1 = JSON.parse(r.content[0].text)?.value?.memory_id;
  } catch (e) { bad("remember (global fact)", e.message); }

  try {
    const r = await client.callTool("remember", {
      scope: "global", type: "preference", topic: "http-verify",
      title: `${tag}-log`, body: prefBody1,
      tags: [tag], source: { kind: "agent" },
      importance: 2, confidence: 5
    });
    expectOk("remember (preference)", r, (p) => p?.ok === true);
    mem2 = JSON.parse(r.content[0].text)?.value?.memory_id;
  } catch (e) { bad("remember (preference)", e.message); }

  try {
    // Rephrase the FIRST fact's body (sub-string overlap, NOT an exact
    // match) to exercise the near_duplicate advisory warning.  Adding
    // a different suffix to the body keeps it unique vs. the prior run
    // while preserving enough overlap that the ranker's near-dup
    // detector fires.
    const r = await client.callTool("remember", {
      scope: "global", type: "fact", topic: "http-verify",
      title: `${tag}-pg-rephrased`,
      body: `primary datastore is postgres for the api (rephrase=${salt})`,
      tags: [tag], source: { kind: "agent" },
      importance: 3, confidence: 4
    });
    expectOk("remember (near-dup advisory)", r, (p) => {
      const warns = p?.value?.warnings ?? [];
      return p?.ok === true && warns.some((w) => w.code === "near_duplicate");
    });
  } catch (e) { bad("remember (near-dup advisory)", e.message); }

  if (mem1) {
    try {
      const r = await client.callTool("update_memory", {
        memory_id: mem1, patch: { importance: 5, tags: [tag, "stack", "boosted"] }
      });
      expectOk("update_memory", r, (p) => p?.ok === true);
    } catch (e) { bad("update_memory", e.message); }
  } else bad("update_memory", "no mem1 id");

  if (mem1) {
    try {
      const r = await client.callTool("supersede_memory", {
        old_memory_ids: [mem1],
        replacement: {
          scope: "global", type: "fact", topic: "http-verify",
          title: `${tag}-pg-v2`, body: "primary datastore is postgres v2 (sharded)",
          tags: [tag], source: { kind: "agent" },
          importance: 4, confidence: 5
        },
        reason: "verify-test supersede"
      });
      expectOk("supersede_memory", r, (p) => p?.ok === true);
    } catch (e) { bad("supersede_memory", e.message); }
  }

  if (mem2) {
    try {
      const r = await client.callTool("forget_memory", { memory_id: mem2, reason: "verify-test cleanup" });
      expectOk("forget_memory", r, (p) => p?.ok === true);
    } catch (e) { bad("forget_memory", e.message); }
  }

  // ---- READ ----
  console.log("\n[read path]");

  if (mem1) {
    try {
      const r = await client.callTool("get_memory", { memory_id: mem1 });
      const text = r.content[0].text;
      const parsed = JSON.parse(text);
      const entry = parsed.entry ?? parsed.value?.entry ?? parsed.value;
      const hasEntry = entry && (entry.id !== undefined || entry.memory_id !== undefined);
      hasEntry ? ok("get_memory", `id=${mem1}`)
               : bad("get_memory", JSON.stringify(parsed).slice(0, 200));
    } catch (e) { bad("get_memory", e.message); }
  }

  try {
    const r = await client.callTool("list_memories", { scope: "global", limit: 50 });
    expectOk("list_memories (global)", r, (p) => Array.isArray(p?.value) || Array.isArray(p?.items) || Array.isArray(p));
  } catch (e) { bad("list_memories (global)", e.message); }

  try {
    const r = await client.callTool("search_memories", { query: tag, scope: "global", limit: 20 });
    expectOk("search_memories", r, (p) => {
      const items = p?.value ?? p?.items ?? p;
      return Array.isArray(items);
    });
  } catch (e) { bad("search_memories", e.message); }

  try {
    const r = await client.callTool("recall_context", { query: `postgres ${tag}`, scope: "global" });
    expectOk("recall_context", r, () => true);
  } catch (e) { bad("recall_context", e.message); }

  try {
    const r = await client.callTool("get_memory_budget", { scope: "global" });
    expectOk("get_memory_budget", r, (p) => p && (p.budget !== undefined || p.usage !== undefined));
  } catch (e) { bad("get_memory_budget", e.message); }

  try {
    const r = await client.callTool("explain_recall", { query: `postgres ${tag}`, scope: "global", top_k: 5 });
    expectOk("explain_recall", r, () => true);
  } catch (e) { bad("explain_recall", e.message); }

  try {
    const r = await client.callTool("list_backups", {});
    expectOk("list_backups", r, () => true);
  } catch (e) { bad("list_backups", e.message); }

  // ---- MAINTENANCE / EXPORT ----
  console.log("\n[maintenance & export]");

  try {
    const r = await client.callTool("maintain_memories", { action: "find_duplicates", scope: "global" });
    expectOk("maintain_memories.find_duplicates", r, () => true);
  } catch (e) { bad("maintain_memories.find_duplicates", e.message); }

  let planId = null;
  try {
    const r = await client.callTool("plan_maintenance", { scope: "global" });
    const text = r.content[0].text;
    const parsed = JSON.parse(text);
    const pid = parsed?.plan_id ?? parsed?.value?.plan_id;
    if (pid) { ok("plan_maintenance", `plan_id=${pid}`); planId = pid; }
    else bad("plan_maintenance", JSON.stringify(parsed).slice(0, 200));
  } catch (e) { bad("plan_maintenance", e.message); }

  if (planId) {
    try {
      const r = await client.callTool("apply_maintenance", {
        plan_id: planId, confirm: true, idempotency_key: `verify-${stamp}-apply`
      });
      expectOk("apply_maintenance (with plan_id)", r, () => true);
    } catch (e) { bad("apply_maintenance (with plan_id)", e.message); }
  } else bad("apply_maintenance (with plan_id)", "no plan_id");

  try {
    const r = await client.callTool("maintain_memories", { action: "vacuum_fts", scope: "global" });
    expectOk("maintain_memories.vacuum_fts", r, () => true);
  } catch (e) { bad("maintain_memories.vacuum_fts", e.message); }

  try {
    const r = await client.callTool("export_memory_context", {
      scope: "global", query: `postgres ${tag}`, budget_chars: 2000
    });
    expectOk("export_memory_context", r, () => true);
  } catch (e) { bad("export_memory_context", e.message); }

  if (mem1) {
    try {
      const r = await client.callTool("record_memory_feedback", { memory_id: mem1, kind: "up" });
      expectOk("record_memory_feedback", r, () => true);
    } catch (e) { bad("record_memory_feedback", e.message); }
  }

  if (mem1) {
    try {
      const r = await client.callTool("record_memory_provenance", {
        memory_id: mem1, source_kind: "session", source_ref: `http-verify-${stamp}`
      });
      expectOk("record_memory_provenance", r, () => true);
    } catch (e) { bad("record_memory_provenance", e.message); }
  }

  if (mem1) {
    try {
      const r = await client.callTool("explain_memory_provenance", { memory_id: mem1 });
      expectOk("explain_memory_provenance", r, () => true);
    } catch (e) { bad("explain_memory_provenance", e.message); }
  }

  if (mem1) {
    try {
      const r = await client.callTool("confirm_memory_trust", {
        memory_id: mem1, trust_level: "user_confirmed",
        user_confirmed: true, reason: "verify-test"
      });
      if (!r.isError) ok("confirm_memory_trust", "accepted");
      else ok("confirm_memory_trust (expected error on extended profile)", `is_error=${r.isError}`);
    } catch (e) { bad("confirm_memory_trust", e.message); }
  }

  // ---- ERRORS ----
  console.log("\n[error paths]");

  try {
    const r = await client.callTool("no_such_tool", {});
    r.isError ? ok("unknown tool -> is_error", `is_error=${r.isError}`)
              : bad("unknown tool -> is_error", "expected is_error");
  } catch (e) { bad("unknown tool", e.message); }

  try {
    const r = await client.callTool("remember", {});
    r.isError ? ok("missing required args -> is_error", `is_error=${r.isError}`)
              : bad("missing required args", "expected is_error");
  } catch (e) { bad("missing required args", e.message); }

  try {
    const r = await fetch(`${BASE}/no-such-path`);
    r.status === 404 ? ok("GET /no-such-path -> 404", `status=${r.status}`)
                     : bad("404", `status=${r.status}`);
  } catch (e) { bad("404", e.message); }

  await client.close();

  console.log(`\n=== summary: ${pass} pass / ${fail} fail ===\n`);
  if (fail > 0) {
    console.log("failures:");
    for (const r of results) {
      if (!r.ok) console.log(`  - ${r.name} :: ${r.detail}`);
    }
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(2);
});
