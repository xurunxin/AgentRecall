# 敏感度矩阵

> **🌏 语言 / Language**: 中文。English: [`sensitivity-matrix.en.md`](./sensitivity-matrix.en.md)。  
> **当前实现版本 / Implementation version**: v1.1.3(单一敏感度策略 GATE-03,v1.1.6 仍按此执行)。

本指南说明 v1.1.3 GATE-03(issue #33)敏感度策略。它是 [`docs/adr/0006-one-sensitivity-policy.md`](../../adr/0006-one-sensitivity-policy.md) 的运维侧配套文档,ADR 描述规范的 `AuthorizationDecision` + 维护分类 + 按行 vs 按包语义。

## TL;DR

- **Core 和 Extended Profile 永不继承 `"restricted"` 可见性。** 即便 Core / Extended 进程的数据目录中有合法的 `admin.cap`,在 SQL 边界它仍然只能看到 `"normal"` 行。Capability 文件只是操作员元数据,**不会**自动在非 Admin Profile 上授权 restricted 读。
- **只有 Admin Profile + 加载的 capability 才获得 `"restricted"` 可见性。** 进程启动时加载的内存 token 是闸门;按请求 capability token 是不带 `profile_required` 的能力类型的按调用例外。
- **SQL 边界是唯一真相。** 每条带内容的路径都会查询规范的 `AuthorizationDecision` 并在 SQL 层应用过滤。**没有**路径在响应渲染时再做过滤。
- **`forbidden_visibility` 是稳定错误码**,用于从所有表面拒绝未授权的 restricted 访问。错误包络**绝不**包含行的 `sensitivity` 字面量或任何由行派生的秘密(标题 / 正文 / 标签 / 来源)。

## 中心可见性矩阵

| Profile × Sensitivity | 读 | 搜索 / 列表 / 召回 | 导出 | 维护 apply | 导入 restricted 包 | Admin capability |
| --- | --- | --- | --- | --- | --- | --- |
| Core × normal | 是 | 是 | 是 | 是(apply_archive / apply_merge 仅 normal) | n/a(必须通过 `allow_restricted: true` + capability token 显式选择) | 拒绝 |
| Core × private | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| Core × restricted | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| Extended × normal | 是 | 是 | 是 | 是 | n/a | 拒绝 |
| Extended × private | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| Extended × restricted | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| Admin × normal | 是 | 是 | 是 | 是 | 是(需要 capability) | 是(按请求) |
| Admin × private | 是 | 是 | 是 | 是(需要 capability) | 是(需要 capability) | 是(按请求) |
| Admin × restricted | 是 | 是 | 是 | 是(需要 capability) | 是(需要 capability) | 是(按请求) |

## 维护动作分类

| 动作 | 在 Extended 中安全 | 限制为 Admin | 需要 capability |
| --- | --- | --- | --- |
| `view_cleanup_candidates` | 是(仅 normal 列表) | — | — |
| `plan_archive_low_value` | 是(dry-run) | — | — |
| `plan_merge_duplicates` | 是(dry-run) | — | — |
| `plan_apply_maintenance` | 是(dry-run,仅 normal) | — | — |
| `apply_archive_low_value` | 是(仅 normal) | — | — |
| `apply_merge_duplicates` | — | 是(Admin Profile,仅 normal + private) | restricted 合并需要按请求 capability token |
| `apply_supersede` | — | 是(Admin Profile) | — |
| `apply_forget` | — | 是(Admin Profile) | `sensitivity_restricted` 类型的 forget 需要按请求 capability token |
| `apply_maintenance` | — | 是 | — |
| `preview_budget_bypass` | — | — | 是(`trust_promotion`) |
| `apply_force_forget` | — | — | 是(`sensitivity_restricted`) |
| `rebuild_markdown_index` | 是(限制在可见 scope) | — | — |

## 常见运维问题

### Q: 数据目录里有合法 `admin.cap`,但 Core 进程仍然只看到 `"normal"`,为什么?

答:这是 v1.1.3 GATE-03 契约。Core / Extended 进程**永不会**仅仅因为 `admin.cap` 存在就继承 `"restricted"` 可见性。Capability 文件只是操作员元数据;可见性上限由 Profile 决定。

要获得 `"restricted"` 可见性,需要用 `AGENT_RECALL_PROFILE=admin` 启动进程(MCP 服务器入口在 Admin Profile 激活但没有有效 capability 时启动失败)。

### Q: Admin 进程无法启动,怎么办?

答:Admin Profile 的 MCP 服务器入口在缺少有效 capability 时拒绝启动。执行 `agent-recall admin grant` 安装有效 capability(用 `0o600` / Windows 仅所有者 ACL 写入规范的 `admin.cap`),然后重启。

### Q: 读 `restricted` 行时拿到 `forbidden_visibility`,这是什么意思?

答:SQL 边界过滤器在隐藏该行。`forbidden_visibility` 错误包络**绝不**包含行的 `sensitivity` 字面量或任何由行派生的秘密(标题 / 正文 / 标签 / 来源),只包含运维元数据(`memory_id`)。要看到该行,需要用 Admin Profile + 加载的 capability 重启。

### Q: `apply_merge_duplicates` 在 Core 上返回零合并,怎么办?

答:v1.1.3 GATE-03 规范把 `apply_merge_duplicates` 限制到 Admin Profile(破坏性路径要求 Admin)。在 Core / Extended 上,维护服务以 `unauthorized` 拒绝该动作。

要在 Core 上合并,可以先运行 `find_duplicates`(只读路径在 Core 上安全),然后通过 `update_memory` 配合规范 `revision` + `user_confirmed` 标志手动 supersede 重复行(`user_confirmed` 本身需要按请求路径上的 `trust_promotion` capability)。

### Q: 用按请求 capability token 能否提升 Core 的可见性上限?

答:不能。v1.1.3 GATE-03 规范说得很清楚:Core / Extended 上的按请求 capability token 授权的是**操作**(例如在 restricted 包上 `import_trust_restore`),但**不会**提升**可见性**上限。可见性由 Profile 决定;按请求 token 只是不带 `profile_required` 的能力类型的按调用例外。

Restricted 可见性的唯一路径是 Admin Profile + 加载的 capability。

## 参见

- [`docs/adr/0006-one-sensitivity-policy.md`](../../adr/0006-one-sensitivity-policy.md) — 描述规范的 `AuthorizationDecision` + 维护分类 + 按行 vs 按包语义的 ADR。
- `src/services/auth-context.ts` — 规范的授权决策 + `MAINTENANCE_ACTION_POLICY` 表。
- `src/services/memory-read-service.ts` — 每个读方法都串入决策。
- `docs/superpowers/specs/2026-07-28-v1.1.3-gate-03-sensitivity-design.md` — #33 的设计规范。
