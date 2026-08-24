# AgentRecall Admin (Tauri 桌面应用) — 设计规范

> 日期：2026-08-24
> 状态：草案（待用户复核）
> 修订：—
> 作者：brainstorming 工作流（许润鑫 × Mavis）
> 关联 issue：—

> 🌏 语言 / Language: 中文。English: [agent-recall-admin-design.en.md]

## 背景与问题

AgentRecall 是一个本地优先的 MCP 记忆服务（v1.1.6，commit `c4b373a`），核心是
SQLite 真相源 + `MemoryService` 三层门面（`MemoryReadService` /
`MemoryWriteService` / `MemoryMaintenanceService`）。v1.1.3 在
"零新依赖、零行为回归" 原则下完成了 capability、sensitivity、evidence
契约，**但目前没有任何 GUI 入口**：

- 用户只能通过 MCP 客户端（Claude Desktop、Cursor、opencode-plugin）调用
  `remember` / `list_memories` / `search_memories` / `get_memory` 等工具
- 记忆之间的关系（supersede、merge、同 topic、同 project）只能通过
  `search` 的文本结果间接感知,没有"看全貌"的可视化手段
- 服务管理（启停、doctor、备份、配置）只能通过 CLI（`bin/agent-recall.ts`），
  跨平台用户体验不一致

需求方希望补一个**桌面 GUI 应用**作为：

1. **记忆可视化**：以知识图谱方式展示 memory 节点 + 关系边
2. **项目管理工具**：覆盖记忆 CRUD + 服务管理 + 备份/导入

## 目标

交付一个 **Tauri 2.0 桌面应用** `agent-recall-admin`，作为 AgentRecall 的
GUI 前端：

- **零侵入**：`src/`、`bin/`、`dist/`、`test/` 一行不动；现有 npm 发版流程
  不断；新功能用 monorepo 子包形式承载
- **双通道数据访问**：读走 Rust 直读 SQLite，写走 MCP stdio 复用现有治理
- **三阶段交付**：v0.1 graph 只读 + monorepo 骨架 → v0.2 记忆 CRUD →
  v0.3 服务管理 + 备份/导入

## 范围

### 在范围内

- Tauri 2.0 应用：`apps/admin/`
- 共享类型 / schema 包：`packages/contracts/`
- 仓库根 monorepo 化（`pnpm-workspace.yaml` + 根 `package.json` 加
  `workspaces` 字段）
- graph 视图：节点 = memory，边 = supersede / merge / co_topic / co_scope
- 记忆 CRUD：list / get / create / update / forget / merge / supersede
- 服务管理：stdIO MCP 子进程启停、doctor 报告、日志查看
- 备份/导入：列出 `data-home/agent-recall/backups/`、立即备份、导入
- 实时性：5s 轮询 SQLite mtime，变化时广播 `db:changed` 事件
- 跨平台：Windows / macOS / Linux 桌面（v0.3 验证）

### 不在范围内

- 实时协作（多用户同时编辑）
- Tauri 应用内的 SQL 查询控制台
- 跨 data-home 多实例切换
- Tauri 应用内的 agent 推理 / RAG
- 移动端（iOS / Android）
- 自动更新 / 升级检查
- Tauri 应用签名 / 公证（v0.1 / v0.2 走"开发版",v0.3 评估正式签名）
- i18n 翻译自动化（只预留,内容手写）

## 设计

### 仓库结构

```
AgentRecall/
├── apps/
│   └── admin/                          # Tauri 2.0 应用
│       ├── src-tauri/                  # Rust 后端
│       │   ├── src/
│       │   │   ├── main.rs             # 入口
│       │   │   ├── reader/             # SQLiteReader + 查询
│       │   │   ├── mcp/                # MCPClient + 子进程管理
│       │   │   ├── service/            # 服务启停、doctor、备份
│       │   │   └── commands/           # tauri::command 暴露给前端
│       │   ├── Cargo.toml
│       │   └── tauri.conf.json
│       ├── src/                        # React 前端
│       │   ├── routes/                 # /graph, /memories, /service, /backup
│       │   ├── components/             # 复用组件
│       │   ├── lib/                    # tauri invoke 封装、轮询 hook
│       │   └── App.tsx
│       ├── package.json
│       ├── tsconfig.json
│       └── vite.config.ts
├── packages/
│   └── contracts/                      # 共享 schema/类型（workspace 包）
│       ├── src/
│       │   ├── schema.ts               # zod schema: Memory, GraphNode, GraphEdge
│       │   ├── types.ts                # 派生 TypeScript 类型
│       │   ├── graph.ts                # GraphFilter, GraphResponse, EdgeKind
│       │   ├── errors.ts               # 错误码枚举
│       │   └── index.ts
│       └── package.json
├── src/                                # 现有 AgentRecall MCP 服务代码，不动
├── bin/  dist/  test/  docs/  ...      # 现有结构不动
├── package.json                        # 根：加 workspaces 字段
└── tsconfig.base.json                  # 新增：共享 TS 编译配置（可选）
```

> **注意**：AgentRecall 当前用 **npm**（无 `pnpm-lock.yaml`），不引入
> pnpm。monorepo 用 npm 原生 workspaces（Node 16+ 支持），仅根
> `package.json` 加 `workspaces` 字段，不需要额外的 `pnpm-workspace.yaml`。
> 后续若团队切到 pnpm/ bun workspaces,可平迁。

**关键约束**：

- 现有 `src/`、`bin/`、`dist/`、`test/`、`docs/` 一行不动
- 根 `package.json` 加 `"workspaces": ["apps/*", "packages/*"]`，但
  保留所有现有 scripts 不动；`files` 字段保持 `["dist","README.md",
  "LICENSE","CHANGELOG.md"]` 不动（**确保 npm publish 仍只发 dist/**）
- `packages/contracts` 通过 npm workspaces 协议
  `"agent-recall:contracts": "*"` 被 `apps/admin` 引用
- `packages/contracts` 的 schema 与 `src/domain.ts` 手工同步；CI 校验两边
  类型一致

### 数据层 — 双通道架构

```
┌──────────────────────────────┐
│   apps/admin (Tauri Shell)   │
│                              │
│  ┌─────────────┐  ┌────────┐  │
│  │ SQLiteReader│  │MCPClient│ │
│  │  (rust 侧)  │  │(rust 侧)│ │
│  └──────┬──────┘  └────┬───┘  │
└─────────┼──────────────┼──────┘
          │              │
   ┌──────▼──────┐  ┌────▼─────────────┐
   │ data-home/  │  │ child process:   │
   │ agent-recall│  │ node agent-recall│
   │   .db (RO)  │  │   (stdio, MCP)   │
   └─────────────┘  └──────────────────┘
```

**通道 A：SQLiteReader（只读）**

- 用 `rusqlite`（纯 Rust，同步）开 `data-home/agent-recall.db`，
  连接模式 `SQLITE_OPEN_READ_ONLY`
- **绝不** 执行 INSERT/UPDATE/DELETE/CREATE/DROP/ALTER
- 启动时强制读 `PRAGMA user_version` 与 `packages/contracts` 里的
  `SCHEMA_VERSION` 常量比对，不一致 → 启动失败并提示
- 暴露的 Tauri commands：
  - `get_graph(filter: GraphFilter) → GraphResponse`
  - `list_memories(filter, page, page_size) → MemoryListResponse`
  - `get_memory(id: string) → Memory`
  - `get_memory_stats() → StatsResponse`
  - `get_db_status() → { schema_version, mtime_ms, size_bytes }`

**通道 B：MCPClient（读写，走治理）**

- 用 `tokio::process::Command` 启动
  `node dist/src/launcher.js`（或 dev 模式 `tsx src/launcher.ts`）
- 自实现 stdio JSON-RPC 客户端（不引第三方 MCP 库以保持精简）：
  `initialize` → `tools/list` → `tools/call`
- 进程生命周期：
  - **懒启动**：首次写操作时启动；空闲 5 分钟自动 `kill`
  - **预热可选**：UI "启用写"按钮显式触发，避免冷启动延迟
  - **健康监测**：子进程崩了 → 标记 `mcp:unavailable` + 广播
    `mcp:status` 事件，UI 显示 banner
  - **自动重启**：最多 3 次,失败后提示用户
- 暴露的 Tauri commands：
  - `remember(payload) → { memory_id }`
  - `update_memory(payload) → { memory_id, revision }`
  - `forget_memory(id, reason) → { ok }`
  - `merge_memories(ids, replacement) → { memory_id }`
  - `supersede_memory(old_id, replacement) → { memory_id }`
  - `run_maintenance(action) → { changed, details }`
  - `start_mcp_process() / stop_mcp_process() / get_mcp_status()`

### 共享 contracts 包

`packages/contracts` 是 AgentRecall 主服务 与 Tauri 应用之间的**单一真相源**，
避免 schema 漂移。

**内容**（纯 TypeScript,只 peer dep zod）：

```ts
// packages/contracts/src/schema.ts — 镜像 src/domain.ts 的核心形状
export const MemorySchema = z.object({
  id: z.string().uuid(),
  scope: z.enum(['project', 'global']),
  project_id: z.string().nullable(),
  type: z.enum(['preference','procedure','fact','decision','lesson','debugging','constraint']),
  topic: z.string().min(1).max(180),
  title: z.string().min(1).max(500),
  body: z.string(),
  tags: z.array(z.string()).default([]),
  importance: z.number().int().min(1).max(5),
  confidence: z.number().int().min(1).max(5),
  sensitivity: z.enum(['normal','private','restricted']).default('normal'),
  status: z.enum(['active','archived','superseded','forgotten']).default('active'),
  supersedes: z.array(z.string().uuid()).default([]),
  source: z.object({
    kind: z.enum(['user','agent','tool','file','command','external']),
    ref: z.string().optional(),
  }),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  revision: z.number().int().min(0),
});

// packages/contracts/src/graph.ts
export const EdgeKindSchema = z.enum(['supersede','merge','co_topic','co_scope']);
export type EdgeKind = z.infer<typeof EdgeKindSchema>;

export const GraphNodeSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),        // 截断到 ~60 字符
  type: MemorySchema.shape.type,
  topic: z.string(),
  scope: z.enum(['project','global']),
  project_id: z.string().nullable(),
  importance: z.number().int(),
  status: MemorySchema.shape.status,
  created_at: z.string().datetime(),
});

export const GraphEdgeSchema = z.object({
  source: z.string().uuid(),
  target: z.string().uuid(),
  kind: EdgeKindSchema,
  weight: z.number().min(0).max(1),  // co_topic/co_scope 时为共现强度
});

export const GraphFilterSchema = z.object({
  scope: z.enum(['project','global','all']).default('all'),
  project_id: z.string().optional(),
  topic: z.array(z.string()).optional(),
  type: z.array(MemorySchema.shape.type).optional(),
  status: z.array(MemorySchema.shape.status).default(['active']),
  min_importance: z.number().int().min(1).max(5).optional(),
  max_nodes: z.number().int().min(1).max(2000).default(500),
  include_co_topic: z.boolean().default(true),
  include_co_scope: z.boolean().default(false),  // 默认关：同 scope 边会爆炸
});

export const GraphResponseSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  total: z.number().int(),
  truncated: z.boolean(),
  generated_at: z.string().datetime(),
});
```

**与 `src/domain.ts` 的同步机制**：

1. **单向依赖**：`packages/contracts` 不允许 `import` `src/`,反过来
   `src/` 可从 `packages/contracts` 引用常量（可选）
2. **手写同步 + 视觉评审**：不引入 codegen 工具,反而增加复杂度。
   开发期靠 code review 警觉
3. **CI 校验**：`scripts/check-contract-sync.mjs` 启动期跑：
   `src/services/memory-read-service.ts` 的返回类型与
   `packages/contracts/src/schema.ts` 的 zod schema **结构性对比**
   （字段名、类型、必填）。漂移则 fail CI
4. **PR 模板强制**：改了 `src/domain.ts` 必须勾选"已同步 `packages/contracts`"

**跨语言**：Rust 端在 `apps/admin/src-tauri/src/contracts/` 下**手工**
mirror 一份 Rust struct（从 zod schema 转写）,`SCHEMA_VERSION` 常量在
两边各定义一份,启动时比对。v0.1 之后可考虑引入 `ts-rs` 或 `specta`
自动化,但**第一版不引入**。

### 前端 — React + xyflow

```
apps/admin/src/
├── App.tsx                            # 根 + Layout
├── routes/
│   ├── graph.tsx                      # 主面板：GraphCanvas + 过滤栏
│   ├── memories.tsx                   # 列表 + 搜索 + 分页
│   ├── memory-detail.tsx              # 单条记忆详情/编辑
│   ├── service.tsx                    # 服务管理
│   └── backup.tsx                     # 备份/导入
├── components/
│   ├── graph/
│   │   ├── GraphCanvas.tsx            # xyflow 容器
│   │   ├── MemoryNode.tsx             # 自定义节点
│   │   ├── EdgeLegend.tsx             # 边类型图例
│   │   ├── FilterBar.tsx              # 过滤栏
│   │   └── LayoutSelector.tsx         # dagre / elk / force 切换
│   ├── memories/
│   │   ├── MemoryCard.tsx
│   │   ├── MemoryList.tsx
│   │   ├── MemoryEditor.tsx           # 创建/编辑表单
│   │   └── ConfirmDialog.tsx          # 破坏性操作二次确认
│   ├── service/
│   │   ├── ProcessStatus.tsx
│   │   ├── DoctorReport.tsx
│   │   └── LogViewer.tsx
│   ├── backup/
│   │   ├── BackupList.tsx
│   │   └── ImportPanel.tsx
│   └── common/
│       ├── ErrorBanner.tsx
│       ├── EmptyState.tsx
│       └── PollIndicator.tsx
├── lib/
│   ├── tauri.ts                       # invoke 封装 + 类型守卫
│   ├── useGraph.ts                    # React Query 风格
│   ├── usePolling.ts                  # 订阅 db:changed
│   └── errors.ts                      # 错误码 → 用户消息映射
└── styles/
    └── theme.css                      # 浅/深主题
```

**关键设计点**：

1. **GraphCanvas（xyflow）**：
   - 节点自定义 `MemoryNode`：截断 title + topic badge + status 颜色
   - 边自定义：4 种 kind 不同颜色 + 虚实区分
   - 布局：默认 dagre（层次）,可切 force / elk
   - 交互：单击 drawer / 双击详情 / 拖动吸附 / 滚轮缩放 / hover 高亮

2. **FilterBar**：
   - 多选 topic、type、status、scope
   - `min_importance` 滑杆
   - "应用"按钮触发重新请求（防抖 300ms）
   - URL query string 同步过滤状态

3. **MemoryEditor**：
   - 复用 `packages/contracts` 的 zod schema 做前端校验
   - 错误码 → 用户消息：
     - `SENSITIVITY_DENIED` → "内容含受限敏感词"
     - `CAPABILITY_DENIED` → "当前 profile 不允许此操作"
     - `IDEMPOTENCY_CONFLICT` → 自动 retry,前端无感

4. **Service 面板**：
   - 状态卡：stdIO MCP 子进程状态
   - 启停按钮：`start_mcp_process` / `stop_mcp_process`
   - doctor 报告：调 `agent-recall doctor`（通过 Rust 调 CLI 子进程）
   - 日志查看：读 `data-home/agent-recall.log`

5. **Backup 面板**：
   - 列表：`data-home/agent-recall/backups/`
   - "立即备份"按钮 → `agent-recall backup`（CLI）
   - 导入：文件选择器 + `agent-recall import`（二次确认）

6. **实时性**：`usePolling` hook 订阅 `db:changed` Tauri 事件
   → 收到事件 → 触发 `useGraph` 的 refetch

### 数据流 + 实时性

**启动流程**：

```
Tauri 启动
  ├─→ SQLiteReader.open(db_path, READ_ONLY)
  │     ├─ PRAGMA user_version → 与 SCHEMA_VERSION 比对
  │     │     ├─ 一致:继续
  │     │     └─ 不一致:ErrorBanner("schema 不匹配,请升级/降级 admin 应用")
  │     ├─ 记下 mtime₀
  │     └─ 启动轮询 task
  ├─→ MCPClient: 不立即启动子进程,状态 = Idle
  └─→ 前端加载 → 默认路由 /graph → 调 get_graph({}) → 渲染
```

**写记忆数据流**：

```
MemoryEditor.submit(payload)
  ├─→ 前端 zod 校验(payload)
  │     └─ 失败:显示字段错误,不 invoke
  └─→ invoke('remember', payload, { idempotencyKey: uuid() })
        ├─→ Rust: MCPClient.ensure_running()
        │     ├─ 子进程未启动: spawn launcher, 等待 initialize 握手
        │     └─ 启动失败:返回 { error: MCP_PROCESS_UNAVAILABLE }
        ├─→ Rust: MCPClient.call_tool('remember', payload, idempotencyKey)
        │     ├─ 构造 JSON-RPC request(id 自增,timeout 10s)
        │     ├─ 写 stdin
        │     ├─ 读 stdout 直到匹配 id
        │     └─ 解析 response.content[0].text(JSON)
        └─→ 前端
              ├─ 成功:乐观更新本地 cache,显示 toast
              └─ 失败:错误 banner
```

**实时性 — 轮询 + 事件广播**：

```rust
tokio::spawn(async {
  let mut ticker = tokio::time::interval(Duration::from_secs(5));
  let mut last_mtime = get_mtime().await;
  loop {
    ticker.tick().await;
    let now = std::fs::metadata(db_path).modified()?;
    if now > last_mtime {
      last_mtime = now;
      app_handle.emit("db:changed", { mtime_ms: now.timestamp_millis() })?;
    }
  }
});
```

- 轮询频率：默认 5s,前端设置面板可调（1/5/15/30s）
- 选轮询而非 WAL hook / MCP 推送：
  - SQLite WAL hook 不反映业务写入
  - MCP 推送需主服务改造,影响 v1.x 契约
  - 5s 延迟对"管理工具"足够

### 错误处理

| 错误码 | 触发场景 | 前端行为 |
|---|---|---|
| `SCHEMA_VERSION_MISMATCH` | 启动时 PRAGMA user_version 与 contracts 不一致 | ErrorBanner + 禁用所有读/写,提示升级 |
| `DB_NOT_FOUND` | data-home 下找不到 .db | 显示"无数据"空状态 |
| `MCP_PROCESS_UNAVAILABLE` | 子进程启动失败或崩了 | 写按钮 disabled,顶栏红色 banner |
| `MCP_TOOL_CALL_FAILED` | MCP 协议层错误 | toast 显示原始 message |
| `INVALID_FILTER` | 过滤参数 schema 失败 | FilterBar 字段红框 |
| `GRAPH_TOO_LARGE` | max_nodes 截断后 total 仍 > 阈值 | 黄色 banner"图谱已截断" |
| `CAPABILITY_DENIED` | 当前 profile 不允许该操作 | toast"该操作需要更高权限" |
| `SENSITIVITY_DENIED` | 秘密扫描命中 | toast + 跳转 secret-detector 配置 |
| `IDEMPOTENCY_CONFLICT` | 同 key 重复提交 | 自动用新 key 重试,前端无感 |

### 测试策略

**Rust 侧**（`apps/admin/src-tauri/`）：

- 单元测试：
  - `SQLiteReader::get_graph()`：准备测试 DB,断言 nodes/edges/total/truncated
  - `MCPClient::call_tool()`：mock 子进程（stdin→stdout 桩）
  - 轮询 task：用 `tempfile` 改 mtime,断言 `db:changed` 事件触发
- 集成测试：`tests/integration.rs` 启真实 Tauri builder,调
  `app.handle().invoke()`

**前端**（`apps/admin/src/`）：

- 单元测试：Vitest + React Testing Library
  - 组件：MemoryNode/FilterBar/MemoryEditor
  - hooks：useGraph/usePolling（用 mock Tauri API）
- 契约测试：`packages/contracts` 自身的 zod schema roundtrip +
  `scripts/check-contract-sync.mjs`

**端到端**（`apps/admin/tests/e2e/`）：

- 用 `tauri-driver` / WebDriver
- 准备 fixture DB（脚本生成,放到 `tests/fixtures/`）
- 场景：启动 → graph 渲染 / 点节点 drawer / 创建记忆 5s 内可见 /
  修改过滤 URL 同步 / 启停 MCP 子进程 / 备份/导入可恢复

**手动验证清单**（PR 模板勾选）：

- [ ] Tauri 启动后能读现有 .db
- [ ] schema_version 故意改大 → 启动失败,提示明确
- [ ] 改一条记忆（走 MCP 写）→ 5s 内 graph 自动更新
- [ ] 子进程手动 kill → UI 正确显示 unavailable,点击重试可恢复
- [ ] 跨平台 smoke：Windows / macOS / Linux 各跑一次

## 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| **R1: schema 漂移**（Rust 读假设表结构） | 读到错误数据,最坏 panic | 启动期 user_version 校验；`scripts/check-contract-sync.mjs` CI 强制 |
| **R2: 子进程启动延迟**（每次写 ~200ms） | 用户感知卡顿 | 懒启动 + 预热开关；空闲 5min 保留 |
| **R3: 子进程崩溃未恢复** | 写功能不可用 | 监测 + 自动重启（最多 3 次）+ UI 提示 |
| **R4: monorepo 改造破坏现有 npm 发版** | 上游用户拿不到包 | 不动 `src/`/`bin/`/`dist/`；根 `package.json` 只加 `workspaces` 字段,保留所有现有 scripts 与 `files` 字段 |
| **R5: Tauri 2.0 + 大型 React 项目的 bundle 体积** | 安装包膨胀 | code splitting、按需 import xyflow 子模块、telemetry off |
| **R6: Tauri 与 OS 集成（权限/签名/公证）** | macOS Gatekeeper / Windows SmartScreen | v0.1 不签名,文档提示"开发版"或用 `tauri build --no-bundle`；v0.2 评估签名 |
| **R7: Tauri Rust ↔ MCP 进程间传输** | JSON-RPC 错位、消息丢失 | 自实现 MCP client 时严格按 `initialize` → `tools/list` → `tools/call` 流程,带 ping/heartbeat;timeout 严格设置 |
| **R8: 多任务并发读写** | Rust 只读 + Node 写入,SQLite lock 冲突 | Rust 用 `SQLITE_OPEN_READ_ONLY` + 短事务（SQLite WAL 模式支持并发读） |
| **R9: 数据隐私**（Tauri 读全库） | 用户能看见所有 memory,包括 private/restricted | 前端按 `sensitivity` 字段过滤显示,`restricted` 默认隐藏,需在设置里显式开启 |

## 验收标准

### v0.1：graph 只读 + monorepo 骨架（第一个 PR）

- ✅ 仓库结构按"仓库结构"小节落地,`pnpm install` 在根目录成功
- ✅ `apps/admin` 能 `cargo build` 成功
- ✅ Tauri 启动 → /graph 路由显示空状态或 fixture 数据
- ✅ get_graph SQL 跑通（返回 nodes/edges/total）
- ✅ 轮询 task 跑通（改 .db 触发事件,前端 console 可见）
- ✅ 测试：SQLiteReader 单元测试 5+,前端 MemoryNode 快照测试
- ✅ 文档：`docs/guides/admin-app.md` 用户使用说明
- ❌ 不包含：任何写操作、服务管理、备份/导入

### v0.2：记忆 CRUD + 写走 MCP

- ✅ MCPClient 子进程启停 + JSON-RPC 通信
- ✅ remember / update_memory / forget_memory 全部能调通
- ✅ 写后 5s 内 graph 自动更新
- ✅ MemoryEditor 表单 + 校验 + 错误展示
- ✅ ConfirmDialog 二次确认（forget）
- ✅ 单元 + 集成测试覆盖
- ❌ 不包含：服务管理、备份/导入

### v0.3：服务管理 + 备份/导入 + polish

- ✅ /service 面板：状态/启停/doctor/日志
- ✅ /backup 面板：列表/立即备份/导入
- ✅ 主题/响应式
- ✅ 跨平台 smoke
- ✅ README + RELEASE_NOTES

## 跨阶段一致性约束

- 每个 PR 严格自包含,不跨阶段
- 不在 v0.1 提前实现 v0.2/v0.3 能力（避免 YAGNI）
- CI 任何阶段必须绿：typecheck + test（unit + integration）
- 写操作能力在 v0.1 必须显式标注 "DISABLED" 而非 stub,避免误用

## 文档约定

- 主 spec 文件中文（本文件）
- 英文翻译放同目录 `agent-recall-admin-design.en.md`
- 用户文档放 `docs/guides/admin-app.md`（v0.1 交付时）

## 待用户确认

- [ ] 仓库结构与 monorepo 改造是否可接受（关键约束:现有 `src/` 不动）
- [ ] 节点/边模型：节点=memory,边=supersede/merge/co_topic/co_scope 是否够用
- [ ] 双通道（Rust 直读 SQLite + Rust 启 MCP stdio 写）是否可接受
- [ ] 实时性走 5s 轮询是否够用
- [ ] 三阶段交付节奏是否可接受
