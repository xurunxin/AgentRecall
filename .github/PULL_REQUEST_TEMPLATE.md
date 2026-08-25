## Summary

<!-- Briefly describe what this PR changes and why. -->

## Changes

<!-- List the user-visible or contract-visible changes. -->

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / no behavior change
- [ ] Documentation only
- [ ] Build / CI / tooling

## How to test

<!-- Concrete steps a reviewer can follow to verify the change.
     Include exact commands and expected output where possible. -->

1.
2.
3.

## Checklist

- [ ] `npm test` passes locally
- [ ] `npm run typecheck` passes
- [ ] `npm run check-contracts` exits 0 (when `src/domain.ts` or `packages/contracts/` changed)
- [ ] No new runtime dependency added without prior discussion
- [ ] No behavior regression for existing MCP clients
- [ ] `CHANGELOG.md` updated (if user-visible)
- [ ] Docs updated (if public API or behavior changed)

## AgentRecall Admin v0.1 手动验证清单(仅当本 PR 涉及 `apps/admin/` 或 `packages/contracts/` 时)

> GitHub 模板无法做条件触发,**靠 reviewer 检查**。下方各项仅在 PR 修改了
> admin 前端、Tauri 后端或 contracts schema 时需要勾选;否则请把整段删除。

- [ ] `cd apps/admin/src-tauri && cargo build` 编译成功
- [ ] `cd apps/admin && npm run dev` 启动 Vite 无错误
- [ ] `npm run tauri -- dev` 启动 Tauri 应用,窗口正常显示
- [ ] `npm run check-contracts` 退出码 0
- [ ] 启动后 `/graph` 视图显示节点 + 边
- [ ] 通过 MCP 写一条记忆 → 5s 内 graph 自动更新(`db:changed` 事件)
- [ ] 故意把 data-home 的 `user_version` 改大 → 应用启动失败,提示明确
- [ ] 手动覆盖 data-home 的 fixture:复制 `apps/admin/tests/fixtures/seed.sql`
      到本地 data-home,重启应用,看到 50+ 节点渲染
