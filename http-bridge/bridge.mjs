#!/usr/bin/env node
//
// bridge.mjs - agent-recall 的 MCP-over-HTTP 桥接
//
// 实现 MCP Streamable HTTP transport 规范(version 2025-03-26+):
//   POST   /mcp      JSON-RPC 请求(响应是 application/json 或 SSE)
//   GET    /mcp      server-initiated SSE 流
//   DELETE /mcp      关闭 session
//
// 同时提供方便端点:
//   GET  /health     服务健康 + profile + data home
//   GET  /tools      工具清单(等价于 POST /mcp tools/list)
//   GET  /info       服务元信息
//
// 直接复用 agent-recall 的 MemoryService + 工具注册;不起子进程。
// 所有 mcp 请求都在同一进程内处理,session 状态在内存中。
//
// 用法:
//   node bridge.mjs [port]
//   PORT=8080 node bridge.mjs
//
// 环境变量(从 .bridge.env 自动加载):
//   AGENT_RECALL_HOME     数据目录
//   AGENT_RECALL_PROFILE  core | extended | admin
//   AGENT_RECALL_ACTOR    默认 actor
//   AGENT_RECALL_VERBOSE  1 = 打印请求日志
//   MCP_HTTP_PORT         监听端口(覆盖位置参数)

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// PROJECT_ROOT resolution chain (for the Bun single-file binary build
// where __dirname points at the binary's install dir, not the source):
//   1) --project-root <abs path> command-line flag
//   2) AGENT_RECALL_PROJECT_ROOT env var
//   3) walk upward from process.execPath looking for dist/src/index.js
//      (covers the standard install layout: dist-bin/binary + dist/src/index.js)
//   4) __dirname/.. (source-tree dev mode, npm run dev)
function findProjectRoot() {
  const flagIdx = process.argv.findIndex((a) => a === "--project-root");
  if (flagIdx >= 0 && process.argv[flagIdx + 1]) {
    return resolve(process.argv[flagIdx + 1]);
  }
  if (process.env.AGENT_RECALL_PROJECT_ROOT) {
    return resolve(process.env.AGENT_RECALL_PROJECT_ROOT);
  }
  // Walk up from the binary location looking for the canonical marker
  let cur = dirname(process.execPath);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cur, "dist", "src", "index.js"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // Last resort: relative to this file (dev mode via `node bridge.mjs`)
  return resolve(__dirname, "..");
}
const PROJECT_ROOT = findProjectRoot();
if (process.env.AGENT_RECALL_VERBOSE === "1") {
  console.error(`[http-bridge] PROJECT_ROOT = ${PROJECT_ROOT}`);
  console.error(`[http-bridge] process.execPath = ${process.execPath}`);
}
const DIST_INDEX = join(PROJECT_ROOT, "dist", "src", "index.js");

// Make the project's node_modules reachable from dynamic-imported code
// (dist/src/index.js) when the binary is launched from a different
// cwd.  Bun resolves bare imports via the cwd's ancestor node_modules
// chain; by prepending PROJECT_ROOT/node_modules to NODE_PATH and
// chdir()-ing there, the dynamic-imported service file finds SDK
// packages even when the bridge was started from http-bridge/ or any
// other working directory set by the install script.
const PROJECT_NODE_MODULES = join(PROJECT_ROOT, "node_modules");
if (existsSync(PROJECT_NODE_MODULES)) {
  const sep = process.platform === "win32" ? ";" : ":";
  process.env.NODE_PATH = PROJECT_NODE_MODULES +
    (process.env.NODE_PATH ? sep + process.env.NODE_PATH : "");
  try {
    const { Module } = await import("node:module");
    if (typeof Module._initPaths === "function") Module._initPaths();
  } catch {}
}

// fileImport is unused now; left as a no-op import helper for
// backwards-compat with prior code paths (kept commented to avoid
// emitting an unused-symbol warning).
// const fileImport = (rel) => import(`../dist/${rel}`);

// STATIC top-level imports of every dist module the bridge needs.
// As with the index.js import above, these are static so bun build
// can resolve the entire dependency graph at compile time.
import { CapabilityStore } from "../dist/src/admin/capability.js";
import { registerCoreTools, registerExtendedTools, memoryToolNames, CORE_TOOL_NAMES } from "../dist/src/tools/register-tools.js";
import { registerMemoryResources } from "../dist/src/mcp/resources.js";
import { resolveActor } from "../dist/src/actor.js";
import { ProjectIdentityResolver } from "../dist/src/scope-resolver.js";
import { resolveAuthorization } from "../dist/src/services/auth-context.js";

// ---- 加载 env 文件(权威源,覆盖 process.env) ----
// 查找顺序(后者被前者覆盖):
//   1) AGENT_RECALL_BRIDGE_ENV_FILE 显式指定路径
//   2) <exe-dir>/.env                 二进制模式标准 .env(KEY=VALUE)
//   3) <exe-dir>/.bridge.env          二进制模式 JSON 变体
//   4) <__dirname>/.bridge.env        dev (node bridge.mjs) JSON 变体
// "exe-dir" 是 process.execPath 的目录;在 `node bridge.mjs` 模式下
// process.execPath 是 node.exe,我们跳过步骤 2/3(否则会从 node 的
// 安装目录读 .env,毫无意义)。判断方法:process.execPath 的 basename
// 是否包含 "agent-recall-http-bridge"。
const VERBOSE = process.env.AGENT_RECALL_VERBOSE === "1";
const IS_BINARY_MODE = /agent-recall-http-bridge/.test(process.execPath);

function isBinaryEnvCandidate(p) {
  if (!existsSync(p)) return false;
  return true;
}

function loadEnvFile(path) {
  try {
    const raw = readFileSync(path, "utf8");
    const trimmed = raw.trimStart();
    let entries = {};
    if (trimmed.startsWith("{")) {
      // JSON variant — explicit object with quoted keys.
      const data = JSON.parse(raw);
      for (const [k, v] of Object.entries(data)) entries[k] = String(v);
    } else {
      // Standard .env (KEY=VALUE lines; # comments; optional export;
      // bare value is a string; "..." or '...' quotes are stripped).
      for (const rawLine of raw.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!m) continue;
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        // Strip trailing inline comments for unquoted values.
        if (!m[2].startsWith('"') && !m[2].startsWith("'")) {
          const hashIdx = v.indexOf(" #");
          if (hashIdx >= 0) v = v.slice(0, hashIdx).trim();
        }
        entries[m[1]] = v;
      }
    }
    let count = 0;
    for (const [k, v] of Object.entries(entries)) {
      // Env file is authoritative: it OVERRIDES whatever was set
      // before (dotenv semantics).  We log the new key even if
      // process.env already had a value, so the operator can see
      // that the env file has taken effect.
      process.env[k] = v;
      count++;
    }
    console.error(`[http-bridge] loaded env from ${path} (${count} key(s))`);
  } catch (e) {
    console.error(`[http-bridge] failed to load env from ${path}: ${e.message}`);
  }
}

if (process.env.AGENT_RECALL_BRIDGE_ENV_FILE) {
  loadEnvFile(process.env.AGENT_RECALL_BRIDGE_ENV_FILE);
} else if (IS_BINARY_MODE) {
  const exeDir = dirname(process.execPath);
  const dotenv = join(exeDir, ".env");
  const jsonenv = join(exeDir, ".bridge.env");
  if (isBinaryEnvCandidate(dotenv)) {
    loadEnvFile(dotenv);
  } else if (isBinaryEnvCandidate(jsonenv)) {
    loadEnvFile(jsonenv);
  } else {
    console.error(`[http-bridge] no env file next to ${process.execPath} (.env / .bridge.env)`);
  }
} else {
  const devEnv = join(__dirname, ".bridge.env");
  if (existsSync(devEnv)) loadEnvFile(devEnv);
}

// 命令行 port 优先, 然后 process.env(已被 .env 覆盖), 最后默认
const PORT = Number.parseInt(
  process.argv[2] ?? process.env.MCP_HTTP_PORT ?? "7777",
  10
);

// ---- 加载已构建的 service factory ----
// STATIC top-level import of the project's compiled MCP service entry.
// This is critical for the bun single-file binary build: a top-level
// static import gives the bundler a complete dependency graph at
// compile time, so the whole dist/src/ tree (and its transitive
// imports of @modelcontextprotocol/sdk, zod, etc.) is folded into
// the binary.  An `await import(...)` would be a runtime dynamic
// import that bun cannot follow, and the produced binary would then
// try to load the dist/ files from the filesystem at run time, which
// fails in single-binary deployments.
//
// IMPORTANT: do NOT `import` from `../dist/src/index.js` here.
// `dist/src/index.js` ends with:
//
//     if (isDirectExecution()) {
//         main().catch(...)
//     }
//
// In a bun-compiled single-file binary on Windows, `isDirectExecution()`
// returns true (process.argv[1] matches the binary's own path), so the
// `main()` call fires on module init.  `main()` creates a
// `StdioServerTransport` and immediately connects it; with stdin/stdout
// closed (background service), the transport drains EOF, the
// `server-lifecycle` triggers `process.exit(0)`, and the binary exits
// before our HTTP `listen()` can pin the event loop.  Inlining the two
// functions we need (`createService`, `resolveDataHome`) here keeps the
// binary's import graph out of `index.js`, which side-steps the auto-
// invocation.  The two functions are tiny: `resolveDataHome` reads the
// `AGENT_RECALL_HOME` / `LOCAL_MEMORY_MCP_HOME` env vars and expands a
// leading `~`; `createService` wires a `SQLiteMemoryStore` +
// `MarkdownExporter` + `MemoryService` together.
import { homedir } from "node:os";
import { SQLiteMemoryStore } from "../dist/src/sqlite-store.js";
import { MarkdownExporter } from "../dist/src/markdown-exporter.js";
import { MemoryService } from "../dist/src/memory-service.js";
import { resolveActor as resolveActorHelper } from "../dist/src/actor.js";

function expandBridgeHome(input) {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(homedir(), input.slice(2));
  }
  return input;
}
function resolveDataHomeBridge(env = process.env) {
  const configured = env.AGENT_RECALL_HOME?.trim() || env.LOCAL_MEMORY_MCP_HOME?.trim();
  return resolve(expandBridgeHome(
    configured === undefined || configured.length === 0
      ? "~/.agent-recall"
      : configured
  ));
}
function createServiceBridge(dataHome = resolveDataHomeBridge(), options = {}, activeProfile = "core") {
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const exporter = new MarkdownExporter(join(dataHome, "exports"));
  return new MemoryService(
    store,
    exporter,
    resolveActorHelper(undefined),
    dataHome,
    options.capabilityStore,
    activeProfile
  );
}
const indexModule = {
  createService: createServiceBridge,
  resolveDataHome: resolveDataHomeBridge,
};

// ---- 构造 MemoryService ----
const dataHome = indexModule.resolveDataHome();
const profile = (() => {
  const v = process.env.AGENT_RECALL_PROFILE?.trim();
  if (!v) return "extended";
  if (!["core", "extended", "admin"].includes(v)) {
    console.error(`[http-bridge] unknown AGENT_RECALL_PROFILE='${v}', falling back to 'extended'`);
    return "extended";
  }
  return v;
})();
const actor = process.env.AGENT_RECALL_ACTOR ?? "agent:http-bridge";

// admin profile 必须有 capability
let capabilityStore;
if (profile === "admin") {
  capabilityStore = new CapabilityStore(dataHome, { persistent: true });
  if (!capabilityStore.hasCapability()) {
    console.error(
      `[http-bridge] AGENT_RECALL_PROFILE=admin requires a valid operator capability. ` +
      `Run \`agent-recall admin grant\` first.`
    );
    process.exit(1);
  }
}

const service = createServiceBridge(dataHome, { capabilityStore }, profile);
console.error(
  `[http-bridge] service ready: home=${dataHome} profile=${profile} actor=${actor}`
);

// ---- 工具注册 ----
const registerFn = profile === "core" ? registerCoreTools : registerExtendedTools;

const defaultActor = resolveActor(undefined);
const identityResolver = new ProjectIdentityResolver(service.store, defaultActor);
const authorization = resolveAuthorization(
  { activeProfile: profile, hasCapability: capabilityStore?.hasCapability() === true },
  { kind: "read", restrictedAllowed: false }
);
const actorMaxSensitivity =
  profile === "admin" && capabilityStore?.hasCapability() === true
    ? "restricted"
    : "normal";

// 每个 session 一个 McpServer + Transport
const sessions = new Map();

function createSession() {
  const server = new McpServer({
    name: "agent-recall",
    version: "1.1.5"
  });
  registerFn(server, service);
  registerMemoryResources(server, {
    store: service.store,
    dataHome,
    defaultActor,
    identityResolver,
    activeProfile: profile,
    capabilityStore,
    authorization,
    actorMaxSensitivity
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, { server, transport });
      if (VERBOSE) console.error(`[http-bridge] session opened: ${sessionId}`);
    }
  });
  transport.onclose = () => {
    if (transport.sessionId && sessions.has(transport.sessionId)) {
      sessions.delete(transport.sessionId);
      if (VERBOSE) console.error(`[http-bridge] session closed: ${transport.sessionId}`);
    }
  };
  transport.onerror = (err) => {
    console.error(`[http-bridge] transport error:`, err);
  };

  return { server, transport };
}

// ---- HTTP server ----
const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id, accept",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Expose-Headers": "mcp-session-id"
    });
    return res.end();
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

  try {
    if (method === "GET" && path === "/health") {
      const body = JSON.stringify({
        ok: true,
        bridge: "agent-recall-http-bridge",
        transport: "streamable-http",
        mcp_home: dataHome,
        mcp_profile: profile,
        mcp_actor: actor,
        active_sessions: sessions.size,
        uptime_s: Math.round(process.uptime())
      });
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body)
      });
      return res.end(body);
    }

    if (method === "GET" && path === "/info") {
      const body = JSON.stringify({
        ok: true,
        service: "agent-recall",
        profile,
        endpoints: {
          "POST /mcp": "JSON-RPC 2.0 (MCP Streamable HTTP)",
          "GET /mcp":  "server-initiated SSE stream",
          "DELETE /mcp": "close session",
          "GET /health": "service health",
          "GET /tools": "list tools (convenience, requires session)"
        },
        mcp_spec: "2025-03-26"
      }, null, 2);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body)
      });
      return res.end(body);
    }

    if (method === "GET" && path === "/tools") {
      const names = profile === "core"
        ? Array.from(CORE_TOOL_NAMES)
        : Array.from(memoryToolNames);
      const body = JSON.stringify({
        ok: true,
        profile,
        count: names.length,
        names
      }, null, 2);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body)
      });
      return res.end(body);
    }

    if (path === "/mcp") {
      if (method === "DELETE") {
        const sessionHeader = req.headers["mcp-session-id"];
        const session = typeof sessionHeader === "string" ? sessions.get(sessionHeader) : undefined;
        if (!session) {
          res.writeHead(404, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "session not found" }));
        }
        await session.transport.handleRequest(req, res);
        return;
      }

      if (method === "GET") {
        const sessionHeader = req.headers["mcp-session-id"];
        const session = typeof sessionHeader === "string" ? sessions.get(sessionHeader) : undefined;
        if (!session) {
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "mcp-session-id header required" }));
        }
        await session.transport.handleRequest(req, res);
        return;
      }

      if (method === "POST") {
        const sessionHeader = req.headers["mcp-session-id"];
        const hasHeader = typeof sessionHeader === "string" && sessionHeader.length > 0;
        const sessionValid = hasHeader && sessions.has(sessionHeader);
        const body = await readJsonBody(req);

        if (sessionValid) {
          const session = sessions.get(sessionHeader);
          if (VERBOSE) console.error(`[http-bridge] POST /mcp session=${sessionHeader} method=${body?.method}`);
          await session.transport.handleRequest(req, res, body);
          return;
        }

        if (hasHeader && body?.method !== "initialize") {
          res.writeHead(404, { "content-type": "application/json" });
          return res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: body?.id ?? null,
            error: { code: -32000, message: "session not found" }
          }));
        }

        if (body?.method !== "initialize") {
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: body?.id ?? null,
            error: { code: -32000, message: "Mcp-Session-Id header required for non-initialize requests" }
          }));
        }

        const { server, transport } = createSession();
        await server.connect(transport);
        if (VERBOSE) console.error(`[http-bridge] initialize: ${body?.params?.clientInfo?.name ?? "?"}`);
        await transport.handleRequest(req, res, body);
        return;
      }
    }

    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "not found", path }));
  } catch (e) {
    console.error(`[http-bridge] handler error:`, e);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
    }
    res.end(JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: e instanceof Error ? e.message : String(e) }
    }));
  }
});

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error(`invalid JSON: ${e.message}`)); }
    });
    req.on("error", reject);
  });
}

// ---- 启动 ----
try {
  // Await the listening event so the bridge exits cleanly if the
  // socket cannot be bound (port in use, missing permissions, etc.)
  // instead of silently falling off the end of the top-level code.
  await new Promise((resolve, reject) => {
    httpServer.once("error", (err) => reject(err));
    httpServer.once("listening", () => resolve(undefined));
    httpServer.listen(PORT, "127.0.0.1");
  });
  console.error(
    `[http-bridge] listening on http://127.0.0.1:${PORT}\n` +
    `  transport:  streamable-http (MCP 2025-03-26)\n` +
    `  home:       ${dataHome}\n` +
    `  profile:    ${profile}\n` +
    `  actor:      ${actor}\n` +
    `  endpoints:  POST /mcp, GET /mcp, DELETE /mcp, GET /health, GET /info, GET /tools`
  );
} catch (e) {
  console.error(`[http-bridge] listen failed: ${e?.message ?? e}`);
  process.exit(1);
}

// Keep the event loop alive after the top-level awaits finish.
// Without this, a script that has nothing else pending (no timer, no
// keep-alive socket) would let bun exit at the next checkpoint.  The
// never-resolved trailing await is the canonical pattern; the actual
// signal handlers live further down.
process.on("SIGINT", () => { httpServer.close(); process.exit(0); });
process.on("SIGTERM", () => { httpServer.close(); process.exit(0); });
await new Promise(() => {}); // never resolves; keeps event loop alive

httpServer.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`[http-bridge] port ${PORT} already in use; exiting`);
    process.exit(0);
  } else {
    console.error(`[http-bridge] server error:`, err);
    process.exit(1);
  }
});

