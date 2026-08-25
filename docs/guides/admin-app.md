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

## v0.2 新增

### 工作栏改版

- 已选 filter 用 pill chips(可点击 ✕ 移除)
- `+` 按钮展开高级过滤弹层(importance / max_nodes / topic / type / status / co_topic / co_scope)
- 底部第二行:组织模式切换器(5 选 1)+ ✨ 整理按钮 + 手动 refresh

### 节点组织方式

5 种模式可切换:

- **无** — 原 dagre LR
- **按主题** — 同 topic 节点聚成水平簇,簇间大间距
- **按类型** — 7 种 type(preference / procedure / fact / decision / lesson / debugging / constraint)各自区域
- **按 scope** — 左 global / 右 project
- **按状态** — 4 行(active / archived / superseded / forgotten)

切换组织模式后点 ✨ 整理按钮,所有节点按当前模式重新布局(瞬间切换,无动画)。

### 详情页增强

drawer 扩到 460px,新增 4 个 section:

- **全文 body** — 等宽 + 横向滚动 + 复制按钮
- **标签 tags** — pill chips,无标签显示 —
- **来源 source** — 折叠 JSON,默认收起
- **关联记忆**:
  - 版本演进:supersedes / superseded_by 双向
  - 合并:merge(留 v0.3 持久化 TODO)
  - 相关主题:co_topic(限 5 条,显示总数)
  - 相关 scope:co_scope(默认折叠,显示总数)

点关联记忆的某行 → drawer 内容区 swap(不关闭,平滑换)。

点"在图中定位" → drawer 关闭(canvas pan/高亮留 v0.3,v0.2 简化)。

点"复制 ID" / "复制全文" → 调 clipboard API。

### 数据模型

- `GraphNode` 保持精简(不扩字段)
- `GraphFilter.organization` 字段(后端忽略,纯前端布局开关)
- `get_memory` 命令响应改 `MemoryDetail`,含 `related: MemoryRelations`
- 新 `packages/contracts/src/memory.ts` 模块:`RelatedNodeSchema` / `MemoryRelationsSchema` / `MemoryDetailSchema`

### v0.3 计划

- merge 关系持久化(GraphEdge 写库)
- co_scope 展开后虚拟滚动
- "在图中定位" 实现 canvas pan + 2s 高亮
- 整理动画缓动(FLIP / spring)
