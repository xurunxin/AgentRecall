# Derivation Jobs 使用指南(v1.2.0-alpha.0)

> 🌏 语言 / Language:中文。English: [jobs.en.md](jobs.en.md)

本指南介绍 v1.2.0-alpha.0 引入的 **derivation job** 子系统 — AgentRecall 从"显式记忆控制面"演进到"记忆生命周期系统"时搭起来的执行基底。Phase 0 #48 只交付 substrate(任务、状态机、lease、reap、redaction);Phase 1 / 2 会在上面写具体的执行器(session 蒸馏、Skill 抽取、bootstrap 扫描等)。

## 这个子系统解决什么

v1.2 引入的工作流有三个共性: **昂贵 + 可中断 + 多阶段 + 需要证据**。直接给每个工作流写一套"自己的队列 + 自己的恢复 + 自己的血缘"会出现三套不兼容的实现。`derivation job` 子系统把这层通用逻辑抽出来:

- 一次 derivation 请求 = 一个 `derivation_jobs` 行,带幂等键 + 输入指纹 + 配置指纹;
- 每个 stage = 一个 `derivation_runs` 行,带 `started_at` / `finished_at` / `policy_version` / `provider_id`;
- 每个产物 = 一个 `derivation_outputs` 行,带 `(job_id, run_id, output_kind, output_id, disposition)`,与 memory / asset 表形成血缘。
- 多进程互斥靠 SQLite `BEGIN IMMEDIATE` + lease;**不需要 Redis / 任何外部组件**。

## 三种入口

Phase 0 暴露三个等价入口:

1. **CLI**:`agent-recall jobs list | show | cancel | run`
2. **MCP resource**:`agentrecall://jobs/{job_id}`(只读,返回 job + runs + outputs 三块 JSON)
3. **程序化**:从 Node 直接 `import { DerivationJobStore } from 'agent-recall/jobs/service.js'`,传入 `SQLiteMemoryStore` 实例

CLI / MCP / 程序化三个入口共享同一份 `DerivationJobStore`,因此 `enqueue` / `claim` / `cancel` 的语义在所有入口都一致。

## 状态机

```
        enqueue
          │
          ▼
       queued ──claim──▶ running ──complete──▶ succeeded
          │               │   │
          │               │   └──fail─────▶ failed (next_retry_at? ──re-claim──▶ queued)
          │               │   │
          │               │   └──markCancelled─▶ cancelled
          │               │   │
          │               │   └──requestCancel (cancel_requested_at)
          │               │
          └──────────────reap expired lease────────────▶ queued
```

关键不变量:

- 同一 `(creator_actor_id, kind, idempotency_key)` + 同 `(input_digest, config_digest)` → 同一 `job_id`;**不同 digest → `idempotency_digest_mismatch` 异常**(确定性拒绝)。
- `running` 的 job 必须有 `lease_owner` + `lease_expires_at`;lease 过期 = 可被 reap 接管。
- `failed` 状态需要 `next_retry_at IS NOT NULL` 才会被 re-claim;**没有 next_retry_at 的 failed 是终态**,不会被再次取出。
- `cancel_requested_at` 只在 stage 边界被消费,不在 stage 中途抢断。

## 端到端示例

### 1. 写一个 derivation 调用(伪代码 — Phase 2 才有真实 executor)

```ts
import { DerivationJobStore, DEFAULT_LEASE_TTL_MS } from "agent-recall/jobs/service";
import { SQLiteMemoryStore } from "agent-recall/sqlite-store";
import { createHash } from "node:crypto";

const store = new SQLiteMemoryStore(`${process.env.AGENT_RECALL_HOME}/memory.sqlite`);
const jobs = new DerivationJobStore(store);

// 1. enqueue — 计算 input / config 指纹
const inputDigest = "sha256:" + createHash("sha256").update(JSON.stringify(input)).digest("hex");
const configDigest = "sha256:" + createHash("sha256").update(JSON.stringify(providerConfig)).digest("hex");

const { job, replayed } = jobs.enqueue({
  kind: "session_distill",       // Phase 2 才会有的执行器
  scope: "project",
  project_id: "proj_alpha",
  creator_actor_id: "user:dev",
  idempotency_key: "distill-2026-08-25-001",
  input_digest: inputDigest,
  config_digest: configDigest
});

if (replayed) {
  console.log("Already enqueued:", job.job_id);
}
```

### 2. 注册一个执行器(Phase 0 已有空 executor,Phase 2 才有真实 kind)

```ts
import { runOnce, makeLeaseOwner } from "agent-recall/jobs/runner";

const result = await runOnce(store, [
  {
    kind: "session_distill",
    execute: async ({ job, startStage }) => {
      // 1. 读 immutable inputs(在事务外,大量 IO 在这里)
      const stage = startStage("window_select", [{ kind: "session_event", id: "evt_1" }]);
      // 2. 解析
      const outputs = await doExtraction(job);
      // 3. 落产物
      stage.finish("succeeded", "sha256:abc", [
        { output_kind: "candidate", output_id: "cand_1", disposition: "proposed" }
      ]);
      return { status: "succeeded" };
    }
  }
], {
  lease_owner: makeLeaseOwner(),
  lease_ttl_ms: 30_000,
  max_jobs: 16
});

console.log(result);
// { attempted: 1, succeeded: 1, failed: 0, cancelled: 0 }
```

### 3. CLI 视角

```bash
# 列出所有 job
agent-recall jobs list

# 查看单个 job 的 detail(runs + outputs 完整列表)
agent-recall jobs show job_<uuid>

# 在 worker 跑之前请求取消(runner 在下个 stage 边界处理)
agent-recall jobs cancel job_<uuid>

# 同步跑一轮(本期没有真实 executor,会标 failed;Phase 2 之后才会 succeeded)
agent-recall jobs run --kind session_distill --json
```

### 4. MCP 视角

读取一个 job 的完整状态(供 admin app / 客户端使用):

```jsonc
// 资源:agentrecall://jobs/{job_id}
// 返回:
{
  "ok": true,
  "job":   { "job_id": "...", "kind": "session_distill", "state": "succeeded", ... },
  "runs":  [ { "run_id": "...", "stage": "window_select", "status": "succeeded", ... } ],
  "outputs": [
    { "job_id": "...", "run_id": "...", "output_kind": "candidate",
      "output_id": "cand_1", "disposition": "proposed" }
  ]
}
```

## 常见诊断

### "我 enqueue 了一个 job 但 list 看不到"

1. 检查 `agent-recall migrate` 是否把 schema 升到 v14(`SELECT user_version FROM pragma_user_version;` 在 sqlite3 CLI 下查看)。
2. 检查 `--json` 的 list 输出 `state` 字段:`queued` 才算入队成功。
3. 检查 `creator_actor_id` / `kind` / `idempotency_key` 三元组是否与已有行撞上 — 撞上会返回原 `job_id` 而不是新行。

### "两个 worker 抢同一个 job,都 claim 成功了"

这不应该发生:claim 是单笔 `BEGIN IMMEDIATE` 事务,谓词里有 lease 过期检查。如果你看到这种现象:

1. 确认两个 worker 用的不是同一个 SQLite 文件(共享 data home);
2. 确认两个 worker 的 SQLite WAL mode 生效了(`PRAGMA journal_mode=WAL`);AgentRecall v1.1.x 默认开 WAL。

### "我的 job 一直卡在 running"

可能是上一个 worker 崩溃但 lease 还没过期(默认 30s)。等 30s 后再跑一次 `runOnce` — 内部 `reap()` 会把过期的 `running` 行重置为 `queued`。或者主动 cancel 一次(但 cancel 只在 stage 边界生效,如果 stage 本身在僵死,需要等 reap)。

### "我重放了同一个 idempotency_key 但改了 input,被拒绝了"

这是预期行为(issue #48 AC #3):同 key 不同 digest = 不同的 derivation 请求,应该走新的 `idempotency_key`。如果你真的想重跑,用新的 key(例如 `distill-2026-08-25-002`)。

### "我想知道某个 memory 是哪个 job 产的"

查 `derivation_outputs` 表,`WHERE output_id = ? AND output_kind = 'applied_memory' AND disposition = 'applied'`。JOIN `derivation_runs` 拿到 stage 信息,JOIN `derivation_jobs` 拿到 input_digest / config_digest / creator。Phase 3 #55 评测工具会暴露这个查询;Phase 0 没有 UI 入口,只能直接 SQL。

## 与现有工具的关系

- `remember` / `search_memories` / `recall_context` 不变。Phase 0 没有任何用户可见行为变化。
- `apply_maintenance` 仍走 `maintenance_plans` / `maintenance_plan_items`(v6 schema),不通过 derivation substrate。
- `import_batches`(v13)仍走原路径;v1.2 的 session ingest 走 #49 的新表 + derivation job 提交,不在本指南范围。
- v1.1.x 的 OpenCode plugin 直接读 SQLite 做 prompt 注入,行为不变。Phase 2 #52 才会改成调共享装配器。

## 不在本指南范围

- 具体执行器的实现(`#50` / `#53` / `#54` 在 Phase 1 / 2 落地)
- HTTP bridge 的 `jobs` 端点(Phase 2 之后)
- Admin app 的 Job 浏览 / 候选审核界面(Phase 2 之后)
- `--watch` 循环(等 Phase 2 #54 bootstrap planner 一并实现)
- 评测 / 灰度指标(Phase 3 #55 收口)
