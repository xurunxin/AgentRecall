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
const PROJECT_ROOT = resolve(__dirname, "..");
const DIST_INDEX = join(PROJECT_ROOT, "dist", "src", "index.js");

// Windows ESM loader 需要 file:// URL
const fileImport = (rel) => {
  const abs = join(PROJECT_ROOT, "dist", rel);
  return import(pathToFileURL(abs).href);
};

// ---- 加载 .bridge.env(权威源,覆盖 process.env) ----
const ENV_FILE = join(__dirname, ".bridge.env");
const VERBOSE = process.env.AGENT_RECALL_VERBOSE === "1";

if (process.env.AGENT_RECALL_BRIDGE_ENV_FILE) {
  loadEnvFile(process.env.AGENT_RECALL_BRIDGE_ENV_FILE);
} else if (existsSync(ENV_FILE)) {
  loadEnvFile(ENV_FILE);
}

function loadEnvFile(path) {
  try {
    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw);
    for (const [k, v] of Object.entries(data)) {
      process.env[k] = String(v);
    }
    if (VERBOSE) console.error(`[http-bridge] loaded env from ${path} (${Object.keys(data).length} keys)`);
  } catch (e) {
    console.error(`[http-bridge] failed to load env from ${path}: ${e.message}`);
  }
}

// 命令行 port 优先, 然后 process.env(已被 .env 覆盖), 最后默认
const PORT = Number.parseInt(
  process.argv[2] ?? process.env.MCP_HTTP_PORT ?? "7777",
  10
);

// ---- 加载已构建的 service factory ----
const indexModule = await import(pathToFileURL(DIST_INDEX).href);
const createService = indexModule.createService;

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
  const capMod = await fileImport("src/admin/capability.js");
  capabilityStore = new capMod.CapabilityStore(dataHome, { persistent: true });
  if (!capabilityStore.hasCapability()) {
    console.error(
      `[http-bridge] AGENT_RECALL_PROFILE=admin requires a valid operator capability. ` +
      `Run \`agent-recall admin grant\` first.`
    );
    process.exit(1);
  }
}

const service = createService(dataHome, { capabilityStore }, profile);
console.error(
  `[http-bridge] service ready: home=${dataHome} profile=${profile} actor=${actor}`
);

// ---- 工具注册 ----
const toolsModule = await fileImport("src/tools/register-tools.js");
const registerFn = profile === "core" ? toolsModule.registerCoreTools : toolsModule.registerExtendedTools;

// 资源注册相关模块(预先 await 一次)
const resourcesMod = await fileImport("src/mcp/resources.js");
const defaultActorMod = await fileImport("src/actor.js");
const scopeMod = await fileImport("src/scope-resolver.js");
const authMod = await fileImport("src/services/auth-context.js");

const defaultActor = defaultActorMod.resolveActor(undefined);
const identityResolver = new scopeMod.ProjectIdentityResolver(service.store, defaultActor);
const authorization = authMod.resolveAuthorization(
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
  resourcesMod.registerMemoryResources(server, {
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
        ? Array.from(toolsModule.CORE_TOOL_NAMES)
        : Array.from(toolsModule.memoryToolNames);
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
httpServer.listen(PORT, "127.0.0.1", () => {
  console.error(
    `[http-bridge] listening on http://127.0.0.1:${PORT}\n` +
    `  transport:  streamable-http (MCP 2025-03-26)\n` +
    `  home:       ${dataHome}\n` +
    `  profile:    ${profile}\n` +
    `  actor:      ${actor}\n` +
    `  endpoints:  POST /mcp, GET /mcp, DELETE /mcp, GET /health, GET /info, GET /tools`
  );
});

httpServer.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`[http-bridge] port ${PORT} already in use; exiting`);
    process.exit(0);
  } else {
    console.error(`[http-bridge] server error:`, err);
    process.exit(1);
  }
});

process.on("SIGINT", () => { httpServer.close(); process.exit(0); });
process.on("SIGTERM", () => { httpServer.close(); process.exit(0); });
