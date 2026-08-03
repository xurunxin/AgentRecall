# AgentRecall（中文用户文档）

[![CI](https://github.com/xurunxin/AgentRecall/actions/workflows/ci.yml/badge.svg)](https://github.com/xurunxin/AgentRecall/actions/workflows/ci.yml)

> 本文档是 `README.md` 的中文版本，面向中文使用者。**当前实现版本：v1.1.4**。
>
> 英文原版请参阅仓库根目录的 [`README.md`](../../README.md)。

AgentRecall 是一个面向编码 Agent 的本地优先（local-first）MCP 记忆服务。它为兼容 MCP 的客户端提供一套受治理（governed）的工具面，用于存储、检索、维护、导出全局或项目范围的记忆条目。

- **真相源（Source of truth）**：SQLite。
- **Markdown 导出**：确定性产物，用于审阅与交接，**不是**实时数据库。
- **传输方式**：stdio，不需要托管数据库、嵌入服务或联网模型调用。

## 目录

- [环境要求](#环境要求)
- [架构概览](#架构概览)
- [源码构建安装](#源码构建安装)
- [MCP 与 CLI 的区别](#mcp-与-cli-的区别)
- [数据目录](#数据目录)
- [MCP 客户端配置](#mcp-客户端配置)
- [工具集（按 Profile 划分）](#工具集按-profile-划分)
- [项目身份解析](#项目身份解析)
- [能力（Capability）边界](#能力capability边界)
- [敏感度策略](#敏感度策略)
- [安装方式](#安装方式)
- [OpenCode 集成](#opencode-集成)
- [升级与回滚](#升级与回滚)
- [运行期配置（环境变量）](#运行期配置环境变量)
- [记忆维护建议](#记忆维护建议)
- [本地存储位置](#本地存储位置)
- [Doctor 自检](#doctor-自检)
- [发布流程](#发布流程)
- [候选发布门禁（RC Gate）](#候选发布门禁rc-gate)
- [打包产物端到端生命周期](#打包产物端到端生命周期)
- [不可变性 + 证据契约](#不可变性--证据契约)
- [开发与测试](#开发与测试)
- [变更日志](#变更日志)
- [本地校验](#本地校验)

## 环境要求

- **Node.js ≥ 24**
- npm
- 一个能启动 stdio 服务的 MCP 兼容客户端

## 架构概览

`MemoryService` 是 `src/services/` 下三个子服务的对外门面（façade）：

- `MemoryReadService` — 读取类：`getMemory`、`listMemories`、`searchMemories`、`getMemoryBudget`、`exportMemoryContext`。
- `MemoryWriteService` — 写入类：`remember`、`updateMemory`、`supersedeMemory`、`mergeMemories`、`forgetMemory`、`configureProjectBudget`。
- `MemoryMaintenanceService` — 维护类：`maintainMemories`，以及每个动作的独立实现：`findDuplicates`、`mergeDuplicates`、`rebuildMarkdownIndex`、`expireDueMemories`、`archiveLowValueMemories`、`vacuumFts`。

公共助手（审计追加、预算评估、Actor 查询、环境变量读取、比较函数）统一在 `src/services/memory-service-helpers.ts` 中实现。门面本身持有 `SQLiteMemoryStore`、可选的 `MarkdownExporter`、默认 Actor、数据目录、当前激活的工具 Profile、加载到的能力（capability），并通过共享的 `ReadContext` / `WriteContext` / `MaintenanceContext` 注入到每个子服务。`backup()` 出于历史原因（Stage 1）仍保留在门面。

`MemoryService` 的公开 API 与每个公开方法是 v1.1.3 契约：副作用为零的项目身份解析（#31）、按 Profile 划定的 Admin 能力（含加载期权限校验，#32）、以及为每条内容路径提供唯一规范的 `AuthorizationDecision`（#33）。三子服务拆分是纯可维护性变更，对外行为零回归。

## 源码构建安装

克隆、安装、构建并启动 stdio 服务：

```bash
git clone https://github.com/xurunxin/AgentRecall.git
cd AgentRecall
npm install
npm run build
npm start
```

本地开发（无需构建）：

```bash
npm run dev
```

构建完成后，包内二进制指向 `dist/src/index.js`。正式平台的安装配方见后文 [安装方式](#安装方式)。

## MCP 与 CLI 的区别

AgentRecall 产物中包含两个可执行入口：

| 二进制命令 | 对应文件 | 用途 |
| --- | --- | --- |
| `agent-recall-mcp` | `dist/src/index.js` | MCP stdio 服务。默认 10 个读写/规划类工具；通过 `AGENT_RECALL_PROFILE=extended` 启用 20 个工具集 |
| `agent-recall` | `dist/bin/agent-recall.js` | 独立 CLI，用于一次性检查、健康检查、手动备份、Schema 迁移 |

调用 CLI：

```bash
node dist/bin/agent-recall.js doctor
# 或在 npm install 之后：
npx agent-recall doctor
```

`agent-recall --version` / `agent-recall -v` 输出服务端版本号（与 MCP 握手以及每个 `meta.server_version` 字段一致；权威值在 `src/server-version.ts`）。

## 数据目录

默认运行时数据位于：

```text
~/.agent-recall/
```

通过 `AGENT_RECALL_HOME` 可指定其他目录：

```bash
AGENT_RECALL_HOME=/path/to/agent-recall npm start
```

以 `~/` 或 `~\` 开头的相对路径会按当前用户主目录展开；其他值会解析为绝对路径。Windows 下的 JSON 客户端配置需要注意反斜杠转义，例如 `C:\\path\\to\\agent-recall-data`。旧变量已不再文档化；请使用 `AGENT_RECALL_HOME`。

## MCP 客户端配置

大多数 MCP 客户端支持 JSON 形式的 server 条目。运行 `npm run build` 后使用构建产物：

```json
{
  "mcpServers": {
    "agent-recall-mcp": {
      "command": "node",
      "args": ["/path/to/agent-recall/dist/src/index.js"],
      "env": {
        "AGENT_RECALL_HOME": "/path/to/agent-recall-data",
        "AGENT_RECALL_ACTOR": "claude-code"
      }
    }
  }
}
```

打包后 MCP 默认是 **Core** Profile（10 个读写/规划工具）。在 `env` 块中设置 `AGENT_RECALL_PROFILE=extended` 即可切换到 20 个工具的 **Extended** Profile（含记忆语义 + 管理类工具）。`admin` Profile 需要同时设置 `AGENT_RECALL_PROFILE=admin` **并** 装载一份有效的操作员能力（capability），装载方式见 `agent-recall admin grant`。详细合同见 [能力（Capability）边界](#能力capability边界) 以及 `docs/adr/0005-profile-scoped-admin-capability.md`。

如果你的客户端支持 `cwd`，也可以通过 npm 启动：

```json
{
  "mcpServers": {
    "agent-recall-mcp": {
      "command": "npm",
      "args": ["start"],
      "cwd": "/path/to/agent-recall",
      "env": {
        "AGENT_RECALL_HOME": "/path/to/agent-recall-data",
        "AGENT_RECALL_ACTOR": "claude-code"
      }
    }
  }
}
```

## 工具集（按 Profile 划分）

三个 Profile 注册不同的工具集。Core 是打包默认；Extended 在 Core 基础上加入记忆语义 + 管理类工具；Admin 继承 Extended 的 20 个工具，并在加载期通过操作员能力对 `profile_required` 能力把关。

| Profile | `AGENT_RECALL_PROFILE` | 工具数 | 工具清单 |
| --- | --- | --- | --- |
| Core | （未设置） | 10 | `recall_context`、`remember`、`search_memories`、`get_memory`、`list_memories`、`update_memory`、`supersede_memory`、`forget_memory`、`get_memory_budget`、`maintain_memories` |
| Extended | `extended` | 20 | Core 10 个 + `merge_memories`、`record_memory_feedback`、`record_memory_provenance`、`explain_memory_provenance`、`confirm_memory_trust`、`plan_maintenance`、`apply_maintenance`、`export_memory_context`、`import_memory_context`（1 个占位）、`audit_memory`（1 个占位） |
| Admin | `admin`（需具备 capability） | 20 | 与 `extended` 工具面相同；差异在于加载期能力门禁——`AGENT_RECALL_PROFILE=admin` 的进程在 `${AGENT_RECALL_HOME}/admin.cap` 缺失或失效时会拒绝绑定 stdio |

`memory://health` 同时暴露 `active_profile` 和 Admin 边界状态 `capability_state`（`granted` / `missing`）。

## 项目身份解析

v1.1.3 GATE-01（issue #31）引入三种项目身份解析模式：

- `lookup` — 纯读。遇到未注册的 `project_path` 时返回 `identity_conflict`，**对** `project_identities` / `project_aliases_new` **零写入**。
- `strict_existing` — 拒绝未绑定的 `project_id` / `project_path`；规范的预检 + 应用期重校验入口。
- `register` — 唯一允许向 `project_identities` / `project_aliases_new` 插入的模式。规范注册路径是 `MemoryWriteService.configureProjectBudget(...)` 或 CLI `agent-recall project register <path>`。

逃生口 `AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID=1` 仅在一次性操作员排障时使用，**不适合**生产 Agent 流程——它允许仅凭 `project_id` 而没有注册身份时以 "unbound" 模式继续。详细设计见 `docs/adr/0004-identity-resolution-modes.md`，操作员指南见 [`docs/zh-CN/guides/identity-resolution.md`](guides/identity-resolution.md)。

## 能力（Capability）边界

v1.1.3 GATE-02（issue #32）补齐了 v1.1.2 的 Admin 边界漏洞。核心合同如下：

- **按 Profile 划定可见性。** 仅 Admin Profile 进程 + 有效能力才获得 `"restricted"` 可见性。Core / Extended 进程即便数据目录下存在 `admin.cap`，可见性仍停留在 `"normal"`（关闭了 v1.1.2 的可见性泄漏）。
- **加载期权限校验。** 解析能力文件前，先校验 POSIX 模式 + 所有者 + 符号链接状态；Windows 下用 `icacls` 探测 ACL，拒绝任何非系统/非所有者主体。漂移则将内存中的 token 置空；`status()` 在不泄漏 token 字节的前提下返回 `{kind: "drift", drift_reason, path}`。
- **按请求的能力。** Core / Extended 调用方可在请求中携带 `capability` 字段以授权一个特权操作（该路径与当前 Profile 无关）；但带有 `profile_required: "admin"` 的能力类型会在 Core / Extended 上以 `reason: "profile_mismatch"` 拒绝。

授权 / 状态 / 撤销：

```bash
agent-recall admin grant
agent-recall admin status
agent-recall admin revoke
```

完整设计见 `docs/adr/0005-profile-scoped-admin-capability.md`，操作员指南见 [`docs/zh-CN/guides/operator-capability.md`](guides/operator-capability.md)。

## 敏感度策略

v1.1.3 GATE-03（issue #33）将所有读取 / 导出 / 资源 / 维护 / CLI / MCP 路径统一到一条规范 `AuthorizationDecision`（`max_sensitivity`、`capability_token_present`、`reasoning`）。该决策是每条内容路径的唯一真相源，SQL 边界过滤器是唯一决定敏感度的地方。

3 × 3 可见性矩阵（3 个 Profile × 3 个敏感度级别）：

| Profile | normal | private | restricted |
| --- | --- | --- | --- |
| Core | 是 | 是 | 否 |
| Extended | 是 | 是 | 否 |
| Admin（具备 capability） | 是 | 是 | 是 |

Core / Extended 进程上对 restricted 的导出请求会返回 `FORBIDDEN_VISIBILITY`；CLI 退出码 1，错误码稳定为 `forbidden_visibility`。详细设计见 `docs/adr/0006-one-sensitivity-policy.md`，操作员指南见 [`docs/zh-CN/guides/sensitivity-matrix.md`](guides/sensitivity-matrix.md)。

## 安装方式

**规范的安装配方**为：下载平台特定压缩包 → 校验 SHA-256 → 解压 → 安装运行期依赖 → 运行。压缩包名称内嵌平台标记；平台词表为 `linux-x64`、`darwin-x64`、`win32-x64`。

```bash
# 1. 选择正式平台产物
VERSION="1.1.4"
PLATFORM="linux-x64"   # 或 `darwin-x64` / `win32-x64`
ARCHIVE="agent-recall-${VERSION}-${PLATFORM}.tar.gz"
# Windows 下使用：`agent-recall-${VERSION}-${PLATFORM}.zip`

# 2. 从 `v${VERSION}` 的 GitHub Release 下载压缩包 + SHA-256 清单
#    （Release 正文里会列出每个产物及其 SHA-256）。

# 3. 校验完整性
sha256sum -c "agent-recall-${VERSION}-${PLATFORM}.sha256"

# 4. 解压
tar -xzf "$ARCHIVE"              # POSIX (linux-x64 / darwin-x64)
# Windows (PowerShell):
#   Expand-Archive -Path "${ARCHIVE}.zip" -DestinationPath .

# 5. 安装运行期依赖（压缩包内含 `dist` + `README.md` + `LICENSE` + `CHANGELOG.md`；
#    **不包含** `node_modules`）。
(cd agent-recall-${VERSION} && npm install --omit=dev)

# 6. 运行
node agent-recall-${VERSION}/dist/src/index.js      # MCP stdio 服务
node agent-recall-${VERSION}/dist/bin/agent-recall.js doctor   # CLI 自检
```

`package.json` 的 `files` 数组仅打包 `dist`、`README.md`、`LICENSE`、`CHANGELOG.md`，**不**包含 `node_modules`。消费端的 `npm install --omit=dev` 是规范的安装步骤。发布生命周期（解包 → 安装 → lifecycle E2E）的契约见 `docs/adr/0003-extracted-artifact-lifecycle.md` 和 [`docs/zh-CN/guides/release-publication.md`](guides/release-publication.md)。

### Bun 单文件二进制（附加渠道）

如果需要一个无需 Node.js、无需 `npm install` 的单文件可执行：

```bash
# 1. 从 GitHub Release 下载对应平台二进制
VERSION="1.1.4"
PLATFORM="linux-x64"   # 或 darwin-x64、darwin-arm64、win32-x64
curl -L -o agent-recall \
  "https://github.com/xurunxin/AgentRecall/releases/download/v${VERSION}/agent-recall-${PLATFORM}"
chmod +x agent-recall

# 2. 对照 Release 的 MANIFEST.json 校验（推荐）
curl -L -O "https://github.com/xurunxin/AgentRecall/releases/download/v${VERSION}/MANIFEST.json"
sha256sum -c <(jq -r ".entries[] | select(.platform==\"${PLATFORM}\" and .kind==\"cli\") | \"agent-recall  \" + .sha256" MANIFEST.json)

# 3. 运行
./agent-recall doctor
```

Bun 二进制自带 SQLite 驱动（`bun:sqlite`），消费端主机无需 Node 运行期。完整配方与能力矩阵见 [`docs/zh-CN/guides/bun-distribution.md`](guides/bun-distribution.md)。

## OpenCode 集成

要让 AgentRecall 在 [OpenCode](https://opencode.ai) 中工作，需要注册 MCP 服务（用于主动工具调用），并可选地注册随项目打包的 prompt 注入插件（用于在每一轮 LLM 输入中被动注入 `[AGENT_RECALL]` 上下文）。规范的配方——包括 `mcp:` 与 `plugin:` 配置、环境变量、选项表、smoke 测试、卸载步骤——见 [`docs/zh-CN/guides/opencode-install.md`](guides/opencode-install.md)。插件源码位于仓库 `opencode-plugin/`。

MCP 服务与插件**相互独立**：MCP 是纯 JSON-RPC-over-stdio 进程，响应 `initialize` 和 `tools/list`，不触及系统提示；插件仅通过 `experimental.chat.system.transform` 向 `output.system` 追加一段上下文。从 `opencode.json` 中移除插件条目不会影响 MCP 工具的可用性。

## 升级与回滚

### 升级 v1.1.3 → v1.1.4

v1.1.4 的迁移**保持 Schema 不变**：

- v1.1.3 的 schema v13 已足够；v1.1.4 主要是 MCP stdio 服务的优雅退出（`src/mcp/server-lifecycle.ts`）+ 新增环境变量 `AGENT_RECALL_VERBOSE_STDIO` 用于在退出时向 stderr 输出原因行。
- 默认 `npm test` 已排除 `test/release-gate/**` 以及 packaged-artifact / 多进程压力 / blackbox 子套件；这些重型套件继续由各自的 segregated config 承载。
- `user_version` 仍为 `13`。

每台主机的升级步骤：

1. 停止当前运行的 MCP / CLI 进程。
2. 用 v1.1.4 构建产物替换 `dist/`（`tar -xzf` / `Expand-Archive`）。
3. 如果新 `package.json` 携带了依赖变更，重新执行 `npm install --omit=dev`（v1.1.4 无此变化）。
4. 运行 `node dist/bin/agent-recall.js migrate --yes`（对 v13 → v13 是 no-op，对 v0..v12 则会按阶段补齐迁移）。
5. 用相同的 `AGENT_RECALL_HOME` 与 `AGENT_RECALL_ACTOR` 重启 MCP。

### 回滚 v1.1.4 → v1.1.3

v1.1.3 的对外行为由 v1.1.4 完全保留（无破坏性变更）。回滚步骤：

1. 停止当前运行的 MCP / CLI 进程。
2. 从已知良好备份中恢复 v1.1.3 的 `dist/`（`agent-recall backup` 会将 SQLite 写到 `<AGENT_RECALL_HOME>/backups/memory-<timestamp>.sqlite`）。
3. 如需确认 v1.1.4 没有遗留状态，运行 `node dist/bin/agent-recall.js doctor`。
4. 用 v1.1.3 二进制重启。

Schema 保持不变的契约意味着向前（v1.1.3 → v1.1.4）或向后（v1.1.4 → v1.1.3）滚动都**不需要**数据迁移。

## 运行期配置（环境变量）

以下环境变量在运行期读取（无需重启；下次调用即生效）。均有安全默认值，非法值会回退到默认并向 stderr 输出一行警告。

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `AGENT_RECALL_HOME` | `~/.agent-recall` | SQLite 文件、备份、导出所在目录。 |
| `AGENT_RECALL_ACTOR` | `agent` | 审计行的默认 Actor 名。建议在 MCP 客户端配置中设为 `agent:claude-code`、`agent:cursor` 等，以使按 Agent 视图、trust_boost、last_accessed_by 端到端生效。 |
| `AGENT_RECALL_STALE_DAYS` | `90` | `stale_memories` doctor 检查的阈值。必须为正整数。 |
| `AGENT_RECALL_TRUST_STRONG` | `0.3` | 调用 Agent 自己写入的记忆的 recall `trust_boost`。范围 `[0, 1]`。 |
| `AGENT_RECALL_TRUST_SOFT` | `0.1` | 调用 Agent 最近访问过的记忆的 recall `trust_boost`。范围 `[0, 1]`。 |
| `AGENT_RECALL_SUPPRESS_MCP_DEPRECATION` | 未设置 | 设为 `1` 以屏蔽一次性 MCP 服务弃用提示。 |
| `AGENT_RECALL_PROFILE` | `core`（打包默认） | v1.1.2 (issue #22 + #23) → v1.1.3 (#32)：选择当前 MCP 工具 Profile。`core` 注册 10 个读写/规划工具；`extended` 在此基础上再增加 10 个；`admin` 注册与 `extended` 相同的 20 个工具面，但通过加载期能力校验来把关 `profile_required: "admin"` 类能力。未知值在启动期 fail-closed。 |
| `AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID` | 未设置（默认严格） | v1.1.2 (issue #21) → v1.1.3 (#31)：默认关闭的旧版逃生口。设为 `1` 时，仅凭 `project_id` 而未注册身份时以 "unbound" 模式继续。严格模式会在解析期拒绝未知 id，且在写入任何 project scope、alias、记忆、审计、预算行之前就失败。 |
| `AGENT_RECALL_VERBOSE_STDIO` | 未设置 | v1.1.4 新增：设为 `1` 时，MCP stdio 服务在退出时向 stderr 输出一行 `agent-recall shutting down (stdin EOF)` / `… (SIGTERM)` / `… (SIGINT)`。热路径默认静默，stdout 保持协议纯净。 |

## 记忆维护建议

- 任务开始时，优先调用 `recall_context`，传入当前任务查询字符串和（若可用）当前项目路径。输出会优先排列调用 Agent 自己的记忆，并以 `[writer: <actor>]` 标注作者。
- 每条记忆保持原子：一项偏好、一个决定、一条约束、一个教训或一个调试事实。
- 写入前先搜索，避免重复或近似重复。
- **跨 Agent 去重**：当 `remember` 的内容与现有记忆的 token-set Jaccard ≥ 0.7 时，会返回新记忆**并**在 `warnings[]` 中给出 `near_duplicate` 提示。完全匹配 `duplicate_candidate` 路径仍是硬性阻断，需要 `confirm_write: true` 才放行。
- 项目专属事实、路径、命令、调试教训请用 `scope: "project"`。
- 跨项目偏好与稳定约束请用全局 scope。
- 偏好高置信、长期有效的事实。归档或取代（supersede）陈旧条目，避免积累矛盾。
- **绝不**存储密钥、私钥、bearer token、原始 `.env` 文件、凭据或客户敏感数据。
- 形似机密的写入与更新会在入库前被拒绝；拒绝审计元数据**不**包含原始机密文本。
- 写入返回 `capacity_exceeded` 时，先搜索或运行维护动作再重试。

## 本地存储位置

权威 SQLite 数据库：

```text
<AGENT_RECALL_HOME>/memory.sqlite
```

导出的 Markdown 文件：

```text
<AGENT_RECALL_HOME>/exports/
```

Markdown 导出用于检查与交接。在 `exports/` 下的手动编辑可能因 `maintain_memories` 的 `action: "rebuild_markdown_index"` 被覆盖。

## Doctor 自检

`agent-recall doctor` 跑 **24** 项健康检查，退出码：

- `0` — 全部正常
- `1` — 仅警告，无失败
- `2` — 至少一项失败（数据完整性、数据目录缺失等）

检查分三组：

- **运行期（Stage 1-7）**：data_home、integrity、schema_version、fts_consistency、backup_directory、disk_free、audit_health、capacity_headroom、actor_distribution、last_accessed_by、actor_ownership、stale_memories。
- **v1.0 验收（Stage 14 / spec § 9.1）**：scope_safety、revision_integrity、journal_mode、sqlite_runtime、lock_health、backup_verification、project_alias_collision、ranking_health、export_collision、audit_revision_gap、secret_policy_version、idempotency_integrity。

可作为周期性自检，或在 Schema 升级、手工编辑 SQLite 等风险操作前后使用。`--json` 支持脚本化输出。完整操作员指南见 [`docs/zh-CN/guides/release-publication.md`](guides/release-publication.md)。

## 发布流程

发布过程受以下文档约束：

- [`docs/adr/0003-extracted-artifact-lifecycle.md`](../../docs/adr/0003-extracted-artifact-lifecycle.md) — 跨平台 `Pack → Extract → Install → Lifecycle E2E` 门禁。
- [`docs/adr/0004-immutable-tag-and-evidence.md`](../../docs/adr/0004-immutable-tag-and-evidence.md) — 不可变 Tag + 证据评论契约。
- [`docs/adr/0007-release-evidence-contract.md`](../../docs/adr/0007-release-evidence-contract.md) — v1.1.3 起的证据 Schema（正式平台、fail-closed 校验器、稳定不变量）。
- [`docs/adr/0008-deterministic-orchestration.md`](../../docs/adr/0008-deterministic-orchestration.md) — 5 job 的 CI 拓扑（per-suite + matrix leg + release-aggregate）。
- [`docs/zh-CN/guides/release-publication.md`](guides/release-publication.md) — 操作员面向的 `prepare-release.mjs` 流程 + 发布门禁。
- [`docs/zh-CN/guides/release-test-topology.md`](guides/release-test-topology.md) — per-suite CI 对应（哪个 job 跑哪个套件、预期耗时、失败时该看哪里）。

## 候选发布门禁（RC Gate）

仅当一个 commit 拥有完整、保留的发布证据时，操作员才能基于该 commit 发布：

1. 冻结目标 commit 并推到一个 `rc-*` 分支，例如：`git push origin HEAD:rc-1.1.4-candidate`。这会触发 `.github/workflows/release-candidate.yml` 在 Ubuntu、macOS、Windows 上以 Node 24 运行。该次运行之后不要再加发布阻塞性变更；新 commit 必须重跑候选并作废旧证据。
2. 等待 `Release Candidate Gate` 工作流成功完成。该工作流校验：精确的候选 SHA、release stress profile、migrations、backup / restore、strict snapshot import、cleanup、MCP profiles、artifact globs，并上传 `release-evidence.json` 与 `release-candidate.json`。
3. 在打 tag 之前，把候选 commit SHA 与工作流 URL 复制到 [issue #19](https://github.com/xurunxin/AgentRecall/issues/19)。在 review 或 issue 评论中显式引用两者，例如：`candidate SHA: <40-char SHA>; workflow: https://github.com/xurunxin/AgentRecall/actions/runs/<run-id>`。
4. 仅在证据为绿后再推送发布 tag：`git tag v1.1.4 <candidate-sha> && git push origin v1.1.4`。`release.yml` 会找到该精确 SHA 对应的一次成功候选工作流，验证证据 artifact 与 `release_commit`，如果 tag 指向别处则 fail-closed。Tag 不可仅依赖旧的 commit-status 上下文。

证据 artifact 是操作员的审计连接：包含候选 SHA、工作流 URL 与各 job 的 URL（带结论与耗时）、OS / Node 详情、测试与迁移计数、artifact 名、已知的非阻塞限制。

## 打包产物端到端生命周期

一个独立的 CI 门禁（`.github/workflows/release-candidate.yml` 的 `matrix` job + `.github/workflows/release.yml` 的 `verify-extracted-artifacts` job）会在 Linux、macOS、Windows 上端到端跑**打包后的**发布压缩包。该门禁独立于 source / build smoke（`mcp-blackbox-extracted`），后者仍然下载构建好的 `dist/` 跑既有的 blackbox 套件。

生命周期门禁步骤：

1. **打包候选发布产物** — 镜像生产 `release.yml` 的 `Strip dev-only artefacts` + `Pack` 步骤（Linux / macOS 上 `.tar.gz`，Windows 上 `.zip`）。
2. **解压候选发布产物** — 调用 `node scripts/extract-release-artifact.mjs`，传入归档路径 + `$RUNNER_TEMP/agent-recall-extracted` + 平台标签（`linux` / `darwin` / `win32`）。POSIX 调 `tar -xzf`，Windows 调 PowerShell `Expand-Archive`，对 Linux / macOS 的 `.zip` 用 `unzip -q -o`；然后断言解压树中包含正式入口（`dist/src/index.js` + `dist/bin/agent-recall.js` + `package.json`）。
3. **在解压产物中安装运行期依赖** — 在解压树内执行 `npm install --omit=dev`。归档的 `package.json` `files` 列表打包 `dist` + `README.md` + `LICENSE` + `CHANGELOG.md`，**不**包含 `node_modules`；该步骤对齐消费端表面。
4. **计算候选产物的哈希** — 在归档上跑 `node scripts/compute-artifact-hashes.mjs`，生成 `release-artifact-hashes.json`（`{ schema_version, candidate_sha, generated_at, artifacts: [{ platform, artifact_path, sha256, size_bytes, mtime }] }`）。matrix leg 将该 JSON 作为证据片段的一部分上传。
5. **解压产物 lifecycle E2E** — 跑 `npx vitest run test/blackbox/packaged-install.test.ts`，并将 `AGENT_RECALL_EXTRACTED_ARTIFACT` 指向解压目录。该套件以**打包后的** MCP 服务为被测对象，端到端跑 11 个公开的 lifecycle 场景。
6. `record-evidence` 将每个 matrix leg 的 `release-artifact-hashes.json` 按 `artifact_path` 聚合到一张 `sha256_checksums` 映射中，并由 `scripts/release-evidence.mjs` 转发到 `release-evidence.json`。

`release.yml` 的 `verify-extracted-artifacts` matrix 重新下载每个平台产物、重新解压、重新计算 SHA-256、重新跑 lifecycle E2E。**任何**一个平台失败都会阻塞 tag。

### 本地跑 lifecycle

```bash
npm run build
STAGE="stage-agent-recall"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R dist "$STAGE/dist"
cp package.json "$STAGE/package.json"
cp README.md "$STAGE/README.md"
cp LICENSE "$STAGE/LICENSE"
VERSION=$(node -e 'console.log(require("./package.json").version)')
tar -czf "agent-recall-${VERSION}-linux-x64.tar.gz" -C "$STAGE" .

AGENT_RECALL_PACKAGED_ARTIFACT="agent-recall-${VERSION}-linux-x64.tar.gz" \
AGENT_RECALL_EXTRACT_DIR="$PWD/extracted" \
AGENT_RECALL_PLATFORM="linux" \
  node scripts/extract-release-artifact.mjs

(cd extracted && npm install --omit=dev)

GITHUB_SHA="$(git rev-parse HEAD)" \
MATRIX_OS="linux" \
  node scripts/compute-artifact-hashes.mjs "agent-recall-${VERSION}-linux-x64.tar.gz"

AGENT_RECALL_EXTRACTED_ARTIFACT="$PWD/extracted" \
AGENT_RECALL_SUPPRESS_MCP_DEPRECATION="1" \
  npx vitest run test/blackbox/packaged-install.test.ts
```

完整设计见 [`docs/adr/0003-extracted-artifact-lifecycle.md`](../../docs/adr/0003-extracted-artifact-lifecycle.md)。

## 不可变性 + 证据契约

发布步骤遵循 [`docs/adr/0004-immutable-tag-and-evidence.md`](../../docs/adr/0004-immutable-tag-and-evidence.md) 中的"不可变 Tag + 证据评论"契约。操作员面向的入口是 `scripts/prepare-release.mjs`：

- 已有 tag `v1.0.0` / `v1.1.0` / `v1.1.1` / `v1.1.2` / `v1.1.3` / `v1.1.4` **永远不可移动**。`prepare-release.mjs` 拒绝覆盖任何已存在 tag；脚本源码不含 `git tag -f` / `git push --force` / `git push --tags`，CI 失败即为回归信号。
- 发布期 `GITHUB_SHA` 必须等于 `git rev-parse HEAD`。不一致会以结构化 stderr 行退出 1；脚本不会从一个未 checkout 的 commit 创建 tag。
- `ARTIFACT_DIR` 必须包含**全部**三个平台发布归档（`linux-x64` / `darwin-x64` / `win32-x64`）**以及** 由 `scripts/compute-artifact-hashes.mjs` 生成的 `release-artifact-hashes.json`。缺失平台或哈希陈旧都会退出 1。
- `DRY_RUN=1` 是默认值：脚本校验所有输入并在 `ARTIFACT_DIR` 下写入 `release-notes.md` + `issue-19-evidence-comment.md`，**不会**创建 annotated tag。审阅产物后再用 `DRY_RUN=0` 重跑以创建 tag。
- 作者身份通过 `git tag -a` 的 `--author` 标志传递；脚本绝不调用 `git config`，也不修改开发者的 `~/.gitconfig`。

```bash
GITHUB_SHA="$(git rev-parse HEAD)" \
ARTIFACT_DIR="$PWD/dist-stage" \
RELEASE_TAG="v1.1.4" \
DRY_RUN="1" \
  node scripts/prepare-release.mjs
```

该脚本无第三方依赖（仅 Node 18+ 标准库），由 `test/release-gate/p3-release-immutability.test.ts` 覆盖。完整操作员流程见 [`docs/zh-CN/guides/release-publication.md`](guides/release-publication.md)。

## 开发与测试

项目随带一套确定性的 per-suite 编排器（`scripts/run-test-suites.mjs`），用以取代 v1.1.2 的单体 `npm test`。每个重型套件（MCP black-box、migration / backup / import、多进程 10,000-op 压力、打包产物 lifecycle）都拆为独立脚本与独立 CI job。

```bash
# 单元 / 集成层（默认；v1.1.3+ 契约）
npm test

# 重型套件（每个套件各有独立 vitest config）
npm run test:blackbox
npm run test:migrations
npm run test:stress
npm run test:packaged-artifact

# 确定性编排器（按规范顺序以子进程跑全部套件）
npm run test:all-suites
```

构建、类型检查、发布产物 glob 校验：

```bash
npm run build
npm run typecheck
npm run verify:artifacts
```

## 变更日志

阶段级变更记录在 [`CHANGELOG.md`](../../CHANGELOG.md)。v1.1.4 段落为最新发布头；v1.1.3 为上一发布。

> 历史 CHANGELOG 不提供中文翻译，请以英文原版为准。

## 本地校验

```bash
npm test -- test/e2e.test.ts
npm test
npm run typecheck
npm run build
git diff --check
```
