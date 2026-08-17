# v1.1.3 发布说明

> **🌏 语言 / Language**: 中文。English: [RELEASE_NOTES.en.md](./RELEASE_NOTES.en.md)。

本文件是 AgentRecall v1.1.3 的发布说明。它记录了发布 commit、平台制品、迁移 / 兼容性契约以及已知的非阻塞限制。运维在 `git push origin v1.1.3` 之后,把这部分内容粘贴到 GitHub Release body。

## Release

| 字段 | 值 |
| --- | --- |
| `release_commit` | `366bc98a04183d3ab1657c91dd873c34745c6ea1` |
| `tag` | `v1.1.3` |
| `date` | 2026-07-30(lane close;GH Release 由运维手工推送) |
| 前置版本(`main`) | `366bc98` |

## 平台制品

| 平台 | 归档 | size_bytes | sha256 |
| --- | --- | ---: | --- |
| linux-x64 | `agent-recall-1.1.3-linux-x64.tar.gz` | 328419 | `1dbc1004d8a692616c0aa6a264d689771c47d996baf5a9a104a2c8aab37b9bdb` |
| darwin-x64 | `agent-recall-1.1.3-darwin-x64.tar.gz` | 657996 | `90676e883cea93c179dbc033ee60b4425eb475f7ca3ab1755304e2bb580d7110` |
| win32-x64 | `agent-recall-1.1.3-win32-x64.zip` | 1357629 | `68b47b4e0418ce251fe59e97ed5378a39835b7ef27050ed0d1e4462cc85322b6` |

三个归档均由同一份 `dist/` 树在同一个 commit(`366bc98`)产出;`release-artifact-hashes.json` 是规范的 SHA-256 manifest。

## SHA-256 校验值

为方便使用:

```text
1dbc1004d8a692616c0aa6a264d689771c47d996baf5a9a104a2c8aab37b9bdb  agent-recall-1.1.3-linux-x64.tar.gz
90676e883cea93c179dbc033ee60b4425eb475f7ca3ab1755304e2bb580d7110  agent-recall-1.1.3-darwin-x64.tar.gz
68b47b4e0418ce251fe59e97ed5378a39835b7ef27050ed0d1e4462cc85322b6  agent-recall-1.1.3-win32-x64.zip
```

## 迁移 / 兼容性说明

- **保留 schema 的迁移**:v1.1.2 → v1.1.3 是 schema-preserving 的。v13 `user_version` 不变(v1.1.3 lane 完全叠加在 v1.1.2 之上)。`import_batches.audit_metadata_json` 列是唯一的数据库表面变更;`addColumnIfMissing` 对 pre-v13 数据库透明处理。
- **项目身份解析模式(issue #31)**:`ProjectIdentityResolver.resolve(..., mode)` 现在遵循 `mode` 参数。`lookup` 与 `strict_existing` 在成功和失败时都不写库;`register` 是唯一允许插入 `project_identities` / `project_aliases_new` 的模式。Apply 事务在 revisions + aggregate-budget 校验之间重新校验身份绑定;preflight 与 apply 之间的身份漂移以 `identity_drift` 回滚。
- **Profile-scoped admin capability(issue #32)**:只有带有效 capability 的 Admin-profile 进程在读路径上获得 `"restricted"` 可见性。加载期的 `permission_drift` / `acl_drift` / `symlink` / `unsupported_owner` 通过 `status()` 暴露,不泄露 token 字节。按请求 capability 路径仍然保留,作为 Core / Extended 对不带 `profile_required` 的能力类型的规范授权入口。
- **单一敏感度策略(issue #33)**:SQL 边界的 `sensitivity` 过滤器对每个 (profile, capability, row-sensitivity) 三元组解析出唯一的规范决策;`core` 与 `extended` 调用方拿到一致的按行可见性包络。

## 已知非阻塞限制

- `p3-extracted-artifact-lifecycle.test.ts` 有一处与 v1.1.3 无关的既存正则不匹配:它在 `release-candidate.yml` 中断言 `release-artifact-hashes-`(带尾随短横),但 workflow 实际是 `release-artifact-hashes.json`(`.json` 前没有尾随短横)。正则的收紧发生在 Phase A,workflow 当时未同步。该失败作为 follow-up 回归信号记录;该测试在项目文档化的排除列表中,v1.1.3 release lane 跳过它。
- Windows-only 的 `multi-process-stress` orphan-dir flake(清理 `rmSync` 与下一条测试的 `mkdtempSync` 竞用)作为既存的非阻塞限制记录在排除列表中。
- Windows PowerShell `Expand-Archive` 依赖(matrix leg 在 Windows runner 上用 `powershell -NoProfile -Command Expand-Archive` 处理 `.zip` 归档)。Windows runner 镜像自带 PowerShell;若未来使用不带 PowerShell 的最小化 runner 镜像,需要 Node 原生的回退(`node:zlib` + tar 解析器)。

## npm publish

**`npm publish` 不在 v1.1.3 的范围内。** 包标记为 `"private": true`;GitHub release 制品(3 个平台归档 + SHA-256 manifest)是规范的发布介质。**不要**对该仓库尝试 `npm publish`。

## 验证

本地运维排练证据记录在 `docs/superpowers/evidence/2026-07-29-v1.1.3-gate-08.md`(GATE-08 证据文件)。CI 矩阵 + canonical release-commit SHA 对应的 GH Actions 运行是发布的 source of truth;运维在打 tag 之前,运行规范的 `scripts/prepare-release.mjs (DRY_RUN=0)` + `scripts/verify-release-evidence.mjs --stable` 来收集最终证据。

Workflow 链接(运维跑完 canonical push 之前是占位符):

- Release Candidate Gate: `https://github.com/xurunxin/AgentRecall/actions/runs/<release-candidate-run-id>`
- Release: `https://github.com/xurunxin/AgentRecall/actions/runs/<release-run-id>`

运维在手工 push 之后填入真实 URL(lane 在 `docs/superpowers/evidence/2026-07-29-v1.1.3-gate-08.md` 下记录本地排练证据)。
