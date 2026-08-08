# Bun 单文件二进制分发

> 本文档是 `docs/guides/bun-distribution.md` 的中文版本。**当前实现版本：v1.1.5**。

Bun 分发路径是**附加的**分发渠道。Node 的 npm 包（`agent-recall`）仍然是主路径。Bun 二进制面向需要单文件 drop-in、且能接受较小覆盖面的运维者（已做 smoke 测试，但未跑完整 vitest）。

## 前置条件

- **构建主机**：PATH 上需有 Bun ≥ 1.3.0（`bun --version`）。
- **消费主机**：无。Bun 二进制是自包含的。

## 构建

```bash
npm run build:bun
```

脚本会为每个正式平台（`linux-x64`、`darwin-x64`、`darwin-arm64`、`win32-x64`）在 `dist-bin/` 下写出 `agent-recall-<plat>[.exe]` 和 `agent-recall-mcp-<plat>[.exe]`，并生成 `dist-bin/MANIFEST.json`（含每个二进制的 SHA-256）。

脚本在任何工作前会断言 `bun --version >= 1.3.0`，若主机 Bun 版本过老会以清晰消息退出非零。

## 安装

从对应版本 GitHub Release 中挑选适配消费端平台的二进制。对照 Release 的 `MANIFEST.json` 校验 SHA-256，然后放入 `PATH`：

```bash
# linux-x64 示例
curl -L -o agent-recall https://github.com/xurunxin/AgentRecall/releases/download/v1.1.5/agent-recall-linux-x64
curl -L -o MANIFEST.json https://github.com/xurunxin/AgentRecall/releases/download/v1.1.5/MANIFEST.json
sha256sum -c <(jq -r '.entries[] | select(.platform=="linux-x64" and .kind=="cli") | "agent-recall  " + .sha256' MANIFEST.json)
chmod +x agent-recall
sudo mv agent-recall /usr/local/bin/agent-recall
```

MCP 服务二进制走相同配方（`agent-recall-mcp-<plat>`）。

## Smoke 测试

```bash
npm run smoke:bun
```

针对主机平台二进制跑 7 步 smoke（`--version`、`help`、`doctor`、export+import 往返、`backup`、备份后 `doctor`、HTTP daemon 端到端 probe）。全部通过退出 0；任一失败输出 `[smoke_failed]`。二进制缺失时干净跳过。HTTP probe 见下一节。

## 共享 HTTP daemon

v1.1.5 起，agent-recall 二进制新增 `agent-recall --http` 模式：启动一个本地 HTTP 守护进程，多个 HTTP 客户端（HTTP-capable agent、Bun 友好的子代理）通过 Bearer token 共享同一进程、同一 `MemoryService`、同一 SQLite 连接，按 MCP 会话隔离 actor。该模式专门解决多 agent 客户端各自 spawn stdio 进程造成的资源膨胀问题（同一 host 跑几十个 idle stdio 子进程）；stdio 路径继续保留（v1.1.4 的 `server-lifecycle` 合同不变），并新增了 stdio 空闲退出（见 `AGENT_RECALL_STDIO_IDLE_MS`）。

> **重要**：`agent-recall-mcp --http` **不会**进入 HTTP 模式。兼容名 `agent-recall-mcp` 始终是 stdio（v1.1.4 的 dispatch 合同不变，`--http` 与 `AGENT_RECALL_MCP_TRANSPORT` 都被忽略）。HTTP 模式只能从 `agent-recall` 进入。

### 启动

```bash
agent-recall --http
```

也可通过环境变量软切换（`agent-recall` 收到 `AGENT_RECALL_MCP_TRANSPORT=http` 时等价于 `--http`；其它取值如 `HTTP` / `stdio` 不触发）：

```bash
AGENT_RECALL_MCP_TRANSPORT=http agent-recall list
```

`agent-recall` 没有 `--http`、没有 `AGENT_RECALL_MCP_TRANSPORT=http` 时仍按 v1.1.5 默认行为走（无参数 → stdio，`<subcommand>` → CLI）。

### 环境变量

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `AGENT_RECALL_HTTP_HOST` | `127.0.0.1` | 守护进程绑定接口。保持 `127.0.0.1`；公网接口无鉴权兜底，禁止放开。 |
| `AGENT_RECALL_HTTP_PORT` | `7777` | 监听端口。设 `0` 想让 OS 分配端口（**当前不支持**，见下方“已知限制”）。 |
| `AGENT_RECALL_HTTP_ALLOWED_ORIGINS` | （空） | 逗号分隔的浏览器 origin 白名单（例：`http://localhost:5173`）。空时只接受无 `Origin` 头的非浏览器客户端。 |
| `AGENT_RECALL_HTTP_VERBOSE` | （关） | 设为 `1` 在 stderr 打 `[mcp-http] …` 诊断行（启动 / 关停 / handler 错误）。生产环境保持关闭。 |
| `AGENT_RECALL_MCP_TRANSPORT` | （未设置） | `agent-recall` 收到值 `http` 时走 HTTP；其它值不触发。 |
| `AGENT_RECALL_PROFILE` | `core` | 决定注册的 MCP 工具集。`admin` 还需要本机 `admin.cap` capability；缺则 daemon 启动失败并以非零退出。 |
| `AGENT_RECALL_HOME` | 平台默认 | 数据根目录；lockfile 与 SQLite 都位于其下。 |
| `AGENT_RECALL_STDIO_IDLE_MS` | `600000`（10 min） | **stdio 端**空闲退出阈值（无 MCP 消息且无 in-flight 请求持续 N ms 后退出），沿用 `server-lifecycle` 的 1.5 s 上限 + 二次信号逃生。设为 `0` 关闭。HTTP 模式不读此变量。 |

### 锁文件与 token

启动时 launcher 调用 `acquireOrJoin`：

- 锁文件路径：`${AGENT_RECALL_HOME}/.mcp-${AGENT_RECALL_PROFILE}.lock`。
- 首次启动：`fs.open('wx')` 原子建锁，写入 JSON 负载：
  ```json
  {
    "pid": 12345,
    "endpoint": "http://127.0.0.1:7777/mcp",
    "transport": "tcp",
    "token": "<64 hex chars; 32 raw bytes>",
    "started_at": "2026-08-08T...",
    "version": "1.1.5",
    "data_home": "...",
    "profile": "core"
  }
  ```
- 已有锁：检查 `pid` 是否存活 + 端口 TCP 探活；任一失败即 unlink 旧锁并接管。
- Token 长度 64 hex 字符（32 字节随机；与 `admin.cap` 同熵预算）。POSIX 上文件 mode 紧到 `0o600`。
- **同进程内同 `pid` 重复调用会 join**（返回现有 endpoint + token），不会重写。

客户端**必须**在 HTTP 请求中带上 token 作为 Bearer：

```
Authorization: Bearer <64 hex chars>
```

### 客户端连接

每个 MCP 客户端必须满足：

1. 必带 `Authorization: Bearer <token>`；不带 → 401 + `WWW-Authenticate: Bearer`。
2. 必带 `Accept: application/json, text/event-stream`；不带 → SDK 在 pre-flight 阶段直接 406（`Not Acceptable: Client must accept both application/json and text/event-stream`）。
3. `Content-Type: application/json`。
4. **首次 `initialize` 请求**的 `params` 字段**必须**包含 `actor`（缺 → 400 `missing_actor`；结构非法 → 400 `invalid_actor`）：
   ```json
   {
     "jsonrpc": "2.0",
     "id": 1,
     "method": "initialize",
     "params": {
       "protocolVersion": "2025-03-26",
       "capabilities": {},
       "clientInfo": { "name": "my-agent", "version": "0.1.0" },
       "actor": { "kind": "agent", "id": "my-agent-001" }
     }
   }
   ```
   `actor.kind` 必须是 `"agent"` / `"user"` / `"service"` 之一；`actor.id` 为非空字符串。`actor` 一旦登记到 session，后续请求不可更改（spec § actor 锁定）。
5. `initialize` 响应带 `mcp-session-id` 头；后续 POST 必须回带该头，DELETE 带 `mcp-session-id` 关闭会话。

Node / Bun `fetch` 最小示例（取 token 后）：

```ts
const res = await fetch(endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "demo", version: "0" },
      actor: { kind: "agent", id: "demo" },
    },
  }),
});
const sessionId = res.headers.get("mcp-session-id");
// 后续 tools/list / tools/call 回带 mcp-session-id
```

`scripts/smoke-bun-binary.mjs` 步骤 7 是端到端参考实现：spawn `agent-recall --http`、等 lockfile 出现、读 `endpoint`+`token`、发 `initialize`（带 actor）、捕获 `mcp-session-id`、发 `tools/list` 验证 per-session `McpServer`（Task 11 修复）、SIGTERM 关停、清理临时 `AGENT_RECALL_HOME`。

### 已知限制（v1.1.5 推迟项）

- **lockfile 不在干净退出时 unlink**。守护进程在 shutdown 序列末尾调用 `process.exit(0)`，绕过 launcher 包裹 `runHttpServer` 的 `try/finally release()` 块。下次启动的 `acquireOrJoin` 通过 pid 探活 + 端口探活自动回收旧锁；新守护进程接管，token 轮换。
- **OS-assigned 端口（`port=0`）不支持**。lockfile 的 `endpoint` 写入的是 `AGENT_RECALL_HTTP_PORT` 的请求值，**不会**反映实际绑定的端口；客户端按请求值连不上。生产环境固定端口即可。
- **网络盘 data home**。spec 规划在 lockfile 父目录命中 NFS / SMB 时打印 stderr 警告（不强制退化），v1.1.5 尚未实装。届时把 `AGENT_RECALL_HOME` 放在本机文件系统是更稳的选择（当前实现未做软检查，提前规避即可）。

## 能力矩阵

| 能力 | Node 二进制 | Bun 二进制 |
| --- | --- | --- |
| `--version` / `help` / `doctor` | 是 | 是（已 smoke） |
| `list` / `show` / `search` / `audit` | 是 | 是（已 smoke） |
| `export` / `import` | 是 | 是（已 smoke） |
| `backup` / `restore` | 是 | 是（已 smoke） |
| `migrate --yes` | 是 | 是（Node 测试覆盖；Bun 运行期未直接跑） |
| `admin grant/status/revoke` | 是 | 是（已 smoke） |
| MCP stdio（10/20 工具） | 是 | 是（同一份 `dist/src/index.js` + Bun 运行期） |
| MCP stdio 空闲退出（`AGENT_RECALL_STDIO_IDLE_MS`，默认 10 min，`0` 关闭；v1.1.5） | 是 | 是 |
| 共享 HTTP daemon（`agent-recall --http`，Bearer + per-session actor；v1.1.5） | 是 | 是（已 smoke 步骤 7） |
| 全部 24 项 `doctor` 检查 | 是（Node 上 vitest） | Bun 上 smoke（3 + 6） |
| `AGENT_RECALL_HOME` 环境变量 | 是 | 是 |
| `AGENT_RECALL_PROFILE` 环境变量 | 是 | 是 |
| `AGENT_RECALL_HTTP_HOST` / `AGENT_RECALL_HTTP_PORT` 环境变量（v1.1.5） | 是 | 是 |
| `AGENT_RECALL_HTTP_ALLOWED_ORIGINS` 环境变量（v1.1.5） | 是 | 是 |
| `AGENT_RECALL_HTTP_VERBOSE` 环境变量（v1.1.5，HTTP 诊断 stderr 日志） | 是 | 是 |
| `AGENT_RECALL_MCP_TRANSPORT` 环境变量（v1.1.5，`http` 软切换） | 是 | 是 |
| `AGENT_RECALL_VERBOSE_STDIO` 环境变量（v1.1.4） | 是 | 是 |

> v1.1.4 起的 MCP 优雅退出（`src/mcp/server-lifecycle.ts`）保证 Bun 二进制在 stdin EOF 或收到终止信号后干净退出，`AGENT_RECALL_VERBOSE_STDIO=1` 时会在 stderr 输出原因行。
>
> v1.1.5 的 stdio 空闲退出复用同一 `server-lifecycle` 通道（`AGENT_RECALL_STDIO_IDLE_MS=0` 关闭），HTTP 模式另有 `AGENT_RECALL_HTTP_VERBOSE=1` 门控的 `[mcp-http] …` 诊断行。详见上一节。

## 发布渠道

Bun 二进制是 GitHub Release 产物，**不是** npm 产物。npm 包继续只发 Node 路径。理由：

- 保持 npm 包体积不变。
- 保持 `package.json` `bin` 简单（不需要 platform-matrix postinstall）。
- 解耦 Bun 二进制发布与 npm publish 节奏——Bun 二进制可以提前于、伴随或独立于 npm 发布。

消费 `dist-bin/MANIFEST.json` 的发布流水线由后续 ADR（`docs/adr/0007-bun-binary-release.md`）规定，不在本文档范围内。
