# OpenCode 安装指南

> 本文档是 `docs/guides/opencode-install.md` 的中文版本。**当前实现版本：v1.1.4**。

本指南是注册 AgentRecall（`local-memory-mcp`）到 [OpenCode](https://opencode.ai) 的**规范配方**。涵盖两个必需步骤：MCP 服务（`mcp:` 段）与 prompt 注入插件（`plugin:` 段），以及可选的环境变量与排障开关。

下面示例中的路径以项目位于 `G:\Projects\MetronX\local-memory-mcp` 为前提，且已经执行过 `npm install` 和 `npm run build`（或已安装正式发布的产物；详见顶层 README "安装方式" 一节）。

## 1. 注册 MCP 服务

将 server 块加到 `~/.config/opencode/opencode.json` 的 `mcp` 下：

```json
{
  "mcp": {
    "agent-recall": {
      "command": [
        "node",
        "G:\\Projects\\MetronX\\local-memory-mcp\\dist\\src\\index.js"
      ],
      "enabled": true,
      "environment": {
        "AGENT_RECALL_HOME": "G:\\Memory\\AgentRecall",
        "AGENT_RECALL_ACTOR": "claude-code"
      },
      "type": "local"
    }
  }
}
```

这会向 OpenCode 会话暴露当前 MCP Profile 注册的工具。打包默认是 Core（10 个工具）；设置 `AGENT_RECALL_PROFILE=extended` 可启用 20 个 Extended 工具，`admin` 则还需要有效操作员 capability。`mcp:` 块是 MCP 工具可用所需的**唯一**注册；第 2 步的插件与它相互独立。

## 2. 注册 prompt 注入插件（可选）

插件位于项目内 `G:\Projects\MetronX\local-memory-mcp\opencode-plugin\`。它是**可选的伴生**：装上后，每个 LLM 轮次的系统提示会自动追加一段 `[AGENT_RECALL]` 块，包含项目级 + 全局记忆。不装则需要手动调用 `recall_context` 来拉取。

把路径加到 `~/.config/opencode/opencode.json` 的 `plugin` 下：

```json
{
  "plugin": [
    "G:\\Projects\\MetronX\\local-memory-mcp\\opencode-plugin"
  ]
}
```

选项以二元组第二个元素传入：

```json
{
  "plugin": [
    [
      "G:\\Projects\\MetronX\\local-memory-mcp\\opencode-plugin",
      { "max_chars": 6000, "cache_ttl_ms": 90000, "debug": false }
    ]
  ]
}
```

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `max_chars` | `8000` | 注入块的硬上限字符数。 |
| `cache_ttl_ms` | `60000` | 复用已格式化块的时长。设为 `0` 关闭缓存。 |
| `db_path` | （默认） | 覆盖 DB 位置，见下文环境变量。 |
| `max_entries` | `40` | 包含的记忆条目硬上限。 |
| `include_global` | `true` | 设为 `false` 时仅注入项目 scope 记忆。 |
| `header` | （默认） | 注入块的首行；设为空字符串可省略。 |
| `debug` | `false` | 每次注入时向 `stderr` 输出日志。 |

插件通过 `node:sqlite` 读取与 MCP 服务相同的 SQLite 库（`$AGENT_RECALL_HOME/memory.sqlite`）。它**不写**也不覆盖已有的系统提示内容——只是向 `output.system` 追加。所有 IO / 解析 / Schema 错误都被捕获并记录；插件失败时是 no-op，LLM 调用照常进行。

## 3. 环境变量

MCP 服务从自身进程环境读取这些变量（在 `mcp.agent-recall.environment` 块或 shell 中设置）：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `AGENT_RECALL_HOME` | `~/.agent-recall` | 数据目录；SQLite 位于 `${AGENT_RECALL_HOME}/memory.sqlite`。 |
| `AGENT_RECALL_ACTOR` | `agent` | 默认审计 Actor。 |
| `AGENT_RECALL_PROFILE` | `core` | 可选 `core` / `extended` / `admin`；`admin` 还需要有效操作员 capability。 |
| `AGENT_RECALL_SUPPRESS_MCP_DEPRECATION` | 未设置 | 设为 `1` 屏蔽一次性 MCP 弃用提示。 |
| `AGENT_RECALL_VERBOSE_STDIO` | 未设置 | 设为 `1` 时，在 stdin 关闭或收到终止信号时向 stderr 输出一行退出原因；stdout 保持协议纯净。 |

插件通过相同的解析链识别 `AGENT_RECALL_HOME`；可通过选项中的 `db_path` 覆盖。

> **v1.1.4 行为变化**：MCP stdio 服务现在在客户端关闭 stdin 或发送终止信号时会干净退出（`src/mcp/server-lifecycle.ts`）。设置 `AGENT_RECALL_VERBOSE_STDIO=1` 可在退出时看到 `agent-recall shutting down (stdin EOF)` / `… (SIGTERM)` / `… (SIGINT)` 的原因行。热路径默认静默，stdout 始终保持协议纯净。

## 4. 验证

保存 `opencode.json` 后，在任意项目里启动一个全新 OpenCode 会话：

1. 确认 MCP 工具已出现（如 `agent-recall_recall_context`、`agent-recall_remember`）。它们列在会话系统提示中。
2. 如果装了插件，确认每轮系统提示都已追加 `[AGENT_RECALL]` 块。设置 `debug: true` 可在 stderr 看到日志。
3. 验证 SQLite 路径：插件 debug 日志会打印 `loaded N project scope(s) from <path>; include_global=<bool>`。

单独 smoke 测试 MCP 服务（不经过插件）：

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' \
  | node G:\\Projects\\MetronX\\local-memory-mcp\\dist\\src\\index.js
```

预期：先收到 `serverInfo.name: "agent-recall"` 的响应，再收到 `tools/list` 响应（列出当前 Profile 的工具）。

## 5. 单独 smoke 测试插件

插件自带 `node --test` 套件：

```bash
npm --prefix G:\\Projects\\MetronX\\local-memory-mcp\\opencode-plugin test
```

预期：`pass 5 fail 0`。套件默认打开 `G:\Memory\AgentRecall\memory.sqlite`；可通过插件选项中的 `db_path` 按测试覆盖。

## 6. 卸载

从 OpenCode 中移除 AgentRecall：

1. 从 `~/.config/opencode/opencode.json` 中删除 `mcp.agent-recall` 块。
2. 从 `opencode.json` 的 `plugin` 数组中删除 `G:\\Projects\\MetronX\\local-memory-mcp\\opencode-plugin` 条目（如有）。
3. `$AGENT_RECALL_HOME/memory.sqlite` **不会**被自动删除——如需清空请自行备份或删除。

## 相关链接

- MCP 服务源码：本仓库 `src/`。
- 插件源码：本仓库 `opencode-plugin/index.js`。
- 插件选项 / 失败模式：`opencode-plugin/README.md`。
- 与插件同仓的决定：见 `CHANGELOG.md`。
