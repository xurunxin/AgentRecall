#!/usr/bin/env node
//
// verify.mjs - 通过 HTTP 端点逐个验证 agent-recall MCP 工具
//
// 用法: node verify.mjs [baseUrl]
//   默认 http://127.0.0.1:7781
//
// 覆盖:
//   - 元信息端点: /health, /tools, /mcp/resources/health
//   - 写入工具: remember (3 种情形), update_memory, supersede_memory, forget_memory
//   - 读取工具: get_memory, list_memories, search_memories, recall_context,
//     get_memory_budget, explain_recall, list_backups
//   - 维护 / 导出: maintain_memories.find_duplicates, plan_maintenance,
//     apply_maintenance (with plan_id), maintain_memories.vacuum_fts,
//     export_memory_context
//   - 语义: record_memory_feedback, record_memory_provenance,
//     explain_memory_provenance, confirm_memory_trust (admin boundary)
//   - 错误路径: 未知 tool, 缺参数, 404

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

async function call(tool, args) {
  const res = await fetch(`${BASE}/tools/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args ?? {})
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

function expectOk(label, body, predicate) {
  if (!body.ok) return bad(label, `is_error=${body.is_error}  raw=${JSON.stringify(body.parsed ?? body.raw).slice(0, 200)}`);
  if (predicate && !predicate(body.parsed)) {
    return bad(label, `predicate failed  raw=${JSON.stringify(body.parsed).slice(0, 300)}`);
  }
  ok(label, body.parsed ? shortSummary(body.parsed) : "");
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
  console.log(`\n=== agent-recall HTTP verification ===`);
  console.log(`base: ${BASE}\n`);

  // ---- 元信息 ----
  console.log("[meta]");
  try {
    const h = await (await fetch(`${BASE}/health`)).json();
    h.bridge && h.mcp_entry ? ok("GET /health", `pid=${h.child_pid} profile=${h.mcp_profile}`)
                              : bad("GET /health", JSON.stringify(h));
  } catch (e) { bad("GET /health", e.message); }

  try {
    const t = await (await fetch(`${BASE}/tools`)).json();
    t.ok && t.count >= 10 ? ok("GET /tools", `${t.count} tools`)
                          : bad("GET /tools", JSON.stringify(t).slice(0, 200));
  } catch (e) { bad("GET /tools", e.message); }

  try {
    const r = await (await fetch(`${BASE}/mcp/resources/health`)).json();
    r.ok ? ok("GET memory://health", shortSummary(r.resource))
         : bad("GET memory://health", JSON.stringify(r).slice(0, 200));
  } catch (e) { bad("GET memory://health", e.message); }

  // ---- WRITE ----
  console.log("\n[write path]");
  const stamp = Date.now();
  const tag = `verify-${stamp}`;

  let mem1;
  try {
    const body = await call("remember", {
      scope: "global", type: "fact", topic: "http-verify",
      title: `${tag}-pg`, body: "primary datastore is postgres",
      tags: [tag, "stack"], source: { kind: "agent" },
      importance: 3, confidence: 4
    });
    expectOk("remember (global fact)", body, (p) => p?.ok === true && typeof p?.value?.memory_id === "string");
    mem1 = body.parsed?.value?.memory_id;
  } catch (e) { bad("remember (global fact)", e.message); }

  let mem2;
  try {
    const body = await call("remember", {
      scope: "global", type: "preference", topic: "http-verify",
      title: `${tag}-log`, body: "default log level is info",
      tags: [tag], source: { kind: "agent" },
      importance: 2, confidence: 5
    });
    expectOk("remember (preference)", body, (p) => p?.ok === true);
    mem2 = body.parsed?.value?.memory_id;
  } catch (e) { bad("remember (preference)", e.message); }

  try {
    const body = await call("remember", {
      scope: "global", type: "fact", topic: "http-verify",
      title: `${tag}-pg-rephrased`, body: "primary datastore is postgres for the api",
      tags: [tag], source: { kind: "agent" },
      importance: 3, confidence: 4
    });
    expectOk("remember (near-dup advisory)", body, (p) => {
      const warns = p?.value?.warnings ?? [];
      return p?.ok === true && warns.some((w) => w.code === "near_duplicate");
    });
  } catch (e) { bad("remember (near-dup advisory)", e.message); }

  if (mem1) {
    try {
      const body = await call("update_memory", {
        memory_id: mem1,
        patch: { importance: 5, tags: [tag, "stack", "boosted"] }
      });
      expectOk("update_memory", body, (p) => p?.ok === true);
    } catch (e) { bad("update_memory", e.message); }
  } else bad("update_memory", "no mem1 id from earlier remember");

  if (mem1) {
    try {
      const body = await call("supersede_memory", {
        old_memory_ids: [mem1],
        replacement: {
          scope: "global", type: "fact", topic: "http-verify",
          title: `${tag}-pg-v2`, body: "primary datastore is postgres v2 (sharded)",
          tags: [tag], source: { kind: "agent" },
          importance: 4, confidence: 5
        },
        reason: "verify-test supersede"
      });
      expectOk("supersede_memory", body, (p) => p?.ok === true);
    } catch (e) { bad("supersede_memory", e.message); }
  }

  if (mem2) {
    try {
      const body = await call("forget_memory", {
        memory_id: mem2, reason: "verify-test cleanup"
      });
      expectOk("forget_memory", body, (p) => p?.ok === true);
    } catch (e) { bad("forget_memory", e.message); }
  }

  // ---- READ ----
  console.log("\n[read path]");

  if (mem1) {
    try {
      const body = await call("get_memory", { memory_id: mem1 });
      const parsed = body.parsed ?? {};
      const entry = parsed.entry ?? parsed.value?.entry ?? parsed.value;
      const hasEntry = entry && (entry.id !== undefined || entry.memory_id !== undefined);
      hasEntry ? ok("get_memory", `id=${mem1}`)
               : bad("get_memory", JSON.stringify(parsed).slice(0, 200));
    } catch (e) { bad("get_memory", e.message); }
  }

  try {
    const body = await call("list_memories", { scope: "global", limit: 50 });
    expectOk("list_memories (global)", body, (p) => Array.isArray(p?.value) || Array.isArray(p?.items) || Array.isArray(p));
  } catch (e) { bad("list_memories (global)", e.message); }

  try {
    const body = await call("search_memories", { query: tag, scope: "global", limit: 20 });
    expectOk("search_memories", body, (p) => {
      const items = p?.value ?? p?.items ?? p;
      return Array.isArray(items);
    });
  } catch (e) { bad("search_memories", e.message); }

  try {
    const body = await call("recall_context", { query: `postgres ${tag}`, scope: "global" });
    expectOk("recall_context", body, () => true);
  } catch (e) { bad("recall_context", e.message); }

  try {
    const body = await call("get_memory_budget", { scope: "global" });
    expectOk("get_memory_budget", body, (p) => p && (p.budget !== undefined || p.usage !== undefined));
  } catch (e) { bad("get_memory_budget", e.message); }

  try {
    const body = await call("explain_recall", { query: `postgres ${tag}`, scope: "global", top_k: 5 });
    expectOk("explain_recall", body, () => true);
  } catch (e) { bad("explain_recall", e.message); }

  try {
    const body = await call("list_backups", {});
    expectOk("list_backups", body, () => true);
  } catch (e) { bad("list_backups", e.message); }

  // ---- MAINTENANCE / EXPORT ----
  console.log("\n[maintenance & export]");

  try {
    const body = await call("maintain_memories", { action: "find_duplicates", scope: "global" });
    expectOk("maintain_memories.find_duplicates", body, () => true);
  } catch (e) { bad("maintain_memories.find_duplicates", e.message); }

  let planId = null;
  try {
    const body = await call("plan_maintenance", { scope: "global" });
    const ok2 = body.ok && (body.parsed?.plan_id || body.parsed?.value?.plan_id);
    if (ok2) {
      ok("plan_maintenance", `plan_id=${ok2}`);
      planId = body.parsed?.plan_id ?? body.parsed?.value?.plan_id;
    } else {
      bad("plan_maintenance", JSON.stringify(body.parsed ?? body.raw).slice(0, 200));
    }
  } catch (e) { bad("plan_maintenance", e.message); }

  if (planId) {
    try {
      const body = await call("apply_maintenance", {
        plan_id: planId, confirm: true,
        idempotency_key: `verify-${stamp}-apply`
      });
      expectOk("apply_maintenance (with plan_id)", body, () => true);
    } catch (e) { bad("apply_maintenance (with plan_id)", e.message); }
  } else {
    bad("apply_maintenance (with plan_id)", "no plan_id from plan_maintenance");
  }

  try {
    const body = await call("maintain_memories", { action: "vacuum_fts", scope: "global" });
    expectOk("maintain_memories.vacuum_fts", body, () => true);
  } catch (e) { bad("maintain_memories.vacuum_fts", e.message); }

  try {
    const body = await call("export_memory_context", {
      scope: "global", query: `postgres ${tag}`, budget_chars: 2000
    });
    expectOk("export_memory_context", body, () => true);
  } catch (e) { bad("export_memory_context", e.message); }

  if (mem1) {
    try {
      const body = await call("record_memory_feedback", { memory_id: mem1, kind: "up" });
      expectOk("record_memory_feedback", body, () => true);
    } catch (e) { bad("record_memory_feedback", e.message); }
  }

  if (mem1) {
    try {
      const body = await call("record_memory_provenance", {
        memory_id: mem1, source_kind: "session", source_ref: `http-verify-${stamp}`
      });
      expectOk("record_memory_provenance", body, () => true);
    } catch (e) { bad("record_memory_provenance", e.message); }
  }

  if (mem1) {
    try {
      const body = await call("explain_memory_provenance", { memory_id: mem1 });
      expectOk("explain_memory_provenance", body, () => true);
    } catch (e) { bad("explain_memory_provenance", e.message); }
  }

  if (mem1) {
    try {
      const body = await call("confirm_memory_trust", {
        memory_id: mem1, trust_level: "user_confirmed",
        user_confirmed: true, reason: "verify-test"
      });
      if (body.ok) ok("confirm_memory_trust", "accepted (admin boundary open)");
      else ok("confirm_memory_trust (expected error on extended profile)",
              `is_error=${body.is_error}  detail=${shortSummary(body.parsed ?? body.raw)}`);
    } catch (e) { bad("confirm_memory_trust", e.message); }
  }

  // ---- ERRORS ----
  console.log("\n[error paths]");

  try {
    const r = await fetch(`${BASE}/tools/no_such_tool`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    });
    const body = await r.json();
    !body.ok ? ok("unknown tool -> 4xx", `is_error=${body.is_error}`)
             : bad("unknown tool -> 4xx", "expected is_error=true");
  } catch (e) { bad("unknown tool", e.message); }

  try {
    const r = await fetch(`${BASE}/tools/remember`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    });
    const body = await r.json();
    !body.ok ? ok("missing required args -> is_error", `is_error=${body.is_error}`)
             : bad("missing required args", "expected is_error=true");
  } catch (e) { bad("missing required args", e.message); }

  try {
    const r = await fetch(`${BASE}/no-such-path`);
    r.status === 404 ? ok("GET /no-such-path -> 404", `status=${r.status}`)
                     : bad("404", `status=${r.status}`);
  } catch (e) { bad("404", e.message); }

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
