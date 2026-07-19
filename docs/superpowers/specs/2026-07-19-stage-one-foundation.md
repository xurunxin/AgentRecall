# AgentRecall Stage One Foundation Spec

Date: 2026-07-19

Stage: 1 of 3 in the [2026-07-19 improvement plan](../plans/2026-07-19-agent-recall-improvements.md).

## Summary

把 agent-recall 从"只能通过 MCP 工具看"变成"自己也能看、自己也能查、有故障保护、有责任追溯"。本阶段交付五件互相独立、可以分批上线的事:

1. `agent-recall` CLI 子命令 (list / show / search / audit / doctor / export / backup)
2. `doctor` 一键体检 (integrity / schema / fts / disk / capacity / audit)
3. `actor` 字段结构化 + `AGENT_RECALL_ACTOR` env 兜底
4. Backup 机制 (每次维护后 + 手动 CLI，保留最近 14 份)
5. Tool description 全面重写为 trigger / shape / failure 三段式

这五件事共同回答一个核心问题:**个人用 + 跨 agent 共享前提下,没有运维时怎么自助排查、自助恢复**。

## 背景

之前的设计 spec ([2026-06-13-local-memory-mcp-design.md](./2026-06-13-local-memory-mcp-design.md)) 把 agent-recall 定义为"local single-user coding agent memory"。本 spec 进一步收窄前提:

- **个人工具** — 无 CI、无远程监控、无团队 review;出问题时只有用户一个人兜底。
- **跨 agent 共享** — 同一份 SQLite 可能被 Claude Code / Cursor / Codex / Aider 等多个 MCP 客户端同时持有连接。

这个前提直接淘汰了之前 [改进计划](../plans/2026-07-19-agent-recall-improvements.md) 里多项 P2/P3 工作 (CI / metrics / health tool / ADR / web UI 等)。本 spec 只解决这个前提下的最高优先级问题。

## Goals

- 用户在终端里能直接 `agent-recall list` / `show` / `search` / `audit` / `doctor`,无需启动 MCP 客户端
- `doctor` 一行命令定位"数据是否健康",有结构化退出码 (OK=0 / WARN=1 / FAIL=2)
- Backup 是**默认**而非可选 — 每次成功的 maintenance 之后,以及手动 `agent-recall backup` 都会留一份
- Audit log 的 `actor` 字段能区分具体是哪个 agent / 用户,跨 agent 责任可追溯
- 11 个 MCP 工具的 description 包含 trigger / shape / failure,新 agent 接进来能"看 description 就会用"
- 对外 MCP 协议 (tool 名称、schema、行为) **不变**

## Non-Goals

- 不做 web UI (阶段三之外不讨论)
- 不做 metrics / health 端点 (用 CLI doctor 替代)
- 不做自动 cron / 定时 backup (依赖外部 scheduler,例如 Task Scheduler / launchd)
- 不做跨设备同步 (V1 全局 non-goal)
- 不做 embedding / LLM 总结
- 不拆 `MemoryService` (阶段二)
- 不动 Zod / 手写校验的双层结构 (阶段二)
- 不引入新依赖 (Node 24 stdlib + 现有 `zod` / `@modelcontextprotocol/sdk` / `vitest` 之外不加)

## 范围与五件事的设计

### 1. CLI 子命令

#### 入口

- 新文件 `bin/agent-recall.ts`,TypeScript 源码
- 编译后产物 `dist/bin/agent-recall.js`
- `package.json` 增加 bin 字段:
  ```json
  "bin": {
    "agent-recall": "./dist/bin/agent-recall.js",
    "agent-recall-mcp": "./dist/index.js"
  }
  ```
  - `agent-recall-mcp` 保留旧名,避免破坏现有 MCP 客户端配置
  - 老的 `agent-recall` bin 字段含义(MCP server)改名,新 `agent-recall` 给 CLI 用
  - **风险点**: 已经配了 `"command": "agent-recall"` 的 MCP 客户端会从启动 MCP server 变成启动 CLI 失败
  - **对策**: README 写清迁移步骤;在 `dist/index.js` 启动时打 stderr 警告"deprecation: please use agent-recall-mcp"

#### 命令列表

| 命令 | 用途 | 关键参数 |
|---|---|---|
| `agent-recall list` | 列记忆 | `--scope` `--project-id` `--status` `--limit` `--offset` `--json` |
| `agent-recall show <id>` | 看单条 + audit history | `--json` |
| `agent-recall search <query>` | 全文搜索 | `--scope` `--project-id` `--limit` `--json` |
| `agent-recall audit <memory_id>` | 单独看 audit | `--json` |
| `agent-recall doctor` | 一键体检 | `--json` `--no-color` |
| `agent-recall export` | 手动触发 markdown 导出 | `--scope` `--project-id` `--out <path>` |
| `agent-recall backup` | 手动触发 backup | `--keep <n>` `--json` |
| `agent-recall migrate` | 显式执行 schema migration | `--yes` (跳过确认) |

#### 通用 flag

- `--data-home <path>` 覆盖 `AGENT_RECALL_HOME` / `LOCAL_MEMORY_MCP_HOME`
- `--json` 输出机器可读 JSON
- 颜色: 默认开启,`--no-color` / `NO_COLOR=1` 关闭
- 退出码: 0=成功, 1=用户错误(记忆不存在等), 2=数据错误 (doctor 失败等), 3=内部错误

#### 实现选型

- **不**引入 commander / yargs。Node 24 stdlib 加 50 行手写 arg parser 足够
- 输出库: stdlib only,手写 table formatter
- 不引 chalk (颜色用 ANSI escape 直写)
- 复用 `src/index.ts` 的 `createService()` 和 `resolveDataHome()`

#### 输出格式示例 (人类)

```
$ agent-recall list --scope project --project-id local-memory-mcp --limit 3
ID                                  TYPE       TOPIC          IMPORTANCE  UPDATED
mem_a1b2c3d4e5f6...                debugging  database       4           2026-07-19T08:14:22Z
mem_b2c3d4e5f6a1...                lesson     testing        3           2026-07-18T22:01:05Z
mem_c3d4e5f6a1b2...                procedure  release        5           2026-07-18T14:30:00Z

3 active entries (of 12 total in scope).
```

```
$ agent-recall doctor
agent-recall doctor @ 2026-07-19T20:01:00Z

[ OK ]  Data home              /home/me/.agent-recall (writable)
[ OK ]  SQLite integrity       ok
[ OK ]  Schema version         2 (latest)
[ OK ]  FTS index              142 rows in fts == 142 rows in memory_entries
[ OK ]  Backup directory       14 backups, newest 2h ago
[ OK ]  Disk free              42.1 GB available
[ OK ]  Audit log health       0 write_rejected in last 24h
[ WARN]  Capacity headroom      global active = 412/500 (82%)

Summary: 7 OK, 1 WARN, 0 FAIL. Exit 1.
```

### 2. doctor 子命令

#### 检查项

| # | 检查 | 实现 | 等级 |
|---|---|---|---|
| 1 | data home 存在且可写 | `fs.statSync` + `fs.accessSync` writable | FAIL if missing |
| 2 | SQLite integrity | `PRAGMA integrity_check` | FAIL if != "ok" |
| 3 | Schema version | 读 `PRAGMA user_version`,跟代码常量 `CURRENT_SCHEMA_VERSION` 比 | WARN if < latest; FAIL if user_version > latest (downgrade) |
| 4 | FTS 一致性 | `SELECT COUNT(*) FROM memory_fts` vs `memory_entries` | FAIL if 不等 |
| 5 | Backup 目录 | `backups/` 存在 + 列出最近 14 份 | WARN if 缺 / 最新 > 7 天 |
| 6 | Disk free | `fs.statfs` (Node 18.15+) | WARN if < 100 MB |
| 7 | Audit log health | `SELECT COUNT(*) FROM audit_events WHERE event='write_rejected' AND created_at >= now - 24h` | WARN if > 10; FAIL if > 100 |
| 8 | Capacity headroom | global / 每个 project 的 active 数量 / budget | WARN if > 80% |
| 9 | Actor 异常分布 | `SELECT actor, COUNT(*) FROM audit_events GROUP BY actor` 列出未知 actor | INFO (默认不报) |

#### 退出码

- 0: 全 OK
- 1: 有 WARN 无 FAIL
- 2: 有 FAIL

#### 性能

- 默认**不**跑 `VACUUM INTO` 或全表扫描
- 9 项检查应在 < 500ms 完成 (10k 条记忆规模)
- 后续可加 `--full` 触发 backup 副本对比 (阶段一不实现)

### 3. actor 字段结构化

#### 当前状态

```sql
actor TEXT NOT NULL CHECK (actor IN ('agent', 'user', 'system'))
```

#### 目标

字符串形式,中间用 `:` 分隔:

| 旧值 | 新值 (示例) |
|---|---|
| `agent` | `agent:claude-code` / `agent:cursor` / `agent:codex` |
| `user` | `user:me` |
| `system` | `system:cleanup` / `system:expiry` |

#### 解析优先级

`remember` / `update` / `forget` 写入 audit 时,actor 解析顺序:

1. 入参里显式传的 actor (e.g. `remember` 的 source 加 `actor` 字段,或 audit-level override)
2. `AGENT_RECALL_ACTOR` env
3. 兜底 `agent:unknown`

CLI 子命令 (手动 `backup` 等) 默认 `user:cli`。

#### Schema migration v2

```sql
-- 在 PRAGMA user_version = 1 → 2 时执行
PRAGMA writable_schema = ON;
UPDATE sqlite_master
SET sql = replace(sql,
  "actor TEXT NOT NULL CHECK (actor IN ('agent', 'user', 'system'))",
  "actor TEXT NOT NULL")
WHERE type = 'table' AND name = 'audit_events';
PRAGMA writable_schema = OFF;
PRAGMA user_version = 2;
```

- 旧值 (`agent` / `user` / `system`) 仍合法,新的 audit 写入新格式
- Migration **不**自动跑,MCP server 启动时只检查,doctor / `agent-recall migrate` 显式触发

#### 受支持的 actor name (推荐清单,非强制)

- Agent: `claude-code` / `cursor` / `codex` / `aider` / `cline` / `continue` / `windsurf` / `roo-cline` / `copilot`
- User: `user:cli` / `user:editor`
- System: `system:expiry` / `system:archive` / `system:dedup` / `system:doctor` / `system:backup` / `system:migration`

清单 hardcode 在 `src/actor.ts`,不读 config。

### 4. Backup 机制

#### 触发

| 触发条件 | 行为 |
|---|---|
| `maintain_memories` 工具调用成功 + `changed > 0` | 自动 backup |
| `agent-recall backup` CLI | 手动 backup |
| `agent-recall doctor` 检查项 5 | 只读,不触发 backup |

#### 实现

```ts
// 伪代码
function backup(db: DatabaseSync, targetPath: string): { size: number; path: string } {
  // VACUUM INTO 必须在事务外执行,会用 EXCLUSIVE 锁
  db.exec(`VACUUM INTO '${targetPath.replace("'", "''")}'`);
  return { size: statSync(targetPath).size, path: targetPath };
}
```

- 输出路径: `backups/<ISO-timestamp-without-colons>.sqlite`
- 时间戳格式: `2026-07-19T20-01-00Z` (冒号替换成 `-` 兼容 Windows 文件名)
- 写完后跑 `PRAGMA quick_check` 验证副本可读 (不验证 `integrity_check`,太慢)
- 写 audit event: `event: "backup_created"`, metadata 含 `path` / `size` / `duration_ms`

#### 保留策略

- 保留最近 14 份 (`keep = 14`,可被 `--keep N` 覆盖,默认 14)
- 删除逻辑: 按文件名字母序 (= 时间序) 排序,超过 `keep` 份的删
- 删除失败不阻塞,记 stderr warning
- **不**做"每周日保留一份"等复杂策略 (阶段一够用)

#### 失败处理

- Backup 失败: 主操作 (e.g. `maintain_memories`) **不**回滚,仅 warning 写到 stderr + 写 audit event `event: "backup_failed"`, metadata 含 `error` 字符串 (不含 SQL 等敏感信息)
- Disk 满:VACUUM INTO 会抛错,被 catch 包装成 `BackupError`

#### 性能

- 10k 条 / 5MB SQLite → VACUUM INTO 约 200ms (本地 SSD 估测)
- 期间其他 agent 写入会卡 — README 明示,考虑阶段二 chunked backup

### 5. Tool description 重写

#### 格式约定

每个 tool 的 description 包含三段:

```
[TRIGGER] <when to call this tool>

[INPUT] <shape summary in one line>

[OUTPUT] <what the agent will get back>

[FAILURE] <common failure modes and how to recover>
```

每段最多 80 字符,总长上限 400 字符。

#### 当前 11 个 tool 全部重写

重点改的 (其他可以保持接近现状):

| Tool | 现状问题 | 重写要点 |
|---|---|---|
| `recall_context` | 没说返回 markdown 格式、agent 怎么消费 | 强调"返回 markdown context pack,直接拼到 system prompt" |
| `remember` | 没说 capacity / duplicate 怎么 fallback | 强调"先 search 再 remember;capacity_exceeded 时跑 maintain_memories" |
| `search_memories` | 没说 limit 默认值、score 排序 | 强调"默认 limit 10,按 bm25 排序" |
| `get_memory` | 没说返回 audit history | 强调"同时返回 audit 链" |
| `list_memories` | 没说默认 status=active | 强调 |
| `update_memory` | 没说 `id` / `memory_id` 别名 | 强调"memory_id 优先" |
| `supersede_memory` | 没说原子性保证 | 强调"新条目创建 + 旧条目 supersede 是同一事务" |
| `forget_memory` | 没说释放字符 | 强调"body 清空但 id 保留,审计可追" |
| `get_memory_budget` | 没说 `cleanup_candidates` 用途 | 强调"cleanup_candidates 是建议,需要显式调用 forget_memory / update_memory" |
| `maintain_memories` | 没说 5 个 action 的差异 | 强调"action 决定行为,expire_due 会自动 forget_memory" |
| `export_memory_context` | 跟 recall_context 重复 | 强调"返回完整 markdown 文档,用于人读;agent 任务开始用 recall_context" |

#### 实现

- 新建 `src/tools/descriptions.ts`,导出 `memoryToolDescriptions: Record<MemoryToolName, string>`
- `register-tools.ts` 改用这个新 map
- `memoryToolDescriptions` 之前在 `register-tools.ts` 里内联,删除

## 数据模型 / Schema

### 当前 schema_version = 1 (隐式)

SQLite 没有显式 version。Stage 1 引入:

- `PRAGMA user_version` 跟踪当前 schema 版本
- `CURRENT_SCHEMA_VERSION = 2` 写在 `src/sqlite-store.ts`
- migration 函数: `migrate_v1_to_v2()`
- 启动流程:
  1. `PRAGMA user_version` → 读到 current version
  2. 顺序跑 `migrate_vN_to_vN+1` 直到 = CURRENT_SCHEMA_VERSION
  3. **不**自动跑 (除非 `AGENT_RECALL_AUTO_MIGRATE=1`)

### v1 → v2 变化

只放宽 `audit_events.actor` CHECK 约束。详见上文"actor 字段结构化"。

### v2 之后预留

- `merge_memories` (阶段二) — 可能需要 `merged_into` 字段
- `last_accessed_by_agent` (阶段二) — 需要新表
- 当前阶段不预留,避免无谓 schema 变动

## 文件 / 模块变化

### 新增

```
bin/
  agent-recall.ts                     # CLI 入口

src/cli/
  index.ts                            # 命令分发
  arg-parser.ts                       # 手写 arg parser
  format.ts                           # 人类/JSON/颜色输出
  commands/
    list.ts
    show.ts
    search.ts
    audit.ts
    doctor.ts
    export.ts
    backup.ts
    migrate.ts

src/doctor/
  index.ts                            # orchestrator
  checks/
    data-home.ts
    integrity.ts
    schema-version.ts
    fts-consistency.ts
    backup-directory.ts
    disk-free.ts
    audit-health.ts
    capacity-headroom.ts
    actor-distribution.ts

src/backup.ts                         # VACUUM INTO + 保留策略
src/actor.ts                          # actor 解析 (参数 → env → 兜底)
src/tools/descriptions.ts             # 重写后的 tool description
```

### 修改

```
src/index.ts                          # 拆 createService / main 复用
src/sqlite-store.ts                   # schema migration 拆版本,引入 CURRENT_SCHEMA_VERSION
src/memory-service.ts                 # appendAudit 接受新 actor 格式;不主动改 public API
src/tools/register-tools.ts           # 用新 descriptions
package.json                          # bin 字段、scripts
README.md                             # 补 CLI 章节、迁移提示
```

### 不修改

- 11 个 MCP tool 的 schema, name, 行为
- `write-validator.ts` / `budget-governor.ts` / `scope-resolver.ts` / `secret-detector.ts` / `markdown-exporter.ts` / `domain.ts`
- 测试:已有 `test/e2e.test.ts` / `memory-service.test.ts` / 等保持绿,只追加新测试

## API 稳定性承诺

- 11 个 MCP tool 的 name / schema / 返回结构 **不变**
- 工具 description 变 (用户能感知,但 agent 多能自适应)
- SQLite 表结构向后兼容 (v1 → v2 只放宽 CHECK 约束,旧数据可读)
- Audit actor 取值集合扩展 (向后兼容)
- 新增 CLI 是纯增量,不影响 MCP server
- `package.json` 的 bin 字段调整 (把 MCP server 重命名) 是破坏性,README 写清迁移

## 测试计划

### 单元 / 集成

```
test/cli/list.test.ts                 # 5 个 case
test/cli/show.test.ts                 # 4 个 case (存在 / 不存在 / --json / 颜色)
test/cli/search.test.ts               # 5 个 case
test/cli/audit.test.ts                # 3 个 case
test/cli/doctor.test.ts               # 6 个 case (全 OK / 损坏 / 缺备份 / 容量 / schema / 磁盘)
test/cli/backup.test.ts               # 4 个 case
test/cli/migrate.test.ts              # 3 个 case (v1 → v2 / 幂等 / 失败)
test/cli/arg-parser.test.ts           # 8 个 case (--flag / positional / --key=value / 颜色)
test/doctor.test.ts                   # 9 个 check 单独 unit test
test/backup.test.ts                   # VACUUM INTO / 保留策略 / 失败
test/actor.test.ts                    # 优先级 / 推荐清单 / 兜底
test/sqlite-store-migration.test.ts   # 跨版本升级 / 降级报错
test/memory-service-actor.test.ts     # audit 写入新 actor 格式
test/tools-descriptions.test.ts       # 11 个 tool 的 description 长度 / 三段格式
```

### 已有测试

- `test/e2e.test.ts` 必须保持绿
- `test/memory-service.test.ts` 必须保持绿
- `test/tool-registration.test.ts` 必须保持绿 (description 重写不影响 schema)

### 性能 smoke

- 10000 条记忆下,`doctor` < 500ms
- `agent-recall list --limit 100` < 200ms
- backup (5MB SQLite) < 1s

## Verification

```bash
npm run typecheck
npm run build
node bin/agent-recall.js --help
node bin/agent-recall.js doctor
node bin/agent-recall.js list --limit 5
node bin/agent-recall.js search "test" --limit 3
node bin/agent-recall.js backup
node bin/agent-recall.js doctor       # 验证 backup 检查项 OK
npm test
git diff --check
```

## 风险与对策

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| 1 | `bin` 字段把 `agent-recall` 从 MCP 入口改到 CLI | 已配 MCP 客户端失效 | 保留 `agent-recall-mcp` 别名;README 写迁移;`dist/index.js` 启动打 stderr 警告 |
| 2 | `VACUUM INTO` 期间持 EXCLUSIVE 锁 | 跨 agent 卡 100ms~几秒 | README 明示;backup 失败不阻塞主操作 |
| 3 | `writable_schema = ON` 改 CHECK 约束是 SQLite 官方支持但不常用 | migration 失败风险 | 在 test 里覆盖 v1 → v2 / v2 → v2 幂等;失败回滚到迁移前 backup |
| 4 | actor 自由字符串 → 数据脏 | 审计混乱 | 推荐清单 + doctor 报告 actor 分布;不强制 |
| 5 | Tool description 改变 → 已有的 agent 训练 / prompt 失效 | agent 行为变化 | description 是文档级变更,agent 多能自适应;但建议在 CHANGELOG / commit message 写清 |
| 6 | 启动时不自动 migrate,用户忘了跑 | 新版本起不来 | 启动时打 stderr 警告 + exit code 提示;doctor 默认跑 migrate-dry-run 检查 |
| 7 | Windows 路径 / 颜色 ANSI | 体验差 | 颜色默认开 + `NO_COLOR` env 尊重;文件路径用 `path.join` |
| 8 | 14 份 backup 占空间 | 磁盘满 | 默认 14 份,用户可通过 `AGENT_RECALL_BACKUP_KEEP` env 调小 |

## 实施顺序 (建议 commit 切分)

1. `actor.ts` + `src/memory-service.ts` 改 appendAudit 接受新格式 (纯增,不动 schema)
2. `src/sqlite-store.ts` 引入 `CURRENT_SCHEMA_VERSION` + `migrate_v1_to_v2()` (v1 → v2 仍是 no-op,actor 还在白名单里)
3. `src/tools/descriptions.ts` + `register-tools.ts` 改 description
4. `src/backup.ts` + 在 `MemoryService.maintainMemories` 里 hook backup
5. `src/actor.ts` 解析 + `src/index.ts` 读 env
6. `src/doctor/` 9 个 check + orchestrator
7. `src/cli/` 8 个命令 + arg parser + format
8. `bin/agent-recall.ts` 入口
9. `package.json` bin 字段调整 + scripts
10. README 补 CLI 章节、迁移提示
11. 测试: 先 actor → backup → doctor → cli 顺序写
12. e2e 跑通,提交

每步可独立提交、单独跑测试。actor + description + backup 的代码改动不会让已有 e2e 红;doctor / cli 是纯新增。

## 开放问题

1. **MCP server 启动时是否 auto-migrate?** 当前倾向"不自动,doctor 提示",但用户可能忘记。是否要在启动时检测到 version mismatch 时 stderr 警告但不阻塞?
2. **`AGENT_RECALL_ACTOR` 怎么传播给 MCP server?** 取决于每个 agent 启动 MCP server 时是否把 env 传过去。Claude Code 传 env 容易,Cursor 通过 JSON 配置 env 字段。需要在 README 写每个 agent 的 env 配法
3. **Backup 是否跨 platform 测试?** VACUUM INTO 行为在 Windows / macOS / Linux 上一致,但路径处理有差。CI 上至少跑 macOS + Linux;Windows 手动测
4. **CLI 错误信息的 i18n?** 阶段一保持英文 (跟 MCP 错误一致),后续看 user 是否需要中文

## 后续阶段 (本 spec 不实现,仅记录依赖)

- 阶段二依赖:
  - `merge_memories` 工具 — 需要 actor 已经在 audit 里能区分 agent
  - `remember` 重复警告升级 — 需要 doctor / CLI 能查 actor 来源
  - `MemoryService` 拆 façade — 不依赖本阶段
  - 维护操作 chunked — 不依赖本阶段
- 阶段三依赖:
  - `import` 子命令 — 用本阶段的 CLI 框架
  - Markdown 格式可调 — 不依赖本阶段
  - PII 检测 — 不依赖本阶段
  - 软冲突 detection — 需要 actor 来源
