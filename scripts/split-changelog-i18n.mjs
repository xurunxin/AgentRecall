#!/usr/bin/env node
// One-shot i18n split for CHANGELOG.md.
// Splits the existing CHANGELOG.md into:
//   - CHANGELOG.en.md  (English mirror, adds language banner)
//   - CHANGELOG.md     (Chinese primary, with v1.1.6 entry translated to
//                       Chinese; v1.1.5 and earlier preserved in English as
//                       historical record, marked with a clear note)
//
// Run from the project root: `node scripts/split-changelog-i18n.mjs`
// Safe to re-run (idempotent: rewrites both output files in place).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const changelogPath = resolve(root, "CHANGELOG.md");
const enPath = resolve(root, "CHANGELOG.en.md");

const original = readFileSync(changelogPath, "utf8");

// Detect the line ending used by the original (CRLF on Windows git checkouts).
const eol = original.includes("\r\n") ? "\r\n" : "\n";

// Find boundaries. v1.1.6 entry starts at the "## [1.1.6]" heading.
// v1.1.5 starts at the first "## [1.1.5]" heading.
const v116Start = original.indexOf("## [1.1.6]");
const v115Start = original.indexOf("## [1.1.5]");

if (v116Start < 0 || v115Start < 0 || v115Start < v116Start) {
  throw new Error(
    `Could not locate v1.1.6 / v1.1.5 headings (v116Start=${v116Start}, v115Start=${v115Start})`
  );
}

const historyEntries = original.slice(v115Start);

// Find H1 boundary to insert the banner in both files.
const h1Marker = `# Changelog${eol}${eol}`;
const h1Idx = original.indexOf(h1Marker);
if (h1Idx < 0) {
  throw new Error("Could not find H1 marker in original CHANGELOG.md");
}
const restAfterH1 = original.slice(h1Idx + h1Marker.length);

// --- English mirror --------------------------------------------------------
const enBanner = `> **🌏 Language**: English. 中文(默认): [CHANGELOG.md](./CHANGELOG.md).`;
const enContent = `${h1Marker}${enBanner}${eol}${eol}${restAfterH1}`;
writeFileSync(enPath, enContent, "utf8");
console.log(`Wrote ${enPath} (${enContent.length} bytes)`);

// --- Chinese primary -------------------------------------------------------
const v116Chinese = `## [1.1.6] — 发布门强化:清理 CHANGELOG${eol}${eol}` +
`### 新增${eol}${eol}` +
`- \`release-candidate.yml\` 的 matrix leg 现在按 OS 分别打包归档并写出 v1.1.3 GATE-04 的 per-platform fragment(\`release-evidence-fragment-matrix-<os>.json\`);\`Release aggregate\` 步骤通过 \`release-evidence.mjs --fragments\` 读取 3 个 matrix leg fragment + 3 个 packaged-artifact fragment,产出符合 v1.1.3 形态的 \`release-evidence.json\`(每平台的 \`ci_jobs[]\` + \`artifacts[]\` + 聚合 \`stress_summary\`)。${eol}` +
`- \`verify-release-evidence.mjs\` 切到 v1.1.3 GATE-04 严格 schema(\`schema_version: "1.1.3"\`);v1.1.2 的 \`LegacyReleaseEvidence\` 平行 schema、\`isLegacy\` 分派、\`verifyLegacyDocument()\` 全部删除。\`MISMATCHED_PLATFORMS\` 交叉校验(3 个 ci_jobs 与 3 个 artifacts 的 sha256 匹配)在 tag 路径上重新启用。${eol}` +
`- \`src/store/sqlite-store.ts\` 新增 \`withBusyRetry(op, opts?)\`,处理 \`SQLITE_BUSY\` + \`SQLITE_LOCKED\` 的指数退避(5 次重试,10ms → 200ms;耗尽时抛出 \`SQLiteBusyError\`,附 \`attempts\` + \`lastError\`)。类内的 \`runWithBusyRetry\`(同步,5 次 × 10ms 自旋)保留。\`isSqliteBusyError\` 现在也匹配 \`SQLITE_LOCKED\`(errcode 6,errno 6,code \`SQLITE_LOCKED\`)— v1.1.3 文档中 "SQLITE_LOCKED 不可重试" 的说法在 8-worker release profile 的 Windows-latest 争用下是错的。${eol}` +
`- \`scripts/archive.ts\` 实现 Node 原生 \`tar.gz\`(通过 \`zlib.createGzip\` 走 USTAR,**零**新增 npm 依赖)。\`archive(src, dest, "tar.gz" | "zip")\` 返回 \`{ sha256, size_bytes }\`。Windows 生产环境的 \`.zip\` 仍走 PowerShell \`Compress-Archive\`;Node 辅助函数接管测试往返路径,3 平台 tar.gz 往返不再 Windows 跳过。${eol}` +
`- \`src/mcp/server-lifecycle.ts\` 关闭序列用 \`Promise.all\` 并行 \`transport.close()\` + \`server.close()\`(SDK 的 \`StdioServerTransport.close()\` 幂等,在 \`server.close()\` in-flight 时安全;server 内部的 \`AbortController\` 不依赖 transport 已关闭)。调用方传入的 \`onShutdown\`(例如 \`service.store.close()\`)保持串行 — SQLite 关闭是唯一必须落在 \`process.exit(0)\` 之前的操作,否则会丢失最后一条审计追加。单元测试的 "errors during transport.close are also caught" 案例更新以反映新 D2 契约:即使 \`transport.close()\` 出错,\`server.close()\` **也**会被并行段调用(错误在到达清理钩子之前就终止了并行段)。${eol}` +
`- \`test/multi-process-stress.test.ts\` 的清理改为异步 + 重试。新增 \`cleanHomeAsync(homePath)\`(用 \`fs.promises.rm\`,参数 \`maxRetries: 3, retryDelay: 100, force: true\`,顶层 rm 仍抛错时回退到逐项 unlink)与 \`killChildrenGracefully(children)\`(\`SIGTERM\` → 500ms 宽限 → \`SIGKILL\` 升级),替换所有 \`rmSync\` 与无条件的 \`child.kill("SIGKILL")\`。suite 结束后的 "无孤儿子进程或临时数据目录" 断言在干净的 tmpdir 上是严格的(0 孤儿,0 屏障目录);v1.1.5 时代 "接受 SIGKILLed 受害者的 dataHome 作为唯一允许的孤儿" 的 workaround 注释删除。${eol}` +
`- \`test/blackbox/mcp-stdio-idle.test.ts\` 的 "在 idleMs=500、无流量时通过 idle 哨兵干净退出" 案例,把 v1.1.5 的 cap-bounded 2.5s 等待改为等待 stderr 上的 \`[lifecycle] idle-sentinel\\n\`(MCP 入口通过 \`src/mcp/server-lifecycle.ts\` 中新的 \`onShutdownComplete(reason)\` 钩子发出,门控在 \`reason === "stdio_idle_timeout"\`,所以 SIGTERM / EOF / SIGINT 路径保持静默)。该哨兵消除了 v1.1.5 时代编排器冷启动的时序 flake。${eol}` +
`- \`http-bridge/install-windows-autostart.ps1\` 把 stash \`autostart-wip-2026-08-09\` 里的 WIP 落地(该文件在 v1.1.5 时代的清理中从 main 删除,WIP 保留在具名 stash 中等 v1.1.6 取回)。三方法自启动安装器:Task Scheduler 主路径(XML,\`RestartOnFailure\` ×3,通过 svchost 静默启动,需要 admin),HKCU Run 注册表 + Startup 文件夹快捷方式作为回退。子命令:\`-Install\`(默认)、\`-Status\`、\`-Uninstall\`、\`-RunNow\`。WIP 中的 3 行 \`Write-Host\` 在双引号字符串里写了 CJK 标签(\`验证\` / \`启动\` / \`卸载\`)并嵌套了 \`$PSCommandPath\` 插值,这是 PowerShell 5.1 的分词器陷阱;修复方法是把标签改用 ASCII(\`Verify\` / \`RunNow\` / \`Uninstall\`),CJK 移到上方注释中(PS 5.1 \`[Parser]::ParseFile\` 报告 0 个解析错误)。${eol}` +
`- \`http-bridge/.gitignore\` 忽略 bridge 写出的 6 个运行时产物(\`.bridge.env\` 用户配置,跨 \`-Uninstall\` 保留;\`.run-bridge.cmd\`、\`.task.xml\`、\`bridge.err\`、\`bridge.out\`、\`test-body.json\`)以及 E1 手动测试的输出捕获(\`.e1-test-output.txt\`)。${eol}${eol}` +
`### 删除${eol}${eol}` +
`- v1.1.5 的 "Known non-blocking limits" 整段删除(共 4 条:extracted-artifact-lifecycle v1.1.3 GATE-04 fragment 流水线、multi-process-stress Windows 孤儿 flake、mcp-stdio-idle 编排器冷启动时序、verify-release-evidence v1.1.2 遗留 shim)。4 个 workaround 全部在本版本中物理删除,该段是"删除"而不是"加注释"。${eol}` +
`- \`release.yml\` 中 \`if: matrix.os != 'windows-latest'\` 的 stress 跳过(B1 commit 在新的 \`withBusyRetry\` 下重新启用了 windows-latest multi-process stress)。${eol}` +
`- \`p3-extracted-artifact-lifecycle.test.ts\` 中 \`if (process.platform === "win32") { return }\` 的 tar 往返跳过(C1 commit 用 Node 原生 \`scripts/archive.ts\` 取代了 shell-out 到 GNU tar 的 \`packTarGz\`)。${eol}` +
`- \`mcp-stdio-idle.test.ts\` 从 \`vitest.config.ts\`(unit-integration)与 \`vitest.blackbox.config.ts\`(mcp-blackbox)的 \`exclude\` 中移除(D1 commit 在哨兵等待改写后重新包含该测试)。${eol}` +
`- \`mcp-shutdown.test.ts\` 全部 4 处调用点 + 函数默认值的 \`waitForExit(child, 5000)\` 上限(D2 commit 在 lifecycle 并行化解决根因后,回到 2500)。${eol}${eol}` +
`### 已验证${eol}${eol}` +
`- \`release-candidate.yml\` 在 \`rc-1.1.6-candidate\` @ v1.1.6 上为绿(3 平台 matrix leg 按 OS 打包,上传 3 个 matrix leg fragment + 3 个 packaged-artifact fragment,聚合步骤产出 v1.1.3 形态的 \`release-evidence.json\` 且 \`MISMATCHED_PLATFORMS\` 为空,验证器在 tag 上通过 v1.1.3 严格路径)。${eol}` +
`- 默认套件:631/631 测试在 Windows-latest 通过(v1.1.5 时代 \`mcp-stdio-idle.test.ts\` 的 Windows afterAll EPERM——\`rmSync\` 与仍关闭中的 stdio 管道竞用——v1.1.6 不变,仍是唯一的文件级 flake;底层的 3 个 idle 哨兵测试通过)。${eol}` +
`- 压测套件(\`vitest.stress.config.ts\`, \`STRESS_PROFILE=ci\`):11/11 测试在 Windows-latest 连续 3 次运行后通过。D3 的异步 + 重试清理关闭了 Windows-latest 的 EBUSY/EPERM 窗口,使 suite 结束后的孤儿断言严格。${eol}` +
`- 黑盒套件(\`vitest.blackbox.config.ts\`):117/117 测试在 Windows-latest 通过;摘要中列为 v1.1.5 时代 flake 的 4 个 mcp-e2e 文件级测试在 D1 的哨兵改写 + D2 的并行化之后不再出现在失败集中。${eol}` +
`- 手动:\`install-windows-autostart.ps1 install / status / uninstall\` 周期在 Windows 11 pwsh 7 上通过(非 admin 走 HKCU Run 回退;admin 走 Task Scheduler 主路径;\`[lifecycle] idle-sentinel\` 改写 + D2 并行化使编排器在忙 VM 环境下也不再 flake \`mcp-shutdown.test.ts\`)。

`;

const zhH1 = `# 变更日志${eol}${eol}`;
const zhBanner = `> **🌏 语言 / Language**: 中文。English: [CHANGELOG.en.md](./CHANGELOG.en.md)。${eol}${eol}` +
`本文件记录 agent-recall 的所有重要变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),项目遵守 [Semantic Versioning](https://semver.org/)(非正式遵守 — 这是个人工具,但保留文件结构以便未来贡献者使用)。${eol}${eol}` +
`> **关于历史条目**:v1.1.5 及更早的条目保留英文原文(2026-08 之前没有中文文档约定)。从 v1.1.6 起,新条目用中文记录,英文版在 [CHANGELOG.en.md](./CHANGELOG.en.md) 同步。${eol}${eol}`;

const zhContent = `${zhH1}${zhBanner}${v116Chinese}${historyEntries}`;
writeFileSync(changelogPath, zhContent, "utf8");
console.log(`Wrote ${changelogPath} (${zhContent.length} bytes)`);

// Sanity check: v1.1.5 heading is preserved in the output.
if (!zhContent.includes("## [1.1.5]")) {
  throw new Error("v1.1.5 heading missing from output");
}
if (!zhContent.includes("## [1.1.6]")) {
  throw new Error("v1.1.6 heading missing from output");
}
console.log("Sanity checks pass: both v1.1.5 and v1.1.6 headings present.");
