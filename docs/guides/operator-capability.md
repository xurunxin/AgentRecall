# 操作员 Capability

> **🌏 语言 / Language**: 中文。English: [`operator-capability.en.md`](./operator-capability.en.md)。  
> **当前实现版本 / Implementation version**: v1.1.3(Profile-scoped capability 契约 GATE-02,v1.1.6 仍按此执行)。

本指南说明如何在 v1.1.3 GATE-02 Profile-scoped 契约下管理操作员 capability(`admin.cap`)(issue #32)。它是 [`docs/adr/0005-profile-scoped-admin-capability.md`](../../adr/0005-profile-scoped-admin-capability.md) 的运维侧配套文档,ADR 描述按 Profile 划分的契约 + 加载期权限校验规则。

## TL;DR

- Capability 文件是操作员 capability token 的唯一持久化介质(32 字节来自 `crypto.randomBytes`,64 个十六进制字符)。
- 文件位于 `${AGENT_RECALL_HOME}/admin.cap`,权限边界为 POSIX `0o600` / Windows 仅所有者 ACL。
- 只有加载了 capability 的 Admin Profile 进程才获得 `"restricted"` 可见性。Core / Extended 进程无论 `admin.cap` 是否存在,可见性都停留在 `"normal"`。
- 按请求 capability token 路径,是 Core / Extended 进程为不要求 Admin Profile 的特权操作授权的标准方式。带 `profile_required: "admin"` 的能力类型会返回 `profile_mismatch`。

## Grant / revoke / status

```text
agent-recall admin grant [--label <text>]
agent-recall admin status
agent-recall admin revoke
```

### `grant`

向 `${AGENT_RECALL_HOME}/admin.cap` 写入一个全新的 64 字符十六进制 token,带标准权限边界(POSIX `0o600` / Windows 通过 `icacls` 设为仅所有者)。新 token 以脱敏形式(`**** <最后 4 位 hex>`)打印。运维应当把完整 token 复制到秘密存储中;打印的并不是完整 token。

每次 `grant()` 调用都会轮换已有 token(内存中是新 token,磁盘文件被覆盖)。

### `status`

报告磁盘上的状态,绝不泄露 token 字节。可能的状态:

| 状态 | 含义 |
| --- | --- |
| `granted` | 文件存在、能解析、并通过权限校验。返回 `token_tail`(最后 4 位 hex)+ `fingerprint`(前 16 位 hex);绝不返回完整 token。 |
| `missing` | 文件不存在。存储拒绝所有特权操作。 |
| `drift` | 文件存在但未通过权限校验。`drift_reason` 是 `permission_drift` / `acl_drift` / `symlink` / `unsupported_owner` 之一。drift 分支绝不返回 token 字节。 |

`status` 报告 `drift` 时,推荐的修复方式是重新执行 `agent-recall admin grant`(会用正确权限重建文件)。底层 `fs` 错误会被记录但不会通过 `status` 暴露(drift 原因是稳定代码,而非 OS 特定的消息)。

### `revoke`

删除 capability 文件。CLI 成功时静默(幂等:对缺失文件执行 revoke 是 no-op)。

任何变更要影响到运行中的进程都需要重启(内存中的 token 在启动时设置;`revoke()` 删除文件,但运行中的进程仍持有 token,直到重启)。

## 权限要求

文件必须:

- **POSIX**:`0o600`(仅所有者可读写)。任何 group / other 位都是 drift。文件所有者必须等于当前 `process.getuid()`。
- **Windows**:通过 `icacls` 设置为仅所有者 ACL。CLI 授予 `${user}:(F)` 并移除 `Everyone`、`Users` 和继承的 ACE。

文件不得:

- 是符号链接(规范记录路径必须是常规文件)。
- 是目录、设备或其他非常规文件。
- 由不同的 uid 拥有(POSIX)。

Drift 检测在 `load()` 时执行(`CapabilityStore` 的构造器)。Drift 会把内存中的 token 清空;之后 `authorize(...)` 调用会返回 `capability_missing`。

## 按 Profile 授权

契约限定了哪个 Profile 可以授权哪种能力类型:

| 能力类型 | Admin Profile | 按请求(Core / Extended) | 按请求(Admin) |
| --- | --- | --- | --- |
| `trust_promotion` | 是 | 否(`profile_mismatch`) | 否(`profile_mismatch` — Admin 用内存 token,不需要按请求) |
| `sensitivity_restricted` | 是 | 否(`profile_mismatch`) | 否 |
| `sensitivity_visibility` | 是 | 否(`profile_mismatch`) | 否 |
| `import_trust_restore` | 是 | 是 | 是 |
| `import_restricted` | 是 | 是 | 是 |

Admin Profile 进程通过启动时从磁盘文件加载的内存 capability token 授权所有类型。按请求 capability token 路径是给 Core / Extended 中的 Agent 流程使用的。

### 按请求授权示例

在 Core / Extended 进程中,需要写入 `restricted` 行的 Agent 流程:

1. 运维执行 `agent-recall admin grant` 安装有效 capability(此操作本身要求切换到 Admin Profile)。
2. Agent 读取打印的 token(完整的 64 字符十六进制值;运维从秘密存储中取出;CLI 仅打印脱敏尾部)。
3. Agent 在调用特权 MCP 工具时附带 `capability: <token>` 字段。
4. `authorize(...)` 调用把该 token 与启动时加载的内存 capability 比对。

对 `import_trust_restore` 和 `import_restricted`,按请求路径在所有 Profile 上都可用。`trust_promotion` 和 `sensitivity_restricted` 路径要求 Admin Profile(或启动时设置的进程内内存 token,后者要求启动时就是 Admin)。

## 取证示例

特权写入被拒绝时:

```text
reason: "profile_mismatch"
  -> 该能力类型的 profile_required: "admin",但当前 Profile 是 Core / Extended。
     切换到 Admin Profile(或使用进程内内存 token,这要求启动时就是 Admin)。

reason: "capability_missing"
  -> 内存 token 为空。运行 `agent-recall admin status` 了解原因:
     - `missing`: 执行 `agent-recall admin grant`
     - `drift`: 执行 `agent-recall admin grant` 用正确权限重建文件
       (drift 分支暴露稳定的原因代码;底层 `fs` 错误被记录但永不返回)

reason: "token_mismatch"
  -> 提供的 capability token 与内存 token 不匹配。校验 token 是否被正确复制
     (没有空白,正好 64 个十六进制字符)。

reason: "permission_drift"
  -> (此原因现在通过 `status()` 包的 `drift` 分支暴露;按调用的 `authorize(...)`
     不再返回它。重新运行 `agent-recall admin status` 查看稳定的 drift 原因。)

reason: "capability_malformed"
  -> 提供的 token 不是 64 个十六进制字符(或有空白 / 非十六进制字符)。
     去除空白;校验 token 长度。
```

## 常见运维问题

### Q: `admin status` 报 `drift`,是什么意思?

Drift 表示磁盘上的 `admin.cap` 存在但未通过加载期的权限校验。`drift_reason` 是稳定代码:

- `permission_drift`:POSIX 文件模式设置了 group / other 位(`0o644`、`0o664` 等),或文件由不同 uid 拥有。
- `acl_drift`:Windows ACL 授予了非所有者主体的访问权限(例如 `Users`、`Authenticated Users`)。
- `symlink`:文件是符号链接。重新执行 `agent-recall admin grant` 写入常规文件。
- `unsupported_owner`:(POSIX)文件由不同 uid 拥有。从运维账户重新执行。

修复方法都一样:重新执行 `agent-recall admin grant`(以规范权限写入新文件)。

### Q: Core 进程显示 `"restricted"` 读,为什么?

不应该出现 — v1.1.3 契约规定 Core / Extended 进程在磁盘上即使有 capability,可见性也停留在 `"normal"`。如果看到 `"restricted"` 读,检查:

1. 通过 `memory://health.active_profile` 查看当前 Profile。
2. 通过 `memory://health.capability_state` 查看 capability 状态。

如果 Core 进程报告 `active_profile: "admin"`,说明该进程是用 `AGENT_RECALL_PROFILE=admin` 启动的(MCP 服务器入口的规范 Admin 闸门)。修复方法:不带该环境变量重启。

### Q: Admin 进程显示 `missing` capability,为什么?

Admin Profile 的 MCP 服务器入口在 capability 缺失 / 格式错误 / drift 时启动失败。进程会以 `process.exitCode = 1` 退出,并报稳定消息:

```text
agent-recall failed to start: AGENT_RECALL_PROFILE=admin requires a valid operator capability.
```

修复方法:执行 `agent-recall admin grant` 安装有效 capability,然后重启。

### Q: 按请求 capability token 路径返回 `profile_mismatch`,为什么?

该能力类型的 `profile_required: "admin"`。按请求路径仅对**没有** `profile_required` 的类型(import capability 表面)可用。对 `trust_promotion` 和 `sensitivity_restricted`,授权路径是 Admin Profile 进程的内存 token;按请求路径不被查阅。

## 参见

- [`docs/adr/0005-profile-scoped-admin-capability.md`](../../adr/0005-profile-scoped-admin-capability.md) — 描述三条契约的 ADR。
- `src/admin/capability.ts` — 实现。
- `src/cli/commands/admin.ts` — CLI 表面(`grant` / `status` / `revoke`)。
- `docs/superpowers/specs/2026-07-28-v1.1.3-gate-02-capability-design.md` — #32 的设计规范。
