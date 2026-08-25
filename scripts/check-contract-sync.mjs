#!/usr/bin/env node
// 对比 packages/contracts/src/schema.ts (MemorySchema) 与 src/domain.ts (MemoryEntry) 的字段集。
// 规则:contracts 字段必须是 src/domain.ts 字段的**子集**(即 contracts ⊆ MemoryEntry)。
//
// 为什么是 "contracts ⊆ domain" 而不是反过来?
//   Task 2 brief 注 1 明确说:"只校验 contracts 字段是 src/domain.ts 的子集"。
//   Task 2 report 重申了这一点。`src/domain.ts:MemoryEntry` 是真实存储的
//   "超集"持久化形态;contracts 故意只暴露 admin UI 关心的字段。
//   所以:
//     - extra(contracts 有但 domain 没有) = 漂移 → exit 1
//     - missing(domain 有但 contracts 没有) = 允许(admin 视图不展示这些) → 仅打印 info
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");

const domainTs = readFileSync(resolve(ROOT, "src/domain.ts"), "utf8");
const contractsSchema = readFileSync(
  resolve(ROOT, "packages/contracts/src/schema.ts"),
  "utf8"
);

// 简化提取:从 contracts/schema.ts 抓 z.object({...}) 里所有 key。
function extractContractsFields(src) {
  const m = src.match(/MemorySchema\s*=\s*z\.object\(\{([\s\S]*?)\}\);/);
  if (!m) throw new Error("MemorySchema not found in contracts/src/schema.ts");
  const fields = new Set();
  for (const line of m[1].split("\n")) {
    const km = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
    if (km) fields.add(km[1]);
  }
  return fields;
}

// 简化提取:从 src/domain.ts 的 `export type MemoryEntry = { ... }` 块里抓所有 key。
// 注:实际类型名为 MemoryEntry(Task 2 落地后命名从 Memory 改为 MemoryEntry);
// 严格匹配 `MemoryEntry` 而非 `Memory`,以免误匹配 MemoryType/MemoryScope 等复合类型。
function extractDomainFields(src) {
  const m = src.match(/export type MemoryEntry\s*=\s*\{([\s\S]*?)\};/);
  if (!m) throw new Error("MemoryEntry type not found in src/domain.ts");
  const fields = new Set();
  for (const line of m[1].split("\n")) {
    const km = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*[?:]/);
    if (km) fields.add(km[1]);
  }
  return fields;
}

const domainFields = extractDomainFields(domainTs);
const contractsFields = extractContractsFields(contractsSchema);

// contracts ⊆ domain 校验:
//   - extra = contracts 漂出 domain 子集 → ERROR(exit 1)
//   - missing = contracts 不需要包含 domain 全部字段 → 仅打印 info
const extra = [...contractsFields].filter((f) => !domainFields.has(f));
const missing = [...domainFields].filter((f) => !contractsFields.has(f));

if (extra.length > 0) {
  console.error(
    `❌ contracts has fields not in src/domain.ts MemoryEntry (drift): ${extra.join(", ")}`
  );
  console.error(
    "  contracts must be a subset of src/domain.ts. Either remove these fields from packages/contracts/src/schema.ts or add them to src/domain.ts MemoryEntry."
  );
  process.exit(1);
}

if (missing.length > 0) {
  console.log(
    `ℹ️  contracts omits ${missing.length} fields that exist in src/domain.ts MemoryEntry (allowed by spec): ${missing.join(", ")}`
  );
}

console.log(
  `✅ contracts schema is in sync with src/domain.ts MemoryEntry (${contractsFields.size} fields, subset of ${domainFields.size})`
);
