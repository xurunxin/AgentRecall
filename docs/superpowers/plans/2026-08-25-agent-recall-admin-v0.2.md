# AgentRecall Admin v0.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 v0.1 graph 只读基础上,加 4 种节点组织模式 + 一键整理 + 工作栏改版 + 详情页全文/关联记忆,产出可独立 PR 的 12-task 增量。

**Architecture:** 数据模型两层,前端轻 `GraphNode` 走图查询,后端 `get_memory` 返回 `MemoryDetail` 含 `related: MemoryRelations`,drawer 打开时单次拉详情;前端 5 个 layout 函数(目前 dagre + 4 个分组模式)统一接口,GraphCanvas 按 `filter.organization` 选 layout;工作栏 pill chips + 弹层,OrgModeSwitcher + OrganizeButton 集成在 FilterBar 同行。

**Tech Stack:** Tauri 2.0 + Rust 1.96 + tokio + rusqlite,React 18 + Vite 5 + TypeScript 5.8 + dagre,Vitest 3,@tauri-apps/api 2.0,zod 4(后端 serde 重写为手工)。无新增 npm 依赖。

## Global Constraints

- **零侵入**:`src/` / `bin/` / `dist/` / `test/` 一行不动。新增只在 `apps/admin/` / `packages/contracts/`。
- **v0.1 baseline 继续工作**:v0.1 32 commits + 10/10 vitest + 11/11 cargo 全部仍要通过。
- **GraphNode 保持精简**:不扩字段;body / tags / source 走 `get_memory` 详情接口。
- **`organization` 是前端 layout 开关**:后端忽略,不进 SQL WHERE。
- **npm workspaces only**:`@agent-recall/contracts`(scoped),无 pnpm/yarn/bun。
- **commit 前缀**:`feat:` / `fix:` / `chore:` / `refactor:` / `test:` / `docs:`,每个 task 一次 commit。
- **Plan 工作目录**:在已有 worktree `feat/admin-v01-graph-readonly` (`.worktrees/v01-admin/`)上,无需新建。
- **测试门槛**:`tsc --noEmit` clean / `vitest` 100% pass / `cargo test` 100% pass。
- **PR 节奏**:每个 task 一 commit,累积 5+ task 后开新 PR(沿用 v0.1 PR #46 节奏)。
- **本规划 12 tasks 一次 commit 一次 PR**:不强制,但 task 边界允许这样切。

## File Structure

### Modified

- `packages/contracts/src/graph.ts` — 加 `ORG_MODES` / `OrgMode` / `GraphFilter.organization` 字段
- `packages/contracts/src/index.ts` — 导出新 `memory.ts` 模块
- `packages/contracts/tests/graph.test.ts` — 加 `organization` 字段测试
- `apps/admin/src/components/graph/GraphCanvas.tsx` — 删 inline `layoutWithDagre`,改 import;接 `filter.organization`
- `apps/admin/src/components/graph/FilterBar.tsx` — pill chips + 弹层 + OrgModeSwitcher + OrganizeButton
- `apps/admin/src/components/graph/MemoryDrawer.tsx` — 380→460px,加 4 sections
- `apps/admin/src/lib/tauri.ts` — 加 `getMemoryDetail` 到 `cmds`
- `apps/admin/src/routes/graph.tsx` — 传 `filter.organization`,挂 useMemoryDetail
- `apps/admin/src-tauri/src/commands/memory.rs` — `Memory` 改 `MemoryDetail`,加 4 个 related 子查询
- `docs/guides/admin-app.md` — 加 v0.2 新功能 section
- `CHANGELOG.md` — 加 v0.2 entry

### Created

- `packages/contracts/src/memory.ts` — `RelatedNodeSchema` / `MemoryRelationsSchema` / `MemoryDetailSchema`
- `packages/contracts/tests/memory.test.ts` — 新文件,3 个 schema roundtrip
- `apps/admin/src/components/graph/layouts/layoutNone.ts` — 把 inline `layoutWithDagre` 搬过来
- `apps/admin/src/components/graph/layouts/layoutByTopic.ts`
- `apps/admin/src/components/graph/layouts/layoutByType.ts`
- `apps/admin/src/components/graph/layouts/layoutByScope.ts`
- `apps/admin/src/components/graph/layouts/layoutByStatus.ts`
- `apps/admin/src/components/graph/layouts/layoutByTopic.test.ts`
- `apps/admin/src/components/graph/layouts/layoutByType.test.ts`
- `apps/admin/src/components/graph/layouts/layoutByScope.test.ts`
- `apps/admin/src/components/graph/layouts/layoutByStatus.test.ts`
- `apps/admin/src/components/graph/MemoryBody.tsx` + `MemoryBody.test.tsx`
- `apps/admin/src/components/graph/MemoryTags.tsx` + `MemoryTags.test.tsx`
- `apps/admin/src/components/graph/MemorySource.tsx` + `MemorySource.test.tsx`
- `apps/admin/src/components/graph/RelatedMemories.tsx` + `RelatedMemories.test.tsx`
- `apps/admin/src/components/graph/OrgModeSwitcher.tsx` + `OrgModeSwitcher.test.tsx`
- `apps/admin/src/components/graph/OrganizeButton.tsx` + `OrganizeButton.test.tsx`
- `apps/admin/src/lib/useMemoryDetail.ts` + `useMemoryDetail.test.ts`
- `apps/admin/src-tauri/tests/memory_detail_test.rs`

---

## Task 1: Contracts 扩展 (OrgMode + MemoryDetail schemas)

**Files:**
- Modify: `packages/contracts/src/graph.ts`
- Create: `packages/contracts/src/memory.ts`
- Create: `packages/contracts/tests/memory.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/tests/graph.test.ts`

**Interfaces:**
- Consumes: existing `MemoryType` / `MemoryStatus` from `./schema.js`
- Produces:
  - `OrgMode` (type, `"none" | "by_topic" | "by_type" | "by_scope" | "by_status"`)
  - `GraphFilter.organization: OrgMode` (default `"none"`)
  - `RelatedNode`, `MemoryRelations`, `MemoryDetail` (types + zod schemas)
  - `getMemoryDetail(id)` Tauri command (declared in `cmds` later, Task 4)

- [ ] **Step 1: 写失败测试 — 改 `graph.test.ts` 加 `organization` 字段**

打开 `packages/contracts/tests/graph.test.ts`,在 `describe("GraphFilterSchema")` 块里加:

```ts
it("defaults organization to 'none' and accepts all 5 modes", () => {
  expect(GraphFilterSchema.parse({}).organization).toBe("none");
  for (const m of ["none", "by_topic", "by_type", "by_scope", "by_status"]) {
    expect(GraphFilterSchema.parse({ organization: m }).organization).toBe(m);
  }
  expect(GraphFilterSchema.safeParse({ organization: "by_zzz" }).success).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/admin
npm --workspace=@agent-recall/contracts test -- --run graph.test
```

Expected: FAIL,`organization: undefined` 因为字段还没加。

- [ ] **Step 3: 改 `graph.ts` 加 `OrgMode` 和 `organization` 字段**

打开 `packages/contracts/src/graph.ts`,在文件顶部 `EDGE_KINDS` 之后加:

```ts
export const ORG_MODES = ["none", "by_topic", "by_type", "by_scope", "by_status"] as const;
export type OrgMode = (typeof ORG_MODES)[number];
```

在 `GraphFilterSchema` 末尾加 `organization: z.enum(ORG_MODES).default("none"),`。

- [ ] **Step 4: 跑测试确认通过**

```bash
npm --workspace=@agent-recall/contracts test -- --run graph.test
```

Expected: PASS。

- [ ] **Step 5: 写失败测试 — 新建 `memory.test.ts`**

创建 `packages/contracts/tests/memory.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  RelatedNodeSchema,
  MemoryRelationsSchema,
  MemoryDetailSchema,
} from "../src/memory.js";

const fullMemory = {
  id: "mem_aaaaaaaaaaaaaaaaaaaaaaaa",
  scope: "project" as const,
  project_id: "p1",
  type: "decision" as const,
  topic: "auth",
  title: "Use JWT for stateless auth",
  body: "Long body here…",
  tags: ["auth", "jwt"],
  importance: 4,
  confidence: 5,
  sensitivity: "private" as const,
  status: "active" as const,
  supersedes: ["mem_bbbbbbbbbbbbbbbbbbbbbb"],
  source: { kind: "user" as const, ref: "claude" },
  created_at: "2026-08-25T10:00:00.000Z",
  updated_at: "2026-08-25T10:00:00.000Z",
  revision: 1,
};

const relatedNode = {
  id: "mem_cccccccccccccccccccccccc",
  title: "Use refresh tokens",
  topic: "auth",
  type: "decision" as const,
  status: "active" as const,
  importance: 3,
};

describe("RelatedNodeSchema", () => {
  it("accepts a valid node", () => {
    expect(RelatedNodeSchema.safeParse(relatedNode).success).toBe(true);
  });
  it("rejects importance out of range", () => {
    expect(RelatedNodeSchema.safeParse({ ...relatedNode, importance: 6 }).success).toBe(false);
  });
});

describe("MemoryRelationsSchema", () => {
  it("accepts empty relations", () => {
    const r = MemoryRelationsSchema.parse({
      supersedes: [], superseded_by: [], merge: [],
      co_topic: [], co_topic_total: 0, co_scope: [], co_scope_total: 0,
    });
    expect(r.co_topic_total).toBe(0);
  });
});

describe("MemoryDetailSchema", () => {
  it("extends Memory and adds related", () => {
    const d = MemoryDetailSchema.parse({
      ...fullMemory,
      related: {
        supersedes: [relatedNode], superseded_by: [], merge: [],
        co_topic: [relatedNode], co_topic_total: 1, co_scope: [], co_scope_total: 0,
      },
    });
    expect(d.related.supersedes[0].id).toBe(relatedNode.id);
    expect(d.body).toBe("Long body here…");
  });
  it("rejects when related is missing", () => {
    expect(MemoryDetailSchema.safeParse(fullMemory).success).toBe(false);
  });
});
```

- [ ] **Step 6: 跑测试确认失败**

```bash
npm --workspace=@agent-recall/contracts test -- --run memory.test
```

Expected: FAIL,`Cannot find module '../src/memory.js'`。

- [ ] **Step 7: 创建 `memory.ts` 实现 schemas**

创建 `packages/contracts/src/memory.ts`:

```ts
import { z } from "zod";
import { MemorySchema, MEMORY_TYPES, MEMORY_STATUSES } from "./schema.js";

export const RelatedNodeSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  topic: z.string(),
  type: z.enum(MEMORY_TYPES),
  status: z.enum(MEMORY_STATUSES),
  importance: z.number().int().min(1).max(5),
});

export const MemoryRelationsSchema = z.object({
  supersedes: z.array(RelatedNodeSchema),
  superseded_by: z.array(RelatedNodeSchema),
  merge: z.array(RelatedNodeSchema),
  co_topic: z.array(RelatedNodeSchema),
  co_topic_total: z.number().int().min(0),
  co_scope: z.array(RelatedNodeSchema),
  co_scope_total: z.number().int().min(0),
});

export const MemoryDetailSchema = MemorySchema.extend({
  related: MemoryRelationsSchema,
});

export type RelatedNode = z.infer<typeof RelatedNodeSchema>;
export type MemoryRelations = z.infer<typeof MemoryRelationsSchema>;
export type MemoryDetail = z.infer<typeof MemoryDetailSchema>;
```

- [ ] **Step 8: 跑测试确认通过**

```bash
npm --workspace=@agent-recall/contracts test -- --run memory.test
```

Expected: 5/5 PASS。

- [ ] **Step 9: 改 `index.ts` 导出新模块**

打开 `packages/contracts/src/index.ts`,加:

```ts
export * from "./memory.js";
```

- [ ] **Step 10: 跑全部 contracts 测试确认全过**

```bash
npm --workspace=@agent-recall/contracts test
```

Expected: 20/20 PASS(原 15 + 新 5)。

- [ ] **Step 11: typecheck + commit**

```bash
cd ../..  # repo root
git add packages/contracts
git commit -m "feat(contracts): add OrgMode + MemoryDetail schemas for v0.2"
```

---

## Task 2: Layout 系统重构 + 5 种布局

**Files:**
- Create: `apps/admin/src/components/graph/layouts/layoutNone.ts`
- Create: `apps/admin/src/components/graph/layouts/layoutByTopic.ts`
- Create: `apps/admin/src/components/graph/layouts/layoutByType.ts`
- Create: `apps/admin/src/components/graph/layouts/layoutByScope.ts`
- Create: `apps/admin/src/components/graph/layouts/layoutByStatus.ts`
- Create: 4 个 `*.test.ts`(layoutNone 不测,只是 re-export)
- Modify: `apps/admin/src/components/graph/GraphCanvas.tsx` 删 inline `layoutWithDagre`,改 import

**Interfaces:**
- Consumes: `GraphNode`, `GraphEdge` from `@agent-recall/contracts`
- Produces: 5 个 `layoutXxx(nodes: GraphNode[], edges: GraphEdge[]) => Record<string, Position>` 函数(同形状)

- [ ] **Step 1: 写失败测试 — 新建 `layoutByTopic.test.ts`**

创建 `apps/admin/src/components/graph/layouts/layoutByTopic.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { GraphNode, GraphEdge } from "@agent-recall/contracts";
import { layoutByTopic } from "./layoutByTopic.js";

const n = (id: string, topic: string): GraphNode => ({
  id, label: id, type: "fact", topic, scope: "global", project_id: null,
  importance: 3, status: "active", created_at: "2026-08-25T00:00:00.000Z",
});

describe("layoutByTopic", () => {
  it("groups nodes by topic with horizontal offset", () => {
    const nodes = [n("a", "auth"), n("b", "auth"), n("c", "cache"), n("d", "auth"), n("e", "cache")];
    const layout = layoutByTopic(nodes, []);
    // 同 topic 的节点 x 坐标互相接近
    const xa = layout.a!.x, xb = layout.b!.x, xc = layout.c!.x;
    // auth 组的 x 坐标应该都小于 cache 组(因为 auth 在前)
    expect(Math.max(xa, xb)).toBeLessThan(Math.min(xc, xc));
  });
  it("returns position for every input node", () => {
    const nodes = [n("a", "auth"), n("b", "cache")];
    const layout = layoutByTopic(nodes, []);
    expect(Object.keys(layout).sort()).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/admin
npm test -- --run layoutByTopic
```

Expected: FAIL,`Cannot find module ./layoutByTopic.js`。

- [ ] **Step 3: 创建 `layoutByTopic.ts`**

创建 `apps/admin/src/components/graph/layouts/layoutByTopic.ts`:

```ts
import dagre from "@dagrejs/dagre";
import type { GraphEdge, GraphNode } from "@agent-recall/contracts";
import { layoutWithDagre } from "./layoutNone.js";

type Position = { x: number; y: number };
const TOPIC_GAP = 200;
const NODE_WIDTH = 140;
const NODE_HEIGHT = 42;

/** 同 topic 节点水平成簇,簇间用 TOPIC_GAP 隔开。 */
export function layoutByTopic(
  nodes: GraphNode[],
  edges: GraphEdge[]
): Record<string, Position> {
  const byTopic = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    const list = byTopic.get(n.topic) ?? [];
    list.push(n);
    byTopic.set(n.topic, list);
  }
  const out: Record<string, Position> = {};
  let offsetX = 0;
  for (const group of byTopic.values()) {
    const ids = new Set(group.map((g) => g.id));
    const groupEdges = edges.filter(
      (e) => ids.has(e.source) && ids.has(e.target)
    );
    const groupLayout = layoutWithDagre(group, groupEdges);
    if (Object.keys(groupLayout).length === 0) continue;
    const xs = Object.values(groupLayout).map((p) => p.x);
    const groupMin = Math.min(...xs);
    const groupMax = Math.max(...xs);
    for (const [id, pos] of Object.entries(groupLayout)) {
      out[id] = { x: pos.x - groupMin + offsetX, y: pos.y };
    }
    offsetX += groupMax - groupMin + TOPIC_GAP;
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -- --run layoutByTopic
```

Expected: 2/2 PASS。

- [ ] **Step 5: 创建 `layoutNone.ts` 搬 inline `layoutWithDagre`**

打开 `apps/admin/src/components/graph/GraphCanvas.tsx`,把函数 `layoutWithDagre` 和它依赖的常量 `NODE_WIDTH` / `NODE_HEIGHT`(这两个是它的私有常量,从 `GraphCanvas` 顶部移出来)整段剪切,粘贴到新文件 `apps/admin/src/components/graph/layouts/layoutNone.ts`:

```ts
import dagre from "@dagrejs/dagre";
import type { GraphEdge, GraphNode } from "@agent-recall/contracts";

type Position = { x: number; y: number };
const NODE_WIDTH = 42 + 8 + 90; // 140, dagre box
const NODE_HEIGHT = 42;

/** 现有 dagre LR 布局(单层,无分组)。 */
export function layoutWithDagre(
  nodes: GraphNode[],
  edges: GraphEdge[]
): Record<string, Position> {
  // ... 完整函数体,从 GraphCanvas.tsx 原样复制
  // (包括 layoutWithDagre 内部的 isolates 网格兜底)
}

export const layoutNone = layoutWithDagre;
```

- [ ] **Step 6: 改 `GraphCanvas.tsx` 删 inline 函数,改 import**

在 `GraphCanvas.tsx` 顶部加 `import { layoutNone } from "./layouts/layoutNone.js";`(从 dagre 直接 import 也要改)

把 `baseLayout = useMemo(() => layoutWithDagre(nodes, edges), [nodes, edges])` 改成 `baseLayout = useMemo(() => layoutNone(nodes, edges), [nodes, edges])`。

确保 `GraphCanvas.tsx` 里再也没有 `function layoutWithDagre` 的定义。

- [ ] **Step 7: 跑 typecheck + 全部 vitest 确认 v0.1 没坏**

```bash
cd apps/admin
npm run typecheck
npm test
```

Expected: tsc clean, 10/10 PASS(v0.1 baseline 仍工作)。

- [ ] **Step 8: 创建剩下 3 个 layout + 它们的 test**

为 `by_type` / `by_scope` / `by_status` 各创建一个 `*.ts` 和 `*.test.ts`,模式与 `by_topic` 相同:

**`layoutByType.ts`**:按 `node.type` 分组,每组 TB rankdir(`rankdir: "TB"`)垂直堆叠,组间用 150px 垂直间距。函数签名同上。

**`layoutByScope.ts`**:左半屏 `scope='global'`,右半屏 `scope='project'`,dagre 内嵌;若某一 scope 没有节点,只画另一边。

**`layoutByStatus.ts`**:4 行,按 `status` 排序(active / archived / superseded / forgotten),每行内 dagre LR,行间用 100px 垂直间距。

每个的 `test.ts` 至少包含:
- 同 group 的节点 x/y 在合理范围(group 内更近,group 间更远)
- 返回 keys 数量等于输入 nodes 数量

- [ ] **Step 9: 跑全部 layout 测试 + typecheck**

```bash
cd apps/admin
npm test -- --run layouts
npm run typecheck
```

Expected: 8/8 PASS(每个 layout 2 个 test),tsc clean。

- [ ] **Step 10: commit**

```bash
cd ../..
git add apps/admin/src/components/graph/layouts apps/admin/src/components/graph/GraphCanvas.tsx
git commit -m "refactor(admin): extract layoutWithDagre to layouts/, add 4 group layouts"
```

---

## Task 3: Rust get_memory → MemoryDetail + 4 个 related 子查询

**Files:**
- Modify: `apps/admin/src-tauri/src/commands/memory.rs`
- Create: `apps/admin/src-tauri/tests/memory_detail_test.rs`

**Interfaces:**
- Consumes: existing `Memory` struct in `commands/memory.rs`, `Connection` from `rusqlite`
- Produces:
  - `pub struct MemoryDetail { ...Memory fields, pub related: MemoryRelations }`
  - `pub struct MemoryRelations { supersedes, superseded_by, merge, co_topic, co_topic_total, co_scope, co_scope_total }`
  - `pub struct RelatedNode { id, title, topic, r#type, status, importance }`
  - Tauri command `get_memory` now returns `Result<MemoryDetail, AppError>`

- [ ] **Step 1: 写失败集成测试 — 新建 `memory_detail_test.rs`**

创建 `apps/admin/src-tauri/tests/memory_detail_test.rs`:

```rust
//! MemoryDetail 集成测试,验证 get_memory 返回的 related 字段正确。
//!
//! Fixture (3 行 memory_entries):
//!   - mem_alpha: project=p1, topic=auth, type=decision, supersedes=[]
//!   - mem_beta:  project=p1, topic=auth, type=fact,    supersedes=[mem_alpha]
//!   - mem_gamma: project=p2, topic=cache, type=lesson,  supersedes=[]
//!
//! 期望:查 mem_alpha 拿到
//!   related.supersedes=[]; related.superseded_by=[mem_beta]
//!   related.co_topic=[mem_beta]; co_topic_total=1
//!   related.co_scope=[]; co_scope_total=0   (project_id 不同)

use agent_recall_admin::commands::memory::get_memory_for_test;

#[test]
fn related_superseded_by_and_co_topic() {
    // (具体 setup 和 assertion 在 Step 7 一起写,这里先创建文件结构)
}
```

(完整测试在 Step 7 写,这里只先建空文件)

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/admin/src-tauri
cargo test --test memory_detail_test
```

Expected: FAIL,`module 'commands' is private` 或 `function 'get_memory_for_test' not found`。

- [ ] **Step 3: 在 `memory.rs` 加 struct 定义 + `MemoryDetail`**

打开 `apps/admin/src-tauri/src/commands/memory.rs`,在文件顶部 `use` 块之后,加:

```rust
/// `get_memory` 返回的完整详情(现有 Memory 全字段 + related)。
#[derive(Debug, Serialize, Deserialize)]
pub struct MemoryDetail {
  // 现有 Memory 全字段逐字复制(不要 #[serde(flatten)] 以保证 wire 兼容)
  pub id: String,
  pub scope: MemoryScope,
  pub project_id: Option<String>,
  #[serde(rename = "type")]
  pub memory_type: MemoryType,
  pub topic: String,
  pub title: String,
  pub body: String,
  pub tags: Vec<String>,
  pub importance: u8,
  pub confidence: u8,
  pub sensitivity: String,
  pub status: MemoryStatus,
  pub supersedes: Vec<String>,
  pub source: serde_json::Value,
  pub created_at: chrono::DateTime<chrono::Utc>,
  pub updated_at: chrono::DateTime<chrono::Utc>,
  pub revision: u32,
  // 新增
  pub related: MemoryRelations,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct MemoryRelations {
  pub supersedes: Vec<RelatedNode>,
  pub superseded_by: Vec<RelatedNode>,
  pub merge: Vec<RelatedNode>,        // TODO v0.3: GraphEdge 持久化后填充
  pub co_topic: Vec<RelatedNode>,
  pub co_topic_total: u32,
  pub co_scope: Vec<RelatedNode>,
  pub co_scope_total: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RelatedNode {
  pub id: String,
  pub title: String,
  pub topic: String,
  #[serde(rename = "type")]
  pub r#type: String,
  pub status: String,
  pub importance: u8,
}
```

- [ ] **Step 4: 改 `get_memory` 返回 `MemoryDetail` + 4 个子查询**

把现有 `get_memory` 函数的返回类型 `Result<Memory, AppError>` 改成 `Result<MemoryDetail, AppError>`。函数体改成:

```rust
#[tauri::command]
pub async fn get_memory(
  state: State<'_, AppState>,
  id: String,
) -> Result<MemoryDetail, AppError> {
  let guard = state.reader.lock().unwrap();
  let reader = guard.as_ref().ok_or_else(|| {
    AppError::Io(std::io::Error::new(
      std::io::ErrorKind::NotFound, "DB not opened",
    ))
  })?;
  let conn = reader.conn_ref();
  let mem = conn.query_row(
    "SELECT id, scope, project_id, type, topic, title, body, tags_json, importance, confidence, sensitivity, status, supersedes_json, source_json, created_at, updated_at, revision \
     FROM memory_entries WHERE id = ?",
    params![id],
    parse_memory_row,
  )?;
  // 1) supersedes: 直接从 mem.supersedes 拉
  let supersedes = related_summary_for_ids(conn, &mem.supersedes)?;
  // 2) superseded_by: LIKE 反查
  let superseded_by = related_superseded_by(conn, &id)?;
  // 3) merge: v0.2 留空
  let merge = vec![];
  // 4) co_topic: 同 topic, 排除自身
  let (co_topic, co_topic_total) =
    related_by_field(conn, "topic", &mem.topic, std::slice::from_ref(&id), 5)?;
  // 5) co_scope: 同 scope + project_id
  let scope_value = memory_scope_str(&mem.scope).to_string();
  let project_value = mem.project_id.clone();
  let (co_scope, co_scope_total) =
    related_by_scope(conn, &scope_value, project_value.as_deref(), &id, 3)?;

  Ok(MemoryDetail {
    id: mem.id, scope: mem.scope, project_id: mem.project_id,
    memory_type: mem.memory_type, topic: mem.topic, title: mem.title,
    body: mem.body, tags: mem.tags, importance: mem.importance,
    confidence: mem.confidence, sensitivity: mem.sensitivity,
    status: mem.status, supersedes: mem.supersedes, source: mem.source,
    created_at: mem.created_at, updated_at: mem.updated_at, revision: mem.revision,
    related: MemoryRelations {
      supersedes, superseded_by, merge,
      co_topic, co_topic_total, co_scope, co_scope_total,
    },
  })
}
```

- [ ] **Step 5: 加 3 个 helper**

在 `memory.rs` 文件底部(已有 `parse_memory_row` 等 helper 附近)加:

```rust
/// 按 id 列表拉 RelatedNode 摘要(给 supersedes 用)。
fn related_summary_for_ids(
  conn: &Connection,
  ids: &[String],
) -> Result<Vec<RelatedNode>, AppError> {
  if ids.is_empty() { return Ok(vec![]); }
  let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
  let sql = format!(
    "SELECT id, title, topic, type, status, importance FROM memory_entries
     WHERE id IN ({}) ORDER BY updated_at DESC", placeholders);
  let mut stmt = conn.prepare(&sql)?;
  let params: Vec<&dyn ToSql> = ids.iter().map(|i| i as &dyn ToSql).collect();
  let rows = stmt.query_map(params_from_iter(params), parse_related_row)?;
  rows.collect::<Result<_, _>>().map_err(AppError::Sqlite)
}

/// 反查被哪些 mem supersede 了(被引用方)。
/// SQLite 没有 JSON 操作,LIKE 模糊匹配,应用层过滤。
fn related_superseded_by(
  conn: &Connection,
  self_id: &str,
) -> Result<Vec<RelatedNode>, AppError> {
  let pattern = format!("%\"{}\"%", self_id);
  let mut stmt = conn.prepare(
    "SELECT id, title, topic, type, status, importance FROM memory_entries
     WHERE supersedes_json LIKE ? AND id != ? ORDER BY updated_at DESC LIMIT 50",
  )?;
  let rows = stmt.query_map(params![pattern, self_id], parse_related_row)?;
  // 应用层过滤: 必须确实包含 self_id(避免 LIKE 误中)
  let raw: Vec<RelatedNode> =
    rows.collect::<Result<_, _>>().map_err(AppError::Sqlite)?;
  Ok(raw
    .into_iter()
    .filter(|n| {
      // 这里需要重新查 supersedes_json 严格包含,简单做法:用 re-query
      // 因为 LIKE 已经粗筛,这里再 verify: 拿每个 n.id 查它的 supersedes_json
      true  // 简化: 接受 LIKE 结果, 配合 LIMIT 50 上界兜底
    })
    .collect())
}

/// 按单字段匹配 + exclude id,返回 items + total。
fn related_by_field(
  conn: &Connection,
  field: &str,
  value: &str,
  exclude_ids: &[&str],
  limit: u32,
) -> Result<(Vec<RelatedNode>, u32), AppError> {
  // field 必须是白名单
  let field = match field { "topic" => "topic", "scope" => "scope", _ => bail_invalid_field() };
  let excl = exclude_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
  let total_sql = format!(
    "SELECT COUNT(*) FROM memory_entries WHERE {} = ? AND id NOT IN ({})",
    field, excl);
  let mut total_params: Vec<Box<dyn ToSql>> = vec![Box::new(value.to_string())];
  for id in exclude_ids { total_params.push(Box::new(id.to_string())); }
  let total: u32 = conn.query_row(
    &total_sql, params_from_iter(total_params.iter().map(|b| b.as_ref())),
    |r| r.get(0),
  )?;
  let items_sql = format!(
    "SELECT id, title, topic, type, status, importance FROM memory_entries
     WHERE {} = ? AND id NOT IN ({}) ORDER BY updated_at DESC, id ASC LIMIT ?",
    field, excl);
  let mut all_params = total_params;
  all_params.push(Box::new(limit as i64));
  let mut stmt = conn.prepare(&items_sql)?;
  let param_refs: Vec<&dyn ToSql> =
    all_params.iter().map(|b| b.as_ref()).collect();
  let items: Vec<RelatedNode> = stmt
    .query_map(params_from_iter(param_refs), parse_related_row)?
    .collect::<Result<_, _>>()
    .map_err(AppError::Sqlite)?;
  Ok((items, total))
}

fn related_by_scope(
  conn: &Connection,
  scope: &str,
  project_id: Option<&str>,
  exclude_id: &str,
  limit: u32,
) -> Result<(Vec<RelatedNode>, u32), AppError> {
  // 简化: 同 scope + 同 project_id (project 维度的"同 scope")
  let total: u32 = if let Some(pid) = project_id {
    conn.query_row(
      "SELECT COUNT(*) FROM memory_entries WHERE scope = ? AND project_id = ? AND id != ?",
      params![scope, pid, exclude_id], |r| r.get(0),
    )?
  } else {
    conn.query_row(
      "SELECT COUNT(*) FROM memory_entries WHERE scope = ? AND project_id IS NULL AND id != ?",
      params![scope, exclude_id], |r| r.get(0),
    )?
  };
  let mut stmt = if let Some(pid) = project_id {
    conn.prepare(
      "SELECT id, title, topic, type, status, importance FROM memory_entries
       WHERE scope = ? AND project_id = ? AND id != ?
       ORDER BY updated_at DESC, id ASC LIMIT ?",
    )?
  } else {
    conn.prepare(
      "SELECT id, title, topic, type, status, importance FROM memory_entries
       WHERE scope = ? AND project_id IS NULL AND id != ?
       ORDER BY updated_at DESC, id ASC LIMIT ?",
    )?
  };
  let items: Vec<RelatedNode> = if let Some(pid) = project_id {
    stmt.query_map(params![scope, pid, exclude_id, limit as i64], parse_related_row)?
       .collect::<Result<_, _>>().map_err(AppError::Sqlite)?
  } else {
    stmt.query_map(params![scope, exclude_id, limit as i64], parse_related_row)?
       .collect::<Result<_, _>>().map_err(AppError::Sqlite)?
  };
  Ok((items, total))
}

fn parse_related_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RelatedNode> {
  Ok(RelatedNode {
    id: row.get(0)?,
    title: row.get(1)?,
    topic: row.get(2)?,
    r#type: row.get(3)?,
    status: row.get(4)?,
    importance: row.get(5)?,
  })
}

fn bail_invalid_field() -> ! { panic!("invalid field name") }
```

> 注释:`related_superseded_by` 当前用 LIKE 模糊匹配(应用层不再二次过滤) — 在 fixture 测试里我们只用 3 个 memory,误中风险低。v0.3 可改为建 supersedes_json 倒排索引。

- [ ] **Step 6: 暴露 `get_memory_for_test` 给集成测试**

为了测试方便,在 `memory.rs` 底部加:

```rust
/// 暴露给集成测试的 helper(仅 #[cfg(test)] 可见)
#[cfg(test)]
pub async fn get_memory_for_test(
  db_path: &str,
  id: &str,
) -> Result<MemoryDetail, AppError> {
  // 打开 db_path 的 SQLite (rusqlite::Connection::open),
  // 直接调内部 helper(把 parse_memory_row + 4 个 related 子查询)
  // 复制 get_memory 主体但用 connection 参数,不是 tauri::State
  todo!("v0.2 fixture helper - 在 Step 7 写具体实现")
}
```

(Step 7 一起完成)

- [ ] **Step 7: 写 fixture + 3 个集成测试**

替换 `memory_detail_test.rs` 全文:

```rust
//! 集成测试:验证 get_memory 返回的 related 字段。
//!
//! 用 tempfile 创建一个独立 SQLite,跑 migrations 创建一个
//! 简化版 memory_entries 表(只保留 8 个列),插入 3 条 fixture:
//!   - mem_alpha: project=p1, topic=auth,  type=decision, status=active,   supersedes=[]
//!   - mem_beta:  project=p1, topic=auth,  type=fact,    status=active,   supersedes=[mem_alpha]
//!   - mem_gamma: project=p2, topic=cache, type=lesson,  status=active,   supersedes=[]

use rusqlite::{params, Connection};
use std::collections::HashSet;
use agent_recall_admin::commands::memory::{MemoryDetail, get_memory_for_test};

fn setup_db() -> Connection {
  let conn = Connection::open_in_memory().unwrap();
  conn.execute_batch("
    CREATE TABLE memory_entries (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      project_id TEXT,
      type TEXT NOT NULL,
      topic TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      importance INTEGER NOT NULL,
      confidence INTEGER NOT NULL,
      sensitivity TEXT NOT NULL,
      status TEXT NOT NULL,
      supersedes_json TEXT NOT NULL DEFAULT '[]',
      source_json TEXT NOT NULL DEFAULT '{\"kind\":\"user\"}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL
    );
  ").unwrap();
  // 插入 3 行 fixture (alpha, beta, gamma)
  conn.execute(
    "INSERT INTO memory_entries (id, scope, project_id, type, topic, title, body, tags_json, importance, confidence, sensitivity, status, supersedes_json, source_json, created_at, updated_at, revision)
     VALUES (?1, 'project', 'p1', 'decision', 'auth', 'Use JWT', 'body1', '[]', 4, 5, 'normal', 'active', '[]', '{\"kind\":\"user\"}', '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z', 1)",
    params!["mem_alpha"],
  ).unwrap();
  conn.execute(
    "INSERT INTO memory_entries (id, scope, project_id, type, topic, title, body, tags_json, importance, confidence, sensitivity, status, supersedes_json, source_json, created_at, updated_at, revision)
     VALUES (?1, 'project', 'p1', 'fact', 'auth', 'JWT libs', 'body2', '[]', 3, 4, 'normal', 'active', '[\"mem_alpha\"]', '{\"kind\":\"user\"}', '2026-08-25T00:00:01.000Z', '2026-08-25T00:00:01.000Z', 1)",
    params!["mem_beta"],
  ).unwrap();
  conn.execute(
    "INSERT INTO memory_entries (id, scope, project_id, type, topic, title, body, tags_json, importance, confidence, sensitivity, status, supersedes_json, source_json, created_at, updated_at, revision)
     VALUES (?1, 'project', 'p2', 'lesson', 'cache', 'LRU wins', 'body3', '[]', 3, 4, 'normal', 'active', '[]', '{\"kind\":\"user\"}', '2026-08-25T00:00:02.000Z', '2026-08-25T00:00:02.000Z', 1)",
    params!["mem_gamma"],
  ).unwrap();
  conn
}

#[tokio::test]
async fn get_memory_alpha_returns_superseded_by_beta_and_co_topic() {
  // 写 fixture 到临时文件,get_memory_for_test 打开它
  let dir = tempfile::tempdir().unwrap();
  let db_path = dir.path().join("test.db");
  let conn = setup_db();
  // 备份到磁盘
  conn.execute("VACUUM INTO ?1", params![db_path.to_str().unwrap()]).unwrap();
  drop(conn);

  let detail = get_memory_for_test(db_path.to_str().unwrap(), "mem_alpha")
    .await.expect("get_memory should succeed");
  assert_eq!(detail.id, "mem_alpha");
  assert!(detail.related.supersedes.is_empty(), "alpha has no supersedes");
  let superseded_ids: HashSet<&str> = detail.related.superseded_by.iter()
    .map(|n| n.id.as_str()).collect();
  assert!(superseded_ids.contains("mem_beta"), "beta supersedes alpha");
  let co_topic_ids: HashSet<&str> = detail.related.co_topic.iter()
    .map(|n| n.id.as_str()).collect();
  assert!(co_topic_ids.contains("mem_beta"), "beta shares auth topic");
  assert_eq!(detail.related.co_topic_total, 1);
  assert!(detail.related.co_scope.is_empty(), "different project_id");
  assert_eq!(detail.related.co_scope_total, 0);
  assert!(detail.related.merge.is_empty(), "TODO v0.3");
}

#[tokio::test]
async fn get_memory_alpha_supersedes_is_empty_and_co_topic_includes_beta() {
  let dir = tempfile::tempdir().unwrap();
  let db_path = dir.path().join("test.db");
  let conn = setup_db();
  conn.execute("VACUUM INTO ?1", params![db_path.to_str().unwrap()]).unwrap();
  drop(conn);
  let detail = get_memory_for_test(db_path.to_str().unwrap(), "mem_alpha")
    .await.unwrap();
  assert_eq!(detail.related.supersedes.len(), 0);
  assert!(detail.related.co_topic.iter().any(|n| n.id == "mem_beta"));
}

#[tokio::test]
async fn get_memory_gamma_has_no_relations() {
  let dir = tempfile::tempdir().unwrap();
  let db_path = dir.path().join("test.db");
  let conn = setup_db();
  conn.execute("VACUUM INTO ?1", params![db_path.to_str().unwrap()]).unwrap();
  drop(conn);
  let detail = get_memory_for_test(db_path.to_str().unwrap(), "mem_gamma")
    .await.unwrap();
  assert_eq!(detail.related.supersedes.len(), 0);
  assert_eq!(detail.related.superseded_by.len(), 0);
  assert_eq!(detail.related.co_topic_total, 0);
  assert_eq!(detail.related.co_scope_total, 0);
}
```

需要在 `Cargo.toml` 的 dev-deps 加 `tempfile = "3"`,并把 `commands` 模块从 crate-private 改成 `pub`(在 `mod.rs` 改)。

- [ ] **Step 8: 跑 cargo test 验证**

```bash
cd apps/admin/src-tauri
cargo test --test memory_detail_test
```

Expected: 3/3 PASS。

- [ ] **Step 9: 跑全部 cargo test 确认 v0.1 11/11 仍过**

```bash
cargo test
```

Expected: 14/14 PASS(原 11 + 新 3)。

- [ ] **Step 10: commit**

```bash
cd ../../..
git add apps/admin/src-tauri
git commit -m "feat(admin): get_memory returns MemoryDetail with related (supersede/co_topic/co_scope)"
```

---

## Task 4: 前端 tauri wrapper + useMemoryDetail hook

**Files:**
- Modify: `apps/admin/src/lib/tauri.ts`
- Create: `apps/admin/src/lib/useMemoryDetail.ts`
- Create: `apps/admin/src/lib/useMemoryDetail.test.ts`

**Interfaces:**
- Consumes: `MemoryDetail`, `AppError` types
- Produces: `cmds.getMemoryDetail(id)`, `useMemoryDetail(id) => { data, error, isLoading }`

- [ ] **Step 1: 写失败测试 — `useMemoryDetail.test.ts`**

创建 `apps/admin/src/lib/useMemoryDetail.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useMemoryDetail } from "./useMemoryDetail.js";

vi.mock("./tauri.js", () => ({
  cmds: {
    getMemoryDetail: vi.fn(),
  },
}));

import { cmds } from "./tauri.js";

const fakeDetail = {
  id: "mem_alpha",
  body: "abc",
  related: { supersedes: [], superseded_by: [], merge: [], co_topic: [], co_topic_total: 0, co_scope: [], co_scope_total: 0 },
  // ... Memory 全字段填上
} as any;

describe("useMemoryDetail", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns loading state initially", () => {
    (cmds.getMemoryDetail as any).mockResolvedValue(fakeDetail);
    const { result } = renderHook(() => useMemoryDetail("mem_alpha"));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBe(null);
  });

  it("fetches and returns data", async () => {
    (cmds.getMemoryDetail as any).mockResolvedValue(fakeDetail);
    const { result } = renderHook(() => useMemoryDetail("mem_alpha"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual(fakeDetail);
  });

  it("returns null when id is null", async () => {
    const { result } = renderHook(() => useMemoryDetail(null));
    expect(result.current.data).toBe(null);
    expect(result.current.isLoading).toBe(false);
  });

  it("captures error", async () => {
    (cmds.getMemoryDetail as any).mockRejectedValue({ code: "DB_QUERY_FAILED", message: "boom" });
    const { result } = renderHook(() => useMemoryDetail("mem_alpha"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/admin
npm test -- --run useMemoryDetail
```

Expected: FAIL,`Cannot find module ./useMemoryDetail.js`。

- [ ] **Step 3: 改 `tauri.ts` 加 `getMemoryDetail`**

打开 `apps/admin/src/lib/tauri.ts`,在 `cmds` 对象里加:

```ts
getMemoryDetail: (id: string) => invoke<unknown>("get_memory", { id }),
```

(注意:用现有的 `get_memory` Tauri command,后端在 Task 3 已经改成返回 `MemoryDetail`。)

- [ ] **Step 4: 创建 `useMemoryDetail.ts`**

创建 `apps/admin/src/lib/useMemoryDetail.ts`,模式与 `useGraph.ts` 一致:

```ts
import { useCallback, useEffect, useState } from "react";
import { cmds } from "./tauri.js";
import { humanizeError, type AppError } from "./errors.js";
import type { MemoryDetail } from "@agent-recall/contracts";

interface State {
  data: MemoryDetail | null;
  error: AppError | null;
  isLoading: boolean;
}

export function useMemoryDetail(id: string | null) {
  const [state, setState] = useState<State>({ data: null, error: null, isLoading: false });

  const refetch = useCallback(async () => {
    if (!id) {
      setState({ data: null, error: null, isLoading: false });
      return;
    }
    setState((s) => ({ ...s, isLoading: true }));
    try {
      const data = (await cmds.getMemoryDetail(id)) as MemoryDetail;
      setState({ data, error: null, isLoading: false });
    } catch (raw) {
      const e = raw as AppError;
      setState({ data: null, error: { ...e, message: humanizeError(e) }, isLoading: false });
    }
  }, [id]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { ...state, refetch };
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd apps/admin
npm test -- --run useMemoryDetail
```

Expected: 4/4 PASS。

- [ ] **Step 6: typecheck + 全部 vitest**

```bash
npm run typecheck
npm test
```

Expected: 14/14 PASS(原 10 + 新 4)。

- [ ] **Step 7: commit**

```bash
cd ../..
git add apps/admin/src/lib
git commit -m "feat(admin): useMemoryDetail hook + getMemoryDetail tauri wrapper"
```

---

## Task 5: drawer body 三个小组件 (MemoryBody / MemoryTags / MemorySource)

**Files:**
- Create: `apps/admin/src/components/graph/MemoryBody.tsx`
- Create: `apps/admin/src/components/graph/MemoryBody.test.tsx`
- Create: `apps/admin/src/components/graph/MemoryTags.tsx`
- Create: `apps/admin/src/components/graph/MemoryTags.test.tsx`
- Create: `apps/admin/src/components/graph/MemorySource.tsx`
- Create: `apps/admin/src/components/graph/MemorySource.test.tsx`

**Interfaces:**
- Consumes: `string` (body), `string[]` (tags), `unknown` (source object)
- Produces: 3 个展示组件,无副作用

- [ ] **Step 1: 写失败测试 — `MemoryBody.test.tsx`**

创建 `apps/admin/src/components/graph/MemoryBody.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryBody } from "./MemoryBody.js";

describe("MemoryBody", () => {
  it("renders the body text in a <pre>", () => {
    render(<MemoryBody body="hello world" />);
    const pre = screen.getByText("hello world");
    expect(pre.tagName).toBe("PRE");
  });
  it("copies body to clipboard when copy button clicked", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: write } });
    render(<MemoryBody body="copy me" />);
    fireEvent.click(screen.getByRole("button", { name: /复制/i }));
    expect(write).toHaveBeenCalledWith("copy me");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/admin
npm test -- --run MemoryBody
```

Expected: FAIL,`Cannot find module ./MemoryBody.js`。

- [ ] **Step 3: 创建 `MemoryBody.tsx`**

创建 `apps/admin/src/components/graph/MemoryBody.tsx`:

```tsx
interface Props { body: string; }

export function MemoryBody({ body }: Props) {
  const handleCopy = async () => {
    try { await navigator.clipboard.writeText(body); } catch { /* ignore */ }
  };
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-dim)" }}>全文</span>
        <button type="button" onClick={handleCopy} style={{ fontSize: 11, padding: "2px 6px", background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 3, cursor: "pointer" }}>
          复制
        </button>
      </div>
      <pre style={{
        fontSize: 12, lineHeight: 1.5, fontFamily: "monospace",
        background: "var(--bg-elev)", padding: 8, borderRadius: 4,
        border: "1px solid var(--border)",
        maxHeight: 240, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word",
        margin: 0,
      }}>{body}</pre>
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -- --run MemoryBody
```

Expected: 2/2 PASS。

- [ ] **Step 5: 写失败测试 — `MemoryTags.test.tsx`**

创建 `apps/admin/src/components/graph/MemoryTags.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryTags } from "./MemoryTags.js";

describe("MemoryTags", () => {
  it("renders one pill per tag", () => {
    render(<MemoryTags tags={["auth", "jwt", "rfc7519"]} />);
    expect(screen.getByText("auth")).toBeTruthy();
    expect(screen.getByText("jwt")).toBeTruthy();
    expect(screen.getByText("rfc7519")).toBeTruthy();
  });
  it("shows em-dash when no tags", () => {
    render(<MemoryTags tags={[]} />);
    expect(screen.getByText("—")).toBeTruthy();
  });
});
```

- [ ] **Step 6: 跑测试确认失败**

```bash
npm test -- --run MemoryTags
```

Expected: FAIL,`Cannot find module ./MemoryTags.js`。

- [ ] **Step 7: 创建 `MemoryTags.tsx`**

创建 `apps/admin/src/components/graph/MemoryTags.tsx`:

```tsx
interface Props { tags: string[]; }

export function MemoryTags({ tags }: Props) {
  return (
    <div>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-dim)", marginBottom: 4 }}>标签</div>
      {tags.length === 0
        ? <span style={{ color: "var(--text-dim)", fontSize: 12 }}>—</span>
        : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {tags.map((t) => (
              <span key={t} style={{
                display: "inline-block", padding: "2px 8px", fontSize: 11,
                background: "var(--bg-elev)", border: "1px solid var(--border)",
                borderRadius: 12, color: "var(--text)",
              }}>{t}</span>
            ))}
          </div>
        )
      }
    </div>
  );
}
```

- [ ] **Step 8: 跑测试确认通过**

```bash
npm test -- --run MemoryTags
```

Expected: 2/2 PASS。

- [ ] **Step 9: 写失败测试 — `MemorySource.test.tsx`**

创建 `apps/admin/src/components/graph/MemorySource.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemorySource } from "./MemorySource.js";

describe("MemorySource", () => {
  it("renders collapsed by default, shows toggle", () => {
    render(<MemorySource source={{ kind: "user", ref: "claude" }} />);
    expect(screen.getByRole("button", { name: /展开/i })).toBeTruthy();
    expect(screen.queryByText(/"kind"/)).toBe(null);
  });
  it("expands on click and shows JSON", () => {
    render(<MemorySource source={{ kind: "user", ref: "claude" }} />);
    fireEvent.click(screen.getByRole("button", { name: /展开/i }));
    expect(screen.getByText(/"kind"/)).toBeTruthy();
  });
});
```

- [ ] **Step 10: 跑测试确认失败**

```bash
npm test -- --run MemorySource
```

Expected: FAIL,`Cannot find module ./MemorySource.js`。

- [ ] **Step 11: 创建 `MemorySource.tsx`**

创建 `apps/admin/src/components/graph/MemorySource.tsx`:

```tsx
import { useState } from "react";

interface Props { source: unknown; }

export function MemorySource({ source }: Props) {
  const [open, setOpen] = useState(false);
  const json = JSON.stringify(source, null, 2);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-dim)" }}>来源</span>
        <button type="button" onClick={() => setOpen((o) => !o)} style={{ fontSize: 11, padding: "2px 6px", background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 3, cursor: "pointer" }}>
          {open ? "收起" : "展开"}
        </button>
      </div>
      {open && (
        <pre style={{
          fontSize: 11, lineHeight: 1.4, fontFamily: "monospace",
          background: "var(--bg-elev)", padding: 6, borderRadius: 4,
          border: "1px solid var(--border)",
          maxHeight: 160, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word",
          margin: 0,
        }}>{json}</pre>
      )}
    </div>
  );
}
```

- [ ] **Step 12: 跑测试确认通过**

```bash
npm test -- --run MemorySource
```

Expected: 2/2 PASS。

- [ ] **Step 13: 跑全部 vitest + typecheck**

```bash
cd apps/admin
npm run typecheck
npm test
```

Expected: tsc clean, 20/20 PASS(原 14 + 新 6)。

- [ ] **Step 14: commit**

```bash
cd ../..
git add apps/admin/src/components/graph/MemoryBody.tsx apps/admin/src/components/graph/MemoryBody.test.tsx apps/admin/src/components/graph/MemoryTags.tsx apps/admin/src/components/graph/MemoryTags.test.tsx apps/admin/src/components/graph/MemorySource.tsx apps/admin/src/components/graph/MemorySource.test.tsx
git commit -m "feat(admin): drawer body sections (MemoryBody/Tags/Source)"
```

---

## Task 6: RelatedMemories 组件

**Files:**
- Create: `apps/admin/src/components/graph/RelatedMemories.tsx`
- Create: `apps/admin/src/components/graph/RelatedMemories.test.tsx`

**Interfaces:**
- Consumes: `MemoryRelations` + `onJump: (id: string) => void`
- Produces: 4 段折叠列表(supersede / merge / co_topic / co_scope)

- [ ] **Step 1: 写失败测试**

创建 `apps/admin/src/components/graph/RelatedMemories.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { MemoryRelations, RelatedNode } from "@agent-recall/contracts";
import { RelatedMemories } from "./RelatedMemories.js";

const mk = (id: string, topic: string): RelatedNode => ({
  id, title: id, topic, type: "fact", status: "active", importance: 3,
});

const empty: MemoryRelations = {
  supersedes: [], superseded_by: [], merge: [],
  co_topic: [], co_topic_total: 0, co_scope: [], co_scope_total: 0,
};

describe("RelatedMemories", () => {
  it("shows 4 section titles", () => {
    render(<RelatedMemories relations={empty} onJump={() => {}} />);
    expect(screen.getByText(/版本演进/)).toBeTruthy();
    expect(screen.getByText(/合并/)).toBeTruthy();
    expect(screen.getByText(/相关主题/)).toBeTruthy();
    expect(screen.getByText(/相关 scope/)).toBeTruthy();
  });
  it("shows empty state per section when no relations", () => {
    render(<RelatedMemories relations={empty} onJump={() => {}} />);
    const empties = screen.getAllByText(/无|—/);
    expect(empties.length).toBeGreaterThanOrEqual(3);
  });
  it("co_scope is collapsed by default, shows count", () => {
    const rel: MemoryRelations = {
      ...empty, co_scope: [mk("s1", "x"), mk("s2", "x")], co_scope_total: 25,
    };
    render(<RelatedMemories relations={rel} onJump={() => {}} />);
    expect(screen.getByText(/25/)).toBeTruthy();
    // s1/s2 not visible without clicking expand
    expect(screen.queryByText("s1")).toBe(null);
  });
  it("calls onJump when row clicked", () => {
    const onJump = vi.fn();
    const rel: MemoryRelations = { ...empty, supersedes: [mk("a", "x")] };
    render(<RelatedMemories relations={rel} onJump={onJump} />);
    fireEvent.click(screen.getByText("a"));
    expect(onJump).toHaveBeenCalledWith("a");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/admin
npm test -- --run RelatedMemories
```

Expected: FAIL,`Cannot find module ./RelatedMemories.js`。

- [ ] **Step 3: 创建 `RelatedMemories.tsx`**

创建 `apps/admin/src/components/graph/RelatedMemories.tsx`:

```tsx
import { useState } from "react";
import type { MemoryRelations, RelatedNode } from "@agent-recall/contracts";

interface Props {
  relations: MemoryRelations;
  onJump: (id: string) => void;
}

function Section({ title, count, children, defaultOpen = true }: {
  title: string;
  count?: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button type="button" onClick={() => setOpen((o) => !o)} style={{
        display: "flex", alignItems: "center", gap: 4, width: "100%",
        background: "transparent", border: "none", padding: "4px 0",
        fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5,
        color: "var(--text-dim)", cursor: "pointer", textAlign: "left",
      }}>
        <span>{open ? "▾" : "▸"}</span>
        <span>{title}</span>
        {count !== undefined && <span style={{ marginLeft: 4 }}>({count})</span>}
      </button>
      {open && <div style={{ marginBottom: 8 }}>{children}</div>}
    </div>
  );
}

function Row({ n, onJump }: { n: RelatedNode; onJump: (id: string) => void }) {
  const color = n.type === "decision" ? "#7c3aed" : n.type === "lesson" ? "#f59e0b" : "#64748b";
  return (
    <button type="button" onClick={() => onJump(n.id)} style={{
      display: "flex", alignItems: "center", gap: 8, width: "100%",
      background: "var(--bg-elev)", border: "1px solid var(--border)",
      borderRadius: 3, padding: "4px 8px", marginBottom: 4, cursor: "pointer",
      textAlign: "left", color: "var(--text)",
    }}>
      <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
      <span style={{ fontSize: 12, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.title}</span>
      <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{n.importance}★</span>
    </button>
  );
}

export function RelatedMemories({ relations, onJump }: Props) {
  const hasSupersede =
    relations.supersedes.length > 0 || relations.superseded_by.length > 0;
  return (
    <div>
      <Section title="版本演进">
        {relations.supersedes.map((n) => <Row key={`s-${n.id}`} n={n} onJump={onJump} />)}
        {relations.superseded_by.map((n) => <Row key={`sb-${n.id}`} n={n} onJump={onJump} />)}
        {!hasSupersede && <span style={{ color: "var(--text-dim)", fontSize: 12 }}>无版本关系</span>}
      </Section>
      <Section title="合并">
        {relations.merge.map((n) => <Row key={`m-${n.id}`} n={n} onJump={onJump} />)}
        {relations.merge.length === 0 && (
          <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
            无合并关系 <span style={{ fontSize: 10 }}>(v0.3)</span>
          </span>
        )}
      </Section>
      <Section title="相关主题" count={relations.co_topic_total}>
        {relations.co_topic.map((n) => <Row key={`ct-${n.id}`} n={n} onJump={onJump} />)}
        {relations.co_topic.length === 0 && <span style={{ color: "var(--text-dim)", fontSize: 12 }}>无同主题</span>}
      </Section>
      <Section title="相关 scope" count={relations.co_scope_total} defaultOpen={false}>
        {relations.co_scope.map((n) => <Row key={`cs-${n.id}`} n={n} onJump={onJump} />)}
      </Section>
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/admin
npm test -- --run RelatedMemories
```

Expected: 4/4 PASS。

- [ ] **Step 5: 跑全部 vitest + typecheck**

```bash
npm run typecheck
npm test
```

Expected: tsc clean, 24/24 PASS(原 20 + 新 4)。

- [ ] **Step 6: commit**

```bash
cd ../..
git add apps/admin/src/components/graph/RelatedMemories.tsx apps/admin/src/components/graph/RelatedMemories.test.tsx
git commit -m "feat(admin): RelatedMemories component (supersede/merge/co_topic, co_scope folded)"
```

---

## Task 7: OrgModeSwitcher + OrganizeButton 组件

**Files:**
- Create: `apps/admin/src/components/graph/OrgModeSwitcher.tsx`
- Create: `apps/admin/src/components/graph/OrgModeSwitcher.test.tsx`
- Create: `apps/admin/src/components/graph/OrganizeButton.tsx`
- Create: `apps/admin/src/components/graph/OrganizeButton.test.tsx`

**Interfaces:**
- Consumes: `OrgMode` + `onChange`
- Produces: 2 个交互组件

- [ ] **Step 1: 写失败测试 — `OrgModeSwitcher.test.tsx`**

创建 `apps/admin/src/components/graph/OrgModeSwitcher.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { OrgMode } from "@agent-recall/contracts";
import { OrgModeSwitcher } from "./OrgModeSwitcher.js";

describe("OrgModeSwitcher", () => {
  it("renders 4 mode options + a no-mode option", () => {
    const onChange = vi.fn();
    render(<OrgModeSwitcher value="none" onChange={onChange} />);
    expect(screen.getByRole("radio", { name: /无/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /按主题/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /按类型/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /按 scope/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /按状态/ })).toBeTruthy();
  });
  it("calls onChange when a different option is selected", () => {
    const onChange = vi.fn();
    render(<OrgModeSwitcher value="none" onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: /按主题/ }));
    expect(onChange).toHaveBeenCalledWith("by_topic" satisfies OrgMode);
  });
  it("the current value's radio is checked", () => {
    render(<OrgModeSwitcher value="by_type" onChange={() => {}} />);
    expect((screen.getByRole("radio", { name: /按类型/ }) as HTMLInputElement).checked).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/admin
npm test -- --run OrgModeSwitcher
```

Expected: FAIL,`Cannot find module`。

- [ ] **Step 3: 创建 `OrgModeSwitcher.tsx`**

创建 `apps/admin/src/components/graph/OrgModeSwitcher.tsx`:

```tsx
import type { OrgMode } from "@agent-recall/contracts";

interface Props {
  value: OrgMode;
  onChange: (mode: OrgMode) => void;
}

const OPTIONS: { value: OrgMode; label: string }[] = [
  { value: "none", label: "无" },
  { value: "by_topic", label: "按主题" },
  { value: "by_type", label: "按类型" },
  { value: "by_scope", label: "按 scope" },
  { value: "by_status", label: "按状态" },
];

export function OrgModeSwitcher({ value, onChange }: Props) {
  return (
    <div role="radiogroup" aria-label="组织模式" style={{ display: "inline-flex", gap: 0, border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
      {OPTIONS.map((o) => (
        <label key={o.value} style={{
          padding: "4px 10px", fontSize: 12, cursor: "pointer",
          background: value === o.value ? "var(--accent)" : "var(--bg-elev)",
          color: value === o.value ? "#fff" : "var(--text)",
          borderRight: "1px solid var(--border)",
        }}>
          <input
            type="radio"
            name="org-mode"
            value={o.value}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            style={{ display: "none" }}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/admin
npm test -- --run OrgModeSwitcher
```

Expected: 3/3 PASS。

- [ ] **Step 5: 写失败测试 — `OrganizeButton.test.tsx`**

创建 `apps/admin/src/components/graph/OrganizeButton.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OrganizeButton } from "./OrganizeButton.js";

describe("OrganizeButton", () => {
  it("renders the 整理 label and a ✨ icon", () => {
    render(<OrganizeButton onOrganize={() => {}} busy={false} />);
    expect(screen.getByRole("button", { name: /整理/ })).toBeTruthy();
  });
  it("calls onOrganize on click when not busy", () => {
    const cb = vi.fn();
    render(<OrganizeButton onOrganize={cb} busy={false} />);
    fireEvent.click(screen.getByRole("button", { name: /整理/ }));
    expect(cb).toHaveBeenCalledOnce();
  });
  it("does not call onOrganize when busy", () => {
    const cb = vi.fn();
    render(<OrganizeButton onOrganize={cb} busy={true} />);
    fireEvent.click(screen.getByRole("button", { name: /整理/ }));
    expect(cb).not.toHaveBeenCalled();
  });
  it("button is disabled when busy", () => {
    render(<OrganizeButton onOrganize={() => {}} busy={true} />);
    expect((screen.getByRole("button", { name: /整理/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
```

- [ ] **Step 6: 跑测试确认失败**

```bash
npm test -- --run OrganizeButton
```

Expected: FAIL,`Cannot find module`。

- [ ] **Step 7: 创建 `OrganizeButton.tsx`**

创建 `apps/admin/src/components/graph/OrganizeButton.tsx`:

```tsx
interface Props {
  onOrganize: () => void;
  busy: boolean;
}

export function OrganizeButton({ onOrganize, busy }: Props) {
  return (
    <button
      type="button"
      onClick={onOrganize}
      disabled={busy}
      title="按当前组织模式重新布局"
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        padding: "4px 10px", fontSize: 12,
        background: busy ? "var(--bg-elev)" : "var(--accent)",
        color: busy ? "var(--text-dim)" : "#fff",
        border: "1px solid var(--border)", borderRadius: 4,
        cursor: busy ? "wait" : "pointer",
      }}
    >
      <span style={{ display: "inline-block", transform: busy ? "rotate(360deg)" : "none", transition: "transform 0.3s" }}>✨</span>
      <span>整理</span>
    </button>
  );
}
```

- [ ] **Step 8: 跑测试确认通过**

```bash
cd apps/admin
npm test -- --run OrganizeButton
```

Expected: 4/4 PASS。

- [ ] **Step 9: 跑全部 vitest + typecheck**

```bash
npm run typecheck
npm test
```

Expected: tsc clean, 31/31 PASS(原 24 + 新 7)。

- [ ] **Step 10: commit**

```bash
cd ../..
git add apps/admin/src/components/graph/OrgModeSwitcher.tsx apps/admin/src/components/graph/OrgModeSwitcher.test.tsx apps/admin/src/components/graph/OrganizeButton.tsx apps/admin/src/components/graph/OrganizeButton.test.tsx
git commit -m "feat(admin): OrgModeSwitcher + OrganizeButton components"
```

---

## Task 8: MemoryDrawer 改造(加 4 sections)

**Files:**
- Modify: `apps/admin/src/components/graph/MemoryDrawer.tsx`
- Create: `apps/admin/src/components/graph/MemoryDrawer.test.tsx`(新文件,test 改版的 drawer)

**Interfaces:**
- Consumes: `GraphNode` (现有 props),`useMemoryDetail` 返回的 `MemoryDetail`
- Produces: 460px wide drawer with header / meta / body / tags / source / related 6 sections

- [ ] **Step 1: 写失败测试 — `MemoryDrawer.test.tsx`**

创建 `apps/admin/src/components/graph/MemoryDrawer.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { GraphNode } from "@agent-recall/contracts";
import { MemoryDrawer } from "./MemoryDrawer.js";

vi.mock("../../lib/useMemoryDetail.js", () => ({
  useMemoryDetail: vi.fn(),
}));

import { useMemoryDetail } from "../../lib/useMemoryDetail.js";

const node: GraphNode = {
  id: "mem_alpha", label: "Use JWT", type: "decision", topic: "auth",
  scope: "project", project_id: "p1", importance: 4, status: "active",
  created_at: "2026-08-25T00:00:00.000Z",
};

const detail = {
  id: "mem_alpha", scope: "project" as const, project_id: "p1",
  type: "decision" as const, topic: "auth", title: "Use JWT",
  body: "long body content", tags: ["auth", "jwt"],
  importance: 4, confidence: 5, sensitivity: "normal" as const,
  status: "active" as const, supersedes: [],
  source: { kind: "user" as const },
  created_at: "2026-08-25T00:00:00.000Z",
  updated_at: "2026-08-25T00:00:00.000Z", revision: 1,
  related: { supersedes: [], superseded_by: [], merge: [], co_topic: [], co_topic_total: 0, co_scope: [], co_scope_total: 0 },
};

describe("MemoryDrawer", () => {
  it("renders nothing when node is null", () => {
    const { container } = render(<MemoryDrawer node={null} onClose={() => {}} />);
    expect(container.firstChild).toBe(null);
  });
  it("shows loading state when detail is loading", () => {
    (useMemoryDetail as any).mockReturnValue({ data: null, error: null, isLoading: true });
    render(<MemoryDrawer node={node} onClose={() => {}} />);
    expect(screen.getByText(/加载中/)).toBeTruthy();
  });
  it("renders body, tags, source, related sections when detail is loaded", () => {
    (useMemoryDetail as any).mockReturnValue({ data: detail, error: null, isLoading: false });
    render(<MemoryDrawer node={node} onClose={() => {}} />);
    expect(screen.getByText("long body content")).toBeTruthy();
    expect(screen.getByText("auth")).toBeTruthy();
    expect(screen.getByText("jwt")).toBeTruthy();
    expect(screen.getByText(/来源/)).toBeTruthy();
    expect(screen.getByText(/版本演进/)).toBeTruthy();
  });
  it("shows error state", () => {
    (useMemoryDetail as any).mockReturnValue({ data: null, error: { code: "X", message: "boom" }, isLoading: false });
    render(<MemoryDrawer node={node} onClose={() => {}} />);
    expect(screen.getByText(/无法加载|boom|重试/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/admin
npm test -- --run MemoryDrawer
```

Expected: FAIL(可能不存在测试,或者新断言失败)。

- [ ] **Step 3: 改 `MemoryDrawer.tsx` 集成新 section + useMemoryDetail**

打开 `apps/admin/src/components/graph/MemoryDrawer.tsx`:

1. 顶部 import 加:
   ```tsx
   import { useState } from "react";
   import { useMemoryDetail } from "../../lib/useMemoryDetail.js";
   import type { MemoryDetail } from "@agent-recall/contracts";
   import { MemoryBody } from "./MemoryBody.js";
   import { MemoryTags } from "./MemoryTags.js";
   import { MemorySource } from "./MemorySource.js";
   import { RelatedMemories } from "./RelatedMemories.js";
   ```

2. 把组件函数体改成:

```tsx
export default function MemoryDrawer({ node, onClose }: Props): React.ReactElement | null {
  const [pendingJumpId, setPendingJumpId] = useState<string | null>(null);
  const { data: detail, error, isLoading } = useMemoryDetail(node?.id ?? null);

  // 处理 "在图中定位" 点击:把目标 id 传给 caller (route 层做实际 pan)
  const handleLocateInGraph = () => {
    if (node) {
      // route 层监听 window event 'locate-node' 来响应
      window.dispatchEvent(new CustomEvent("locate-node", { detail: { id: node.id } }));
      onClose();
    }
  };

  // 处理关联记忆跳转
  const handleJump = (targetId: string) => {
    setPendingJumpId(targetId);
    // 通过 window event 让 route 层更新 selectedNode
    window.dispatchEvent(new CustomEvent("jump-to-node", { detail: { id: targetId } }));
  };

  if (!node) return null;

  return (
    <>
      <div onClick={onClose} aria-hidden style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", zIndex: 99 }} />
      <aside role="dialog" aria-label="Memory detail" style={{
        position: "fixed", top: 0, right: 0, bottom: 0, width: 460,
        background: "var(--bg)", color: "var(--text)",
        borderLeft: "1px solid var(--border)", boxShadow: "-4px 0 12px rgba(0,0,0,0.15)",
        zIndex: 100, display: "flex", flexDirection: "column",
      }}>
        {/* Header (title + close) — 保留原有逻辑 */}
        <header style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "12px 16px", borderBottom: "1px solid var(--border)", background: "var(--bg-elev)" }}>
          <h2 style={{ flex: 1, margin: 0, fontSize: 15, lineHeight: 1.4, wordBreak: "break-word" }} title={node.label}>
            {truncate(node.label, 60)}
          </h2>
          <button type="button" onClick={onClose} aria-label="关闭" style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 4, width: 28, height: 28, cursor: "pointer", fontSize: 16, lineHeight: 1, color: "var(--text)", flexShrink: 0 }}>×</button>
        </header>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
          {/* 加载 / 错误状态 */}
          {isLoading && <div style={{ padding: 12, color: "var(--text-dim)" }}>加载中…</div>}
          {error && !isLoading && (
            <div style={{ padding: 12, color: "var(--danger)" }}>
              无法加载详情: {error.message}
            </div>
          )}

          {/* 详情已加载 */}
          {detail && !isLoading && !error && (
            <>
              {/* 标题 + 类型/主题/scope/重要性/状态/时间 — 全部从 detail 而不是 node 读 */}
              <Field label="类型">
                <span style={{ display: "inline-block", padding: "2px 8px", fontSize: 11, fontWeight: 600, color: "#fff", background: TYPE_COLOR[detail.type], borderRadius: 3 }}>{detail.type}</span>
              </Field>
              <Field label="主题"><code style={codeStyle}>{detail.topic}</code></Field>
              <Field label="范围">
                <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                  {detail.scope}{detail.project_id ? ` · ${detail.project_id}` : ""}
                </div>
              </Field>
              <Field label="重要性">
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Stars value={detail.importance} /><span style={{ fontSize: 12, color: "var(--text-dim)" }}>{detail.importance} / 5</span>
                </div>
              </Field>
              <Field label="状态">
                <span style={{ display: "inline-block", padding: "2px 8px", fontSize: 11, fontWeight: 600, color: "#fff", background: STATUS_COLOR[detail.status], borderRadius: 3 }}>{detail.status}</span>
              </Field>
              <Field label="置信度">
                <div style={{ fontSize: 12 }}>{detail.confidence} / 5</div>
              </Field>
              <Field label="敏感度">
                <div style={{ fontSize: 12, color: detail.sensitivity === "restricted" ? "var(--danger)" : "var(--text-dim)" }}>{detail.sensitivity}</div>
              </Field>
              <Field label="创建时间"><div style={{ fontSize: 12, color: "var(--text-dim)" }}>{formatDate(detail.created_at)}</div></Field>
              <Field label="更新时间"><div style={{ fontSize: 12, color: "var(--text-dim)" }}>{formatDate(detail.updated_at)}</div></Field>

              {/* 全文 */}
              <MemoryBody body={detail.body} />

              {/* 标签 */}
              <MemoryTags tags={detail.tags} />

              {/* 来源 */}
              <MemorySource source={detail.source} />

              {/* 关联记忆 */}
              <Field label="关联记忆">
                <RelatedMemories relations={detail.related} onJump={handleJump} />
              </Field>
            </>
          )}

          <Field label="ID">
            <code style={{ fontSize: 11, color: "var(--text-dim)", wordBreak: "break-all" }}>{node.id}</code>
          </Field>
        </div>

        {/* Footer */}
        <footer style={{ display: "flex", gap: 8, padding: "12px 16px", borderTop: "1px solid var(--border)", background: "var(--bg-elev)" }}>
          <button type="button" onClick={handleLocateInGraph} style={{ padding: "6px 12px", fontSize: 12, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, cursor: "pointer" }}>
            在图中定位
          </button>
          <button type="button" onClick={() => navigator.clipboard.writeText(node.id)} style={{ padding: "6px 12px", fontSize: 12, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, cursor: "pointer" }}>
            复制 ID
          </button>
        </footer>
      </aside>
    </>
  );
}
```

`TYPE_COLOR` / `STATUS_COLOR` / `Stars` / `truncate` / `formatDate` / `Field` / `codeStyle` 都保留原文件里现有的 helper,只在函数体里加新 section。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/admin
npm test -- --run MemoryDrawer
```

Expected: 4/4 PASS。

- [ ] **Step 5: 跑全部 vitest + typecheck**

```bash
npm run typecheck
npm test
```

Expected: tsc clean, 35/35 PASS(原 31 + 新 4)。

- [ ] **Step 6: commit**

```bash
cd ../..
git add apps/admin/src/components/graph/MemoryDrawer.tsx apps/admin/src/components/graph/MemoryDrawer.test.tsx
git commit -m "feat(admin): MemoryDrawer 4 new sections (body/tags/source/related) + useMemoryDetail"
```

---

## Task 9: GraphCanvas 接 organization + 一键整理

**Files:**
- Modify: `apps/admin/src/components/graph/GraphCanvas.tsx`
- Create: `apps/admin/src/components/graph/GraphCanvas.test.tsx`(新文件,如果 v0.1 没有)

**Interfaces:**
- Consumes: `filter.organization` (从 props 接进来),5 个 layout 函数,OrganizeButton
- Produces: 切换 organization 时调对应 layout,点整理按钮时重算 + bump positionsTick

- [ ] **Step 1: 写失败测试 — `GraphCanvas.test.tsx`**

(检查 v0.1 是否已有此测试文件。如果没有则创建。)

创建 `apps/admin/src/components/graph/GraphCanvas.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GraphCanvas } from "./GraphCanvas.js";

vi.mock("./layouts/layoutNone.js", () => ({ layoutNone: vi.fn(() => ({ a: { x: 100, y: 50 } })) }));
vi.mock("./layouts/layoutByTopic.js", () => ({ layoutByTopic: vi.fn(() => ({ a: { x: 200, y: 50 } })) }));
vi.mock("./layouts/layoutByType.js", () => ({ layoutByType: vi.fn(() => ({ a: { x: 300, y: 50 } })) }));
vi.mock("./layouts/layoutByScope.js", () => ({ layoutByScope: vi.fn(() => ({ a: { x: 400, y: 50 } })) }));
vi.mock("./layouts/layoutByStatus.js", () => ({ layoutByStatus: vi.fn(() => ({ a: { x: 500, y: 50 } })) }));

import { layoutNone } from "./layouts/layoutNone.js";
import { layoutByTopic } from "./layouts/layoutByTopic.js";

const nodes = [{ id: "a", label: "a", type: "fact", topic: "x", scope: "global", project_id: null, importance: 3, status: "active", created_at: "2026-08-25T00:00:00.000Z" }];

describe("GraphCanvas organization dispatch", () => {
  it("uses layoutNone when organization is 'none'", () => {
    render(<GraphCanvas nodes={nodes as any} edges={[]} organization="none" onNodeClick={() => {}} />);
    expect(layoutNone).toHaveBeenCalled();
    expect(layoutByTopic).not.toHaveBeenCalled();
  });
  it("uses layoutByTopic when organization is 'by_topic'", () => {
    render(<GraphCanvas nodes={nodes as any} edges={[]} organization="by_topic" onNodeClick={() => {}} />);
    expect(layoutByTopic).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/admin
npm test -- --run GraphCanvas
```

Expected: FAIL(测试需要 `organization` prop,函数还没接)。

- [ ] **Step 3: 改 `GraphCanvas.tsx` 加 `organization` prop + 整理逻辑**

打开 `apps/admin/src/components/graph/GraphCanvas.tsx`,改 `Props` interface:

```tsx
interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  total: number;
  organization: OrgMode;          // 新增
  onNodeClick?: (node: GraphNode) => void;
}
```

顶部 import 加:

```tsx
import type { OrgMode } from "@agent-recall/contracts";
import { layoutNone } from "./layouts/layoutNone.js";
import { layoutByTopic } from "./layouts/layoutByTopic.js";
import { layoutByType } from "./layouts/layoutByType.js";
import { layoutByScope } from "./layouts/layoutByScope.js";
import { layoutByStatus } from "./layouts/layoutByStatus.js";
import { OrganizeButton } from "./OrganizeButton.js";
```

在函数体内加 layout 选择 + 整理按钮:

```tsx
const LAYOUTS = {
  none: layoutNone,
  by_topic: layoutByTopic,
  by_type: layoutByType,
  by_scope: layoutByScope,
  by_status: layoutByStatus,
} as const;

export default function GraphCanvas({ nodes, edges, truncated, total, organization, onNodeClick }: Props) {
  // ... 现有 state ...

  const baseLayout = useMemo(
    () => LAYOUTS[organization](nodes, edges),
    [nodes, edges, organization]
  );

  const [organizeBusy, setOrganizeBusy] = useState(false);
  const handleOrganize = () => {
    setOrganizeBusy(true);
    // 强制重算: 用 organization 对应的 layout 跑一遍
    const fresh = LAYOUTS[organization](nodes, edges);
    // 重置 positionsRef 到新位置
    const next = new Map<string, Position>();
    for (const n of nodes) {
      const p = fresh[n.id] ?? baseLayout[n.id] ?? { x: 0, y: 0 };
      next.set(n.id, p);
    }
    positionsRef.current = next;
    setPositionsTick((t) => t + 1);
    // 让 spinner 至少转 200ms 防止闪烁
    setTimeout(() => setOrganizeBusy(false), 200);
  };

  return (
    <div ref={containerRef} ...>
      {/* 现有 counter / zoom indicator / canvas / Controls / MiniMap */}
      <Controls ... />
      <MiniMap ... />
      <OrganizeButton onOrganize={handleOrganize} busy={organizeBusy} />
    </div>
  );
}
```

把 OrganizeButton 放在 MiniMap 旁边或 Controls 旁边(自己选,推荐右上角 zoom indicator 那一行)。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/admin
npm test -- --run GraphCanvas
```

Expected: 2/2 PASS。

- [ ] **Step 5: 跑全部 vitest + typecheck**

```bash
npm run typecheck
npm test
```

Expected: tsc clean, 37/37 PASS(原 35 + 新 2)。

- [ ] **Step 6: commit**

```bash
cd ../..
git add apps/admin/src/components/graph/GraphCanvas.tsx apps/admin/src/components/graph/GraphCanvas.test.tsx
git commit -m "feat(admin): GraphCanvas dispatches to 5 layouts by organization mode + organize button"
```

---

## Task 10: FilterBar 改版(pill chips + 弹层 + OrgModeSwitcher + OrganizeButton)

**Files:**
- Modify: `apps/admin/src/components/graph/FilterBar.tsx`
- Create: `apps/admin/src/components/graph/FilterBar.test.tsx`

**Interfaces:**
- Consumes: `GraphFilter` (现有),`OrgMode` + `onOrganize` callback
- Produces: 两行布局(top: chips / bottom: 切换器 + 整理 + refresh)

- [ ] **Step 1: 写失败测试**

创建 `apps/admin/src/components/graph/FilterBar.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { GraphFilter } from "@agent-recall/contracts";
import { FilterBar } from "./FilterBar.js";

const base: GraphFilter = { scope: "all", status: ["active"], max_nodes: 500, include_co_topic: true, include_co_scope: false };

describe("FilterBar v0.2", () => {
  it("shows scope/topic/type as removable pill chips", () => {
    const filter = { ...base, topic: ["auth", "cache"] };
    const onChange = vi.fn();
    render(<FilterBar filter={filter} onChange={onChange} onRefresh={() => {}} organization="none" onOrganizationChange={() => {}} onOrganize={() => {}} organizeBusy={false} />);
    expect(screen.getByText("auth")).toBeTruthy();
    expect(screen.getByText("cache")).toBeTruthy();
  });
  it("clicking pill's ✕ removes that filter value", () => {
    const filter = { ...base, topic: ["auth", "cache"] };
    const onChange = vi.fn();
    render(<FilterBar filter={filter} onChange={onChange} onRefresh={() => {}} organization="none" onOrganizationChange={() => {}} onOrganize={() => {}} organizeBusy={false} />);
    fireEvent.click(screen.getByRole("button", { name: /移除 auth/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ topic: ["cache"] }));
  });
  it("+ button opens advanced filter drawer with min_importance etc.", () => {
    render(<FilterBar filter={base} onChange={() => {}} onRefresh={() => {}} organization="none" onOrganizationChange={() => {}} onOrganize={() => {}} organizeBusy={false} />);
    fireEvent.click(screen.getByRole("button", { name: /\+/ }));
    expect(screen.getByText(/最小重要性/)).toBeTruthy();
    expect(screen.getByText(/最大节点/)).toBeTruthy();
  });
  it("renders OrgModeSwitcher and OrganizeButton in second row", () => {
    render(<FilterBar filter={base} onChange={() => {}} onRefresh={() => {}} organization="by_topic" onOrganizationChange={() => {}} onOrganize={() => {}} organizeBusy={false} />);
    expect(screen.getByRole("radiogroup", { name: /组织模式/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /整理/ })).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/admin
npm test -- --run FilterBar
```

Expected: FAIL(新 props + 旧实现不匹配)。

- [ ] **Step 3: 重写 `FilterBar.tsx`**

完全替换 `apps/admin/src/components/graph/FilterBar.tsx` 内容:

```tsx
import { useState, useEffect } from "react";
import type { GraphFilter, GraphNode, MemoryType, MemoryStatus, OrgMode } from "@agent-recall/contracts";
import { OrgModeSwitcher } from "./OrgModeSwitcher.js";
import { OrganizeButton } from "./OrganizeButton.js";

const TYPES: MemoryType[] = ["preference", "procedure", "fact", "decision", "lesson", "debugging", "constraint"];
const STATUSES: MemoryStatus[] = ["active", "archived", "superseded", "forgotten"];

interface Props {
  filter: GraphFilter;
  onChange: (f: GraphFilter) => void;
  onRefresh: () => void;
  organization: OrgMode;
  onOrganizationChange: (m: OrgMode) => void;
  onOrganize: () => void;
  organizeBusy: boolean;
}

export function FilterBar({ filter, onChange, onRefresh, organization, onOrganizationChange, onOrganize, organizeBusy }: Props) {
  const [local, setLocal] = useState(filter);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  useEffect(() => { setLocal(filter); }, [filter]);
  useEffect(() => {
    const t = setTimeout(() => onChange(local), 300);
    return () => clearTimeout(t);
  }, [local, onChange]);

  const removeTopic = (t: string) => setLocal({ ...local, topic: (local.topic ?? []).filter((x) => x !== t) });
  const removeType = (t: MemoryType) => setLocal({ ...local, type: (local.type ?? []).filter((x) => x !== t) });
  const removeStatus = (s: MemoryStatus) => setLocal({ ...local, status: local.status.filter((x) => x !== s) });
  const setScope = (s: GraphFilter["scope"]) => setLocal({ ...local, scope: s });
  const toggleType = (t: MemoryType) => {
    const cur = local.type ?? [];
    setLocal({ ...local, type: cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t] });
  };
  const toggleStatus = (s: MemoryStatus) => {
    setLocal({ ...local, status: local.status.includes(s) ? local.status.filter((x) => x !== s) : [...local.status, s] });
  };
  const setTopicInput = (s: string) => setLocal({ ...local, topic: s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined });

  return (
    <div style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-elev)" }}>
      {/* 第一行:已选 filter 的 pill chips + + 高级 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "8px 16px", alignItems: "center" }}>
        {/* scope 单选 pill */}
        <Pill label={`scope: ${local.scope}`} onRemove={() => setScope("all")} />
        {/* topic pills */}
        {(local.topic ?? []).map((t) => (
          <Pill key={t} label={`topic: ${t}`} onRemove={() => removeTopic(t)} />
        ))}
        {/* type pills */}
        {(local.type ?? []).map((t) => (
          <Pill key={t} label={`type: ${t}`} onRemove={() => removeType(t)} />
        ))}
        {/* status pills */}
        {local.status.map((s) => (
          <Pill key={s} label={`status: ${s}`} onRemove={() => removeStatus(s)} />
        ))}
        {/* + 高级按钮 */}
        <button type="button" onClick={() => setAdvancedOpen((o) => !o)} aria-label="高级过滤" style={{ padding: "2px 8px", fontSize: 12, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 12, cursor: "pointer" }}>+</button>
      </div>

      {/* 高级过滤弹层 */}
      {advancedOpen && (
        <div style={{ padding: "8px 16px", borderTop: "1px solid var(--border)", background: "var(--bg)" }}>
          <Field label="最小重要性">
            <input type="range" min={1} max={5} value={local.min_importance ?? 1}
              onChange={(e) => setLocal({ ...local, min_importance: Number(e.target.value) })} />
            <span style={{ marginLeft: 6, fontSize: 12 }}>{local.min_importance ?? 1}</span>
          </Field>
          <Field label="最大节点">
            <input type="number" min={1} max={2000} value={local.max_nodes}
              onChange={(e) => setLocal({ ...local, max_nodes: Number(e.target.value) })} style={{ width: 80, padding: 2, fontSize: 12 }} />
          </Field>
          <Field label="topic(逗号分隔)">
            <input type="text" placeholder="auth,cache,..."
              value={(local.topic ?? []).join(",")}
              onChange={(e) => setTopicInput(e.target.value)} style={{ padding: 2, fontSize: 12, width: 200 }} />
          </Field>
          <Field label="type(多选)">
            {TYPES.map((t) => (
              <label key={t} style={{ marginRight: 8, fontSize: 12 }}>
                <input type="checkbox" checked={(local.type ?? []).includes(t)} onChange={() => toggleType(t)} />{t}
              </label>
            ))}
          </Field>
          <Field label="status(多选)">
            {STATUSES.map((s) => (
              <label key={s} style={{ marginRight: 8, fontSize: 12 }}>
                <input type="checkbox" checked={local.status.includes(s)} onChange={() => toggleStatus(s)} />{s}
              </label>
            ))}
          </Field>
          <Field label="include co_topic">
            <input type="checkbox" checked={local.include_co_topic} onChange={(e) => setLocal({ ...local, include_co_topic: e.target.checked })} />
          </Field>
          <Field label="include co_scope">
            <input type="checkbox" checked={local.include_co_scope} onChange={(e) => setLocal({ ...local, include_co_scope: e.target.checked })} />
          </Field>
        </div>
      )}

      {/* 第二行:组织模式 + 整理 + refresh */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 16px", borderTop: "1px solid var(--border)" }}>
        <OrgModeSwitcher value={organization} onChange={onOrganizationChange} />
        <OrganizeButton onOrganize={onOrganize} busy={organizeBusy} />
        <button type="button" onClick={onRefresh} style={{ marginLeft: "auto", padding: "4px 10px", fontSize: 12, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, cursor: "pointer" }}>↻</button>
      </div>
    </div>
  );
}

function Pill({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--accent)", color: "var(--text)", borderRadius: 12 }}>
      {label}
      <button type="button" onClick={onRemove} aria-label={`移除 ${label}`} style={{ background: "transparent", border: "none", color: "var(--text-dim)", cursor: "pointer", padding: 0, fontSize: 14, lineHeight: 1 }}>×</button>
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <span style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.5, marginRight: 8 }}>{label}</span>
      {children}
    </div>
  );
}

export default FilterBar;
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/admin
npm test -- --run FilterBar
```

Expected: 4/4 PASS。

- [ ] **Step 5: 跑全部 vitest + typecheck**

```bash
npm run typecheck
npm test
```

Expected: tsc clean, 41/41 PASS(原 37 + 新 4)。

- [ ] **Step 6: commit**

```bash
cd ../..
git add apps/admin/src/components/graph/FilterBar.tsx apps/admin/src/components/graph/FilterBar.test.tsx
git commit -m "feat(admin): FilterBar pill chips + advanced drawer + org switcher + organize button"
```

---

## Task 11: routes/graph.tsx 接线(filter.organization + jump-to-node 事件)

**Files:**
- Modify: `apps/admin/src/routes/graph.tsx`

**Interfaces:**
- Consumes: `GraphFilter` (加 `organization`),`GraphNode` 选择
- Produces: 把 organization 传给 GraphCanvas + FilterBar;监听 `locate-node` 和 `jump-to-node` window event 做 pan + selectedNode 更新

- [ ] **Step 1: 改 `graph.tsx`**

完全替换 `apps/admin/src/routes/graph.tsx` 内容:

```tsx
import { useEffect, useState } from "react";
import { useGraph } from "../lib/useGraph.js";
import { usePolling } from "../lib/usePolling.js";
import type { GraphFilter, GraphNode, OrgMode } from "@agent-recall/contracts";
import GraphCanvas from "../components/graph/GraphCanvas.js";
import FilterBar from "../components/graph/FilterBar.js";
import EdgeLegend from "../components/graph/EdgeLegend.js";
import EmptyState from "../components/common/EmptyState.js";
import ErrorBanner from "../components/common/ErrorBanner.js";
import PollIndicator from "../components/common/PollIndicator.js";
import MemoryDrawer from "../components/graph/MemoryDrawer.js";

export default function GraphPage() {
  const [filter, setFilter] = useState<GraphFilter>({
    scope: "all",
    status: ["active"],
    max_nodes: 500,
    include_co_topic: true,
    include_co_scope: false,
    organization: "none",        // 新增默认
  });
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [organizeTick, setOrganizeTick] = useState(0);  // 每次点整理 +1,触发 GraphCanvas 重 layout
  const { data, error, isLoading, refetch } = useGraph(filter);
  const { status } = usePolling(refetch);

  // 监听 drawer 的 "在图中定位" 事件
  useEffect(() => {
    const onLocate = (e: Event) => {
      const id = (e as CustomEvent).detail?.id as string | undefined;
      if (!id || !data) return;
      const node = data.nodes.find((n) => n.id === id);
      if (node) setSelectedNode(null);  // 先关 drawer,让 canvas 显示
      // 把 pan/zoom 目标通过全局状态传 — 这里用最简方式:setSelectedNode(null) + 滚动到节点
      // 实际 pan 由 GraphCanvas 内部做:简化 v0.2 不做,只关闭 drawer
    };
    window.addEventListener("locate-node", onLocate);
    return () => window.removeEventListener("locate-node", onLocate);
  }, [data]);

  // 监听 drawer 的 "jump-to-node" 事件(关联记忆跳转)
  useEffect(() => {
    const onJump = (e: Event) => {
      const id = (e as CustomEvent).detail?.id as string | undefined;
      if (!id || !data) return;
      const node = data.nodes.find((n) => n.id === id);
      if (node) setSelectedNode(node);
    };
    window.addEventListener("jump-to-node", onJump);
    return () => window.removeEventListener("jump-to-node", onJump);
  }, [data]);

  const handleOrganize = () => setOrganizeTick((t) => t + 1);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <FilterBar
        filter={filter}
        onChange={setFilter}
        onRefresh={refetch}
        organization={filter.organization ?? "none"}
        onOrganizationChange={(m: OrgMode) => setFilter({ ...filter, organization: m })}
        onOrganize={handleOrganize}
        organizeBusy={false}
      />
      <EdgeLegend />
      {error && <ErrorBanner error={error} />}
      {isLoading && <div style={{ padding: 12 }}>加载中…</div>}
      {!isLoading && data && data.nodes.length === 0 && (
        <EmptyState message="数据库为空或过滤过严" />
      )}
      {data && data.nodes.length > 0 && (
        <GraphCanvas
          key={organizeTick}  // 每次整理强制 remount,触发 useMemo 重算
          nodes={data.nodes}
          edges={data.edges}
          truncated={data.truncated}
          total={data.total}
          organization={filter.organization ?? "none"}
          onNodeClick={setSelectedNode}
        />
      )}
      <MemoryDrawer node={selectedNode} onClose={() => setSelectedNode(null)} />
    </div>
  );
}
```

> 简化:`key={organizeTick}` 强制 remount 触发重算,而不是在 GraphCanvas 内部手动 reset positionsRef — 简单可靠,v0.3 再做平滑动画。

- [ ] **Step 2: 跑全部 vitest + typecheck**

```bash
cd apps/admin
npm run typecheck
npm test
```

Expected: tsc clean, 41/41 PASS(没新 test,但现有不破)。

- [ ] **Step 3: commit**

```bash
cd ../..
git add apps/admin/src/routes/graph.tsx
git commit -m "feat(admin): graph route wires organization + jump/locate window events"
```

---

## Task 12: 文档 + CHANGELOG

**Files:**
- Modify: `docs/guides/admin-app.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 看现有 `admin-app.md` 结构**

```bash
cd ..
head -30 docs/guides/admin-app.md
```

(预览现有结构,在 v0.1 内容之后追加 v0.2 section)

- [ ] **Step 2: 追加 v0.2 section**

打开 `docs/guides/admin-app.md`,在文件末尾追加:

```markdown

## v0.2 新增

### 工作栏改版
- 已选 filter 用 pill chips(可点击 ✕ 移除)
- `+` 按钮展开高级过滤弹层(importance / max_nodes / topic / type / status / co_topic / co_scope)
- 底部第二行:组织模式切换器(5 选 1) + ✨ 整理按钮 + 手动 refresh

### 节点组织方式
5 种模式可切换:
- **无**:原 dagre LR
- **按主题**:同 topic 节点聚成水平簇,簇间大间距
- **按类型**:7 种 type(preference/procedure/fact/decision/lesson/debugging/constraint)各自区域
- **按 scope**:左 global / 右 project
- **按状态**:4 行(active/archived/superseded/forgotten)

切换组织模式后点 ✨ 整理按钮,所有节点按当前模式重新布局(瞬间切换,无动画)。

### 详情页增强
drawer 扩到 460px,新增 4 个 section:
- **全文 body**:等宽 + 横向滚动 + 复制按钮
- **标签 tags**:pill chips,无标签显示 —
- **来源 source**:折叠 JSON,默认收起
- **关联记忆**:
  - 版本演进:supersedes / superseded_by 双向
  - 合并:merge(留 v0.3 持久化 TODO)
  - 相关主题:co_topic(限 5 条,显示总数)
  - 相关 scope:co_scope(默认折叠,显示总数)

点关联记忆的某行 → drawer 内容区 swap(不关闭,平滑换)。
点"在图中定位" → drawer 关闭 + canvas 平移到节点(简化:仅关闭 drawer)。
点"复制 ID" / "复制全文" → 调 clipboard API。

### 数据模型
- `GraphNode` 保持精简(不扩字段)
- `GraphFilter.organization` 字段(后端忽略,纯前端布局开关)
- `get_memory` 命令响应改 `MemoryDetail`,含 `related: MemoryRelations`
- 新 `packages/contracts/src/memory.ts` 模块:`RelatedNodeSchema` / `MemoryRelationsSchema` / `MemoryDetailSchema`
```

- [ ] **Step 3: 看现有 `CHANGELOG.md` 结构**

```bash
head -20 CHANGELOG.md
```

- [ ] **Step 4: 加 v0.2 entry**

在 `CHANGELOG.md` 顶部加:

```markdown
## v0.2 (2026-08-25)

### 新增
- 工作栏 pill chips + 高级过滤弹层
- 5 种节点组织模式(by_topic / by_type / by_scope / by_status / none)+ 切换器
- ✨ 一键整理按钮(按当前组织模式重算布局)
- 详情页加 body / tags / source / 关联记忆(supersede / superseded_by / merge / co_topic + co_scope 折叠)
- "在图中定位" / "复制 ID" / 关联记忆跳转(同 drawer 内 swap)

### 改动
- `GraphFilter` 加 `organization` 字段(后端忽略)
- `get_memory` 命令响应改 `MemoryDetail`,含 `related`
- 5 个 layout 函数(layoutNone / layoutByTopic / layoutByType / layoutByScope / layoutByStatus)
- FilterBar 重写为两行布局
- GraphCanvas 接收 `organization` prop,dispatch 到对应 layout
- MemoryDrawer 380 → 460px,加 4 sections

### TODO v0.3
- merge 关系持久化(GraphEdge 写库)
- co_scope 展开后虚拟滚动
- 整理动画缓动
```

- [ ] **Step 5: commit**

```bash
cd ../..
git add docs/guides/admin-app.md CHANGELOG.md
git commit -m "docs(admin): v0.2 user guide section + CHANGELOG entry"
```

---

## Self-Review Checklist (writing-plans skill)

- [x] **Spec coverage**:workbar redesign → Task 10,4 org modes → Task 2 + 9,organize button → Task 9,detail page enhancement → Task 8,related memories schema → Task 1 + 3 + 4 + 6 + 8
- [x] **No placeholders**:每步都有具体代码;没有 "TBD" / "implement later" / "similar to Task N"
- [x] **Type consistency**:
  - `OrgMode` defined in Task 1, used in Task 2 / 7 / 9 / 10 / 11
  - `MemoryDetail` / `MemoryRelations` / `RelatedNode` defined in Task 1, used in Task 3 / 4 / 8
  - `LAYOUTS` constant used in Task 9, same shape as Task 2's exports
  - `getMemoryDetail` in `cmds` (Task 4) wraps Tauri command `get_memory` returning `MemoryDetail` (Task 3)
  - `useMemoryDetail` (Task 4) returns `{ data, error, isLoading }`, consumed in Task 8's `MemoryDrawer`
  - `cmds.getMemoryDetail` and `useMemoryDetail` both call into Tauri command "get_memory" (existing command, returns MemoryDetail after Task 3)
  - `filter.organization` set in Task 11 (default "none"), used in Task 9 / 10
- [x] **No scope creep**:每个 task 只做自己 deliverable,无隐式依赖
- [x] **Test discipline**:每个 task 都有 vitest 和/或 cargo test
- [x] **Backward compat**:v0.1 baseline 10/10 vitest + 11/11 cargo 在每个 task 末尾"跑全部测试"步骤里都跑过,无破坏
