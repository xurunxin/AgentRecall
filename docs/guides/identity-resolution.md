# 项目身份解析

> **🌏 语言 / Language**: 中文。English: [`identity-resolution.en.md`](./identity-resolution.en.md)。  
> **当前实现版本 / Implementation version**: v1.1.2(身份解析契约 GATE-01,v1.1.6 仍按此执行)。

本指南说明如何在 AgentRecall 的"默认严格"身份模型下注册项目(v1.1.2 / issue #21 引入,v1.1.3 GATE-01 / issue #31 加固)。它是 [`docs/adr/0004-identity-resolution-modes.md`](../../adr/0004-identity-resolution-modes.md) 的运维侧配套文档,ADR 描述三种模式 + 规范注册路径。

## TL;DR

- **项目级读 / 写默认严格。** 未绑定已注册身份的 `project_id`,或别名指向另一 `project_id` 的 `project_path`,会在写入任何行之前在服务边界被拒绝。
- **唯一允许注册项目的生产路径**是 `MemoryWriteService.configureProjectBudget(project_id, budget, canonical_path, display_name)`(由 CLI 命令 `agent-recall project register <path>` 调用)。MCP 没有公开工具能注册项目。
- **逃生口**`AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID=1` 保留给一次性运维排障,**不**适合生产 Agent 流程;开启后,只有 `project_id` 但尚未注册身份的调用可以以 "unbound" 状态继续(解析器返回 `ok`,`identity_status: "unbound"`)。

## 如何注册项目

唯一受支持的方式:

1. 运行 CLI 命令:

   ```text
   agent-recall project register <canonical_path> \
     --project-id <id> \
     --display-name <name> \
     [--budget <max_active_entries>,<max_total_chars>,<max_topic_chars>,<max_index_chars>]
   ```

2. CLI 调用 `MemoryWriteService.configureProjectBudget(...)`,同时创建 `project_identities` 行(规范绑定 `(project_id, canonical_path)`)和 `project_scopes` 行(预算包络)。`register` 模式是唯一可以插入 `project_identities` / `project_aliases_new` 的模式;CLI 是这条路径在运维侧的别名。

3. 注册后,只有 `project_id` 的调用在 strict 模式下也能成功(严格解析器找到身份行,返回 `ok`,`identity_status: "bound"`)。只有 `project_path` 的调用则通过别名表解析(Windows 大小写不敏感;POSIX 大小写敏感)。

已注册项目是以下操作的前置条件:

- `MemoryService.remember({scope: "project", project_id, ...})`
- `MemoryService.updateMemory(...)` 作用于项目级行
- `MemoryService.searchMemory(...)` 按 `project_id` 过滤
- `MemoryService.getMemoryBudget({project_id})`
- 任何针对项目的 CLI 命令(`agent-recall list --project <id>`、`agent-recall export --project <id>` 等)

## 三种模式 — 对运维的含义

`ProjectIdentityResolver.resolve(input, mode)` 的 `mode` 参数控制该调用是否可以变更身份 / 别名表。三种模式在 (#31 之后)有清晰的区别:

| 模式 | 行为 | 是否变更身份 / 别名 |
| --- | --- | --- |
| `lookup` | 纯读。如果绑定未注册,返回 `ok` 且 `identity_status: "absent"`。永不 upsert。 | 否 |
| `strict_existing` | 纯读。如果绑定未注册,返回 `project_identity_conflict`。永不 upsert。公开读 / 写的默认模式。 | 否 |
| `register` | 唯一的变更者。如 `project_identities` 缺失则插入(对 `(project_id)` 幂等);如 `project_aliases_new` 缺失则插入(对 `alias_key` 幂等)。 | 是 |

生产规则:

- **写**服务(`MemoryWriteService`)只有一个地方用 `register` 模式:`configureProjectBudget`。其他所有写入点的调用都用 `strict_existing`。
- **读**服务(`MemoryReadService`)默认使用 `strict_existing`。可选的 `lookup` 模式供 best-effort 路径使用(例如调用方明确接受绑定不存在时的 `getMemoryBudget`)。

MCP 层通过 `memory://health` 资源暴露严格隔离状态:`strict_isolation: true` 表示解析器在运行时处于严格模式。

## 遗留逃生口

```text
AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID=1
```

允许只有 `project_id` 但尚未注册身份的调用以 "unbound" 模式继续。解析器返回 `ok`,`identity_status: "unbound"`。这是 v1.0.0 → v1.1.1 的行为,作为可选逃生口保留。

**使用场景**:仅用于一次性运维排障。例如:

- 初次安装,忘记运行项目注册步骤。
- `project_identities` 表损坏,需要重建后才能重新启用严格路径。
- 迁移脚本需要在严格解析器拒绝所有调用之前,反填身份数据。

**不要用在**:

- 生产 Agent 流程。逃生口会关闭严格隔离;缺失的身份会被静默放行,这违背 v1.1.2 / #21 的契约。
- 测试夹具(项目注册步骤是测试本身的一部分时)。测试应该调用 `configureProjectBudget`(或其编程等价物)而不是绕过严格解析器。

开关在进程启动时由 `src/scope-resolver.ts` 中的 `isUnboundProjectIdAllowed(env)` 读取。`ProjectIdentityResolver.isAllowUnbound()` 访问器把构造时的开关暴露出来,让 CLI / 资源健康负载无需重新读取环境变量就能声明"严格隔离已禁用"。

## 应用期身份再校验

导入路径(`agent-recall import`、`importMemoryExport`、`applyImport`)带有一个事务内的身份再校验步骤,补齐 v1.1.2 的 IDENTITY-CARVE-OUT。包中触及的每一个 `(project_id, project_path)` 三元组,都会在 apply 事务中通过 `ProjectIdentityResolver.resolve(..., "strict_existing")` 重新解析。出现偏移或缺失绑定时,会抛出 `identity_drift` 并回滚整批(entries + revisions + audit + relations + provenance + `running` / `completed` 批次的行转换)。

偏移包络记录在失败批次行上:

```text
audit_metadata.identity_revalidation = {
  outcome: "drift",
  conflicts: [
    { project_id: "<id>", expected_path: "<path>", observed_path: "<drifted-path>" },
    ...
  ]
}
```

审计员可以这样从 `import_batches` 表中查到强制偏移的尝试:

```sql
SELECT import_batch_id, failure_code, audit_metadata_json
  FROM import_batches
 WHERE audit_metadata_json LIKE '%identity_revalidation%drift%'
 ORDER BY started_at DESC;
```

## 常见运维问题

### Q: `remember({scope: "project", project_id: "my-proj", ...})` 报 `invalid_scope`,为什么?

`project_id` 未注册。运行 `agent-recall project register <path> --project-id my-proj --display-name "My Project"`(或编程调用 `configureProjectBudget`),然后重试。

### Q: `remember({scope: "project", project_path: "/tmp/my-repo", ...})` 报 `project_identity_conflict`,为什么?

该路径已别名到另一个 `project_id`(例如有人把 `/tmp/my-repo` 注册为 `other-proj`)。两种解法:

- 使用已存在的 `other-proj` 身份,或
- 用一个新的 `project_id` 调用 `configureProjectBudget`(别名绑定到第一个注册的 id;用不同 id 重新注册会被拒绝)。

### Q: 想在一条 CLI 命令上用 v1.0.0 的 "unbound" 模式,怎么操作?

在命令行前置环境变量:

```text
AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID=1 agent-recall remember --project my-proj --body "..."
```

CLI 进程启动时会读取该环境变量。在该进程运行期间,`memory://health` 资源会暴露 `strict_isolation: false`。

### Q: 强制偏移的 apply 报 `identity_drift` 失败,怎么追查?

`import_batches` 行处于 `failed` 状态,`failure_code = "apply_failed"`。检查 `audit_metadata_json` 列:

```sql
SELECT import_batch_id, failure_code, audit_metadata_json
  FROM import_batches
 WHERE status = 'failed'
   AND audit_metadata_json LIKE '%identity_revalidation%drift%'
 ORDER BY started_at DESC;
```

JSON 结构定义在 `src/portability/import-batch-store.ts` 的 `ImportBatchAuditMetadata`。`conflicts` 数组列出每个发生偏移的 scope,以及其 expected 与 observed 的 `canonical_path`。

## 参见

- [`docs/adr/0004-identity-resolution-modes.md`](../../adr/0004-identity-resolution-modes.md) — 描述三种模式 + 规范注册路径 + 应用期再校验契约的 ADR。
- `src/scope-resolver.ts` — 解析器实现。
- `src/services/memory-write-service.ts` — 拥有 `configureProjectBudget` 的写服务。
- `src/portability/importer.ts` — 带应用期身份再校验的导入路径。
- `src/portability/import-batch-store.ts` — `ImportBatchAuditMetadata` 类型 + 暴露再校验包络的 `complete` / `fail` 写入器。
