# Session 证据层 使用指南 (v1.2.0-alpha.1)

> 🌏 语言 / Language: 中文。English: [sessions.en.md](sessions.en.md)

本指南介绍 v1.2.0-alpha.1 引入的 **session 证据层** (issue #49) — AgentRecall 从"显式记忆控制面"演进到"记忆生命周期系统"时搭起来的输入端。Phase 1 把"agent 看见了什么 + agent 做了什么"这条原始数据流落库,Phase 2 (#50) 在上面跑 distillation 把原始事件蒸馏成可 reviewable 的候选。

## 这个子系统解决什么

coding-agent 在一次会话中会产生大量事件:`user_message` / `assistant_message` / `tool_call` / `tool_result` / `decision_confirmed` / `error` / `session_started` / `session_ended`。v1.2 之前这些事件只活在 agent 的 working memory 里,会话结束就没了。Session 证据层把"被 agent 看到 / 做过"的事**持久化**到一个 replay-safe 的 ledger,作为后续 distillation 的输入。

关键属性:

- **Replay-safe**: 同一个 `(source_kind, source_version, source_instance_id, source_session_id)` 重入 ingest 是 no-op;不同 body 会抛 `bundle_hash_drift`。
- **Content-addressed**: 事件正文存 head/tail 1KB 在 SQLite 行内(可 grep / 可 inspect),完整正文按 `content_digest` 寻址到本地文件;v0.5.0 的 portability bundle 会把这个本地文件也带上。
- **零突变到 live memory**: 证据层只写 `sessions` / `session_events` / `session_event_blobs` 三张表;memory 表在 candidate apply 之前**不被改动**(Phase 2 #50 显式契约)。
- **Secret scan + injection tag**: secret-like pattern 触发 `redaction_flags: ['contains_secret']`,prompt-injection pattern 触发 `risk_injection`。Distillation extractor 默认跳过这两类事件。

## 数据模型

```sql
sessions               -- 一个 session = 一行;primary key = session_id
session_events         -- 一个 event = 一行;primary key = event_id
session_event_blobs    -- content-addressed body cache;primary key = digest (= content_digest)
```

三张表通过 `session_events.session_id` ↔ `sessions.session_id` 和 `session_events.content_digest` ↔ `session_event_blobs.digest` 关联。

`UNIQUE (source_kind, source_version, source_instance_id, source_session_id)` 是 replay-safe 的契约。同一个 source-identity 重新 ingest 时:
- `bundle_hash` 相同 → 返回原 `session_id`,不写新行
- `bundle_hash` 不同 → 抛 `bundle_hash_drift`,整次 ingest 拒绝

## CLI 使用

```bash
# 把 JSONL bundle ingest 进来(从 OpenCode 钩子或 JSONL fixture 写出的)
agent-recall sessions ingest <bundle.jsonl>

# 列出现有 sessions
agent-recall sessions list

# 看单个 session 的元数据 + 事件列表
agent-recall sessions show <session_id>

# 看 ingest 的 plan counts (accepted / redacted / skipped / rejected)
agent-recall sessions inspect <session_id> --json | jq .plan

# 永久删除一个 session + 它的事件(危险操作;`--confirm` 必填)
agent-recall sessions forget <session_id> --confirm
```

### JSONL bundle 格式

```jsonl
{"schema_version":"1","bundle_id":"...","source_kind":"opencode","source_version":"1.0.0","source_instance_id":"...","source_session_id":"...","project_id":null,"actor_id":"...","client_name":"opencode","client_version":"1.0.0","scope":"global","sensitivity":"normal","started_at":"...","ended_at":"...","adapter_id":"jsonl","adapter_version":"1.0.0","events":[]}
{"schema_version":"1","source_kind":"opencode","source_version":"1.0.0","source_instance_id":"...","source_session_id":"...","project_id":null,"actor_id":"...","client_name":"opencode","client_version":"1.0.0","event_id":"evt_1","sequence":1,"turn_id":"turn-1","event_type":"user_message","role":"user","content":"...","content_digest":"sha256:...","timestamp":"...","sensitivity":"normal","redaction_flags":[],"metadata":{}}
...
```

Line 1 是 bundle header (`events: []`);后续每行一个 event。Zod schema 走共享的 `@agent-recall/contracts` 包 (`packages/contracts/src/sessions.ts` 7 个 schema)。任何 adapter (OpenCode, Claude Code, Codex, custom) 都按这个 shape 写。

## 大小上限 + 自动截断

| 项 | 上限 | 超限行为 |
|---|---|---|
| Per-event body | 256 KB | head/tail 1KB 截断;`redaction_flags: ['truncated']` |
| Per-session 累计 | 8 MB | 后续 event 标 `skipped` |

这两个上限在 `SessionService.ingest` 的 `planBundle` 纯 walk 中决定,行写入前完成,没有半写状态。`bundle_hash` 是 `bundle.events` 的 SHA-256,head/tail 截断后再算 — 这意味着同一个 bundle 在不同 ingest 路径上得到一致的 hash(replay-safe)。

## Secret scan + risk_injection

`SessionService.ingest` 在每条 event 的 `content` 上跑 `secret-detector.ts` 词表;命中的 pattern 替换为 `[redacted:<category>]`,原始 digest 保留。`prompt-injection` 模式(例如 "ignore previous instructions" / "disregard the system prompt")触发 `redaction_flags: ['risk_injection']`。

DistillationService 的 `DeterministicBaselineExtractor` 默认跳过 `redaction_flags` 包含 `risk_injection` 或 `contains_secret` 的事件 — 防止 secret / 注入污染候选候选集。

## MCP resource

```
agentrecall://sessions/{session_id}
```

返回该 session 的元数据 + 事件列表(只读)。MCP 客户端(OpenCode 插件)可以拉这个 resource 来做 in-context 回顾。

## 集成到 distillation pipeline

Phase 2 #50 的 `DistillationService.runOnBundle` 直接消费 `SessionService.inspect(session_id)` 的输出(见 `bundleFromSessionInspection`),无需任何额外的 bridge layer。`runOnce` 的执行器在 `extract` stage 跑 `DeterministicBaselineExtractor`,emit 的 candidate 写到 `derivation_candidates` 表(job_id 来自 `enqueueAndRunSessionDistill` 的 enqueue,run_id 来自 `startStage` 的返回值)。

## 不在本版本范围(留待后续)

- HTTP bridge `sessions` 端点 — Phase 3
- Admin app 的 session 浏览器 — Phase 3
- 跨 session 的对话链路追踪(需要 graph 层) — v1.3+
- 自动 compaction / GC(head/tail 1KB 行内数据,完整的 body 文件) — v1.3 maintenance
