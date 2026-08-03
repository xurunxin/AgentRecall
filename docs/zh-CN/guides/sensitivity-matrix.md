# 敏感度矩阵

> 本文档是 `docs/guides/sensitivity-matrix.md` 的中文版本，适用于 AgentRecall v1.1.4。

所有内容读取、导出、资源、维护、CLI 和 MCP 路径都使用统一的 `AuthorizationDecision`。SQL 边界过滤器是决定可见性的唯一位置；上层不得通过重新读取原始行绕过该边界。

## 3 × 3 可见性矩阵

| Profile | `normal` | `private` | `restricted` |
| --- | --- | --- | --- |
| Core | 允许 | 允许 | 拒绝 |
| Extended | 允许 | 允许 | 拒绝 |
| Admin + 有效 capability | 允许 | 允许 | 允许 |

Core 或 Extended 请求 restricted 内容时，MCP / 资源路径返回 `FORBIDDEN_VISIBILITY`，CLI 使用稳定错误码 `forbidden_visibility` 并退出码 1。拒绝响应不得泄漏被保护行的正文或敏感度字面量。

## 操作员检查

- 只需要 normal / private 内容时，使用 Core 或 Extended，避免不必要地启用 Admin。
- 需要 restricted 内容时，同时确认 `AGENT_RECALL_PROFILE=admin`、`admin.cap` 存在且 `agent-recall admin status` 没有 drift。
- 不要把 capability token 放在记忆、环境变量快照、导出文件或问题报告中。
- 使用 `memory://health` 查看当前 Profile 和 capability 状态；状态接口不会返回 token 字节。

相关设计：[`docs/adr/0006-one-sensitivity-policy.md`](../../../docs/adr/0006-one-sensitivity-policy.md)。
