# Bun 单文件二进制分发

> 本文档是 `docs/guides/bun-distribution.md` 的中文版本。**当前实现版本：v1.1.4**。

Bun 分发路径是**附加的**分发渠道。Node 的 npm 包（`agent-recall`）仍然是主路径。Bun 二进制面向需要单文件 drop-in、且能接受较小覆盖面的运维者（已做 smoke 测试，但未跑完整 vitest）。

## 前置条件

- **构建主机**：PATH 上需有 Bun ≥ 1.3.0（`bun --version`）。
- **消费主机**：无。Bun 二进制是自包含的。

## 构建

```bash
npm run build:bun
```

脚本会为每个正式平台（`linux-x64`、`darwin-x64`、`darwin-arm64`、`win32-x64`）在 `dist-bin/` 下写出 `agent-recall-<plat>[.exe]` 和 `agent-recall-mcp-<plat>[.exe]`，并生成 `dist-bin/MANIFEST.json`（含每个二进制的 SHA-256）。

脚本在任何工作前会断言 `bun --version >= 1.3.0`，若主机 Bun 版本过老会以清晰消息退出非零。

## 安装

从对应版本 GitHub Release 中挑选适配消费端平台的二进制。对照 Release 的 `MANIFEST.json` 校验 SHA-256，然后放入 `PATH`：

```bash
# linux-x64 示例
curl -L -o agent-recall https://github.com/xurunxin/AgentRecall/releases/download/v1.1.4/agent-recall-linux-x64
curl -L -o MANIFEST.json https://github.com/xurunxin/AgentRecall/releases/download/v1.1.4/MANIFEST.json
sha256sum -c <(jq -r '.entries[] | select(.platform=="linux-x64" and .kind=="cli") | "agent-recall  " + .sha256' MANIFEST.json)
chmod +x agent-recall
sudo mv agent-recall /usr/local/bin/agent-recall
```

MCP 服务二进制走相同配方（`agent-recall-mcp-<plat>`）。

## Smoke 测试

```bash
npm run smoke:bun
```

针对主机平台二进制跑 6 步 smoke（`--version`、`help`、`doctor`、export+import 往返、`backup`、备份后 `doctor`）。全部通过退出 0；任一失败输出 `[smoke_failed]`。二进制缺失时干净跳过。

## 能力矩阵

| 能力 | Node 二进制 | Bun 二进制 |
| --- | --- | --- |
| `--version` / `help` / `doctor` | 是 | 是（已 smoke） |
| `list` / `show` / `search` / `audit` | 是 | 是（已 smoke） |
| `export` / `import` | 是 | 是（已 smoke） |
| `backup` / `restore` | 是 | 是（已 smoke） |
| `migrate --yes` | 是 | 是（Node 测试覆盖；Bun 运行期未直接跑） |
| `admin grant/status/revoke` | 是 | 是（已 smoke） |
| MCP stdio（10/20 工具） | 是 | 是（同一份 `dist/src/index.js` + Bun 运行期） |
| 全部 24 项 `doctor` 检查 | 是（Node 上 vitest） | Bun 上 smoke（3 + 6） |
| `AGENT_RECALL_HOME` 环境变量 | 是 | 是 |
| `AGENT_RECALL_PROFILE` 环境变量 | 是 | 是 |
| `AGENT_RECALL_VERBOSE_STDIO` 环境变量（v1.1.4） | 是 | 是 |

> v1.1.4 起的 MCP 优雅退出（`src/mcp/server-lifecycle.ts`）保证 Bun 二进制在 stdin EOF 或收到终止信号后干净退出，`AGENT_RECALL_VERBOSE_STDIO=1` 时会在 stderr 输出原因行。

## 发布渠道

Bun 二进制是 GitHub Release 产物，**不是** npm 产物。npm 包继续只发 Node 路径。理由：

- 保持 npm 包体积不变。
- 保持 `package.json` `bin` 简单（不需要 platform-matrix postinstall）。
- 解耦 Bun 二进制发布与 npm publish 节奏——Bun 二进制可以提前于、伴随或独立于 npm 发布。

消费 `dist-bin/MANIFEST.json` 的发布流水线由后续 ADR（`docs/adr/0007-bun-binary-release.md`）规定，不在本文档范围内。
