# AgentRecall Admin (v0.1) 使用指南

> 🌏 语言 / Language: 中文。English: [admin-app.en.md]

## 简介

`agent-recall-admin` 是 AgentRecall v1.1.6+ 的桌面 GUI 应用,**v0.1
支持只读浏览**:记忆图谱可视化 + 基础过滤。写操作(remember /
update / forget / merge / supersede)在 **v0.2 启用**。

## 环境要求

- Node.js ≥ 24
- npm ≥ 10
- Rust ≥ 1.77(`rustup install stable`)
- Tauri 2.0 系统依赖(见 https://tauri.app/start/prerequisites/)
- 一个已存在数据的 AgentRecall data-home(默认 `~/.agent-recall/agent-recall.db`)

## 构建与运行

### 1. 安装依赖

```bash
cd AgentRecall
npm install
```

### 2. 启动开发模式

```bash
cd apps/admin
npm run tauri -- dev
```

首次会编译 Rust 端(5-10 分钟)。之后增量编译 5-30 秒。

### 3. 配置 data-home

默认读 `~/.agent-recall/agent-recall.db`。如要覆盖:

- Linux / macOS:`export AGENT_RECALL_DATA_HOME=/path/to/your.db`
- Windows(PowerShell):`$env:AGENT_RECALL_DATA_HOME = "C:\path\to\your.db"`

### 4. 跨平台

| 平台 | 状态 |
|---|---|
| Windows 10/11 | ✅ 已验证 |
| macOS 13+ (Intel / Apple Silicon) | ✅ 已验证 |
| Ubuntu 22.04+ | ✅ 已验证 |

## 功能

- ✅ 启动后展示 graph 视图(节点=memory,边=supersede/merge/co_topic/co_scope)
- ✅ 过滤:scope / topic / type / status / min_importance / max_nodes / include_co_topic / include_co_scope
- ✅ 5s 轮询 SQLite mtime,变化时自动刷新
- ❌ 写操作(remember/update/forget/merge/supersede)—— v0.1 **显式 DISABLED**,v0.2 启用
- ❌ 服务管理(启停/doctor/日志)—— v0.3
- ❌ 备份/导入 —— v0.3

## 已知限制

- 不会自动打包(`.msi`/`.dmg`/`.AppImage`),需 `tauri build`(v0.2 启用)
- 轮询频率固定 5s(v0.2 改为设置面板可调)
- 不支持 Tauri 自动更新
- 不签名 / 不公证

## 反馈

提 issue 时附:

- `apps/admin/src-tauri/target/release/agent-recall-admin.log`(如存在)
- `data-home/agent-recall.log`
- OS + 架构 + 屏幕分辨率
- 复现步骤
