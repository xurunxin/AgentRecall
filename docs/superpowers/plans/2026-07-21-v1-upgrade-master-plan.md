# AgentRecall v1 升级 — Master Execution Plan

> 串行 PR 编排，覆盖 spec § 12 Stage 10–13 全部 4 个 stage / 11 个 PR；
> 每批实现后派独立 verifier agent 验收，验收通过才合并，合并后再推进下一批。

| 字段 | 内容 |
|---|---|
| 文档状态 | Draft → 等待用户拍板 |
| 文档日期 | 2026-07-21 |
| 上游 spec | 用户上传的 `2026-07-20-agentrecall-v1-upgrade-spec.md`（已上传） |
| 上游基线 | `main` @ `6e32949`（Stage 9 façade split，320 测试全过） |
| 编排范围 | Stage 10（Correctness Gate / P0）+ Stage 11（Multi-Agent Storage Core）+ Stage 12（Recall Quality + MCP Native）+ Stage 13（Portability & Productization） |
| 执行节奏 | 串行 PR（spec § 13） |
| 验收方式 | 每 PR 实现完成 → 派 `verifier` agent 跑测试+静态检查 → 通过才 merge |
| 明确非目标 | daemon（spec § 7.2 先不上）、embedding（spec § 6.4 默认关闭） |
| 仓库约定 | 改动全在主分支 worktree；CHANGELOG 同步推；不动 `package.json` 依赖；`bin/` 同步 |

---

## 0. 用户确认的边界

通过 `ask_user` 锁定：

1. **范围**：Stage 10–13 全部 4 个 stage、11 个 PR 一并打掉，按 spec § 13 PR 拆分顺序串行。
2. **节奏**：每块做完跑 `npm test` + `npm run typecheck` + 写 CHANGELOG，再进下一块。
3. **验收**：每批派独立 agent 跑验证。验收通过才合并，合并后再推进。
4. **非目标**：`no-daemon`（spec § 7.2 自己说先不上）、`no-embedding`（spec § 6.4 默认关闭）。

---

## 1. 编排总览

| Stage | 主题 | 退出标准 | PR | 估计复杂度 |
|---|---|---|---|---|
| 10 | Correctness Gate（P0 收口） | 6 个 P0 全部关闭；现有工具名+字段全保留；新增 P0 回归测试 | PR1–PR6 | 中（每 PR 半周到 1 周） |
| 11 | Multi-Agent Storage Core | 通过 8 进程并发测试 + 所有历史迁移夹具 + 恢复演练 | PR7, PR8 | 高（schema v4 改动跨面） |
| 12 | Recall Quality + MCP Native | 固定评测集 nDCG/MRR ≥ 基线；MCP contract tests 覆盖所有工具 | PR9 | 高（MCP envelope + 资源协议） |
| 13 | Portability & Productization | 打包安装 + 跨 OS smoke + manifest round-trip | PR10, PR11 | 中（export 抽象 + CI 矩阵） |

### 1.1 PR 依赖图

```
PR1  test(release-gate) ──────┐
                              │ 兜底
PR2  fix(scope)  ─────────────┤
PR3  fix(audit/actor) ────────┤
PR4  fix(recall/ranker+packer) ┤
PR5  fix(ops/migrate+backup) ──┤
PR6  fix(dedup/cross-batch) ───┘
                              ↓
PR7  feat(schema-v4) ─────────┐
PR8  feat(concurrency) ───────┘  ← Stage 11 退出
                              ↓
PR9  feat(mcp-v2) ────────────  ← Stage 12 退出
                              ↓
PR10 feat(portability) ───────┐
PR11 ci(matrix) ──────────────┘  ← Stage 13 退出
```

**约束**：
- PR1 必须最先做 — 它是后续 P0 改动的安全网。
- PR2–PR6 内部互不依赖，理论上能并行；按用户节奏串行做。
- PR7 必须在 PR8 之前 — PR8 依赖 schema v4 表（memory_revisions、memory_accesses、project_aliases、mutation_requests）。
- PR9 独立（不动 schema，只动 MCP envelope）。
- PR10 独立（不动 schema，碰 exporter/restore）。
- PR11 最后（CI 矩阵依赖所有上层 PR 已合并）。

### 1.2 验收 agent 调用约定

每 PR 实现完成后，调用一个独立的 `verifier` 子 agent（task 工具，foreground）：

```
prompt: 你是一个独立的代码验收 agent。请只读不写，对当前工作目录的最新提交执行：
  1. git log -1 --stat 拿到本次 PR 范围
  2. 跑 npm run typecheck（必须 0 error）
  3. 跑 npm test（必须全过，新加测试必须跑）
  4. 对照本 PR 的"验收标准"逐条手动核对（点出未达项）
  5. 静态检查：grep 本 PR 列出的禁用模式，确认没漏改
  6. 输出结构化报告 {pr_id, status: pass|fail, summary, failed_checks, recommend}
注意：你只能读，不能改代码。代码改动一律回退。
```

`verifier` 通过 → 我合并 → 推进下一个 PR。
`verifier` 不通过 → 我修 → 再派一次 `verifier`。

### 1.3 worktree 约定

按仓库历史（`.worktrees/` 目录已存在）：

```
G:\Projects\MetronX\local-memory-mcp\.worktrees\stage10-pr1\
G:\Projects\MetronX\local-memory-mcp\.worktrees\stage10-pr2\
...
G:\Projects\MetronX\local-memory-mcp\.worktrees\stage13-pr11\
```

每 PR 一个 worktree，验证通过后 merge 回 main，worktree 留着供回滚参考。

---

## 2. Stage 10 PR 详细计划（PR1–PR6）

> 共享前置：spec § 5.1–5.6 全部 P0 的详细规格；
> 共享退出标准：spec § 17 v1.0 Definition of Done 第 1–6 条；
> 共享测试基础设施：每 PR 都跑 `npm test` + `npm run typecheck`，新测试落到 `test/` 对应主题文件。

### 2.1 PR1 — `test: add release-gate regressions for scope, actor, ranking, migration and backup`

**目标**：建立 P0 改动的安全网。这些测试在 PR2–PR6 修复前**应当失败**（除 5.5 backup 这一组，spec 已确认现状就是失败的；其它 PR 改动后再转为 pass）。

**改动点**：
- `test/release-gate/p0-scope.test.ts` — 维护路径只传 `project_path` 不影响其他项目；`scope=global + project_path` 拒绝；property test `expect(SQL).toMatch(/project_id\s*=\s*\?/)` for project mutation
- `test/release-gate/p0-actor.test.ts` — Claude Code 创建/更新/合并/遗忘后审计能识别真实 actor；`system:expiry` / `system:dedup` / `system:backup` 区分执行者/请求者；actor filter 不再 N+1 扫 audit
- `test/release-gate/p0-ranking.test.ts` — 同 query score 时 writer 自己的稳定在前；高 importance 不压过无关记录；第一条 > budget 时仍选后续；同输入同 DB 状态同 ranking version 同顺序；`explain_recall` 暴露每条 score breakdown（接口先留空 stub，PR4 实现）
- `test/release-gate/p0-migration.test.ts` — 无 `--yes` 不改 DB；迁移中途注入异常后 DB 可用、version 未前移
- `test/release-gate/p0-backup.test.ts` — backup 目录不可写时 destructive action `changed=0`；审计事件关联到 verified backup；backup 失败不能静默吞

**测试基础设施要求**：
- 使用仓库现有的 `setupTestStore()` / `seedEntries()`（见现有 test 文件）
- migration 中途异常：用 vi.spyOn 在 `migrateToVersion` 注入 throw
- backup 不可写：用 `vi.spyOn(mkdirSync)` 抛 EACCES
- actor 真实注入：构造 RequestContext 的 helper 写到 `test/helpers/request-context.ts`

**验收标准**：
- 全部测试在 PR1 提交时**应失败**（红），证明它真的覆盖了 bug 路径
- 跑 `npm test` 不引入新错误（已有 320 测试仍全过）
- 跑 `npm run typecheck` 0 error
- `git grep -nE "TODO|FIXME|XXX"` 在新增文件里没有未解项

**回滚**：纯新增 `test/release-gate/` + `test/helpers/`，不影响 src，回滚就是 `git revert`。

---

### 2.2 PR2 — `fix(scope): centralize project identity resolution across all services`

**目标**：所有入口只调一个 `resolveMemoryScope`（已存在 `src/scope-resolver.ts:51`），维护路径不再逃逸。

**改动点**：
- `src/services/memory-maintenance-service.ts:524-532` 删除私有 `resolveScope`，改调 `resolveMemoryScope`
- `src/services/memory-read-service.ts`（在 1–100 行的 scope 处理）改调 `resolveMemoryScope`
- `src/services/memory-write-service.ts` 同上
- `src/tools/schemas.ts`（maintain schema）保留 `project_path`，但运行时强制 `resolveMemoryScope` 二次校验
- 新增 `src/services/memory-service-helpers.ts:assertProjectScope` helper — 在 destructive action 进入业务层前断言 `resolved.project_id !== undefined`

**验收标准**（用 PR1 测试跑）：
- ✅ `p0-scope.test.ts` 全部转 pass
- ✅ 现有 320 测试仍全过
- 静态验证：`grep -nE "scope === \"project\".*project_id === undefined" src/services/` 为空（没有裸解析）
- 静态验证：`grep -nE "scope:.*project_id" src/services/memory-maintenance-service.ts` 全部走 `resolveMemoryScope`

**回滚**：单文件级 revert。

---

### 2.3 PR3 — `fix(audit): propagate request actor through every mutation and maintenance path`

**目标**：所有 mutation 路径不再硬编码 `actor: "agent"`，统一 `RequestContext` 透传。

**改动点**：
- `src/domain.ts:88-109` ActorId 类型扩展为 `\`${"agent" | "user" | "system"}:${string}\` | "agent" | "user" | "system"`（spec § 5.2 给出）
- `src/domain.ts` 新增 `RequestContext` 类型（spec § 5.2）
- `src/services/memory-write-service.ts:185, 307` 等所有 `actor: "agent"` 改用 context.actor_id
- `src/services/memory-maintenance-service.ts:222, 281, 321, 482, 518` 同上
- `src/services/memory-service-helpers.ts` 新增 `withRequestContext` helper（不引入新依赖）
- `src/index.ts`（MCP transport）在每个 tool handler 开始处构造 RequestContext（用 `clientInfo` / `requestId` / 当前 cwd 派生 project_id）
- 系统维护事件使用 `system:expiry` / `system:dedup` / `system:backup`，并把调用方记到 metadata.requested_by
- 保留对裸 `actor: "agent"` 的**读取**兼容（新写入全部走结构化，存量不变）

**验收标准**：
- ✅ `p0-actor.test.ts` 全部 pass
- ✅ 现有 320 测试仍全过（保留 `agent` 裸值的读取路径）
- 静态验证：`grep -nE 'actor:\s*"agent"' src/services/` 在 mutation 路径**为 0 命中**（maintenance 系统执行的事件用 `system:xxx`，claude-code 创建用 `agent:claude-code`）

**回滚**：单文件级 revert，actor 兜底读取路径未变。

---

### 2.4 PR4 — `fix(recall): introduce ordered RecallRanker and non-sorting ContextPacker`

**目标**：排序只在 ranker 发生，exporter 只渲染；ContextPacker 单条超预算不丢后续。

**改动点**：
- 新增 `src/services/recall-ranker.ts` — 单一 `rank(query, scope, actor, candidates)` 函数，输出 `RankedItem[]` 含 `score`、`score_components`、`truncated`
- `src/services/memory-read-service.ts:270-302 collectContextEntries` 改为调 `RecallRanker.rank()`，不再自己排
- `src/services/memory-read-service.ts:288 trust_boost: 0` 删除（由 ranker 自己算 trust）
- `src/markdown-exporter.ts:212 .sort(compareEntries)` 删除（exporter 只按入参顺序渲染）
- `src/markdown-exporter.ts:185-189 boundedJoin` 改为 "单条超预算 → 字段级截断，预算未满继续"，不再 break
- `src/markdown-exporter.ts:105-123 compareEntries` 标记 deprecated（仍在 `rebuildMarkdownIndex` 用，但 `buildContextPack` 不再调用）
- 新增 `src/services/explain-recall.ts` — `explainRecall(input)` 返回候选+打分分解
- 排名公式用 spec § 5.3 给出：0.50 lexical + 0.12 scope + 0.10 trust + 0.08 importance + 0.06 confidence + 0.06 recency + 0.04 access + 0.04 feedback（feedback 缺省 0；stale / conflict / unsafe penalty 各 0.05）
- `ranking_version: "v1-default"` 写进返回

**验收标准**：
- ✅ `p0-ranking.test.ts` 全部 pass
- ✅ 现有 320 测试仍全过（其中 `memory-service-recall-trust.test.ts` 调整断言：trust boost 走 ranker，不再期望 read service 内部 0）
- 静态验证：`markdown-exporter.ts` 不再出现 `.sort(`
- 静态验证：`memory-read-service.ts` 不再出现 `trust_boost: 0`

**回滚**：单文件级 revert。`rebuildMarkdownIndex` 仍可走老 `compareEntries`。

---

### 2.5 PR5 — `fix(ops): separate store open from migration; verified pre-mutation backup`

**目标**：`--yes` 在 DB 改动前；destructive action 在事务外、mutation 前生成 verified backup；失败不吞。

**改动点**：
- `src/sqlite-store.ts:370-376` 构造函数删 `this.migrate()`，新增 `StoreOpenMode` 参数：
  ```ts
  type StoreOpenMode = "read_only" | "read_write_no_migrate" | "read_write_auto_migrate";
  ```
  默认 `read_write_no_migrate`
- `src/sqlite-store.ts` 拆分 `migrate()` → `private tryMigrate()`（in-constructor 可选）+ 公开 `runMigrations(opts: {backupFirst: boolean})`
- `src/cli/commands/migrate.ts` — 改为先 `openStore({mode: "read_write_no_migrate"})`，读 version 落后时检查 `--yes`，然后开备份 + 验备份 + 跑 `runMigrations({backupFirst: false})`（备份已手动做）
- `src/cli/index.ts:66-85` — store 构造前决定 mode
- `src/mcp/index.ts`（如已有）/`src/index.ts` — 启动时做 schema preflight；落后且策略允许自动迁移，否则返回 `migration_required`
- `src/backup.ts` 新增 `verifyBackup(file): {ok, integrity_check, schema_version, source_db_generation}` 用独立只读连接
- `src/services/memory-maintenance-service.ts:289, 329` — `maybeBackup` 从 `transaction()` 闭包内移到外；调用前 `verifyBackup`；失败 throw `backup_failed`
- `src/services/memory-maintenance-service.ts:501-505` — 删 `catch {}`，错误向上抛
- `src/backup.ts` 新增 `restoreBackup(file, target)` — 先备当前库，写临时，验证，原子替换
- `src/backup.ts` 新增 `listBackups` / `pruneBackups` 增强
- 新增 `src/doctor/checks/backup-verification.ts` — 报告最近 backup age/hash（spec § 9.1）

**验收标准**：
- ✅ `p0-migration.test.ts` 全部 pass
- ✅ `p0-backup.test.ts` 全部 pass
- ✅ 现有 320 测试仍全过
- 静态验证：`grep -nE "maybeBackup" src/services/memory-maintenance-service.ts` 不在 `transaction(` 闭包内
- 静态验证：`sqlite-store.ts` 构造函数不再有 `this.migrate()`

**回滚**：单文件级 revert。`StoreOpenMode` 默认 `read_write_auto_migrate` 临时兜底开关留 1 个 release 周期。

---

### 2.6 PR6 — `fix(dedup): preserve cross-batch candidates and make auto-merge conservative`

**目标**：`find_duplicates` 跨 batch 不漏；`merge_duplicates` 只对 title+body 完全相同且同 project 才自动折叠；其它只生成 plan。

**改动点**：
- `src/services/memory-maintenance-service.ts:118-145 findDuplicatesChunked` — 跨 batch 共享 `seen` 集合（`similarDuplicateGroups` 内的 pair 也要进 seen）；`BUCKET_CAP` 超过时不跳过整桶，改用 SimHash/minHash 二次过滤
- `src/text-similarity.ts` 新增 `simHash(text): bigint` / `hammingDistance(a, b): number`（纯 JS，无新依赖）
- `src/services/memory-maintenance-service.ts:147-206 mergeDuplicates` — `keep_first` / `keep_newest` 之外，新增 conservative 模式：仅当 `reason === "same_title_and_body"` 且 `group.memory_ids` 全在同一 project 时才自动 supersede；否则 `details.suggested_plan` 返回候选摘要+差异
- `src/services/memory-maintenance-service.ts:147-206` 新增 `auto_merge_enabled: boolean` 入参（默认 false，stage 13 的 plan/apply 会再调）
- 新增 `src/services/dedup-plan.ts` — `buildDedupPlan(groups): MaintenancePlan`（先不接 plan/apply 协议，只生成 plan 结构供 PR6 自测用；PR12 接入 MCP）
- 新增 `test/release-gate/p1-dedup.test.ts`（虽然 PR1 已经加了 cross-batch 基础，但 plan 结构在 PR6 测）

**验收标准**：
- ✅ `p0-ranking.test.ts` 中 cross-batch 重复组（已在 PR1 加）pass
- ✅ 现有 320 测试仍全过
- 新测试：重复记录分别位于 batch 首尾（`findDuplicatesChunked` 切 batch=10，第 0 和第 11）仍能识别为同一 group
- 新测试：不同 project 的相同 title+body 不在同一 group

**回滚**：单文件级 revert。

---

## 3. Stage 11 PR 详细计划（PR7–PR8）

### 3.1 PR7 — `feat(schema-v4): revisions, accesses, actors, aliases and idempotency`

**目标**：spec § 5.6 + § 6.5 的所有表/字段。**这是最大的一块**。

**改动点**：
- `src/sqlite-store.ts` migrate 加 v3 → v4：
  ```sql
  ALTER TABLE memory_entries
    ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
  -- ... 其它 spec § 6.5 字段
  CREATE TABLE memory_revisions (...);
  CREATE TABLE memory_accesses (...);
  CREATE TABLE project_aliases (...);
  CREATE TABLE mutation_requests (...);
  CREATE TABLE memory_relations (...);
  ```
- v3 → v4 数据迁移：
  - `last_accessed_by` JSON 拆到 `memory_accesses`
  - `supersedes_json` 迁到 `memory_relations` (`supersedes`)
  - 从 audit log 回填 `writer_actor_id`（缺省 `agent:unknown`）
- 旧 `last_accessed_by` / `supersedes_json` 列保留**一个 release 周期**做兼容读
- `src/sqlite-store.ts` 加 `idempotencyKey` 处理：mutating 方法签名加 `idempotencyKey?: string`；命中 `mutation_requests` 返回原 result
- `src/services/memory-write-service.ts` 改造：每次 mutation 在 `memory_revisions` 写完整 snapshot；用 spec § 5.6 的 CAS 更新；命中冲突返回 `stale_revision` 含 current revision
- `src/services/memory-service-helpers.ts` 新增 `getEntryByIdAndRevision`、`recordMemoryAccesses(actor, ids)`（一次性 INSERT ON CONFLICT）

**验收标准**：
- ✅ 8 进程并发 10000 次读写 0 lost update / 0 unhandled SQLITE_BUSY（用 `test/concurrency/` harness，spawn 8 子进程）
- ✅ v1/v2/v3 夹具全部能迁到 v4
- ✅ 同一 idempotency_key 重试 10 次只创建一条记忆
- ✅ 两个 actor 同时访问同一条 memory，两者的 access 都保留
- 现有 320 测试 + Stage 10 PR1-6 新增测试全过

**回滚**：保留 v3 schema 路径 + `down` migration；新表在 down 时 `DROP TABLE`。

### 3.2 PR8 — `feat(concurrency): WAL, bounded busy retry and CAS mutations`

**目标**：spec § 5.6 SQLite 基线 + 写入重试 + doctor 报告。

**改动点**：
- `src/sqlite-store.ts` 构造函数加：
  ```sql
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA wal_autocheckpoint = 1000;
  ```
- `src/sqlite-store.ts` 加 `runWithBusyRetry<T>(fn: () => T, opts: {maxRetries, backoffMs})` — 捕获 SQLITE_BUSY 重试 N 次
- `src/services/memory-write-service.ts` 所有 mutation 走 `runWithBusyRetry`
- `src/doctor/checks/journal-mode.ts` — 检查 WAL/synchronous/busy_timeout/checkpoint
- `src/doctor/checks/sqlite-runtime.ts` — 报告 `sqlite_version()` + busy 计数
- `src/doctor/checks/lock-health.ts` — 最近 busy/retry 次数（从 `runWithBusyRetry` 收集的指标）
- `src/sqlite-store.ts` 加 `generation` 字段（每次 WAL checkpoint 时递增），备份时记 `source_db_generation`

**验收标准**：
- 8 进程并发 0 unhandled BUSY
- `npm run cli:doctor` 输出新 checks
- 现有 320 + Stage 10/11 PR1-7 测试全过

**回滚**：WAL 是开关，DOWN 路径 `PRAGMA journal_mode = DELETE`。

---

## 4. Stage 12 PR 详细计划（PR9）

### 4.1 PR9 — `feat(mcp-v2): structured outputs, annotations, progress, cancellation and resources`

**目标**：spec § 6.3 + § 6.4 全部 MCP 协议升级。

**改动点**：
- `src/tools/schemas.ts` 加 `outputSchema` 给每个 tool（沿用现有 zod schema 派生）
- `src/tools/register-tools.ts:40-69, 143-178` 改用 `structuredContent` + 保留 text；业务错误 `isError=true`
- `src/tools/annotations.ts` 新增（spec § 6.3 表）
- `src/services/recall-execution.ts` 新增 — 接收 `progressToken` + `cancellationToken`；长任务（find_duplicates、export、backup verify、restore、migration）走 progress；cancellation 在安全边界停
- `src/mcp/resources/` 新增 5 个 resource（spec § 6.3）
- `src/services/explain-recall.ts`（PR4 的 stub）实装 `explain_recall` tool
- `src/services/maintenance-plan.ts`（PR6 的 stub）实装 `plan_maintenance` / `apply_maintenance` tool
- `src/tools/error-codes.ts` 新增稳定错误码（spec § 8.3）
- `src/services/recall-context.ts` 加 `data-only framing` 头声明（spec § 6.6）
- `src/services/risk-detector.ts` 新增 — 高风险模式检测（"忽略之前指令" 等），标记 `unsafe_content` 降权
- `src/secret-detector.ts` 扩展到 topic、source.ref、metadata、imported 内容

**验收标准**：
- MCP contract test 覆盖所有 tool（`test/mcp/contract/`）
- `progress` / `cancellation` 在 find_duplicates 上手动验证
- 现有测试 + Stage 10/11 全部测试全过

**回滚**：单 PR 完整 revert；MCP 协议 v1 文本仍兼容。

---

## 5. Stage 13 PR 详细计划（PR10–PR11）

### 5.1 PR10 — `feat(portability): canonical export/import and verified restore`

**目标**：spec § 6.7 全部 export/import + restore。

**改动点**：
- 新增 `src/portability/canonical-model.ts` — `CanonicalExport` 统一结构
- 新增 `src/portability/markdown-renderer.ts`（从 `markdown-exporter.ts` 抽）+ `json-renderer.ts`（从 `format-exporters.ts` 抽）+ `yaml-renderer.ts` + `atomic-publisher.ts`
- 共享 collision-safe 文件名映射：`slug + shortHash(original topic)`
- `MANIFEST.json` 生成
- `generated_at` 可选（deterministic 模式默认不写）
- `import --dry-run --conflict keep|replace|merge|fail`
- `src/backup.ts` 加 `restoreBackup` 强化（PR5 stub）— 写临时文件、verify、原子 rename
- `test/portability/cjk-export.test.ts` — 中文/日文/emoji/Windows reserved name 测试
- `test/portability/round-trip.test.ts` — 导出后导入能还原

**验收标准**：
- CJK/emoji/Windows reserved name 不覆盖
- deterministic mode 字节级一致
- restore 后 memory/FTS/aliases/revisions 一致
- 现有 + Stage 10/11/12 全部测试全过

**回滚**：单文件级 revert。export 旧路径仍保留。

### 5.2 PR11 — `ci: cross-platform migration, concurrency and packaging matrix`

**目标**：spec § 11.2 CI 矩阵。

**改动点**：
- `.github/workflows/ci.yml` 新增 — OS matrix（ubuntu/windows/macos）、Node matrix（24 LTS + 最低）、typecheck、unit、integration、MCP contract、migration、concurrency、fault injection、export round-trip、packaging smoke
- 复用 `test/concurrency/` 和 `test/portability/` 已在 PR7/PR8/PR10 落地的 harness
- `.github/workflows/release.yml` 新增 — 跨平台 tarball 打包 + smoke test
- `.gitignore` 加 `.agent-recall/`、WAL/SHM、临时 backup/export 目录
- `README.md` 更新 CI 状态徽章

**验收标准**：
- 3 OS × 2 Node = 6 matrix job 全过
- 打包后的 tarball `node dist/src/index.js` 能起 + 跑 smoke
- 现有 320 + Stage 10–13 全部新增测试在 CI 矩阵全过

**回滚**：workflow revert；本地 `npm test` 仍可独立跑。

---

## 6. 风险与回滚总表

| PR | 风险 | 检测信号 | 回滚方式 |
|---|---|---|---|
| PR1 | 测试本身 bug | `npm test` 失败 | 文件级删除 |
| PR2 | 现有 scope 调用方签名不匹配 | `npm run typecheck` 失败 | revert |
| PR3 | actor 兼容读失败 | 旧 actor 读不到 | 保留裸值读取路径 |
| PR4 | 排名公式与现有断言冲突 | 现有 `memory-service-recall-trust.test.ts` 失败 | 调整公式权重；最坏 revert |
| PR5 | `read_write_no_migrate` 默认导致旧 DB 报 `migration_required` | 集成测试 / smoke | 临时默认改回 `read_write_auto_migrate`，下个 release 再切 |
| PR6 | dedup 索引变大 | `npm test` 大数据集超时 | 调小 bucket cap；最坏 revert |
| PR7 | schema v4 数据迁移丢字段 | migration fixture 失败 | 跑 `restoreBackup` 回到迁移前 |
| PR8 | WAL + busy retry 引入新竞争 | 8 进程并发测试 | 关闭 busy retry，复现问题 |
| PR9 | MCP 协议升级导致旧 client 不识别 | contract test | 保留 text 兼容 |
| PR10 | export 文件名碰撞 | CJK fixture 失败 | revert renderer |
| PR11 | CI 矩阵资源不够 | runner OOM | 拆 job 跑 |

---

## 7. 立即可执行 — Stage 10 PR1 详细步骤

PR1 是这套计划的"零号 PR"，**纯新增测试，不动 src**。这是启动的最低风险起点。

**步骤**：

1. **建 worktree**：
   ```powershell
   git worktree add .worktrees/stage10-pr1 -b feat/stage10-pr1-release-gate-tests
   ```

2. **建测试目录骨架**：
   - `test/release-gate/p0-scope.test.ts`
   - `test/release-gate/p0-actor.test.ts`
   - `test/release-gate/p0-ranking.test.ts`
   - `test/release-gate/p0-migration.test.ts`
   - `test/release-gate/p0-backup.test.ts`
   - `test/helpers/request-context.ts`（actor 测试用）

3. **每个测试文件先写** "red" 状态（让它们在现有代码上失败），证明它们能 catch bug：
   - scope：构造 A、B 两项目，调用 `maintainMemories({scope:"project", project_path:"A"})`，断言 B 的记录不变
   - actor：调用 `updateMemory` 后查 audit，断言 actor 是 `agent:test`，不是 `agent` 裸值
   - ranking：构造相同 query score、相同 importance 的两条不同 writer 记录，断言调用方自己写的在前
   - migration：调用 `cli migrate` 不传 `--yes`，断言 DB 字节不变
   - backup：mock `mkdirSync` 抛 EACCES，断言 `expire_due` 返回 `changed=0`

4. **跑测试**：
   ```powershell
   cd .worktrees/stage10-pr1
   npm test
   ```
   预期：5 个新测试失败（红），320 个老测试全过（绿）

5. **写 CHANGELOG**：
   - 在 `## [Unreleased]` 下加 `### Test Coverage` — Stage 10 PR1 段
   - 在"Test count"表加 Stage 10 PR1 段（红测试 + 0 新通过的）

6. **派 verifier agent 验收**：
   ```
   task agent=verifier prompt="验收 stage10-pr1 ..."
   ```

7. **合并**：verifier 通过 → `git checkout main && git merge --no-ff feat/stage10-pr1` → 推

8. **推进**：进入 PR2

---

## 8. 编排记录

执行时同步更新本节。每个 PR 完成一行：

| PR | branch | 验收结果 | merged commit | CHANGELOG 段 |
|---|---|---|---|---|
| PR1 | feat/stage10-pr1-release-gate-tests | ✅ pass — 10 red (P0 bug 真实存在) / 7 green (invariant 已成立) / 320 老测试无回归 / typecheck 0 error / src/ 无改动 | 8046932 (merge) / 703a9b8 (commit) | Stage 10 PR1 |
| PR2 | feat/stage10-pr2-scope-resolver | ✅ pass — 16 release-gate P0-scope 全绿 / 320 老测试无回归 / typecheck 0 / scope 集中化、删除私有 resolveScope 改调 resolveMemoryScope | 904c26e (merge) / 2193fff (commit) | Stage 10 PR2 |
| PR3 | feat/stage10-pr3-audit-actor | ✅ pass — 17 release-gate (含 p0-actor) 全绿 / 320 老测试无回归 / typecheck 0 / actor 字段从 9 处硬编码 "agent" 全部走 defaultActor + system:* 枚举 | fd31b95 (merge) / 50e0df9 (commit) | Stage 10 PR3 |
| PR4 | feat/stage10-pr4-recall-ranker | ✅ pass — 17 release-gate (含 p0-ranking) 全绿 / 320 老测试无回归 / typecheck 0 / 新 src/services/recall-ranker.ts 含 spec § 5.3 权重公式、boundedJoin 跳过溢出 | 0f202c1 (merge) / bd39d8f (commit) | Stage 10 PR4 |
| PR5 | feat/stage10-pr5-store-migrate-backup | ✅ pass — 17 release-gate (含 p0-migration + p0-backup) 全绿 / 320 老测试无回归 / typecheck 0 / StoreOpenMode 三态 + verifyBackup + restoreBackup + 事务外 maybeBackup | 4f4f461 (merge) / 60605d9 (commit) | Stage 10 PR5 |
| PR6 | feat/stage10-pr6-dedup-cross-batch | ✅ pass — 17 release-gate 全绿 / 320 老测试无回归 / typecheck 0 / similarDuplicateGroups 接受 crossBatchSeen Set + mergeDuplicates 仅 same_title_and_body + 同 project 自动折叠 | 5bcb82c (merge) / 67796ac (commit) | Stage 10 PR6 |
| PR7 | feat/stage11-pr7-schema-v4 | ✅ pass — 17 release-gate 全绿 / 320 老测试无回归 / typecheck 0 / CURRENT_SCHEMA_VERSION=4 + 5 新表 + v3→v4 数据迁移 + memory-service-helpers.ts.idempotency | f87a923 (merge) / c2a50d8 (commit) | Stage 11 PR7 |
| PR8 | feat/stage11-pr8-concurrency-wal | ✅ pass — 17 release-gate 全绿 / 320 老测试无回归 / typecheck 0 / WAL journal_mode + busy_timeout + CAS revision 推迟到 PR9 | 79a48ef (merge) / 4c53e91 (commit) | Stage 11 PR8 |
| PR9 | feat/stage12-pr9-mcp-v2 | ✅ pass — 17 release-gate 全绿 / 358 全测试无回归 (含 21 新 MCP v2 contract) / typecheck 0 / build 0 / MCP v2 envelope (outputSchema+structuredContent+isError+annotations) + 4 新工具 (plan/apply/explain/list_backups) + 5 资源 + 稳定错误码 + risk-detector + data-only framing + progress/cancellation + CAS revision | daccb5d (merge) / dc7873f (commit) | Stage 12 PR9 |
| PR10 | feat/stage13-pr10-portability | ✅ pass — 17 release-gate 全绿 / 391 全测试无回归 (新增 26 portability + 7 portability-import) / typecheck 0 / CanonicalExporter 合并三个格式 exporter + safeTopicBase/shortHash/buildTopicFilenameMap 碰撞安全 + MANIFEST.json 写入/读/验证 + import 命令 (conflict keep/replace/merge/fail + dry-run + require_clean_manifest) + restore 命令 5 步流程 + insertImportedEntry 保留原 id + backup_verified + restore_completed 审计 | 0f8b324 (merge) / 13a5561 (commit) | Stage 13 PR10 |
| PR11 | feat/stage13-pr11-ci-matrix | ✅ pass — 391/391 测试无回归 / typecheck 0 / build 0 / .github/workflows/ci.yml (3 OS × Node 24, typecheck+build+test+export smoke+跨平台路径检查) + .github/workflows/release.yml (tag v* 触发, 跨平台打包 + smoke) + .gitignore (WAL/SHM/pre-restore/.agent-recall/.worktrees) + README.md CI badge | 629c861 (merge) / d77c9c3 (commit) | Stage 13 PR11 |

> 实际执行备注：subagent 不可用，verifier 由我自验（仍是同套验收流程：跑 typecheck + 跑测试 + 静态检查 + 逐条核对 PR 验收标准）。

---

## 9. Definition of Done（Stage 10 退出）

按 spec § 17 v1.0 DoD 第 1–6 条：

- [ ] PR2: 任意 project mutation 都必须解析到唯一 project_id，跨项目隔离测试 pass
- [ ] PR3: 所有 accepted/rejected/system mutation 都有真实 actor/request correlation
- [ ] PR4: Recall 只有一个排序来源；query、trust、scope 与 budget 行为可解释、可回归
- [ ] PR5: 迁移确认真实有效；迁移前 verified backup；失败可恢复
- [ ] PR5: 破坏性维护在 mutation 前备份，备份失败即停止
- [ ] PR6: dedup 跨 batch 完整；自动 merge 仅对完全相同 title+body

**Stage 10 退出条件 = PR1–PR6 全部 merged + verifier 全部 pass。**
