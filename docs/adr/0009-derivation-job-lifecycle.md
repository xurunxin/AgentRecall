# ADR 0009: Derivation Job Lifecycle

- **Status**: Accepted
- **Date**: 2026-08-25
- **Issue**: #48 (Epic #47)
- **Phase**: v1.2.0-alpha.0
- **Supersedes**: —

## Context

AgentRecall v1.1.6 是一个显式的记忆控制面:`remember` / `search_memories` / `recall_context` / `plan_maintenance` / `apply_maintenance` 等操作全部是同步、原子、由用户触发的。v1.2 引入的会话蒸馏、Skill 抽取、冷启动 bootstrap、外部引用刷新则把 AgentRecall 推进到"可选的生命周期系统"维度 — 这类工作流有几个新特性:

1. **昂贵或 provider-backed** — 可能调用 LLM / embedding / 解析大量文件,不能像 `remember` 那样在一次 MCP 调用内完成。
2. **可取消 + 可恢复** — 用户在中间 Ctrl-C、进程崩溃、网络超时都需要恢复机制,不能丢失所有进度。
3. **多阶段** — window select → extract → validate → conflict → review → apply;每个阶段都有自己的输入 / 输出 / 失败模式。
4. **需要证据** — 每个产物必须能溯源到:源 session event、prompt/policy 版本、provider/model、output digest。没有证据 = 不可被任何 recall 信任。

直接给每个新功能写一套"自己的队列 + 自己的恢复 + 自己的 lineage"会出现三套不兼容的实现。本次决策是:先把通用的 job/run substrate 立起来,后续 #50 / #52 / #53 / #54 都基于这个 substrate 写执行器。

参考了 `TencentCloud/TencentDB-Agent-Memory` 的 async extraction queue + generation log 模式;**不复制** Redis / 服务栈,只借鉴语义。

## Decision

### 1. 三张 additive 表

```
derivation_jobs    -- 一次派生请求的真相(job_id / state / lease / cursor)
derivation_runs    -- 每个 stage 的审计行(started -> terminal)
derivation_outputs -- 产物血缘(连接 job -> memory / asset / plan / candidate)
```

均使用 `INTEGER` Unix 毫秒作为时间戳(与 v1.2 的 lease 数值运算匹配;v13 的 `import_batches` 仍保留 ISO 8601 字符串)。

### 2. 9 步执行契约(每个 executor 必须遵守)

1. **Reserve / replay** — `enqueue` 通过 `UNIQUE(creator_actor_id, kind, idempotency_key)` 实现重放;`(input_digest, config_digest)` 与已存在行不一致 → 抛 `idempotency_digest_mismatch`(issue #48 AC #3)。
2. **Claim** — 单笔 `BEGIN IMMEDIATE` 事务,UPDATE 谓词包含 `state='queued' OR (state='failed' AND next_retry_at IS NOT NULL AND next_retry_at<=now)`;两个 worker 抢同一个 job 只有一个赢。
3. **Read immutable inputs** — 读 `sessions` / `assets` / `memory_entries` 等只读路径,落 `input_refs_json`。
4. **Commit checkpoint** — `derivation_runs` insert 状态 `started`。
5. **Work outside txn** — Provider 调用 / 解析 / IO。
6. **Validate + commit** — 同一事务提交 `derivation_runs` finished + `derivation_outputs`(可选)+ `derivation_jobs.cursor_json`。
7. **Renew lease** — **不在中途续约**(见 §4)。
8. **Honor cancel** — `cancel_requested_at` 非空时,本 stage 完成后跳 §9,不在 stage 中途抢断。
9. **Terminal state** — `succeeded` / `failed` / `cancelled`;`redacted_error` 已 scrub。

### 3. lease 规则

- **TTL 默认 30s**(`DerivationJobStore.DEFAULT_LEASE_TTL_MS`)。在 `runOnce({lease_ttl_ms})` / `claim({lease_ttl_ms})` 可覆盖。
- **passive reap**:不引入后台 worker / 守护进程。每次 `listClaimable` / `claim` 之前先扫一次过期 lease,把 `state='running' AND lease_expires_at <= now` 的行重置为 `state='queued'` 并清 lease。
- **没有超时续约**:lease 续约会引入新 race;让每个 stage 必须在 TTL 内完成;TTL 选 30s 足够覆盖所有"纯本地 + 小 prompt"的 stage;Phase 2 #50 的 deterministic baseline extractor 完全本地,留 30s 是设计余量。Phase 3 #55 评测时如果发现需要更大 TTL 再放宽。

### 4. 取消语义

- `requestCancel(jobId)` 只写 `cancel_requested_at`;不动 `state`。
- 当前 stage 完成后,executor 检查 `cancel_requested_at`;非空 → 本 stage 标 `cancelled`,job 标 `cancelled`(走 `markCancelled`)。
- `renewDerivationJobLease` 的谓词包含 `(cancel_requested_at IS NULL OR cancel_requested_at > now)`,这样 cancel 信号在 stage 边界不会被覆盖。

### 5. reap-safe 重复写入

- `derivation_outputs.disposition='applied'` 的行在 `INSERT` 走 SQLite 的 `SQLITE_CONSTRAINT_UNIQUE` 兜底 — 复合主键 `(job_id, output_kind, output_id)` 拒绝任何重复。
- `insertDerivationOutput` 内部用 `isSqliteUniqueConstraintError` 吞掉 `UNIQUE` 错误(识别 `code` / `errcode` / `errno` / `message` 四种形态,跨 `node:sqlite` / `bun:sqlite` 鲁棒),返回 `false`,runner 据此把 reap 接管写为 no-op。
- 这是 issue #48 AC #2 + #5 的关键保障:进程崩溃后 lease 过期 → 第二个 worker 接管 → 它重写相同的 `applied` 产物时被 UNIQUE 拒绝 → 不重复写入已应用的 memory / asset。

### 6. Redacted error 规则

- `redactError(input)` 用 `secret-detector.ts` 既有词表(API key prefix / private key / bearer / env secret / high-entropy),匹配后替换为 `[redacted:<category>]`。
- 输出限长 2000 字符(`MAX_REDACTED_ERROR_LENGTH`)— 一个病态的 stack-trace 不会让 SQLite column 爆掉;完整 trace 仍可走 stderr。
- 原始 prompt / 完整 response body **永远不**落库,只持久化 `output_digest` + 200 字符 rationale(`truncateRationale`)。这与 Epic #47 "do not persist chain-of-thought" 一致。

### 7. 不引入

- **后台 worker daemon**:`--watch` 是显式 opt-in 的 CLI flag,默认 `runOnce` 跑一轮就退。
- **Redis / Kafka / 任何托管组件**:保持 AgentRecall 现有"本地优先 + SQLite only"承诺。
- **事件总线**:阶段间通过 DB row 状态推进,没有第二层真相源。
- **Coordinator service**:Epic #47 "non-goal: distributed queue / scheduler cluster"。

## Consequences

### 正面

- **Phase 1 / 2 不需要重新设计** substrate;`#49` 只需把 `sessions` 表的 row 写到 `derivation_inputs`(后续通过 `input_refs_json`);`#50` 只需写一个 `DeterministicBaselineExecutor`;`#53` / `#54` 同理。
- **多进程安全** 通过 SQLite 的 `BEGIN IMMEDIATE` + 谓词 UPDATE 实现,不依赖任何外部锁服务。
- **取消语义可观察**:job 的 `cancel_requested_at` 是显式列,MCP 客户端可以通过 `agentrecall://jobs/{id}` 资源看到 stage 何时被截断。
- **可重放**:`enqueue(idempotency_key, input_digest, config_digest)` 是 deterministic;同一个三元组 + 同样 digest → 同一 `job_id`;provider 调用的相同 input 必然产生相同 output(由 provider 自身保证,不在本 ADR 范围)。
- **零新依赖**:没有任何 npm 包新增;`package.json` 的 `dependencies` 仍是 2 个。

### 负面 / 待办

- **Stage 内长时间 work 仍受 TTL 约束**:如果一个 stage 因为 provider 超时跑超 30s,会被 reap 接管 — 这是设计意图,但要求 executor 自己实现 provider timeout(在 30s 内取消),不能依赖 substrate。
- **Reap 是被动的**:在大量 worker 闲置、claim 频率低的场景下,一个 crashed job 会等到下一次 claim 才被重新激活。可接受 — 与 Epic #47 "Normal AgentRecall use must not require a worker process" 一致。
- **`isSqliteUniqueConstraintError` 跨 runtime 鲁棒**:目前覆盖 `code` 字符串、`errcode`/`errno` 数值、message 文案;未来 `bun:sqlite` 升级到新版本如果改 error shape,需要再扩 helper。
- **cursor_json 是字符串列,无 SQL 索引** — cursor 是 executor 自己的 checkpoint,不需要按 cursor 查询。可接受。
- **`renewDerivationJobLease` 已实现但 Phase 0 未暴露** — `runOnce` 不调用它;后续 Phase 2 / 3 评测如发现 TTL 真的不够,再启用。

## Compliance

- 本 ADR 与 Epic #47 "Architectural invariants" 1–8 条全部一致。
- 与既有 ADR-0001 (`local-admin-capability-boundary`) / ADR-0006 (`one-sensitivity-policy`) 无冲突。
- 不改变 v13 schema 与现有 MCP tool 表面;`tools/schemas.ts` / `register-tools.ts` / `descriptions.ts` 零修改。
