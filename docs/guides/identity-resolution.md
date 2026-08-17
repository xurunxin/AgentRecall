# 项目身份解析

> **🌏 语言 / Language**: 中文摘要。完整规范（含三种模式的伪代码示例、`identity_conflict` 错误路径、未注册项目的导入流程、与 AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID 开关的交互）请参阅 [`identity-resolution.en.md`](./identity-resolution.en.md)。  
> **Summary in Chinese**. For the full spec (pseudocode for the three modes, `identity_conflict` error paths, unregistered-project import flow, AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID interaction) see [`identity-resolution.en.md`](./identity-resolution.en.md).  
> **当前实现版本 / Implementation version**: v1.1.4.

AgentRecall 将项目路径与项目 ID 的解析分为三种模式。模式决定调用是否允许读取、是否允许注册身份，以及解析过程中是否可以写入项目身份表。

## 三种模式

| 模式 | 作用 | 是否允许写入身份表 |
| --- | --- | --- |
| `lookup` | 只查询已有绑定；未知路径返回 `identity_conflict`。 | 否 |
| `strict_existing` | 只接受已绑定的 `project_id` / `project_path`；未知身份失败。 | 否 |
| `register` | 注册或确认项目绑定，是唯一允许写入身份表的模式。 | 是 |

`lookup` 与 `strict_existing` 成功或失败都不会向 `project_identities` 或 `project_aliases_new` 写入行。正式注册路径是 `agent-recall project register <path>` 或 `MemoryWriteService.configureProjectBudget(...)`。

## 默认严格隔离

默认情况下，未知项目 ID 会在解析阶段被拒绝，避免在项目 scope、别名、记忆、审计或预算表中产生隐式记录。一次性排障可以设置：

```bash
AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID=1
```

启用后，只有项目 ID、但尚未注册身份的调用可以以 `unbound` 状态继续。该开关不建议用于生产 Agent 流程；应先显式注册项目并保持默认严格模式。

## 操作建议

1. 首次接入项目时运行 `agent-recall project register <path>`。
2. MCP 客户端同时提供稳定的 `AGENT_RECALL_HOME` 与项目路径。
3. 导入或维护前先运行预检；预检使用 `strict_existing`，不会偷偷注册未知项目。
4. 遇到 `identity_conflict` 或 `not_found` 时，检查路径规范化、项目 ID 和注册状态，不要直接打开 unbound 逃生口。

相关设计：[`docs/adr/0004-identity-resolution-modes.md`](../../../docs/adr/0004-identity-resolution-modes.md)。
