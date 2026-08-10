# v1.1.6 follow-up tracker — 设计规范

> 日期：2026-08-10
> 状态：已批准（2026-08-10 用户复核通过，进入 writing-plans）
> 修订：—
> 作者：brainstorming 工作流（许润鑫 × Mavis）
> 关联 issue：<https://github.com/xurunxin/AgentRecall/issues/42>

## 背景与问题

v1.1.5（tag `v1.1.5` @ `9d5a9d3`，2026-08-09 发布）的 release-candidate gate 与 release
pipeline 在 PR 40 合并后端到端跑通了，但 **6 个临时绕过** 留在代码与 CHANGELOG 里没拆：

1. **`scripts/verify-release-evidence.mjs` 持有 `LegacyReleaseEvidence` 平行 schema**。
   v1.1.3 GATE-04 / GATE-06 B2 blocker 3（issue #34 / #36）要求的 `--fragments` 聚合器
   在 rc-branch 上没落地，verifier 必须双形态兼容。这是 v1.1.5 设计里最显眼的债。

2. **`release.yml` 在 `windows-latest` 矩阵腿上 skip 多进程 stress**（`if: matrix.os
   != 'windows-latest'`）。原因是 8 进程 × 1250 op 的 release profile 触发
   `SQLITE_BUSY`，目前 `src/store/sqlite-store.ts` 没有 Windows busy 重试。

3. **`test/release-gate/p3-extracted-artifact-lifecycle.test.ts` 在 Windows 上短路
   tar.gz round-trip**（`if (process.platform === "win32") { return }`）。
   `packTarGz` 走 GNU tar shell，Windows 临时路径上 tar 退出码 2。

4. **`vitest.config.ts` + `vitest.blackbox.config.ts` 排除了
   `test/blackbox/mcp-stdio-idle.test.ts`**。该测试在 orchestrator 上冷启动超过
   2.5s 预算，matrix 单跑 runner 上能过。底层的 idle-timer 逻辑本身是过单测的，
   卡在测试的"cap-bounded"写法。

5. **`test/blackbox/mcp-shutdown.test.ts` 把 `waitForExit` cap 从 2.5s 抬到 5s**。
   原因不是 lifecycle 有 bug，是 orchestrator VM 退出期间做了别的活儿。

6. **`test/multi-process-stress.test.ts` 在 Windows 上
   "no orphaned child processes" 断言 flaky**（同步 `rmSync` 与 in-flight
   write 抢资源），从 v1.1.3 写到 v1.1.5 都没真正修过。

加 1 个**用户 WIP**（不属于 release-gate 债，但用户希望收进 v1.1.6）：

7. **`http-bridge/install-windows-autostart.ps1` 重构停在
   `autostart-wip-2026-08-09` stash**。Task Scheduler 优先、HKCU Run + Startup
   folder 兜底，diff 是 102+/55-，基本干完；CJK 编码踩了 PowerShell 5.1 的坑
   （`�?` 字面量）。

这 6 + 1 项在 issue #42 都有详细 drop-when-done 信号；本设计只定义**怎么收**。

## 目标

v1.1.6 = 上述 6 + 1 项全部清理：

- A1（A1 standard）：rc-branch orchestrator 切到 v1.1.3 `--fragments` 聚合器；verifier
  删 `LegacyReleaseEvidence`；重启 3-platform `MISMATCHED_PLATFORMS` 严格检查。
- B1：`src/store/sqlite-store.ts` 加 `winHandleBusy` 重试；release.yml 撤掉
  windows-latest stress skip。
- C1：`packTarGz` 改成 Node-native（`zlib` + `fs` 或 `tar` npm 包）；test 撤掉
  `if (process.platform === "win32")` 短路。
- D1：`mcp-stdio-idle.test.ts` 改用 EOF sentinel 信号而非 cap-bounded 等待；
  2 个 vitest config 重新 include 该 test。
- D2：`src/mcp/lifecycle.ts` 退出路径 profile 优化；`mcp-shutdown.test.ts` 的
  `waitForExit` cap 退回 2.5s。
- D3：`multi-process-stress.test.ts` 清理改 async + retry + per-handle `close()`。
- E1：把 stash 里的 `install-windows-autostart.ps1` 重构落地（修 CJK 编码、
  在 Windows host 上手动跑通 install / status / uninstall、清理
  `http-bridge/` 下的 runtime artifact）。

**完工信号**：`CHANGELOG.md` v1.1.5 的 "Known non-blocking limits" 整段从历史
定稿里删掉，v1.1.6 段不出现该小节。`release.yml` 与 3 个 `test/release-gate/`
测试文件里 4 个临时 if / 短路物理删除（与修复 commit 同提交，**不**单独开
清理 commit）。

## 非目标

- 不改 SQLite 仓库的 schema、版本、并发模型（WAL 保留，busy_timeout 已 5000ms）。
- 不改 `MemoryService` 三件套边界。
- 不引入新 npm 依赖（C1 用 Node 内置 `zlib` 或评估 `tar` 包，但优先零依赖）。
- 不重写 `StdioServerTransport` 或 `idle-timer` 实现（D1 改测试，不改 lifecycle）。
- 不在 v1.1.6 引入新 CI 维度（PowerShell 测试不进 ci.yml；E1 的 Windows 验证
  走 host 手动跑 + commit message 贴日志）。
- 不动 `docs/superpowers/specs/2026-08-06-mcp-process-lifecycle-and-shared-http-design.md`
  涵盖的 stdio 退出 / HTTP 共享设计。
- 不重新打开 v1.1.3 GATE-04 / GATE-06 已 CLOSED 的 issue；本设计是它们的延期收尾。

## 架构总览

### Phase 1 — A1 独立（2-3 周）

```
                ┌─────────────────────────────────────────┐
                │ rc-1.1.6-candidate (A1 commit)          │
                │                                          │
   ┌────────────┴────────────────┐  ┌─────────────────────┴──────────────┐
   │  release-candidate.yml      │  │  release.yml (Phase 1 暂不动)     │
   │  matrix.os ∈ {ubuntu,mac,   │  │  win/mac stress skip 暂保留       │
   │              windows}       │  │  (B1 来再撤)                       │
   │  每条 OS:                    │  │                                    │
   │   - install agent-recall    │  │                                    │
   │   - 跑 test 套件            │  │                                    │
   │   - 上传 fragment 文件:     │  │                                    │
   │     release-evidence-       │  │                                    │
   │     fragment-matrix-<os>.   │  │                                    │
   │     json  (sha256 + ci_jobs)│  │                                    │
   │   - 写 release-artifact-    │  │                                    │
   │     hashes.json             │  │                                    │
   └────────────┬────────────────┘  └─────────────────────┬──────────────┘
                │                                         │
                ▼                                         ▼
       ┌────────────────────────────────────────────────────────┐
       │  Release aggregate step (rc-branch)                    │
       │  1) 读 3 个 fragment                                  │
       │  2) 合并 ci_jobs / artifacts / stress_summary           │
       │  3) 跑 v1.1.3 GATE-04 contract                         │
       │  4) sha256 交叉验证 3 个 fragment 的 release-artifact-  │
       │     hashes.json vs 后续 release.yml 产出的 archive      │
       │  5) 写 release-evidence.json (v1.1.3 形状)             │
       └─────────────────────────────┬──────────────────────────┘
                                     │
                                     ▼
       ┌────────────────────────────────────────────────────────┐
       │  verify-release-evidence.mjs                          │
       │  - LegacyReleaseEvidence 删掉                          │
       │  - 走 v1.1.3 严格 Zod schema                            │
       │  - MISMATCHED_PLATFORMS 重新检查 (3 platform 都有 sha256)│
       └────────────────────────────────────────────────────────┘
```

**Phase 1 → Phase 2 的门**：在 `rc-1.1.6-candidate` @ A1 commit 上跑 ≥ **2 次
连续干净** `release-candidate.yml`。
- 第 1 次：验证新 fragment 形状站得住（每条 OS 都成功上传 fragment、aggregate
  合并成功、verifier 走 v1.1.3 严格路径通过）。
- 第 2 次：验证不是偶发（fragment 上传 / aggregate / MISMATCHED_PLATFORMS 任意
  一处出现 flake，第 2 次要能复现同样绿）。

不卡 `release.yml` / tag / gh release；Phase 1 不发版。

### Phase 2 — 6 个 worktree 并行（4-5 周）

```
        ┌──────────────────────── A1 已在 main ┌────────────────────────┐
        │                                                            │
        ▼                          ▼                                ▼
   ┌─────────┐                ┌─────────┐                       ┌─────────┐
   │ v116-d1 │                │ v116-c1 │                       │ v116-b1 │
   │ D1      │                │ C1      │                       │ B1      │
   │ test    │                │ archive │                       │ SQLite  │
   │ rewrite │                │ Node-   │                       │ retry   │
   │         │                │ native  │                       │         │
   └────┬────┘                └────┬────┘                       └────┬────┘
        │                          │                                │
        │                          │                                │
        │       ┌─────────┐        │       ┌─────────┐              │
        │       │ v116-d2 │        │       │ v116-d3 │              │
        └──────►│ D2     ├────────┘       │ D3     ├──────────────┘
                │ lifecycle│                │ async  │
                │ teardown │                │ retry  │
                └────┬────┘                └────┬────┘
                     │                          │
                     │                          │
                     │       ┌─────────┐        │
                     │       │ v116-e1 │        │
                     └──────►│ E1     ├────────┘
                             │ autostart│
                             │ .ps1     │
                             └────┬────┘
                                  │
                                  ▼
                ┌──────────────────────────────────────┐
                │  rc-1.1.6-candidate (integration)    │
                │  合并顺序：D1 → C1 → B1 → D2 → D3 → E1 │
                │  每个 worktree commit 同 commit 撤   │
                │  对应的 workaround                   │
                └──────────────────┬───────────────────┘
                                   │
                                   ▼
                ┌──────────────────────────────────────┐
                │  v1.1.6 release (rc-gate + release.yml│
                │  + tag + gh release create)           │
                └──────────────────────────────────────┘
```

**worktree 物理位置**：`G:\Projects\MetronX\local-memory-mcp\.worktrees\v116-{b1,c1,d1,d2,d3,e1}\`。
每个 worktree 一个 branch（如 `feat/v116-b1-sqlite-busy`），共享同一 git 仓库。

**合并进 `rc-1.1.6-candidate` 的顺序与理由**：

| # | Worktree | 理由 |
|---|----------|------|
| 1 | v116-d1 | test rewrite，blast 半径最小；顺手验证 orchestrator 冷启动模式（A1 留下的新 fragment 形状） |
| 2 | v116-c1 | tar round-trip 改 Node-native；与 D1 不冲突（D1 改 `mcp-stdio-idle.test.ts`） |
| 3 | v116-b1 | SQLite 重试；与 stress 基础设施与 C1 都无重叠 |
| 4 | v116-d2 | lifecycle 退出 profile；隔离在 `src/mcp/lifecycle.ts` + `mcp-shutdown.test.ts` |
| 5 | v116-d3 | Windows orphan 清理；与 B1 共享 stress 基础设施，放 B1 之后 |
| 6 | v116-e1 | PowerShell 脚本，CI 不碰，独立成提交，无 race |

每个 worktree 的 commit **同 commit 撤**对应 workaround（不是合并到 v1.1.6
之后再撤）：

| Worktree | 撤什么 |
|----------|--------|
| v116-b1 | `release.yml` 里 `if: matrix.os != 'windows-latest'` 那 1 行 |
| v116-c1 | `p3-extracted-artifact-lifecycle.test.ts` 里 `if (process.platform === "win32") { return }` 那段 |
| v116-d1 | `vitest.config.ts` + `vitest.blackbox.config.ts` 里 mcp-stdio-idle 的 `exclude` 2 处 |
| v116-d2 | `mcp-shutdown.test.ts` 里 `waitForExit(child, 5000)` 改回 2500 |
| v116-d3 | CHANGELOG v1.1.5 那条 carry-over 注释（v1.1.6 段会改；与 D3 commit 一起提交） |
| v116-e1 | `http-bridge/` 6 个 runtime artifact 不进 git（加进 `.gitignore`，commit 时不入） |

### Phase 2 合并窗口的 CI 规则

- 每个 worktree push 后，**只在自身分支**跑 CI（不直接对 `rc-1.1.6-candidate` 跑）。
- 合并到 `rc-1.1.6-candidate` 之后，`rc-branch` 的 release-candidate.yml
  跑一次验证（这就是 v1.1.5 的同款 gate）。
- 6 个 worktree 错峰 push（每 10-15 分钟一个），PR 模板显式
  `concurrency: v116-{branch}` 串行化同一 worktree 的多次 push，不串行化
  worktree 之间（让 macos-latest 池子分散压力）。

## 组件

### A1 — Release-evidence 切到 v1.1.3 fragments

**改的文件**：
- `.github/workflows/release-candidate.yml`：matrix leg 上传
  `release-evidence-fragment-matrix-<os>.json`；aggregate step 读 fragments。
- `scripts/verify-release-evidence.mjs`：删 `isLegacyDocument()` 分支 + `LegacyReleaseEvidence`
  Zod schema；走 v1.1.3 严格 schema；恢复 `MISMATCHED_PLATFORMS` 检查（3 platform
  都有 sha256 字段且一致）。
- `scripts/release-evidence.mjs`：不再在 rc-branch 上合成 `tag: "v1.1.X"`（tag
  来自 fragment 而不是 v1.1.2 hardcoded 路径）。

**新增/重写**：
- `release-evidence-fragment-matrix-<os>.json` 形状：
  ```ts
  {
    schema_version: 2,           // 从 1 升到 2
    candidate_sha: "<A1 commit>",
    version: "1.1.6",            // 读 package.json
    platform: "ubuntu-latest",   // 或 macos-latest / windows-latest
    ci_jobs: {                   // v1.1.3 GATE-04 形状
      "unit-integration": { passed: N, failed: 0, skipped: 0, duration_ms: M },
      "mcp-blackbox":     { ... },
      "release-gate":     { ... },
      "packaged-artifact":{ ... }
    },
    stress_summary: {
      profile: "release",
      workers: 8,
      ops_per_worker: 1250,
      unhandled_rejections: 0,
      worker_timeouts: 0
    },
    artifacts: {                 // 该 OS 矩阵腿产出的 archive
      "agent-recall-1.1.6-linux-x64.tar.gz": { sha256, size_bytes, path }
    }
  }
  ```

**Drop-when-done 信号**：`verify-release-evidence.mjs` 里搜不到 `isLegacyDocument`
或 `LegacyReleaseEvidence`；rc-branch CI 跑 2 次连续绿。

### B1 — Windows SQLite busy retry

**改的文件**：
- `src/store/sqlite-store.ts`：新增 `withBusyRetry(operation, { maxRetries=5,
  initialDelayMs=10, maxDelayMs=200, backoff=2 })` helper；在
  `prepare/stmt.run/stmt.get/all/iterate/transaction` 包装层注入；SQLITE_BUSY /
  SQLITE_LOCKED 触发重试。
- `release.yml`：删 `if: matrix.os != 'windows-latest'` 那 1 行（spec 5.6
  stress step 改回无条件运行）。

**新增**：
- `test/unit/sqlite-store-busy-retry.test.ts`：用合成的 SQLITE_BUSY 失败模式
  验证 retry 触发 + 重试计数暴露 + 最终错误码可读（**R3 缓解要求**）。
- CHANGELOG：v1.1.6 段记一条 "Windows multi-process stress: re-enabled (8
  workers × 1250 ops under winHandleBusy retry)"。

**Drop-when-done 信号**：`test/multi-process-stress.test.ts` line 1032 在
`STRESS_PROFILE=release` 下 windows-latest 跑过；release.yml 删 stress skip。

### C1 — 跨平台 archive

**改的文件**：
- `test/release-gate/p3-extracted-artifact-lifecycle.test.ts`：删 `if
  (process.platform === "win32") { return }` 短路；统一调 `scripts/archive.ts`。
- `scripts/archive.ts`（新文件）：纯 Node 实现 `tar + gzip`，`fs.cp` 拼目录 +
  `zlib.createGzip` 写流；接受 `{ src, dest, format: "tar.gz" | "zip" }`；
  `format: "zip"` 路径仍可用（windows 生产矩阵腿的 `.zip` 走 PowerShell
  `Compress-Archive`，`scripts/archive.ts` 不替代生产路径，只替代 test round-trip）。

**Drop-when-done 信号**：3 OS 矩阵腿都跑过 tar.gz round-trip；`if (process.platform
=== "win32")` 删干净。

### D1 — mcp-stdio-idle 改 EOF sentinel

**改的文件**：
- `test/blackbox/mcp-stdio-idle.test.ts`：assertion 从 "cap-bounded 2.5s
  timeout" 改为 "等 lifecycle emit 的 `eof.sentinel` 事件 + 短 grace period
  (e.g. 200ms)"。
- `vitest.config.ts` + `vitest.blackbox.config.ts`：删 mcp-stdio-idle 的
  `exclude` 两处。

**前置动作（**R4 缓解要求**）**：
- 第一步先 grep `src/mcp/` 看 lifecycle 有没有 emit 任何 `eof` /
  `sentinel` / `process.exit(0)` 前的标记事件。
- 如果有，直接用。
- 如果没有，D1 scope 扩到 "在 lifecycle 加 emit（位置：`src/mcp/lifecycle.ts`
  的 graceful shutdown 路径，紧邻 `process.exit(0)`） + 重写 test"。**这会
  改动会先告知用户**。

**Drop-when-done 信号**：`mcp-stdio-idle.test.ts` 在 orchestrator 跑过；2 个
vitest config 重新 include 该 test。

### D2 — Lifecycle 退出 profile 优化

**改的文件**：
- `src/mcp/lifecycle.ts`：profile 退出路径。常见耗时来源：graceful close
  期间 await transport close（HTTP 模式）；await in-flight requests
  resolve；锁文件 unlink；`process.exit(0)`。**优先**：
  1. 并行 transport close + in-flight drain（不串行）。
  2. 锁文件 unlink 改 fire-and-forget（不阻塞 exit）。
  3. `process.exit(0)` 前的 settle 等待有明确上限（已经 100ms，再优化意义
     不大）。
- `test/blackbox/mcp-shutdown.test.ts`：`waitForExit(child, 5000)` 改回 2500。

**Drop-when-done 信号**：orchestrator 上 `mcp-shutdown.test.ts` 在 2.5s 内
过；release.yml 不再含 5s cap。

### D3 — Windows orphan 进程清理

**改的文件**：
- `test/multi-process-stress.test.ts`：cleanup hook 改 async + retry；先
  调 `child.kill('SIGTERM')` → 等 ≤ 500ms → `child.kill('SIGKILL')`（如果还
  在）→ `await fs.promises.rm(homeDir, { recursive: true, force: true, maxRetries:
  3, retryDelay: 100 })`。

**Drop-when-done 信号**：windows-latest 上跑 10 次 stress cleanup 全过；CHANGELOG
v1.1.5 那条 carry-over 注释（"no orphaned child processes"）从 v1.1.6 段删掉。

### E1 — Windows autostart 重构收尾

**改的文件**：
- `http-bridge/install-windows-autostart.ps1`：把 `autostart-wip-2026-08-09`
  stash pop 出来应用；diff 102+/55- 已经是完成度 90%+ 的重构；本步骤做：
  1. 修 CJK 编码踩坑（**R5 缓解要求**）：按 agent memory 那条 PS 5.1 规则
     —— 双引号串里有 CJK + `$(...)` 子表达式会触发 tokenizer 错误；改法是
     把双引号里 CJK 替换成 ASCII（`Login auto-start` 而非 `登录时自动启`），
     CJK 写到注释里（`# 注册为登录时自动启动的服务`）。**先全文件 grep
     `\`$\(` 找双引号子表达式，再 grep CJK 范围（0x4E00-0x9FFF）**。
  2. 验证三方法：Task Scheduler（XML 注册）+ HKCU Run（注册表）+ Startup
     folder（快捷方式）。
  3. -Uninstall / -Status / -RunNow 子命令跑通。
  4. cleanup `http-bridge/` 下 6 个 runtime artifact（加 `.gitignore`，
     commit 时不入）。
- `.gitignore`（或 `http-bridge/.gitignore`）：加
  ```
  http-bridge/.bridge.env
  http-bridge/.run-bridge.cmd
  http-bridge/.task.xml
  http-bridge/bridge.err
  http-bridge/bridge.out
  http-bridge/test-body.json
  ```

**手动测试清单**（commit message 必贴，**R7 缓解要求**）：
- `pwsh -File install-windows-autostart.ps1` → 注册 task（管理员身份）
- `pwsh -File install-windows-autostart.ps1 -Status` → 显示 task 已注册 + 路径
- `pwsh -File install-windows-autostart.ps1 -RunNow` → 触发 task
- `curl http://127.0.0.1:7781/health` → 收到 200 + uptime < 60s
- `pwsh -File install-windows-autostart.ps1 -Uninstall` → task 删除
- 再次 -Status → "not registered"

**Drop-when-done 信号**：`http-bridge/` 6 个 runtime artifact 不再 untracked
（在 `.gitignore`）；stash `autostart-wip-2026-08-09` drop 掉；`install-windows-autostart.ps1`
在 Windows host 上 install/status/uninstall 跑通。

## 错误处理

| 失败点 | 行为 | 用户/Agent 感知 |
|---|---|---|
| A1 fragment 上传某条 OS 失败 | aggregate step 报 "missing fragment: <os>"；整个 gate fail | 用户看 GitHub Actions artifact 列表 |
| A1 MISMATCHED_PLATFORMS 触发 | 列出哪个 platform 的 sha256 不一致 + 期望 vs 实际 | 用户对比 release-artifact-hashes.json |
| B1 winHandleBusy 重试 5 次后还 BUSY | 抛 `SQLiteBusyError: busy after 5 retries`（带最后一次 attempt 的 SQL 上下文） | test 失败，日志可直接看 retry trace |
| C1 archive.ts 写盘失败（EACCES/ENOSPC） | 抛 `ArchiveError` + 清理部分写入 | test 失败，runtime artifact 不留 |
| D1 lifecycle 没 emit sentinel | D1 暂停扩 scope，等用户确认加 emit | Mavis 主动 ping 用户 |
| D2 lifecycle teardown > 2.5s | 改回 5s 临时绕过，profile 报告输出，等下一个迭代 | 不阻塞 v1.1.6 ship（兜底） |
| D3 cleanup retry 3 次还失败 | 抛 `CleanupError` + 列出残留 child pid + home 路径 | test 失败，运维介入 |
| E1 PowerShell tokenizer 错误 | diff 阶段就被 agent memory 那条 PS 5.1 规则挡住（先 grep 再 commit） | Mavis 自查，不让 commit 进 |
| Worktree merge 冲突 | 优先级：当前 worktree commit 优先（按合并顺序的"被合者"逻辑），冲突留给后续合并 | 冲突时停下来跟用户确认 |
| macos-latest runner 池饱和 | 错峰 push + 串行化同 worktree 多次 push | 慢但不停 |

## 测试

### 单元（`test/unit/`）

- `sqlite-store-busy-retry.test.ts` — 新建。覆盖：
  1. 重试触发：合成 SQLITE_BUSY 第 3 次成功（验证 retry 计数器）。
  2. 重试耗尽：5 次后还 BUSY，抛 `SQLiteBusyError` + 暴露 attempts。
  3. 非 BUSY 错误不重试：抛原始错误。
  4. 重试间隔指数退避（用 `vi.useFakeTimers`）。

### 黑盒（`test/blackbox/`）

- `mcp-stdio-idle.test.ts` — **重写**。从 cap-bounded 改为 EOF-sentinel。
  保留 idleMs=500 用例；新增"冷启动 5s 内 sentinel 到达"用例。
- `mcp-shutdown.test.ts` — `waitForExit(child, 5000)` 改回 2500；其他用例
  不动。

### Release-gate（`test/release-gate/`）

- `p3-extracted-artifact-lifecycle.test.ts` — 删 `if (process.platform ===
  "win32")` 短路；用 `scripts/archive.ts` 替换 `packTarGz`。
- `multi-process-stress.test.ts` — cleanup 改 async + retry + per-handle
  close。

### 集成

- `release-candidate.yml` matrix leg：3 OS 都跑 default suite +
  packaged-artifact + multi-process stress（windows-latest 不再 skip）。
- `release.yml`：spec 5.6 stress 矩阵腿移除 `if: matrix.os` 条件。

### E1（host 手动）

- Windows host 上 install / status / uninstall 三步，commit message 贴日志。
  PowerShell 5.1 tokenizer 错误（**R5**）由 commit 前的 grep 自查挡住，不
  让进 git。

## 验收（v1.1.6 发布那一刻必须满足）

**发布管道**
- [ ] A1 commit + 6 个 phase-2 worktree 都已合进 `rc-1.1.6-candidate`
- [ ] `release-candidate.yml` 在 v1.1.6 commit 跑绿
- [ ] `release.yml` 跑绿
- [ ] 3 个 platform archive 上传：`agent-recall-1.1.6-linux-x64.tar.gz` /
      `-darwin-x64.tar.gz` / `-win32-x64.zip`
- [ ] `v1.1.6` tag 切了
- [ ] `gh release create v1.1.6` 发布（3 个 archive + sha256）

**文档**
- [ ] `CHANGELOG.md` 新增 v1.1.6 段（Verified / Added / Removed 三段，参照
      v1.1.5 写法）
- [ ] `CHANGELOG.md` v1.1.5 "Known non-blocking limits" 整段删掉（**不**
      留注脚；v1.1.5 是历史定稿，不回填）

**代码侧 4 个临时绕过物理删除**（与修复同 commit 撤）
- [ ] `release.yml` 里 `if: matrix.os != 'windows-latest'` 删（B1 commit）
- [ ] `p3-extracted-artifact-lifecycle.test.ts` 里
      `if (process.platform === "win32")` 删（C1 commit）
- [ ] `mcp-shutdown.test.ts` 里 `waitForExit(child, 5000)` 改回 2500（D2 commit）
- [ ] `vitest.config.ts` + `vitest.blackbox.config.ts` 里 mcp-stdio-idle
      `exclude` 删（D1 commit）

**worktree 验收**
- B1：`STRESS_PROFILE=release` 在 windows-latest 跑过
- C1：3 OS 都跑 tar.gz round-trip
- D1：orchestrator 跑过 mcp-stdio-idle
- D2：orchestrator 退出 ≤ 2.5s
- D3：Windows stress cleanup 异步 + retry 后 0 flake
- E1：Windows host install / status / uninstall 跑通；CJK 修复

## 风险与缓解

| # | 风险 | 缓解 |
|---|------|------|
| R1 | A1 是最重单点：3-platform MISMATCHED_PLATFORMS 重启要求 rc-branch 矩阵 3 OS 都装包；v1.1.5 release-candidate.yml win/mac 矩阵腿基本没真正跑过 | A1 先在 side branch 上跑 ≥ 2 次连续干净 rc-gate（Phase 1 gate） |
| R2 | worktree 合并冲突（4 个改共享文件） | 每个 worktree commit 同 commit 撤对应 workaround（已写入段 B） |
| R3 | B1 retry 盖住真问题 | B1 commit 必带 unit test 喂合成 SQLITE_BUSY 证明 retry 触发 + 暴露 attempts + 不掩盖错误码 |
| R4 | D1 sentinel 假设不成立 | D1 第一步 grep `src/mcp/` 验 lifecycle 有没有 emit eof sentinel；没有就 scope 扩 + 主动告知用户 |
| R5 | E1 CJK 编码踩 PS 5.1 tokenizer 坑 | commit 前 grep `\`$\(` 找双引号子表达式 + grep CJK 范围；命中就先替换再 commit |
| R6 | GitHub Actions runner 池（macos-latest 小） | 错峰 push（10-15 分钟一个）+ PR 模板 `concurrency: v116-{branch}` 串行化同 worktree 多次 push，不串行 worktree 之间 |
| R7 | E1 没有 CI 覆盖 | v116-e1 commit message 写明 Windows host 手动跑 install / status / uninstall 三步 + 贴健康检查响应 |

## 文档交付

- 本 spec：`docs/superpowers/specs/2026-08-10-v116-followup-design.md`（本文件）
- issue #42 同步：本 spec 链接进去，issue E1 已闭合（随 v1.1.6 完成）
- CHANGELOG v1.1.6 段：与 v1.1.5 同样格式（Added / Removed / Verified），写明 6 + 1
  项的 drop-when-done
- 实施时由 writing-plans skill 产出 `docs/superpowers/plans/2026-08-10-v116-followup-plan.md`

## 计划路线

1. **本 spec 提交**（docs(spec) 提交到 main）
2. **用户复核通过** → 状态从"草稿"改为"已批准"
3. **writing-plans** 把 6 + 1 项拆成可执行 step（每 step 含 commit 模板 + CI 验证）
4. **Phase 1**：A1 在 side branch 上跑 ≥ 2 次连续干净 rc-gate → 合 main → 触发
   `rc-1.1.6-candidate` 跑
5. **Phase 1 gate 通过** → 启动 6 个 worktree（v116-b1 / v116-c1 / v116-d1 /
   v116-d2 / v116-d3 / v116-e1）
6. **每个 worktree 绿后** → 依次合并 D1 → C1 → B1 → D2 → D3 → E1 进
   `rc-1.1.6-candidate`
7. **Phase 2 完成** → rc-branch CI 跑绿 → 切 v1.1.6 tag → release.yml 跑绿 →
   gh release create
8. **CHANGELOG v1.1.5 那段删除 + v1.1.6 段补上**（与 release 同 commit）
9. **issue #42 全部子项勾选**（留 1 个 closed 主 issue 留作历史记录）
