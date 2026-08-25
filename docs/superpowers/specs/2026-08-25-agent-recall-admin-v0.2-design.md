# AgentRecall Admin v0.2 — 工作栏改版 + 节点组织 + 详情页增强

> 日期：2026-08-25
> 状态：草案（待用户复核）
> 修订：v0.1 baseline at commit `c6d884e` (PR #46 后续 ~33 commits on `feat/admin-v01-graph-readonly`)
> 作者：brainstorming 工作流（许润鑫 × Mavis）
> 关联 issue：—
> 前置 spec：[`2026-08-24-agent-recall-admin-design.md`](2026-08-24-agent-recall-admin-design.md)（v0.1 graph 只读 + monorepo 骨架）

> 🌏 语言 / Language: 中文。

## 背景与问题

v0.1 在 PR #46 上已经稳定（32 commits,graph 只读 + 自渲染 + 边/锚点/网格/Controls/MiniMap 修复）。但当前 admin app 还处于"能看不能用"阶段,4 类痛点:

1. **工作栏原始堆砌** — `FilterBar.tsx` 把 scope / topic / type×7 / status×4 / importance / max_nodes / co-topic / co-scope 全部一排 `<label>` 罗列,占两行,可读性差,无法快速切换主题。
2. **图布局单一** — 只用 dagre LR 一刀切,节点散乱没有结构,无法表达"按主题分组"或"按状态分层"等组织意图。
3. **一键整理缺失** — 用户拖乱节点后没有"重新整理"按钮,只能 F5 刷新整页(还会丢失拖动状态)。
4. **详情页残缺** — `MemoryDrawer` 只展示 8 个元数据字段,真正的记忆内容(`body`)和关联记忆(版本演进 / 同主题跳转)都看不到。`get_memory(id)` Rust 命令已经把全行数据拿到了,但前端没接。

参考 [TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) 的"分层记忆 + 语义族聚类 + node_id 钻取"模式,本 spec 给出 v0.2 的统一设计。

## 目标

在 v0.1 基础上交付 4 个增强:

- **G1. 工作栏改版**:已选 filter 用 pill chips 可视化,高级项弹层收纳,新增组织模式切换器 + 整理按钮
- **G2. 节点组织方式**:4 种组织模式(by_topic / by_type / by_scope / by_status),前端 layout 切换
- **G3. 一键整理按钮**:根据当前激活模式重新计算所有节点位置
- **G4. 详情页增强**:body 全文 + tags + source + 关联记忆(supersede / superseded_by / merge / co_topic;co_scope 折叠)

仍坚持 v0.1 的零侵入 / 双通道 / monorepo / Tauri 2.0 约束。

## 范围

### 在范围内

- 前端 `apps/admin/`
  - `FilterBar.tsx` 改版(pill chips + 弹层)
  - 新组件 `OrgModeSwitcher.tsx` / `OrganizeButton.tsx` / `RelatedMemories.tsx` / `MemoryBody.tsx` / `MemoryTags.tsx` / `MemorySource.tsx`
  - 新 `apps/admin/src/components/graph/layouts/{layoutNone,layoutByTopic,layoutByType,layoutByScope,layoutByStatus}.ts`
  - `GraphCanvas.tsx` 接入 `filter.organization`,按模式选择 layout
  - `MemoryDrawer.tsx` 扩展 sections + 接 `useMemoryDetail`
  - 新 `lib/useMemoryDetail.ts`
  - `lib/tauri.ts` 加 `getMemoryDetail(id)` wrapper
- 共享 `packages/contracts/`
  - `graph.ts` 加 `ORG_MODES` / `OrgMode` / `GraphFilter.organization` 字段
  - 新 `memory.ts`:`RelatedNodeSchema` / `MemoryRelationsSchema` / `MemoryDetailSchema`
- Rust 后端 `apps/admin/src-tauri/`
  - `commands/memory.rs` 的 `get_memory` 改返回 `MemoryDetail`(含 `related`)
  - 新增相关记忆查询(2 个新 SQL:`co_topic` + `co_scope`,复用 `supersedes` 字段和 GraphEdge 表)

### 不在范围内 (v0.2)

- 整理动画的缓动(瞬间切换,v0.3 再做 FLIP/spring)
- 节点右键菜单编辑 / 删除(read-only 维持,v0.3 加 CRUD)
- 全文 in-drawer 搜索 / 高亮
- co_scope 展开后的虚拟滚动(固定折叠,co_topic 限 5 条 + "更多" 链接到搜索页)
- 移动端适配
- 主题切换
- 详情页"前进 / 后退"导航(只保留当前节点)

## 设计

### 仓库结构(增量)

```
apps/admin/src/
├── components/graph/
│   ├── FilterBar.tsx                 # 改版
│   ├── GraphCanvas.tsx               # 改:接 organization
│   ├── MemoryDrawer.tsx              # 改:加 4 个 section
│   ├── MemoryNode.tsx                # 不动
│   ├── Controls.tsx                  # 不动
│   ├── MiniMap.tsx                   # 不动
│   ├── EdgeLegend.tsx                # 不动
│   ├── OrgModeSwitcher.tsx           # 新
│   ├── OrganizeButton.tsx            # 新
│   ├── RelatedMemories.tsx           # 新
│   ├── MemoryBody.tsx                # 新
│   ├── MemoryTags.tsx                # 新
│   ├── MemorySource.tsx              # 新
│   └── layouts/
│       ├── layoutNone.ts             # 新(包 dagre LR 现状)
│       ├── layoutByTopic.ts          # 新
│       ├── layoutByType.ts           # 新
│       ├── layoutByScope.ts          # 新
│       └── layoutByStatus.ts         # 新
├── lib/
│   ├── tauri.ts                      # 改:加 getMemoryDetail
│   ├── useGraph.ts                   # 不动
│   ├── useMemoryDetail.ts            # 新
│   └── usePolling.ts                 # 不动
└── routes/
    └── graph.tsx                     # 改:传 organization,挂 useMemoryDetail
```

### 数据模型

#### `GraphNode` 保持精简(不动)

继续作为图查询的轻量返回。body / tags / source / confidence / sensitivity 不进 GraphNode —— 加 1 字段意味着 1000 个节点的图查询多扫 ~30KB 数据,得不偿失。详情页用独立的 `get_memory(id)` 拉全行。

#### `GraphFilter` 加 `organization` 字段

`packages/contracts/src/graph.ts`:

```ts
export const ORG_MODES = ["none", "by_topic", "by_type", "by_scope", "by_status"] as const;
export type OrgMode = (typeof ORG_MODES)[number];

export const GraphFilterSchema = z.object({
  // ... 现有字段 (scope, project_id, topic, type, status, min_importance, max_nodes,
  //     include_co_topic, include_co_scope)
  organization: z.enum(ORG_MODES).default("none"),
});
```

> **重要**:`organization` 不进 SQL WHERE,只是前端 layout 的开关。Rust 端忽略它,后端返回相同的 `nodes + edges`。

#### `MemoryDetail` 新 schema

`packages/contracts/src/memory.ts`(新文件):

```ts
import { z } from "zod";
import { MemoryType, MemoryStatus } from "./schema.js";

export const RelatedNodeSchema = z.object({
  id: z.string().min(1),
  title: z.string(),         // 截断到 ~60 字符
  topic: z.string(),
  type: z.enum(MemoryType),
  status: z.enum(MemoryStatus),
  importance: z.number().int().min(1).max(5),
});

export const MemoryRelationsSchema = z.object({
  supersedes: z.array(RelatedNodeSchema),     // 当前节点 supersedes 这些
  superseded_by: z.array(RelatedNodeSchema),  // 被这些 supersede
  merge: z.array(RelatedNodeSchema),          // 双向合并
  co_topic: z.array(RelatedNodeSchema),       // limit 5
  co_topic_total: z.number().int(),
  co_scope: z.array(RelatedNodeSchema),       // 折叠,只列前 3
  co_scope_total: z.number().int(),
});

export const MemoryDetailSchema = MemorySchema.extend({
  related: MemoryRelationsSchema,
});

export type RelatedNode = z.infer<typeof RelatedNodeSchema>;
export type MemoryRelations = z.infer<typeof MemoryRelationsSchema>;
export type MemoryDetail = z.infer<typeof MemoryDetailSchema>;
```

#### `get_memory` 响应改为 `MemoryDetail`

`apps/admin/src-tauri/src/commands/memory.rs`:

```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct MemoryDetail {
  // 现有 Memory 全字段(id, scope, project_id, type, topic, title, body, tags,
  //   importance, confidence, sensitivity, status, supersedes, source,
  //   created_at, updated_at, revision)
  pub related: MemoryRelations,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct MemoryRelations {
  pub supersedes: Vec<RelatedNode>,    // FROM row.supersedes JOIN
  pub superseded_by: Vec<RelatedNode>, // 双向反查
  pub merge: Vec<RelatedNode>,          // 从 GraphEdge 表 kind='merge' 拉双向
  pub co_topic: Vec<RelatedNode>,       // LIMIT 5
  pub co_topic_total: u32,
  pub co_scope: Vec<RelatedNode>,       // LIMIT 3
  pub co_scope_total: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RelatedNode {
  pub id: String,
  pub title: String,
  pub topic: String,
  pub r#type: String,        // serde rename "type" 同 Memory 现有约定
  pub status: String,
  pub importance: u8,
}
```

### Rust 后端查询

在 `get_memory` 内部串行跑 4 个查询(在事务里保证一致性):

```rust
async fn get_memory(state, id) -> Result<MemoryDetail> {
  // 1) 拉主行 (现有 parse_memory_row,改名 keep memory_basic)
  let mem = conn.query_row("SELECT ... WHERE id = ?", [id], parse_memory_basic)?;

  // 2) supersedes: 从 mem.supersedes 解析的 id 列表
  let supersedes = related_summary_for_ids(&conn, &mem.supersedes)?;

  // 3) superseded_by: 反查 (status='superseded' AND supersedes_json LIKE '%"id"%')
  //   SQLite 没有 JSON 查询, 用 LIKE 模糊匹配 + 应用层过滤
  let superseded_by = related_superseded_by(&conn, id)?;

  // 4) merge: 查 GraphEdge 表 kind='merge' 双向
  //   但 GraphEdge 表当前不在 SQLite 里! v0.1 只在内存里构建 (apps/admin/src-tauri/src/reader/graph.rs::build_graph)
  //   选项:
  //     (a) 新建持久化 GraphEdge 表,把边也存起来
  //     (b) merge 关系存在 memory_entries 的某列里(待查)
  //     (c) v0.2 先返回空 Vec,merge 关系留 v0.3
  //   决策:c) v0.2 merge 留 TODO,supersede + co_topic + co_scope 三个先做
  let merge = vec![];  // TODO v0.3: GraphEdge 持久化

  // 5) co_topic: 同 topic, 排除自身, LIMIT 5 + total count
  let (co_topic, co_topic_total) = related_by_field(&conn, "topic", &mem.topic, &[&id], 5)?;

  // 6) co_scope: 同 scope, 排除自身, LIMIT 3 + total count
  let (co_scope, co_scope_total) = related_by_field(&conn, "scope", scope_str(&mem.scope), &[&id], 3)?;

  Ok(MemoryDetail { ...mem, related: MemoryRelations { supersedes, superseded_by, merge, co_topic, co_topic_total, co_scope, co_scope_total } })
}
```

helper:

```rust
/// 按单字段匹配拉 RelatedNode 列表 + total count。
fn related_by_field(
  conn: &Connection,
  field: &str,                  // "topic" | "scope"
  value: &str,                  // 匹配值
  exclude_ids: &[&str],         // 排除 id
  limit: u32,
) -> Result<(Vec<RelatedNode>, u32)> {
  // 防御: field 必须是白名单
  let field = match field { "topic" => "topic", "scope" => "scope", _ => bail!() };

  // total count
  let total: u32 = conn.query_row(
    &format!("SELECT COUNT(*) FROM memory_entries WHERE {} = ? AND id NOT IN ({})",
      field, exclude_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",")),
    ...)?;

  // items
  let mut stmt = conn.prepare(&format!(
    "SELECT id, title, topic, type, status, importance FROM memory_entries
     WHERE {} = ? AND id NOT IN ({}) ORDER BY updated_at DESC, id ASC LIMIT ?",
    field, ...))?;
  // ...
}
```

**⚠️ merge 关系追踪问题**:v0.1 的 GraphEdge 不持久化,所以 v0.2 后端暂时返回 `merge: vec![]`,在 spec 里明确 TODO v0.3。supersede 已有 `supersedes_json` 列,可双向反查。

### 4 种组织模式(前端 layout)

每个 layout 接收 `(nodes, edges) => Record<nodeId, Position>`,返回与现有 `layoutWithDagre` 同形状。

`apps/admin/src/components/graph/layouts/layoutByTopic.ts`:

```ts
import dagre from "@dagrejs/dagre";

/**
 * 同 topic 的节点聚成一个水平 rank, topic 之间用大间距隔开。
 * 算法: 按 topic 分组 → 每组 dagre LR → 合并坐标 + 偏移。
 */
export function layoutByTopic(
  nodes: GraphNode[], edges: GraphEdge[]
): Record<string, Position> {
  const byTopic = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    if (!byTopic.has(n.topic)) byTopic.set(n.topic, []);
    byTopic.get(n.topic)!.push(n);
  }
  const out: Record<string, Position> = {};
  let offsetX = 0;
  for (const [topic, group] of byTopic) {
    // 用现有的 layoutWithDagre 但只对当前 group
    const groupEdges = edges.filter(e =>
      group.some(n => n.id === e.source) && group.some(n => n.id === e.target));
    const groupLayout = layoutWithDagre(group, groupEdges);
    // 偏移:整组往右挪 offsetX
    const groupWidth = max(groupLayout, "x") - min(groupLayout, "x");
    for (const [id, pos] of Object.entries(groupLayout)) {
      out[id] = { x: pos.x + offsetX, y: pos.y };
    }
    offsetX += groupWidth + 200;  // topic 间距 200
  }
  return out;
}
```

`layoutByType.ts`:类似 by_topic,按 `type` 分组,每组 rankdir 改 TB 垂直堆叠。

`layoutByScope.ts`:左半屏 `scope='global'`,右半屏 `scope='project'`,dagre 内嵌。

`layoutByStatus.ts`:4 行(active / archived / superseded / forgotten),importance 横向排,active 在最上,forgotten 在最下。

`layoutNone.ts`:现有 dagre LR(直接 re-export `layoutWithDagre`)。

**所有 layout 输出形状一致** = `{ [nodeId]: { x, y } }`,GraphCanvas 接入无感。

### 组件

#### `FilterBar.tsx` 改版

两行布局:

```
[all ▾]  topic: [auth ×] [cache ×]  +3 more  +   types: [P][F][D] …   [⊞类型][⊟主题][⇄scope][⊟状态]  ✨整理  ↻
```

- 第一行:已选 filter 的 pill chips(可点击 ✕ 移除),`+` 按钮打开高级过滤弹层(min_importance / max_nodes / include_co_topic / include_co_scope)
- 第二行:组织模式 4 选 1 + 整理按钮 + 手动 refresh
- pill chips 配色:用 `--bg-elev` + 主题色边框

#### `OrgModeSwitcher.tsx`

分段控件(`role="radiogroup"`)或 dropdown。值同步到 `filter.organization`。

```tsx
<OrgModeSwitcher
  value={filter.organization}
  onChange={(mode) => setFilter({ ...filter, organization: mode })}
/>
```

#### `OrganizeButton.tsx`

✨ 整理按钮。点击 → 读 `filter.organization` → 调对应 layout → 重置 `positionsRef` + bump `positionsTick`。按钮在动画期间禁用 + spinner。

#### `MemoryDrawer.tsx` 扩展

380px → 460px(放下 body)。Section 顺序:

1. 标题(已有) + 关闭按钮
2. 基础元数据(类型/主题/scope/重要性/状态/时间 — 已有)
3. **全文 body**(新)— `<pre>` 等宽 + 横向滚动 + 复制按钮
4. **标签 tags**(新)— pill chips,无标签时显示 "—"
5. **来源 source**(新)— 折叠 JSON,默认收起,点开显示 pretty-printed
6. **关联记忆 related**(新)— 见下

底部加"在图中定位"按钮(关闭 drawer + 平移 canvas + 高亮 2 秒)。

#### `RelatedMemories.tsx`

```tsx
function RelatedMemories({ relations, onJump }: Props) {
  return (
    <div>
      <Section title="版本演进">
        {relations.supersedes.map(n => <RelatedRow n={n} onJump={onJump} />)}
        {relations.superseded_by.map(n => <RelatedRow n={n} onJump={onJump} />)}
        {empty && <Empty text="无版本关系" />}
      </Section>
      <Section title="合并">
        {relations.merge.map(n => <RelatedRow n={n} onJump={onJump} />)}
        {empty && <Empty text="无合并关系" />}
      </Section>
      <Section title={`相关主题 (${relations.co_topic_total})`}>
        {relations.co_topic.map(n => <RelatedRow n={n} onJump={onJump} />)}
        {relations.co_topic_total > 5 && (
          <a href={`/search?topic=...`}>查看全部 {relations.co_topic_total} 条</a>
        )}
        {empty && <Empty text="无同主题" />}
      </Section>
      <Section title={`相关 scope`} collapsed count={relations.co_scope_total}>
        {/* 默认折叠, 只显示前 3 条 + "展开" 按钮 */}
        {relations.co_scope.slice(0, 3).map(...)}
      </Section>
    </div>
  );
}
```

#### `useMemoryDetail.ts`

```ts
export function useMemoryDetail(id: string | null) {
  return useQuery({
    queryKey: ["memory", id],
    queryFn: () => id ? invoke<MemoryDetail>("get_memory", { id }) : null,
    enabled: !!id,
    staleTime: 30_000,  // 详情不常变,30s 缓存
  });
}
```

(如果 v0.1 还没引入 react-query 之类的库,降级为 `useState + useEffect` 模式,与现有 `useGraph` 一致。)

### UX 流程

#### 工作栏

- 用户点击工作栏 `+` → 弹层显示高级过滤项,选定后 pill 加到第一行
- 用户切换组织模式(4 选 1) → filter.organization 更新,GraphCanvas 重 layout
- 用户点 ✨ 整理 → 重新计算所有节点位置,瞬间切换(spinner 200ms 期间)
- 用户点 ↻ → 强制 refetch 图数据(轮询已 5s 自动,这个是手动)

#### 详情页钻取

- 用户点节点 → drawer 打开,自动 `get_memory(id)`,loading 时显示骨架
- 用户点关联记忆某行 → `setSelectedNode(newId)`,drawer 内容区 swap(不关闭,平滑过渡)
- 用户点"在图中定位" → drawer 关闭 + canvas 平移到该节点(centers via `handleFit` 或自定义 pan)+ 高亮 2s 后取消
- 用户点"复制 ID" / "复制全文" → clipboard API + toast 1.5s 自动消失

#### 整理按钮

- 读 `filter.organization`,调对应 `layoutXxx(nodes, edges)`
- 重置 `positionsRef` 到新位置
- `setPositionsTick(t => t + 1)` 触发重渲染
- 按钮在计算期间禁用 + spinner,完成后恢复
- **不做缓动**(v0.2 范围外),直接瞬间切换;用户拖动过的位置会被覆盖(已经在 design 风险里说明)

### 错误处理

- `get_memory` 失败(节点被删 / DB 损坏) → drawer 显示 "无法加载详情" + 重试按钮
- `related` 字段任一子查询失败 → 那一段显示 "加载失败",其它段正常
- 工作栏 filter 变更 → 走现有 `useGraph` 重试机制(已有 loading/error 处理)
- co_topic / co_scope 查询超时(单查询 5s) → 该段降级为 "—" + console.error

### 性能

- `get_memory` 在 drawer 打开时触发,1 次 DB 查询 + 4 次 related 查询,串行 ~5-20ms
- `RelatedNode` 不带 body,5+3 条 ≈ 3KB,wire 成本可忽略
- `co_topic` 5 条 + `co_scope` 3 条都用 `LIMIT`,SQLite 单字段索引够用
- layout 切换:31 节点 dagre 重算 < 10ms,无性能问题

## 测试

### 单元 (vitest)

- `packages/contracts`: 15 → +6 tests
  - `OrgModeSchema` roundtrip
  - `RelatedNodeSchema` / `MemoryRelationsSchema` / `MemoryDetailSchema` roundtrip
  - `GraphFilterSchema.organization` 字段默认 "none",接受 5 种值
  - `co_scope_total=0` 时 `co_scope: []` 通过校验

- `apps/admin/src`:
  - `useMemoryDetail.test.ts`: mock invoke,测 loading / data / error 3 个状态
  - `OrgModeSwitcher.test.tsx`: 4 选 1 行为,值变更回写
  - `OrganizeButton.test.tsx`: 点击触发 layout 切换,disabled 状态
  - `RelatedMemories.test.tsx`: 4 段渲染,co_scope 折叠,空态显示
  - `MemoryBody.test.tsx`: 等宽渲染,长 body 横向滚动,复制按钮
  - `MemoryTags.test.tsx`: pill chips,空态
  - 4 个 `layoutXxx.test.ts`: 输入固定 nodes/edges,断言 x/y 范围
  - 现有 FilterBar / GraphCanvas / MemoryDrawer tests 仍要过

### 集成 (cargo test)

- `commands::memory::get_memory` 集成测试:3 个 fixture memory
  - 验证 supersede 双向
  - 验证 co_topic (同 topic,排除自身,LIMIT 5)
  - 验证 co_scope (同 scope,排除自身,LIMIT 3)
  - 验证 total 计数准确
  - 验证 merge 暂时返回 []

### E2E (手动 + 可选 Playwright)

- Tauri 窗口里手测 5 个流程:
  1. 切换 4 种组织模式,验证布局切换
  2. 点 ✨ 整理,验证节点重新分布
  3. 点节点 → drawer 打开 → body / tags / source 渲染正确
  4. drawer 内点关联记忆 → 内容 swap
  5. drawer 内点"在图中定位" → 节点高亮

## 风险与权衡

| 风险 | 缓解 |
|---|---|
| merge 关系没持久化,v0.2 留 TODO | 文档明确 v0.3 处理;前端显示"无合并关系"或隐藏该段 |
| co_scope 可能很多条 | SQL `LIMIT 3` + 单独 `total` 计数;UI 折叠,只显示前 3 + 数量 |
| 切换组织模式丢失用户拖动位置 | 已经在 design 范围里写明;`positionsRef` 在切换时重置;F5 同样行为,符合预期 |
| 详情页跳转会丢失"上一个节点"上下文 | v0.2 暂不做前进/后退;v0.3 加 history stack |
| 工作栏改版回归 v0.1 已稳定的 filter 行为 | 保留所有 `GraphFilter` 字段,只是 UI 重新排版;现有 `useGraph` test 继续通过 |
| 整理动画没做,瞬间切换感觉突兀 | v0.2 范围外,v0.3 加 FLIP/spring;用户可以接受,vs 一次大返工 |
| `get_memory` 多 4 次查询变慢 | 串行 ~5-20ms,drawer 用户能感知;后续如需优化可并行或缓存 |
| `MemorySchema` 已有,新 `MemoryDetailSchema.extend` 必须保证不破坏现有 schema | 单元测试 roundtrip 覆盖;`extend` 不会移除字段 |

## 不在范围 (重申)

v0.2 不做:
- 整理动画缓动
- 节点右键菜单 CRUD
- 全文 in-drawer 搜索 / 高亮
- co_scope 展开后虚拟滚动
- 移动端适配
- 主题切换
- 详情页"前进 / 后退"导航
- merge 关系持久化(留 v0.3)
- GraphNode 字段扩展(保持精简,详情走 `get_memory`)

## 验收标准

- ✅ 4 种组织模式可切换,布局正确变化
- ✅ ✨ 整理按钮按当前模式重算位置
- ✅ 详情页 body / tags / source 完整渲染
- ✅ 关联记忆显示 3 类(supersede / merge / co_topic)+ co_scope 折叠计数
- ✅ 工作栏 pill chips 可视化 + 高级过滤弹层
- ✅ `GraphFilter.organization` 字段在 contracts 包注册,后端忽略
- ✅ `get_memory` 返回 `MemoryDetail` 含 `related` 字段
- ✅ 单元 + 集成 + 手动 E2E 全过
- ✅ v0.1 现有 32 commits + 10/10 vitest 仍全部通过
- ✅ PR #46 后续新 PR 包含本 spec 全部实现

## 文档同步

- 本 spec 文件 `docs/superpowers/specs/2026-08-25-agent-recall-admin-v0.2-design.md` 提交到仓库
- 更新 `docs/guides/admin-app.md`(v0.1 用户指南)加 v0.2 新功能 section
- `CHANGELOG.md` 记 v0.2 entry

## 实施交接

完成本 spec 评审后,下一步走 `writing-plans` skill,把上面的设计展开成 12-15 个有依赖关系的 tasks(contracts 扩展 → Rust 后端 → layout 工具 → 新组件 → 现有组件改版 → 工作栏 → E2E)。
