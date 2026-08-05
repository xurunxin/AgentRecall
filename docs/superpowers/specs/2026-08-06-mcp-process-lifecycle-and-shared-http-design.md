# MCP 进程生命周期与共享服务 — 设计规范

> 日期：2026-08-06
> 状态：待用户复核
> 作者：brainstorming 工作流

## 背景与问题

`agent-recall-mcp` 的 Bun 打包二进制在两类 agent 客户端中暴露了两个问题：

1. **stdio 端残留进程**。现有 `src/mcp/server-lifecycle.ts` 已实现 `stdin end/close`、
   `SIGINT/SIGTERM` 的优雅退出，但 MCP SDK 1.29.0 的 `StdioServerTransport`
   不会主动观察 `end`/`close`（见 `node_modules/.../esm/server/stdio.js:26-33`）。
   当宿主 agent 持续持有 stdio 管道、子 agent 任务完成后又不主动关闭时，
   stdio 进程会无限期驻留。多次子代理并行启动就导致同机出现数十个 idle 进程，
   占用内存与文件句柄。

2. **多 agent 进程膨胀**。当若干子代理都需要 MCP 服务时，常见部署是每个
   客户端独立 spawn 一份 stdio 进程，互不通信、各自持有独立的 SQLite 连接
   与 in-memory capability token，既不共享负载，也不利于审计归因。

## 目标

在不引入新 npm 依赖、不拆分 Bun 工件、不修改 `MemoryService` 三件套边界的前提下：

- **stdio 端**：在“无 MCP 消息、无进行中请求”持续 10 分钟后自动退出。
  通过 `AGENT_RECALL_STDIO_IDLE_MS` 控制（默认 `600_000`，`0` 关闭，
  保持向后兼容）。
- **共享 HTTP 端**：HTTP-capable 的 agent 通过本地 HTTP daemon 复用同一进程、
  同一 `MemoryService`、同一 SQLite 连接；多客户端按 MCP 会话隔离 actor，
  共享工具与资源。
- **共享安全**：仅本机访问；启停通过基于 `${AGENT_RECALL_HOME}/.mcp-<profile>.lock`
  的 lockfile 协调；HTTP 端采用 Bearer Token + Host/Origin 校验。

## 非目标

- 不引入外部 HTTP 框架、OAuth、分布式追踪、进程守护器（systemd/launchd）。
- 不拆分 `MemoryService`；read/write/maintenance 子服务职责不变。
- 不改变 SQLite 仓库（`src/sqlite-store.ts`）的 schema、版本或并发模型。
- 不增加 `package.json` `bin` 数量；Bun 工件清单保持 `cli` / `mcp` 两类。
- 不重写现有 `StdioServerTransport` 路径的 stdio 实现；仅扩展其空闲退出能力。

## 架构总览

```
┌────────────────────────────── 同一 host, 同一 data_home/profile ──────────────────────────────┐
│                                                                                              │
│   stdio 客户端 (子 agent A1)              stdio 客户端 (子 agent A2)                            │
│   ┌──────────────────────┐                ┌──────────────────────┐                            │
│   │ agent-recall-mcp …  │                │ agent-recall-mcp …  │                                │
│   │ (stdio mode)        │                │ (stdio mode)        │                                │
│   └────┬─────── idle timer (10m)         └────┬─────── idle timer (10m)                            │
│        │ stdin EOF / SIGTERM                │ stdin EOF / SIGTERM                                │
│        ▼                                    ▼                                                    │
│   ┌────────────┐                       ┌────────────┐                                          │
│   │ process    │                       │ process    │                                          │
│   │ exit(0)    │                       │ exit(0)    │                                          │
│   └────────────┘                       └────────────┘                                          │
│                                                                                              │
│   HTTP 客户端 (B1, B2, …) → 127.0.0.1:port  + Bearer token                                      │
│                                          │                                                     │
│                                          ▼                                                     │
│   ┌──────────────────────────── 共享 HTTP daemon ────────────────────────────┐               │
│   │ launcher probe-then-join-then-start                                          │               │
│   │  ┌──────────────────────────────────────────────────────┐                    │               │
│   │  │ node:http 监听 (或 Bun.serve)                         │                    │               │
│   │  │  路由: POST/GET/DELETE  by Mcp-Session-Id              │                    │               │
│   │  │  Host/Origin 校验 + Bearer token                       │                    │               │
│   │  └─────────────┬────────────────────────────────────────┘                    │               │
│   │                │  按会话分配 transport                                       │               │
│   │   session map: Map<sessionId, {transport, actor, sessionSecret}>             │               │
│   │                ▼                                                           │               │
│   │   ┌──────────────────────────────────────────────────────┐                    │               │
│   │   │ 一个 McpServer (进程级)                                │                    │               │
│   │   │   tools = registerCore|registerExtended              │                    │               │
│   │   │   resources = registerMemoryResources               │                    │               │
│   │   └────────────────────┬─────────────────────────────────┘                    │               │
│   │                        ▼                                                   │               │
│   │   一个 MemoryService (data_home + profile 锁)                                 │               │
│   │   └─ read / write / maintenance 子服务                                       │               │
│   │   └─ SQLite (WAL, busy_timeout=5000)                                          │               │
│   └──────────────────────────────────────────────────────────┘                    │               │
│                                                                                              │
│   锁文件: ${AGENT_RECALL_HOME}/.mcp-<profile>.lock  (JSON)                                     │
│   {pid, endpoint, transport:"tcp", token, started_at, version, data_home}                    │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 组件

### 新增

- `src/mcp/idle-timer.ts` — stdio 端空闲计时器。导出
  `startIdleTimer({stdin, idleMs, isMessageInFlight, trigger, logger})`，
  在每次 `stdin` `data` 事件重置；`isMessageInFlight()` 为真时挂起计时；
  `0` 表示禁用。`arm()` / `disarm()` 便于测试与关停。
- `src/mcp/http-server.ts` — 共享 HTTP daemon 入口。
  `runHttpServer({memoryService, identityResolver, dataHome, defaultActor,
  capabilityStore, activeProfile, authorization, bind: {host, port}})`。
  内部构建一个 `McpServer`，按 profile 注册 `core`/`extended` 工具与
  `registerMemoryResources`，挂载 `node:http`（Node）或 `Bun.serve`（Bun runtime）
  路由，校验 `Host`/`Origin`/Bearer，登记 `StreamableHTTPServerTransport`
  会话映射，调用 `installServerLifecycle({server, transport: undefined,
  onShutdown, onShutdownError, onShutdownStart, shutdownTimeoutMs: 1500})`。
- `src/mcp/http-transport.ts` — 会话层封装。`onSessionInit` → 新建 transport →
  注入 actor → `server.connect(transport)`；`onSessionClose` / `DELETE` →
  `transport.close()` → 从 map 移除。会话过期由“客户端发 DELETE + 进程退出”
  保证，不引入额外计时器。
- `src/mcp/auth.ts` — Bearer + Host/Origin 校验；
  `validateRequest({req, expectedToken, allowedHosts, allowedOrigins})` 抛
  `HttpError(401|403)`。Token 存于锁文件；启动时若锁文件缺 token 则生成
  32 字节随机十六进制，写回磁盘 `0600` (POSIX) / owner ACL (Windows)。
- `src/mcp/daemon-lock.ts` —
  `acquireOrJoin({dataHome, profile, buildEndpoint})`。
  `fs.open(lockPath, 'wx')` 原子建锁；冲突时读取并 `process.kill(pid, 0)` 探活
  + 连接探测（短超时 250 ms）。`release()` 关闭时按 `pid` 校验后 `fs.unlink`。
  返回 `{joined: boolean, endpoint: string, token: string}`。
- `src/launcher.ts` 扩展 — 新增 `--http` 标志 +
  `AGENT_RECALL_MCP_TRANSPORT=http|stdio` 软覆盖；HTTP 分支先 `acquireOrJoin`：
  存在且活则打 endpoint 退出 0；否则 `runHttpServer`。
  stdio 分支在 `installServerLifecycle` 后挂 `startIdleTimer`，
  由 `AGENT_RECALL_STDIO_IDLE_MS`（默认 `600_000`）控制。
- `src/mcp/server-lifecycle.ts` 扩展 — `ServerLifecycleOptions` 新增
  `isMessageInFlight?: () => boolean`（stdio 用）与 `idleTimeoutMs?: number`；
  `ShutdownReason` 新增 `"stdio_idle_timeout"`。idle 退出通过现有 `shutdown()`
  路径复用 1.5 s 上限与二次信号逃生。

### 保持不变

- `src/memory-service.ts`、`src/services/` 子服务、SQLite 仓库（`src/sqlite-store.ts`）
  零改动。
- `scripts/build-bun-binary.mjs`：无需新增工件；HTTP 路径与 stdio 共用同一
  `agent-recall-mcp` 二进制。

## 数据流

### stdio（一次连接一进程）

```
client → spawn exe → launcher decideMode("mcp", []) → main()
   ↓
createService(dataHome, profile) → new McpServer → registerCore|registerTools
   ↓
new StdioServerTransport → server.connect(transport)  // MCP 上线
   ↓
installServerLifecycle({server, transport, onShutdown: store.close, …})
   ↓
startIdleTimer({stdin, idleMs, isMessageInFlight, trigger: shutdown})
   - 每次 stdin.on("data") 触发 reset()
   - 每次 McpServer 收到 request → inFlight++；响应结束 --inFlight
   - idleMs 计时器到期 + isMessageInFlight()===false → runShutdown("stdio_idle_timeout")
   ↓
[ stdio EOF / 信号 / idle ] → runShutdown → transport.close → server.close → store.close → exit(0)
```

### HTTP（共享 daemon）

```
client B1 → spawn launcher --http  （或同进程复用）
   ↓
decideMode → mcp + http flag → acquireOrJoin({dataHome, profile, buildEndpoint})
   ├─ 锁存在 & pid 活 & 探活 OK → 打印 endpoint+token，exit 0（fork-join 路径）
   └─ 锁存在但 pid 死 / 探活失败 → fs.unlink 旧锁 → fs.open('wx') 写新锁 → runHttpServer
   ↓
runHttpServer:
   创建 McpServer（profile 工具 + resources）+ 一份 MemoryService
   ↓
   bind 127.0.0.1:<port>（port=0 随机；优先用锁文件里的旧 port）
   ↓
   启动 node:http.Server：
     • 任何 /mcp 请求 → validateRequest (Host/Origin/Bearer)
     • POST 无 session → 新建 StreamableHTTPServerTransport(sessionIdGenerator, dns-rebinding-on, allowedHosts/Origins, onsessioninitialized, onsessionclosed)
        → transport.start()，解析 initialize.params.actor，登记 map<sessionId, {transport, actor}>
        → server.connect(transport)
     • POST 带 session → 路由已有 transport
     • DELETE → transport.close()，从 map 移除
   ↓
   installServerLifecycle({server, transport: undefined, onShutdown: store.close, …})
   ↓
   写锁文件 fs.writeFile：{pid, endpoint, token, transport:"tcp", started_at, version, data_home, profile}
   ↓
   [ SIGINT / SIGTERM ] → runShutdown 路径（1.5s ceiling + 二次信号逃生）：
     - http.Server.close() 拒绝新连接
     - 遍历会话 map → 并发 await transport.close()（受 1500ms 上限 race）
     - server.close()
     - onShutdown (store.close)
     - fs.unlink 锁文件
     - exit(0) / exit(1)
```

### 客户端重连（HTTP）

```
client B2 → launcher decideMode → acquireOrJoin
   ↓
读锁 → 拿 token → 端口 TCP 连接 → 带 Authorization: Bearer <token>
   ↓
首次 initialize：
   - 校验 token ✓
   - 在 initialize.params 中读取 actor 字段（结构化：{ kind: "agent", id: "claude-code" }）
   - 创建 transport，会话级 actor 锁定（后续请求不可变）
   ↓
tools/call、resources/read → server 内部走 RequestContext（注入 sessionId + actor）
   ↓
所有写操作通过 MemoryWriteService.authorize() 命中 SQL 边界（沿用现有 sensitivity 过滤）
```

## 错误处理

| 失败点 | 行为 | 用户/宿主感知 |
| --- | --- | --- |
| 锁文件存在但 PID 死 / 探活失败 | 旧锁 unlink + 写新锁；网络盘路径会 stderr 警告（见下方行），不强制退化 | HTTP 启动延迟 ≤ 300 ms |
| 双客户端同时启动 | `fs.open('wx')` 原子失败 → 后者读取后 join winner；winner 未写完 endpoint 时 250 ms 重试 ≤ 3 次 | 后启动者 join 成功，stdout 打印现有 endpoint |
| Bearer token 不匹配 | 401 + `WWW-Authenticate: Bearer`；不暴露 reason | 客户端以非零退出，提示鉴权失败 |
| Host/Origin 不在白名单 | 403 + 不写日志（防止侧信道）；`enableDnsRebindingProtection=true` | 客户端返回 transport 错误 |
| MCP `initialize` 缺 `actor` | 400 + 关闭 transport（不入 map） | 客户端知道缺少 actor 字段 |
| 会话级 actor 跨请求改动 | 关闭 transport + 从 map 移除（actor 锁定） | 客户端需新建会话 |
| `admin` profile 启动但无 capability | 与 stdio 路径同样在 `src/index.ts` 之前 fail-close：stderr 输出固定提示，`process.exitCode=1` | 同今天 stdio 行为 |
| shutdown 序列 > 1500 ms | `onShutdownError` stderr 输出（沿用 verbose gate）+ `exit(1)` | 宿主 reap |
| shutdown 中收到第二次 SIGINT/SIGTERM | `exit(1)` 立即逃生（沿用现有 escape） | 立即 reap |
| 锁目录只读 / 满盘 | stderr 一行 hint + HTTP 失败回退到 stdio（launcher 在 `acquireOrJoin` 抛 `EACCES/ENOSPC` 时回退） | 用户看到“degraded to stdio” |
| `AGENT_RECALL_PROFILE` 不一致（lock 上 vs 环境） | 拒绝启动：HTTP daemon 已存在并绑定其它 profile | 客户端需显式 `--http` 不同端口或先关闭 |
| sqlite-store `BEGIN IMMEDIATE` 超时（> 5s） | 沿用 `runWithBusyRetry` + audit；不杀进程 | 调用方收到超时错误 |
| HTTP 路由层异常 | 走 SDK 自带 `transport.onerror`；最外层 `try/catch` 落 500 + stderr hint | 客户端收到 RPC 错误 |
| `data_home` 是 NFS/网络盘 | 启动期软检查 `fs.lstat` lock 父目录，命中远端盘时 stderr 警告并继续（不强制退化，文档承担主要解释责任） | 文档承担主要解释责任 |

verbose reason log 继续以 `AGENT_RECALL_VERBOSE_STDIO=1` 走 stderr。HTTP 模式
额外要求 `AGENT_RECALL_HTTP_VERBOSE=1` 才打 `[mcp-http] …` 行为日志，
遵守“stdout 仅为 JSON-RPC”。

## 测试

### 单元（`test/unit/`）

- `idle-timer.test.ts` — 新建。覆盖：
  1. `idleMs=0` 永不触发（保证向后兼容）。
  2. `data` 事件重置计时器，不触发 shutdown。
  3. `isMessageInFlight()` 返回真时计时器挂起。
  4. 到期触发 `shutdown("stdio_idle_timeout")`，与手动 `handle.shutdown` 等价。
  5. `uninstall()` 后计时器不再触发。
- `daemon-lock.test.ts` — 新建。覆盖：
  1. 无锁时 `acquireOrJoin` 成功，文件存在、内容可解析。
  2. 同 `pid` 仍活 → `joined: true` + 返回旧 endpoint/token。
  3. 不同 `pid` 但 `process.kill(pid,0)` 抛 `ESRCH` → 回收旧锁、写新锁。
  4. 锁文件损坏 → 视为无锁、回退重写。
  5. `release()` 删除锁，幂等。
- `auth.test.ts` — 新建。覆盖：token 匹配 / 不匹配、Host/Origin 命中 /
  不命中、`/mcp` 之外路径不强制 token。
- `mcp-server-lifecycle.test.ts` 扩展 — 新增两条 case：
  1. `idleTimeoutMs` + `isMessageInFlight()` 触发 `"stdio_idle_timeout"`。
  2. `idleTimeoutMs=0` 仍保持“安静不退出”回归。

### 黑盒（`test/blackbox/`）

- `mcp-stdio-idle.test.ts` — 新建。spawn `dist/src/index.js`：
  1. `AGENT_RECALL_STDIO_IDLE_MS=500` 无任何 stdin 流量，child 在 ≤ 2.5 s 内
     `close` 且 `code===0`，stderr 含 `stdio_idle_timeout`。
  2. 同样 `idleMs=500` 但在 250 ms 注入空行（`\n`），进程存活 ≥ 2.5 s。
  3. `AGENT_RECALL_STDIO_IDLE_MS=0` 安静 stdin 持续 2.5 s 仍存活（回归）。
- `mcp-http-share.test.ts` — 新建。spawn `--http`：
  1. child 监听 127.0.0.1，stdout 写 endpoint + token（用 `AGENT_RECALL_HTTP_VERBOSE=1`）。
  2. 第二个 launcher 启动后 ≤ 500 ms `exit 0` 并打 join 提示；端点同第一个。
  3. 两个 `StreamableHttpClientTransport` 连同一 daemon；`tools/list` 各自成功；
     `remember` 写入后另一会话 `get_memory` 可见。
  4. 杀 daemon (SIGKILL) → 锁文件存在但 PID 死 → 第三次启动重新 bind 成功
     并在 2 s 内 serve。
  5. Bearer 缺失 / 错 → 401。
  6. `admin` profile 缺 capability → daemon 启动失败、非零退出。

### Bun 烟测

- `scripts/smoke-bun-binary.mjs` 加一步 `--http` 启动 + 500 ms 内 `tools/list`；
  失败 `[smoke_failed]`。

### 验证标准

- `npm run test`（含 unit / blackbox 默认集）全绿。
- `npm run smoke:bun` 通过。
- 手动检查 `git status` 仅包含本规范列出的新增/修改文件 + 重建产物。

## 风险与回滚

- **PID 复用**：Windows 上 `process.kill(pid, 0)` 不可靠；通过连接探测 +
  短超时 + 锁文件内容校验做兜底。
- **network share data home**：文档明确禁止；启动期做软检查 + 警告。
- **Bun 编译 HTTP 路径**：在 `scripts/smoke-bun-binary.mjs` 加
  `--http` 步骤，确保单文件 Bun 工件在 Node + Bun 双 runtime 下都可启动。
- **per-session actor 注入**：与现有 `MemoryWriteService.authorize` 的
  SQL 边界保持一致；新增 `RequestContext` 扩展，actor 字段随会话生命周期
  不可变。
- **HTTP 端 transport 关停**：HTTP 模式不把 per-session `transport` 透传
  给 `server-lifecycle`；session 关闭在 HTTP 路由层完成，lifecycle 只负责
  daemon 级收尾。
- **回滚**：规范内每一组件都支持独立 PR 撤销；`AGENT_RECALL_STDIO_IDLE_MS=0`
  与 `--http` 关闭都对应原行为。

## 后续

- 计划阶段：进入 `writing-plans` skill，产出按 PR 切分的实施计划。
- 文档：`docs/zh-CN/guides/bun-distribution.md` 与
  `docs/guides/bun-distribution.md` 各加一节“共享 HTTP daemon”。
- 发布：仍以 `agent-recall-mcp-<plat>` 单一二进制分发；不在 npm 增加 `bin`。
