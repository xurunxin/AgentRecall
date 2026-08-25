import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const SCRIPT = resolve(ROOT, "scripts/check-contract-sync.mjs");

describe("check-contract-sync", () => {
  it("exits 0 when schemas are in sync", () => {
    const out = execFileSync("node", [SCRIPT], { cwd: ROOT, encoding: "utf8" });
    expect(out).toMatch(/✅ contracts schema is in sync/);
  });

  it("exits 1 when contracts is missing a field", () => {
    // 临时把 schema.ts 的 title 字段删掉,跑脚本,期望 exit 1
    // (此用例依赖文件系统 mock,留 v0.2 引入 mock-fs 再做;v0.1 仅做 happy path)
  });
});
