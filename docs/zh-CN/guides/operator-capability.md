# 操作员 Capability

> 本文档是 `docs/guides/operator-capability.md` 的中文版本，适用于 AgentRecall v1.1.4。

Capability 是本地操作员边界，用于授权 Admin Profile 访问 restricted 记忆与其他受保护操作。Capability 文件位于 `${AGENT_RECALL_HOME}/admin.cap`，但仅有文件并不等于所有 MCP Profile 都获得 restricted 可见性。

## Profile 与权限

- Core / Extended：默认最多访问 `normal` 与 `private`；即使数据目录存在 `admin.cap`，也不会自动获得 restricted 可见性。
- Admin：必须设置 `AGENT_RECALL_PROFILE=admin`，并在加载期通过 capability 文件校验，才可以访问 restricted 内容。
- 按请求 capability：Core / Extended 可以为不要求 Admin Profile 的特权操作提供请求级 token；要求 `profile_required: "admin"` 的能力会以 `profile_mismatch` 拒绝。

## 管理命令

```bash
agent-recall admin grant
agent-recall admin status
agent-recall admin revoke
```

`grant` 创建或更新本地 capability；`status` 报告 granted、missing 或 drift 等状态，但不会输出 token 字节；`revoke` 删除本地 capability。

## 加载期安全检查

服务在解析 capability 内容前检查文件权限、所有者与符号链接状态。POSIX 检查模式与 owner；Windows 使用 `icacls` 检查 ACL，并拒绝非系统/非所有者主体。检测到权限漂移、符号链接或不支持的 owner 时，内存 token 会被清空，状态中只保留诊断原因和路径。

不要把 capability 文件提交到 Git、复制到共享目录或放入备份之外的公开位置。修改权限后重启 Admin Profile 进程，让加载期校验重新执行。

## 排障

1. 确认 `AGENT_RECALL_PROFILE=admin` 已设置。
2. 运行 `agent-recall admin status`，确认不是 `missing` 或 `drift`。
3. 确认 `AGENT_RECALL_HOME` 与 MCP 进程实际使用的目录一致。
4. 通过 `memory://health` 检查 `active_profile` 与 `capability_state`，不要从日志中寻找 token。

相关设计：[`docs/adr/0005-profile-scoped-admin-capability.md`](../../../docs/adr/0005-profile-scoped-admin-capability.md)。
