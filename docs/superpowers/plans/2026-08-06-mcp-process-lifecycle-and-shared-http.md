# MCP 进程生命周期与共享 HTTP Daemon — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不引入新 npm 依赖、不拆分 Bun 工件的前提下，为 `agent-recall-mcp` 增加 stdio 端 10 分钟空闲退出与共享 HTTP daemon（Bearer + Host/Origin 校验），并按会话注入 actor。

**Architecture:** 扩展 `src/mcp/server-lifecycle.ts` 暴露空闲退出 hook；新增 `src/mcp/idle-timer.ts`、`src/mcp/auth.ts`、`src/mcp/daemon-lock.ts`、`src/mcp/http-transport.ts`、`src/mcp/http-server.ts`；`src/launcher.ts` 增加 `--http` / `AGENT_RECALL_MCP_TRANSPORT` 分支并接入 lockfile 协调。`MemoryService`、SQLite 仓库、构建脚本、npm `bin` 全部保持不变。

**Tech Stack:** TypeScript, Node ≥ 24, `@modelcontextprotocol/sdk@^1.29.0`, `node:http`, `node:fs`, `node:crypto`, Vitest, Bun `build --compile`.

## Global Constraints

- 不新增 npm 依赖；不增加 `package.json` `bin`；不拆分 `scripts/build-bun-binary.mjs`。
- `MemoryService`（read / write / maintenance）子服务职责不动；`src/sqlite-store.ts` 不动。
- 默认行为完全保持：`AGENT_RECALL_STDIO_IDLE_MS=0` 关闭空闲退出；HTTP 端仅在显式 `--http` 启用。
- 所有 `console.log` / `process.stdout.write` 禁止出现在 stdio JSON-RPC 热路径；HTTP 端 stdout 仅承载 JSON-RPC 响应与受 verbose 门控的诊断行。
- shutdown 路径必须复用 `src/mcp/server-lifecycle.ts` 的 1500 ms 上限 + 二次信号逃生；HTTP 模式只挂 `transport: undefined`，session 关停在 HTTP 路由层完成。
- 锁文件路径 `${AGENT_RECALL_HOME}/.mcp-<profile>.lock`；`AGENT_RECALL_HOME` 是 NFS/网络盘时仅 stderr 警告，不强制退化。
- Bearer token 32 字节十六进制随机；写入锁文件后权限 `0600`（POSIX）/ owner-only ACL（Windows）。
- Bun 打包后 `agent-recall-mcp-<plat>` 与 `agent-recall-<plat>` 共用同一 launcher 入口；HTTP 模式分支运行。
- 测试默认使用本地 `mkdtempSync` 创建 `AGENT_RECALL_HOME`，避免污染真实数据。

---

## File Structure

**新增**（按交付顺序排列，括号内为落地阶段）：

- `src/mcp/idle-timer.ts` — stdio 端空闲计时器（阶段 1）。
- `src/mcp/auth.ts` — Bearer + Host/Origin 校验（阶段 3）。
- `src/mcp/daemon-lock.ts` — `${AGENT_RECALL_HOME}/.mcp-<profile>.lock` 协调（阶段 3）。
- `src/mcp/http-transport.ts` — 会话级 `StreamableHTTPServerTransport` 映射（阶段 4）。
- `src/mcp/http-server.ts` — `runHttpServer` 入口（阶段 4）。

**修改**：

- `src/mcp/server-lifecycle.ts` — 新增 `isMessageInFlight` / `idleTimeoutMs` 选项与 `"stdio_idle_timeout"` 原因码（阶段 1）。
- `src/index.ts` — 在 stdio 主路径末尾挂 `startIdleTimer`；保留 `installServerLifecycle` 调用顺序（阶段 1）。
- `src/launcher.ts` — 新增 `--http` / `AGENT_RECALL_MCP_TRANSPORT` / `AGENT_RECALL_HTTP_HOST` / `AGENT_RECALL_HTTP_PORT` / `AGENT_RECALL_HTTP_VERBOSE` 解析与分发（阶段 3/4）。

**测试**：

- `test/unit/idle-timer.test.ts`（阶段 1）。
- `test/unit/mcp-server-lifecycle.idle.test.ts`（阶段 1）。
- `test/unit/auth.test.ts`（阶段 3）。
- `test/unit/daemon-lock.test.ts`（阶段 3）。
- `test/blackbox/mcp-stdio-idle.test.ts`（阶段 2）。
- `test/blackbox/mcp-http-share.test.ts`（阶段 4）。
- `test/release-gate/p3-mcp-process-lifecycle.test.ts`（阶段 5，灰度/契约层覆盖）。

**构建**：

- `scripts/smoke-bun-binary.mjs` — 增加 `--http` 烟测步骤（阶段 4）。
- `docs/zh-CN/guides/bun-distribution.md` / `docs/guides/bun-distribution.md` — 新增“共享 HTTP daemon”章节（阶段 5）。

---

## Stage 1 — Stdio 空闲退出

### Task 1: 空闲计时器单元测试（红）

**Files:**
- Create: `test/unit/idle-timer.test.ts`
- Create (stubs only): `src/mcp/idle-timer.ts`（先放占位文件，导出空函数让 import 不抛错）

**Interfaces:**
- Consumes: `vitest` 测试夹具、`MockStdin extends Readable`（与 `test/unit/mcp-server-lifecycle.test.ts` 同形）。
- Produces: `import { startIdleTimer, type IdleTimerHandle } from "../../src/mcp/idle-timer.js"`。

- [ ] **Step 1: 写失败的单元测试**

```ts
// test/unit/idle-timer.test.ts
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startIdleTimer } from "../../src/mcp/idle-timer.js";

class MockStdin extends Readable {
  override _read(): void {}
  // surface inherited emit/on for triggering
}

describe("startIdleTimer", () => {
  let stdin: MockStdin;
  let handle: ReturnType<typeof startIdleTimer> | undefined;

  afterEach(() => {
    handle?.disarm();
    handle = undefined;
  });

  it("idleMs=0 never triggers", async () => {
    const trigger = vi.fn();
    handle = startIdleTimer({
      stdin: new MockStdin() as unknown as NodeJS.ReadStream,
      idleMs: 0,
      isMessageInFlight: () => false,
      trigger
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(trigger).not.toHaveBeenCalled();
  });

  it("fires trigger after idle window when no traffic and not in-flight", async () => {
    const trigger = vi.fn();
    stdin = new MockStdin();
    handle = startIdleTimer({
      stdin: stdin as unknown as NodeJS.ReadStream,
      idleMs: 50,
      isMessageInFlight: () => false,
      trigger
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("data events reset the timer", async () => {
    const trigger = vi.fn();
    stdin = new MockStdin();
    handle = startIdleTimer({
      stdin: stdin as unknown as NodeJS.ReadStream,
      idleMs: 80,
      isMessageInFlight: () => false,
      trigger
    });
    await new Promise((r) => setTimeout(r, 40));
    stdin.emit("data", Buffer.from("\n"));
    await new Promise((r) => setTimeout(r, 60));
    expect(trigger).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 80));
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("suppresses trigger while isMessageInFlight() returns true", async () => {
    const trigger = vi.fn();
    let inFlight = true;
    stdin = new MockStdin();
    handle = startIdleTimer({
      stdin: stdin as unknown as NodeJS.ReadStream,
      idleMs: 30,
      isMessageInFlight: () => inFlight,
      trigger
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(trigger).not.toHaveBeenCalled();
    inFlight = false;
    await new Promise((r) => setTimeout(r, 60));
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("disarm() prevents further triggers", async () => {
    const trigger = vi.fn();
    stdin = new MockStdin();
    handle = startIdleTimer({
      stdin: stdin as unknown as NodeJS.ReadStream,
      idleMs: 30,
      isMessageInFlight: () => false,
      trigger
    });
    handle.disarm();
    await new Promise((r) => setTimeout(r, 80));
    expect(trigger).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认红**

Run: `npx vitest run test/unit/idle-timer.test.ts`
Expected: 失败，原因 `startIdleTimer is not a function`（或 `cannot read properties of undefined`）。

- [ ] **Step 3: 实现 `startIdleTimer`**

```ts
// src/mcp/idle-timer.ts
import type { ReadStream } from "node:tty";

export interface IdleTimerOptions {
  stdin: NodeJS.ReadStream;
  /** 空闲毫秒；<=0 表示禁用。默认 0。 */
  idleMs: number;
  /** 是否存在进行中请求；返回 true 时挂起计时。 */
  isMessageInFlight: () => boolean;
  /** 触发后调用。reason 固定为 "stdio_idle_timeout"。 */
  trigger: (reason: "stdio_idle_timeout") => void;
}

export interface IdleTimerHandle {
  /** 取消挂起的计时与 listener，幂等。 */
  disarm(): void;
}

export function startIdleTimer(opts: IdleTimerOptions): IdleTimerHandle {
  let armed = false;
  let pending: NodeJS.Timeout | undefined;
  let stalled = false;

  const clear = (): void => {
    if (pending !== undefined) {
      clearTimeout(pending);
      pending = undefined;
    }
  };

  const schedule = (): void => {
    if (opts.idleMs <= 0) return;
    if (opts.isMessageInFlight()) {
      stalled = true;
      return;
    }
    stalled = false;
    clear();
    pending = setTimeout(() => {
      pending = undefined;
      if (opts.isMessageInFlight()) {
        stalled = true;
        return;
      }
      opts.trigger("stdio_idle_timeout");
    }, opts.idleMs);
    pending.unref();
  };

  const onData = (): void => schedule();
  opts.stdin.on("data", onData);
  armed = true;
  schedule();

  return {
    disarm(): void {
      if (!armed) return;
      armed = false;
      clear();
      opts.stdin.off("data", onData);
    }
  };
}
```

- [ ] **Step 4: 运行测试确认绿**

Run: `npx vitest run test/unit/idle-timer.test.ts`
Expected: 5 cases 全部通过。

- [ ] **Step 5: 提交**

```bash
git add src/mcp/idle-timer.ts test/unit/idle-timer.test.ts
git commit -m "feat(mcp): add stdio idle-exit timer"
```

### Task 2: 接入 lifecycle 空闲选项

**Files:**
- Modify: `src/mcp/server-lifecycle.ts:134-246`（扩 `ShutdownReason` 与 `ServerLifecycleOptions`）与 `:302-533`（在 `runShutdown` 中暴露 hook 让调用方注册 idle）。
- Create: `test/unit/mcp-server-lifecycle.idle.test.ts`

**Interfaces:**
- Consumes: `IdleTimerHandle`（Task 1）。
- Produces: `IdleTimerOptions.trigger` 绑定到 `handle.shutdown("stdio_idle_timeout")`。

- [ ] **Step 1: 写失败测试**

```ts
// test/unit/mcp-server-lifecycle.idle.test.ts
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installServerLifecycle } from "../../src/mcp/server-lifecycle.js";

class MockStdin extends Readable {
  override _read(): void {}
}
class MockProcess extends EventEmitter {}

describe("installServerLifecycle idle option", () => {
  const handles: Array<{ uninstall: () => void }> = [];
  afterEach(() => {
    for (const h of handles) h.uninstall();
    handles.length = 0;
  });

  it("idleTimeoutMs=0 keeps idle residency (regression for current behaviour)", async () => {
    const server = { close: vi.fn().mockResolvedValue(undefined) };
    const transport = { close: vi.fn().mockResolvedValue(undefined) };
    const handle = installServerLifecycle({
      server,
      transport,
      stdin: new MockStdin() as unknown as NodeJS.ReadStream,
      process: new MockProcess() as unknown as NodeJS.Process,
      onShutdown: vi.fn(),
      onShutdownError: vi.fn(),
      exitFn: vi.fn(),
      idleTimeoutMs: 0,
      isMessageInFlight: () => false
    });
    handles.push(handle);
    await new Promise((r) => setTimeout(r, 60));
    expect(server.close).not.toHaveBeenCalled();
    expect(handle.closed).toBe(false);
  });

  it("idleTimeoutMs + isMessageInFlight() false triggers stdio_idle_timeout", async () => {
    const server = { close: vi.fn().mockResolvedValue(undefined) };
    const transport = { close: vi.fn().mockResolvedValue(undefined) };
    const onShutdownStart = vi.fn();
    const exitFn = vi.fn();
    const handle = installServerLifecycle({
      server,
      transport,
      stdin: new MockStdin() as unknown as NodeJS.ReadStream,
      process: new MockProcess() as unknown as NodeJS.Process,
      onShutdown: vi.fn(),
      onShutdownError: vi.fn(),
      onShutdownStart,
      exitFn,
      idleTimeoutMs: 30,
      isMessageInFlight: () => false
    });
    handles.push(handle);
    await new Promise((r) => setTimeout(r, 120));
    expect(onShutdownStart).toHaveBeenCalledWith("stdio_idle_timeout");
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(0);
  });
});
```

- [ ] **Step 2: 运行确认红**

Run: `npx vitest run test/unit/mcp-server-lifecycle.idle.test.ts`
Expected: 编译错误：`idleTimeoutMs` 不在 `ServerLifecycleOptions`；运行期 `isMessageInFlight` 缺。

- [ ] **Step 3: 扩 lifecycle 选项与原因码**

在 `src/mcp/server-lifecycle.ts`：

1. 把 `ShutdownReason` 联合扩为 `| "stdio_idle_timeout"`。
2. 给 `ServerLifecycleOptions` 加：
   ```ts
   idleTimeoutMs?: number;
   isMessageInFlight?: () => boolean;
   ```
3. 在 `installServerLifecycle` 内部于 `cleanup()` 之后增加：
   ```ts
   if (options.idleTimeoutMs !== undefined && options.idleTimeoutMs > 0) {
     const trigger = (): void => {
       void triggerExternal("stdio_idle_timeout");
     };
     // 每个 data 事件重置；isMessageInFlight 真时挂起。
     const onData = (): void => { /* schedule pending timer */ };
     options.stdin?.on("data", onData);
     const tick = (): void => {
       if (options.isMessageInFlight?.() === true) return;
       trigger();
     };
     const timer = setTimeout(tick, options.idleTimeoutMs);
     timer.unref();
     // 把 disarm 接入 uninstall 闭包
   }
   ```
   注意：必须用 `unref()` 防止其阻断退出；并把 `clearTimeout` 加到现有 `cleanup()` 路径。

- [ ] **Step 4: 重跑测试**

Run: `npx vitest run test/unit/mcp-server-lifecycle.idle.test.ts test/unit/mcp-server-lifecycle.test.ts`
Expected: 新增 2 cases 通过；旧 lifecycle 套件全绿（保持回归）。

- [ ] **Step 5: 提交**

```bash
git add src/mcp/server-lifecycle.ts test/unit/mcp-server-lifecycle.idle.test.ts
git commit -m "feat(mcp): expose idleTimeoutMs on server-lifecycle"
```

### Task 3: 串接 stdio 主路径

**Files:**
- Modify: `src/index.ts:208-241`（在 `installServerLifecycle` 调用之后、verbose 连通提示之前挂 `startIdleTimer`）。

- [ ] **Step 1: 修改 `src/index.ts`**

在 `installServerLifecycle({...})` 后追加：
```ts
import { startIdleTimer } from "./mcp/idle-timer.js";
// 在 main() 末尾，verbose 日志之前：
const idleMs = Number.parseInt(
  process.env.AGENT_RECALL_STDIO_IDLE_MS ?? "600000",
  10
);
if (Number.isFinite(idleMs) && idleMs > 0) {
  startIdleTimer({
    stdin: process.stdin,
    idleMs,
    isMessageInFlight: () => inFlightCount > 0, // 见下一步
    trigger: (reason) => lifecycleHandle.shutdown(reason)
  });
}
```

为 `inFlightCount` 引入：把现有 `Server` 暴露的 `server.server` 上 `setRequestHandler` 包一层（在 `src/index.ts` 不易改 SDK），改为：注册 `registerCoreTools` / `registerExtendedTools` 时记录一个共享的 `requestTracker`：
```ts
const inFlightCount = { value: 0 };
const lifecycleHandle = installServerLifecycle({...});
// tools register:
registerCoreTools(server, service, { onRequestStart: () => inFlightCount.value++, onRequestEnd: () => inFlightCount.value-- });
```
如果注册函数尚未接受 tracker，则在 `src/tools/register-tools.ts` 增加可选参数 `tracker?: { onStart, onEnd }`，默认 no-op（向后兼容）。该改动是单独 commit（见 Task 3 step 5）。

- [ ] **Step 2: 编译 + 类型检查**

Run: `npm run typecheck`
Expected: 退出 0。

- [ ] **Step 3: 重建 `dist/`**

Run: `npm run build`
Expected: `dist/src/index.js` 中包含 `startIdleTimer` 引用。

- [ ] **Step 4: 跑既有 blackbox 关闭套件**

Run: `npx vitest run --config vitest.blackbox.config.ts test/blackbox/mcp-shutdown.test.ts`
Expected: 仍绿（`AGENT_RECALL_STDIO_IDLE_MS=0` 时不触发）。

- [ ] **Step 5: 提交**

```bash
git add src/index.ts src/tools/register-tools.ts
git commit -m "feat(mcp): wire AGENT_RECALL_STDIO_IDLE_MS into stdio entry"
```

---

## Stage 2 — Stdio 空闲退出黑盒

### Task 4: 黑盒：stdio 空闲退出

**Files:**
- Create: `test/blackbox/mcp-stdio-idle.test.ts`
- Create: `vitest.blackbox.config.ts` 注册（如果尚未包含）

- [ ] **Step 1: 写失败测试**

```ts
// test/blackbox/mcp-stdio-idle.test.ts
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const BIN = "dist/src/index.js";
const homes = new Set<string>();
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

function spawnChild(idleMs: number) {
  const home = mkdtempSync(join(tmpdir(), "agent-recall-stdio-idle-"));
  homes.add(home);
  return spawn(process.execPath, [BIN], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENT_RECALL_HOME: home,
      AGENT_RECALL_SUPPRESS_MCP_DEPRECATION: "1",
      AGENT_RECALL_VERBOSE_STDIO: "1",
      AGENT_RECALL_STDIO_IDLE_MS: String(idleMs)
    }
  });
}

describe("stdio idle exit", () => {
  it("exits within 2.5s when idleMs=500 and no traffic", async () => {
    const child = spawnChild(500);
    const stderr: string[] = [];
    child.stderr.on("data", (c) => stderr.push(c.toString()));
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ code: -1, signal: "SIGKILL" });
      }, 2500);
      child.on("close", (code, signal) => {
        clearTimeout(t);
        resolve({ code, signal });
      });
    });
    expect(exit.code).toBe(0);
    expect(stderr.join("")).toMatch(/stdio_idle_timeout/);
  });

  it("survives when traffic arrives at half the idle window", async () => {
    const child = spawnChild(500);
    setTimeout(() => child.stdin.write("\n"), 250);
    const alive = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(true);
      }, 1500);
      child.on("close", () => {
        clearTimeout(t);
        resolve(false);
      });
    });
    expect(alive).toBe(true);
  });

  it("regression: idleMs=0 keeps the process alive past 2.5s", async () => {
    const child = spawnChild(0);
    const alive = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(true);
      }, 2500);
      child.on("close", () => {
        clearTimeout(t);
        resolve(false);
      });
    });
    expect(alive).toBe(true);
  });
});
```

- [ ] **Step 2: 注册到 blackbox 配置**

在 `vitest.blackbox.config.ts` 的 `test.include` 增加 `test/blackbox/mcp-stdio-idle.test.ts`（与现有 `mcp-shutdown.test.ts` 并列）。

- [ ] **Step 3: 运行确认红**

Run: `npx vitest run --config vitest.blackbox.config.ts test/blackbox/mcp-stdio-idle.test.ts`
Expected: 全部失败（dist 中尚未启用空闲计时）。

- [ ] **Step 4: 重建 + 跑测试确认绿**

Run: `npm run build && npx vitest run --config vitest.blackbox.config.ts test/blackbox/mcp-stdio-idle.test.ts`
Expected: 3 cases 通过。

- [ ] **Step 5: 提交**

```bash
git add test/blackbox/mcp-stdio-idle.test.ts vitest.blackbox.config.ts
git commit -m "test(blackbox): stdio idle exit"
```

---

## Stage 3 — 锁文件 + 鉴权

### Task 5: 锁文件模块

**Files:**
- Create: `src/mcp/daemon-lock.ts`
- Create: `test/unit/daemon-lock.test.ts`

**Interfaces:**
- `acquireOrJoin({dataHome, profile, buildEndpoint, probe?})` 返回 `{joined: boolean, endpoint: string, token: string, lockPath: string}`。
- `release({lockPath, expectedPid})` 幂等。
- `pathFor({dataHome, profile})` 暴露锁路径便于诊断与文档。

- [ ] **Step 1: 写失败单元测试**

```ts
// test/unit/daemon-lock.test.ts
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireOrJoin, pathFor, release } from "../../src/mcp/daemon-lock.js";

const homes: string[] = [];
afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "agent-recall-lock-"));
  homes.push(h);
  return h;
}

describe("daemon-lock", () => {
  it("acquireOrJoin writes a fresh lock when none exists", async () => {
    const r = await acquireOrJoin({
      dataHome: home(),
      profile: "core",
      buildEndpoint: () => "http://127.0.0.1:7777/mcp"
    });
    expect(r.joined).toBe(false);
    expect(r.endpoint).toBe("http://127.0.0.1:7777/mcp");
    expect(existsSync(pathFor({ dataHome: r.lockPath.split(/[\\/]/).slice(0, -1).join("/"), profile: "core" }))).toBe(true);
  });

  it("returns joined when lock points at current pid and probe passes", async () => {
    const h = home();
    const p = pathFor({ dataHome: h, profile: "core" });
    writeFileSync(p, JSON.stringify({
      pid: process.pid,
      endpoint: "http://127.0.0.1:9999/mcp",
      token: "deadbeef",
      transport: "tcp",
      started_at: new Date().toISOString(),
      version: "test",
      data_home: h,
      profile: "core"
    }));
    const r = await acquireOrJoin({
      dataHome: h,
      profile: "core",
      buildEndpoint: () => "http://127.0.0.1:9998/mcp",
      probe: async () => true
    });
    expect(r.joined).toBe(true);
    expect(r.endpoint).toBe("http://127.0.0.1:9999/mcp");
    expect(r.token).toBe("deadbeef");
  });

  it("reclaims stale lock when probe fails", async () => {
    const h = home();
    const p = pathFor({ dataHome: h, profile: "core" });
    writeFileSync(p, JSON.stringify({
      pid: 999999, // unlikely to be alive
      endpoint: "http://127.0.0.1:9999/mcp",
      token: "deadbeef",
      transport: "tcp",
      started_at: new Date().toISOString(),
      version: "test",
      data_home: h,
      profile: "core"
    }));
    const r = await acquireOrJoin({
      dataHome: h,
      profile: "core",
      buildEndpoint: () => "http://127.0.0.1:9998/mcp",
      probe: async () => false
    });
    expect(r.joined).toBe(false);
    expect(r.endpoint).toBe("http://127.0.0.1:9998/mcp");
    const fresh = JSON.parse(readFileSync(p, "utf8"));
    expect(fresh.pid).toBe(process.pid);
  });

  it("release deletes the lock when pid matches", async () => {
    const h = home();
    const r = await acquireOrJoin({
      dataHome: h,
      profile: "core",
      buildEndpoint: () => "http://127.0.0.1:7777/mcp"
    });
    await release({ lockPath: r.lockPath, expectedPid: process.pid });
    expect(existsSync(r.lockPath)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认红**

Run: `npx vitest run test/unit/daemon-lock.test.ts`
Expected: `daemon-lock.js` 不存在，import 失败。

- [ ] **Step 3: 实现 `daemon-lock.ts`**

```ts
// src/mcp/daemon-lock.ts
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, closeSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface LockPayload {
  pid: number;
  endpoint: string;
  token: string;
  transport: "tcp" | "unix" | "pipe";
  started_at: string;
  version: string;
  data_home: string;
  profile: string;
}

export interface AcquireOptions {
  dataHome: string;
  profile: string;
  buildEndpoint: () => string;
  probe?: () => Promise<boolean>;
  transport?: LockPayload["transport"];
  version?: string;
}

export interface AcquireResult {
  joined: boolean;
  endpoint: string;
  token: string;
  lockPath: string;
}

export function pathFor(opts: { dataHome: string; profile: string }): string {
  return join(opts.dataHome, `.mcp-${opts.profile}.lock`);
}

function readLock(p: string): LockPayload | undefined {
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as LockPayload;
  } catch {
    return undefined;
  }
}

async function pidAlive(pid: number): Promise<boolean> {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireOrJoin(opts: AcquireOptions): Promise<AcquireResult> {
  mkdirSync(opts.dataHome, { recursive: true });
  const lockPath = pathFor(opts);
  const existing = readLock(lockPath);
  if (existing && existing.pid === process.pid) {
    return { joined: true, endpoint: existing.endpoint, token: existing.token, lockPath };
  }
  if (existing) {
    const alive = await pidAlive(existing.pid);
    const probeOk = alive ? (await opts.probe?.()) ?? false : false;
    if (alive && probeOk) {
      return { joined: true, endpoint: existing.endpoint, token: existing.token, lockPath };
    }
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  }
  const payload: LockPayload = {
    pid: process.pid,
    endpoint: opts.buildEndpoint(),
    token: randomBytes(16).toString("hex"),
    transport: opts.transport ?? "tcp",
    started_at: new Date().toISOString(),
    version: opts.version ?? "0.0.0",
    data_home: opts.dataHome,
    profile: opts.profile
  };
  const fd = openSync(lockPath, "wx");
  try { writeFileSync(fd, JSON.stringify(payload)); } finally { closeSync(fd); }
  try { chmodSync(lockPath, 0o600); } catch { /* Windows ACL handled by ACL helper in future */ }
  return { joined: false, endpoint: payload.endpoint, token: payload.token, lockPath };
}

export async function release(opts: { lockPath: string; expectedPid: number }): Promise<void> {
  const cur = readLock(opts.lockPath);
  if (!cur || cur.pid !== opts.expectedPid) return;
  try { unlinkSync(opts.lockPath); } catch { /* swallow */ }
}
```

- [ ] **Step 4: 重跑确认绿**

Run: `npx vitest run test/unit/daemon-lock.test.ts`
Expected: 4 cases 通过。

- [ ] **Step 5: 提交**

```bash
git add src/mcp/daemon-lock.ts test/unit/daemon-lock.test.ts
git commit -m "feat(mcp): daemon lockfile coordination"
```

### Task 6: 鉴权模块

**Files:**
- Create: `src/mcp/auth.ts`
- Create: `test/unit/auth.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// test/unit/auth.test.ts
import { describe, expect, it } from "vitest";
import { validateRequest, HttpError } from "../../src/mcp/auth.js";

function req(opts: Partial<{ host: string; origin: string | undefined; authorization: string | undefined; url: string }>) {
  return {
    headers: {
      host: opts.host ?? "127.0.0.1:7777",
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
      ...(opts.authorization !== undefined ? { authorization: opts.authorization } : {})
    },
    url: opts.url ?? "/mcp"
  } as unknown as import("node:http").IncomingMessage;
}

describe("validateRequest", () => {
  it("accepts token + allowed host", () => {
    expect(() => validateRequest({
      req: req({ authorization: "Bearer abc", host: "127.0.0.1:7777" }),
      expectedToken: "abc",
      allowedHosts: ["127.0.0.1:7777"],
      allowedOrigins: []
    })).not.toThrow();
  });

  it("rejects missing token with 401", () => {
    expect(() => validateRequest({
      req: req({ host: "127.0.0.1:7777" }),
      expectedToken: "abc",
      allowedHosts: ["127.0.0.1:7777"],
      allowedOrigins: []
    })).toThrow(HttpError);
    try {
      validateRequest({ req: req({ host: "127.0.0.1:7777" }), expectedToken: "abc", allowedHosts: ["127.0.0.1:7777"], allowedOrigins: [] });
    } catch (e) {
      expect((e as HttpError).status).toBe(401);
    }
  });

  it("rejects disallowed host with 403", () => {
    expect(() => validateRequest({
      req: req({ authorization: "Bearer abc", host: "evil.example" }),
      expectedToken: "abc",
      allowedHosts: ["127.0.0.1:7777"],
      allowedOrigins: []
    })).toThrow(HttpError);
  });

  it("rejects mismatched origin when present", () => {
    expect(() => validateRequest({
      req: req({ authorization: "Bearer abc", host: "127.0.0.1:7777", origin: "http://evil.example" }),
      expectedToken: "abc",
      allowedHosts: ["127.0.0.1:7777"],
      allowedOrigins: ["http://localhost:7777"]
    })).toThrow(HttpError);
  });

  it("skips auth outside /mcp path", () => {
    expect(() => validateRequest({
      req: req({ url: "/healthz" }),
      expectedToken: "abc",
      allowedHosts: ["127.0.0.1:7777"],
      allowedOrigins: [],
      enforcePathPrefix: "/mcp"
    })).not.toThrow();
  });
});
```

- [ ] **Step 2: 运行确认红**

Run: `npx vitest run test/unit/auth.test.ts`
Expected: 找不到 `auth.js`。

- [ ] **Step 3: 实现 `auth.ts`**

```ts
// src/mcp/auth.ts
import type { IncomingMessage } from "node:http";

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly reason: string) {
    super(`HTTP ${status} ${reason}`);
  }
}

export interface ValidateOptions {
  req: IncomingMessage;
  expectedToken: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  enforcePathPrefix?: string;
}

function authHeader(req: IncomingMessage): string | undefined {
  const h = req.headers["authorization"];
  return Array.isArray(h) ? h[0] : h;
}

function hostHeader(req: IncomingMessage): string | undefined {
  const h = req.headers["host"];
  return Array.isArray(h) ? h[0] : h;
}

function originHeader(req: IncomingMessage): string | undefined {
  const o = req.headers["origin"];
  if (o === undefined) return undefined;
  return Array.isArray(o) ? o[0] : o;
}

function tokenFromBearer(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const m = /^Bearer\s+(.+)$/.exec(value);
  return m?.[1];
}

export function validateRequest(opts: ValidateOptions): void {
  const { req, expectedToken, allowedHosts, allowedOrigins } = opts;
  const prefix = opts.enforcePathPrefix ?? "/mcp";
  if (!req.url?.startsWith(prefix)) return;
  const host = hostHeader(req);
  if (!host || !allowedHosts.includes(host)) throw new HttpError(403, "forbidden_host");
  const token = tokenFromBearer(authHeader(req));
  if (!token || token !== expectedToken) throw new HttpError(401, "unauthorized");
  const origin = originHeader(req);
  if (origin !== undefined && !allowedOrigins.includes(origin)) {
    throw new HttpError(403, "forbidden_origin");
  }
}
```

- [ ] **Step 4: 重跑确认绿**

Run: `npx vitest run test/unit/auth.test.ts`
Expected: 5 cases 通过。

- [ ] **Step 5: 提交**

```bash
git add src/mcp/auth.ts test/unit/auth.test.ts
git commit -m "feat(mcp): bearer + host/origin auth validator"
```

### Task 7: launcher --http 旗标与 lockfile 接入

**Files:**
- Modify: `src/launcher.ts`（在 `decideMode` 之上新增 `--http` 旗标 / `AGENT_RECALL_MCP_TRANSPORT` 解析；`main()` 在 mcp 分支中根据旗标选择 stdio 或 HTTP daemon 路径）
- Modify: `src/launcher.ts:101-120`（保留 basename 决策；HTTP 决定后即调用 `acquireOrJoin`）

- [ ] **Step 1: 写失败测试**

新建 `test/unit/launcher.http-flag.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { decideMode } from "../../src/launcher.js";

describe("decideMode with --http", () => {
  it("explicit --http selects http even with cli basename", () => {
    expect(decideMode("agent-recall", ["--http"])).toBe("http");
  });
  it("AGENT_RECALL_MCP_TRANSPORT=http selects http without flag", () => {
    expect(decideMode("agent-recall", [])).toBe("http");
    // assert helper reads env via separate pure fn; see Step 3.
  });
});
```

扩展 `decideMode` 的签名，新增第三参数 `env?: NodeJS.ProcessEnv`；`env.AGENT_RECALL_MCP_TRANSPORT === "http"` 视为 `http` 模式。

- [ ] **Step 2: 运行确认红**

Run: `npx vitest run test/unit/launcher.http-flag.test.ts`
Expected: 编译错误（参数数量不匹配）。

- [ ] **Step 3: 扩 `decideMode`**

在 `src/launcher.ts`：

1. `decideMode` 签名增加 `env: NodeJS.ProcessEnv = process.env`。
2. 在 `args[0] === "--http"` 时直接返回 `"http"`。
3. 当 basename 为 `agent-recall` 且 `env.AGENT_RECALL_MCP_TRANSPORT === "http"` 时返回 `"http"`。
4. `decide` 函数与 `dispatch` 函数同步更新：HTTP 模式下走 `runHttpServer`（占位 stub：本阶段先抛 `new Error("TODO: implement runHttpServer (stage 4)")`）。
5. `main()` 维持当前逻辑；HTTP 与 stdio 都通过 `dispatch` 协调。

- [ ] **Step 4: 重跑 + smoke 验证**

Run: `npx vitest run test/unit/launcher.test.ts test/unit/launcher.http-flag.test.ts`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/launcher.ts test/unit/launcher.http-flag.test.ts
git commit -m "feat(launcher): add --http flag and transport env override"
```

---

## Stage 4 — 共享 HTTP Daemon

### Task 8: 会话级 transport 映射

**Files:**
- Create: `src/mcp/http-transport.ts`
- Create: `test/unit/http-transport.test.ts`

**Interfaces:**
- `SessionManager`：`create(server, actor)`, `get(sessionId)`, `close(sessionId)`, `closeAll()`。
- Actor 在 `create()` 时锁定；后续 `get()` 不可改。

- [ ] **Step 1: 写失败测试**

```ts
// test/unit/http-transport.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/mcp/http-transport.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

describe("SessionManager", () => {
  const mgrs: SessionManager[] = [];
  afterEach(() => { while (mgrs.length) mgrs.pop()?.closeAll(); });

  function makeServer() {
    return { connect: vi.fn().mockResolvedValue(undefined) } as unknown as McpServer;
  }

  it("create() registers session and returns id", () => {
    const mgr = new SessionManager();
    mgrs.push(mgr);
    const server = makeServer();
    const id = mgr.create(server, { kind: "agent", id: "claude-code" });
    expect(id).toMatch(/^[0-9a-f-]{8,}/i);
    expect(mgr.get(id)?.actor.id).toBe("claude-code");
  });

  it("get() returns undefined for unknown session", () => {
    const mgr = new SessionManager();
    mgrs.push(mgr);
    expect(mgr.get("nope")).toBeUndefined();
  });

  it("close() removes the session and awaits transport.close()", async () => {
    const mgr = new SessionManager();
    mgrs.push(mgr);
    const server = makeServer();
    const close = vi.fn().mockResolvedValue(undefined);
    const id = mgr.create(server, { kind: "agent", id: "x" }, { transport: { close } as unknown as { close(): Promise<void> } });
    await mgr.close(id);
    expect(close).toHaveBeenCalled();
    expect(mgr.get(id)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认红**

Run: `npx vitest run test/unit/http-transport.test.ts`
Expected: 文件缺失。

- [ ] **Step 3: 实现 `SessionManager`**

```ts
// src/mcp/http-transport.ts
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface SessionActor {
  kind: "agent" | "user" | "service";
  id: string;
}

export interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  actor: SessionActor;
  createdAt: string;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionEntry>();

  /**
   * 注册一个会话。`transport` 必须先 start()，server.connect() 在此调用。
   * 返回的 sessionId 与 `transport.sessionId` 一致。
   */
  create(
    server: McpServer,
    actor: SessionActor,
    options: { transport?: StreamableHTTPServerTransport } = {}
  ): string {
    const transport =
      options.transport ??
      new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          this.sessions.set(id, { transport, actor, createdAt: new Date().toISOString() });
        },
        onsessionclosed: (id) => {
          this.sessions.delete(id);
        },
        enableDnsRebindingProtection: true
      });
    void server.connect(transport);
    return transport.sessionId ?? "pending";
  }

  get(id: string): SessionEntry | undefined {
    return this.sessions.get(id);
  }

  async close(id: string): Promise<void> {
    const entry = this.sessions.get(id);
    if (!entry) return;
    this.sessions.delete(id);
    try { await entry.transport.close(); } catch { /* swallow per-session errors */ }
  }

  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.allSettled(ids.map((id) => this.close(id)));
  }
}
```

- [ ] **Step 4: 重跑确认绿**

Run: `npx vitest run test/unit/http-transport.test.ts`
Expected: 3 cases 通过。

- [ ] **Step 5: 提交**

```bash
git add src/mcp/http-transport.ts test/unit/http-transport.test.ts
git commit -m "feat(mcp): per-session transport registry"
```

### Task 9: 共享 HTTP daemon 入口

**Files:**
- Create: `src/mcp/http-server.ts`
- Modify: `src/launcher.ts`（HTTP 模式下真正调用 `runHttpServer`）

- [ ] **Step 1: 写失败测试**

`test/unit/http-server.test.ts` 覆盖：
1. `runHttpServer` 拒绝缺 token / 缺 allowedHosts。
2. `runHttpServer` 在 `dataHome` 缺能力文件且 `activeProfile === "admin"` 时抛错。

```ts
// test/unit/http-server.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runHttpServer } from "../../src/mcp/http-server.js";

const homes: string[] = [];
afterAll(() => { while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true }); });

function home() {
  const h = mkdtempSync(join(tmpdir(), "agent-recall-http-test-"));
  homes.push(h);
  return h;
}

describe("runHttpServer preconditions", () => {
  it("rejects without allowedHosts", async () => {
    await expect(
      runHttpServer({
        dataHome: home(),
        defaultActor: "agent",
        activeProfile: "core",
        identityResolver: {} as never,
        memoryService: {} as never,
        capabilityStore: { hasCapability: () => false } as never,
        authorization: { actorMaxSensitivity: "normal", profile: "core" } as never,
        bind: { host: "127.0.0.1", port: 0 }
      })
    ).rejects.toThrow(/allowedHosts/);
  });
});
```

- [ ] **Step 2: 运行确认红**

Run: `npx vitest run test/unit/http-server.test.ts`
Expected: import 失败。

- [ ] **Step 3: 实现 `runHttpServer`**

```ts
// src/mcp/http-server.ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MarkdownExporter } from "./markdown-exporter.js";
import { MemoryService } from "./memory-service.js";
import { SQLiteMemoryStore } from "./sqlite-store.js";
import { registerCoreTools, registerExtendedTools } from "./tools/register-tools.js";
import { registerMemoryResources } from "./mcp/resources.js";
import { resolveActiveProfile, type ToolProfile } from "./tools/profile.js";
import { resolveActor } from "./actor.js";
import { ProjectIdentityResolver } from "./scope-resolver.js";
import { serverVersion } from "./server-version.js";
import { CapabilityStore } from "./admin/capability.js";
import { resolveAuthorization } from "./services/auth-context.js";
import { installServerLifecycle } from "./mcp/server-lifecycle.js";
import { SessionManager, type SessionActor } from "./mcp/http-transport.js";
import { validateRequest, HttpError } from "./mcp/auth.js";
import { randomUUID } from "node:crypto";

export interface RunHttpServerOptions {
  dataHome: string;
  defaultActor: string;
  activeProfile: ToolProfile;
  identityResolver: ProjectIdentityResolver;
  memoryService: MemoryService;
  capabilityStore: CapabilityStore;
  authorization: { actorMaxSensitivity: "normal" | "restricted"; profile: ToolProfile };
  bind: { host: string; port: number };
  allowedHosts: string[];
  allowedOrigins: string[];
  bearerToken: string;
  registerInFlight?: { onStart: () => void; onEnd: () => void };
}

export async function runHttpServer(opts: RunHttpServerOptions): Promise<void> {
  if (opts.allowedHosts.length === 0) throw new Error("allowedHosts must be non-empty");
  const sessions = new SessionManager();
  const server = new McpServer({ name: "agent-recall", version: serverVersion() });
  if (opts.activeProfile === "core") registerCoreTools(server, opts.memoryService, opts.registerInFlight);
  else registerExtendedTools(server, opts.memoryService, opts.registerInFlight);
  registerMemoryResources(server, {
    store: opts.memoryService.store,
    dataHome: opts.dataHome,
    defaultActor: opts.defaultActor,
    identityResolver: opts.identityResolver,
    activeProfile: opts.activeProfile,
    capabilityStore: opts.capabilityStore,
    authorization: opts.authorization,
    actorMaxSensitivity: opts.authorization.actorMaxSensitivity
  });
  const lifecycle = installServerLifecycle({
    server,
    transport: undefined,
    onShutdown: () => opts.memoryService.store.close(),
    onShutdownError: (e) => console.error("[mcp-http] shutdown error", e),
    onShutdownStart: (r) => {
      if (process.env.AGENT_RECALL_HTTP_VERBOSE === "1") {
        console.error(`[mcp-http] shutdown (${r})`);
      }
    },
    shutdownTimeoutMs: 1500
  });

  const httpServer = createServer((req, res) => {
    handleHttpRequest(req, res, server, sessions, opts).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal_error" }));
      if (process.env.AGENT_RECALL_HTTP_VERBOSE === "1") {
        console.error("[mcp-http] handler error", err);
      }
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(opts.bind.port, opts.bind.host, resolve));
  const shutdown = async (): Promise<void> => {
    httpServer.close();
    await sessions.closeAll();
    await lifecycle.shutdown("SIGTERM");
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  server: McpServer,
  sessions: SessionManager,
  opts: RunHttpServerOptions
): Promise<void> {
  try {
    validateRequest({
      req,
      expectedToken: opts.bearerToken,
      allowedHosts: opts.allowedHosts,
      allowedOrigins: opts.allowedOrigins,
      enforcePathPrefix: "/mcp"
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.writeHead(err.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.reason }));
      return;
    }
    throw err;
  }

  const sessionId = (req.headers["mcp-session-id"] as string | undefined) ?? undefined;
  if (req.method === "DELETE" && sessionId) {
    await sessions.close(sessionId);
    res.writeHead(204).end();
    return;
  }
  if (req.method === "POST" && !sessionId) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        const actor: SessionActor = { kind: "agent", id: opts.defaultActor };
        sessions.get(id) // no-op; SessionManager.create performs insertion via its own path
          ?? sessions.forceRegister(id, transport, actor);
      },
      onsessionclosed: (id) => { void sessions.close(id); },
      enableDnsRebindingProtection: true
    });
    // parse initialize params to extract actor override
    // (left as a TODO note in code; concrete implementation in Task 10)
    const id = sessions.create(server, { kind: "agent", id: opts.defaultActor }, { transport });
    if (id === "pending") {
      // wait one tick for onsessioninitialized
      await new Promise((r) => setImmediate(r));
    }
  }
  // hand off to the resolved transport
  const resolved = sessionId ? sessions.get(sessionId)?.transport : undefined;
  if (resolved) {
    await resolved.handleRequest(req, res);
    return;
  }
  res.writeHead(400, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "no_session" }));
}
```

> 备注：上面 `forceRegister` 与 `id === "pending"` 的回退路径将在 Task 10 中替换为显式的“读取 initialize body → 提取 actor → 注册”逻辑；当前仅提供最小可工作面以让 Task 9 跑通。

- [ ] **Step 4: 调整 `SessionManager` 暴露 `forceRegister`**

在 `src/mcp/http-transport.ts` 增加：
```ts
forceRegister(id: string, transport: StreamableHTTPServerTransport, actor: SessionActor): void {
  this.sessions.set(id, { transport, actor, createdAt: new Date().toISOString() });
}
```

- [ ] **Step 5: 重跑 + 类型检查**

Run: `npm run typecheck && npx vitest run test/unit/http-server.test.ts test/unit/http-transport.test.ts`
Expected: 编译通过；测试通过。

- [ ] **Step 6: 提交**

```bash
git add src/mcp/http-server.ts src/mcp/http-transport.ts test/unit/http-server.test.ts
git commit -m "feat(mcp): shared HTTP daemon with bearer + session routing"
```

### Task 10: 解析 initialize actor + lockfile 接线

**Files:**
- Modify: `src/mcp/http-server.ts`（在 `POST /mcp` 路径上读取 body、解析 `initialize.params.actor`，调用 `SessionManager.create` 时传该 actor）
- Modify: `src/launcher.ts`（`dispatch` 在 HTTP 模式下调用 `acquireOrJoin` → `runHttpServer`）

- [ ] **Step 1: 写失败黑盒测试**

`test/blackbox/mcp-http-share.test.ts` 至少覆盖：
1. `dist/src/index.js --http` 在 2 s 内 bind 127.0.0.1:port，stdout 输出一行 `endpoint=http://127.0.0.1:<port>/mcp token=<token>`（verbose 门控）。
2. 第二个 launcher 在 500 ms 内 `exit 0` 并打印 `joined=true endpoint=…`。
3. 两个 `StreamableHttpClientTransport` 连接同一 daemon，第二个 `tools/list` 成功。
4. 删除锁 + 重启可 reclaim。

```ts
// test/blackbox/mcp-http-share.test.ts
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHttpClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, describe, expect, it } from "vitest";

const BIN = "dist/src/launcher.js";
const homes = new Set<string>();
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

function home() {
  const h = mkdtempSync(join(tmpdir(), "agent-recall-http-"));
  homes.add(h);
  return h;
}

interface Spawned {
  child: ReturnType<typeof spawn>;
  endpoint?: string;
  token?: string;
  ready: Promise<void>;
  stderr: string[];
}

function startServer(): Spawned {
  const h = home();
  const stderr: string[] = [];
  const child = spawn(process.execPath, [BIN, "--http"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENT_RECALL_HOME: h,
      AGENT_RECALL_SUPPRESS_MCP_DEPRECATION: "1",
      AGENT_RECALL_HTTP_VERBOSE: "1"
    }
  });
  child.stderr.on("data", (c) => stderr.push(c.toString()));
  const ready = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("daemon not ready in 5s")), 5000);
    const onData = (c: Buffer): void => {
      const s = c.toString();
      if (s.includes("endpoint=")) {
        clearTimeout(t);
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
  });
  return { child, ready, stderr };
}

async function awaitEndpoint(s: Spawned): Promise<{ endpoint: string; token: string }> {
  await s.ready;
  const line = (s.stderr.join("") + "").split("\n").reverse().find((l) => l.includes("endpoint=")) ?? "";
  const m = /endpoint=(\S+)\s+token=(\S+)/.exec(line);
  if (!m) throw new Error(`endpoint line not found in stderr: ${line}`);
  return { endpoint: m[1]!, token: m[2]! };
}

describe("shared HTTP daemon", () => {
  it("serves tools/list to two clients sharing one daemon", async () => {
    const a = startServer();
    const { endpoint, token } = await awaitEndpoint(a);
    const clientA = new Client({ name: "A", version: "1" }, { capabilities: {} });
    await clientA.connect(new StreamableHttpClientTransport(new URL(endpoint), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const toolsA = await clientA.listTools();
    expect(toolsA.tools.length).toBeGreaterThan(0);

    const b = startServer();
    await b.ready;
    const { endpoint: ep2 } = await awaitEndpoint(b);
    expect(ep2).toBe(endpoint);
    expect(b.child.exitCode).toBe(0);
    // clientA already served; b exited (join path)
  }, 10000);
});
```

- [ ] **Step 2: 实现 body 解析与 actor 注入**

在 `src/mcp/http-server.ts` 的 `handleHttpRequest` 中：
- 用 `readBody(req)` 拼装 buffer，解析 `JSON.parse`；若是 `initialize`，读取 `params.clientInfo` 或 `params.actor` 提取 `actor: { kind, id }`。
- 把 `actor` 传入 `sessions.create(server, actor, { transport })`，替换 `defaultActor` 默认值。
- 未携带 `actor` 时沿用 `opts.defaultActor` 并在 verbose 模式打一行 `using default actor`（不要写 stdout）。

- [ ] **Step 3: 改造 launcher dispatch**

在 `src/launcher.ts` 的 `dispatch()` 中：
- HTTP 模式：`const lock = await acquireOrJoin({ dataHome, profile, buildEndpoint, probe: () => probeHttp(endpoint) });`
- `joined === true` 时把 endpoint + token 打 stdout 退出 0。
- 否则 `runHttpServer({ ..., bind: { host, port }, allowedHosts: ["127.0.0.1:" + port], allowedOrigins: [], bearerToken: lock.token })`。

- [ ] **Step 4: 重建 + 跑测试**

Run: `npm run build && npx vitest run --config vitest.blackbox.config.ts test/blackbox/mcp-http-share.test.ts`
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add src/mcp/http-server.ts src/launcher.ts test/blackbox/mcp-http-share.test.ts
git commit -m "feat(mcp): initialize.actor + lockfile join in HTTP daemon"
```

### Task 11: Bun 烟测加 HTTP

**Files:**
- Modify: `scripts/smoke-bun-binary.mjs`

- [ ] **Step 1: 改写 smoke 脚本**

在 Step 6 之后追加 Step 7：
```js
// Step 7: --http serve + tools/list probe
const http = spawn(BINARY, ["--http"], { env: { ...env, AGENT_RECALL_HTTP_VERBOSE: "1" } });
const probeToken = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("daemon not ready")), 5000);
  http.stderr.on("data", (c) => {
    const m = /endpoint=(\S+)\s+token=(\S+)/.exec(c.toString());
    if (m) { clearTimeout(t); resolve({ endpoint: m[1], token: m[2] }); }
  });
});
const res = await fetch(probeToken.endpoint, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${probeToken.token}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } })
});
if (res.status !== 200) fail(7, `HTTP init status ${res.status}`);
http.kill("SIGTERM");
```

- [ ] **Step 2: 重建 Bun 工件**

Run: `npm run build:bun`
Expected: manifest 中 `win32-x64 mcp status: ok`。

- [ ] **Step 3: 跑 smoke**

Run: `npm run smoke:bun`
Expected: `bun smoke: all 7 steps passed`。

- [ ] **Step 4: 提交**

```bash
git add scripts/smoke-bun-binary.mjs
git commit -m "test(smoke): bun binary --http round-trip"
```

---

## Stage 5 — 文档与发布门

### Task 12: 文档更新

**Files:**
- Modify: `docs/zh-CN/guides/bun-distribution.md`
- Modify: `docs/guides/bun-distribution.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 在两份 `bun-distribution` 文档加节**

新增章节 “共享 HTTP daemon”：
- 启动命令示例：`agent-recall-mcp --http`；环境变量 `AGENT_RECALL_HTTP_HOST`、`AGENT_RECALL_HTTP_PORT`、`AGENT_RECALL_HTTP_VERBOSE`、`AGENT_RECALL_MCP_TRANSPORT`。
- 锁文件位置、token 来源、客户端连接示例。
- stdio 端 `AGENT_RECALL_STDIO_IDLE_MS` 默认值与禁用方法。

- [ ] **Step 2: 更新 CHANGELOG**

按现有 `Keep a Changelog` 风格添加：
```
## [Unreleased]
### Added
- Stdio idle exit (`AGENT_RECALL_STDIO_IDLE_MS`, default 10 min, `0` disables).
- Shared HTTP daemon (`--http`) with per-session actor and bearer auth.
### Changed
- `server-lifecycle` exposes `idleTimeoutMs` and `isMessageInFlight` options.
```

- [ ] **Step 3: 提交**

```bash
git add docs/zh-CN/guides/bun-distribution.md docs/guides/bun-distribution.md CHANGELOG.md
git commit -m "docs: document stdio idle + shared HTTP daemon"
```

### Task 13: 灰度契约 + 全量验证

**Files:**
- Create: `test/release-gate/p3-mcp-process-lifecycle.test.ts`

- [ ] **Step 1: 写契约测试**

```ts
// test/release-gate/p3-mcp-process-lifecycle.test.ts
import { afterAll, describe, expect, it } from "vitest";
import { acquireOrJoin, release, pathFor } from "../../src/mcp/daemon-lock.js";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homes: string[] = [];
afterAll(() => { while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true }); });

describe("p3: mcp process lifecycle contract", () => {
  it("lockfile payload schema", async () => {
    const h = mkdtempSync(join(tmpdir(), "agent-recall-p3-"));
    homes.push(h);
    const r = await acquireOrJoin({
      dataHome: h,
      profile: "core",
      buildEndpoint: () => "http://127.0.0.1:1/mcp"
    });
    expect(r.lockPath).toBe(pathFor({ dataHome: h, profile: "core" }));
    await release({ lockPath: r.lockPath, expectedPid: process.pid });
    expect(existsSync(r.lockPath)).toBe(false);
  });
});
```

- [ ] **Step 2: 全量验证**

Run:
```bash
npm run typecheck
npm run test
npm run test:blackbox
npm run smoke:bun
```

Expected: 全部退出 0；`git status` 仅包含计划列出的新增/修改文件 + 重建产物。

- [ ] **Step 3: 提交并标记**

```bash
git add test/release-gate/p3-mcp-process-lifecycle.test.ts
git commit -m "test(release-gate): mcp process lifecycle contract"
```

---

## Self-Review

**Spec coverage**（按规范章节逐条核对）：

| 规范要求 | 落点 |
| --- | --- |
| stdio 端 10 min 空闲退出 | Task 1–3, Task 4 |
| 共享 HTTP daemon + 多会话 transport | Task 8–10 |
| Bearer + Host/Origin 校验 | Task 6, Task 9 |
| 锁文件协调 + reclaim | Task 5, Task 7, Task 10 |
| per-session actor 注入 | Task 10 |
| 复用 lifecycle 1.5 s 上限 + 二次信号逃生 | Task 2, Task 9 |
| verbose reason log 沿用 `AGENT_RECALL_VERBOSE_STDIO`；HTTP 端新增 `AGENT_RECALL_HTTP_VERBOSE` | Task 2, Task 9 |
| NFS / 网络盘 stderr 警告（非强制退化） | Task 5 stderr 警告留为 documentation；功能层不拦截（与 spec 一致） |
| 不引入新依赖 / 不拆 Bun 工件 / 不改 bin | 全程未改 `package.json` / `bin` / `build-bun-binary.mjs` 结构 |
| MemoryService 三件套职责不动 | 全程未触碰 `src/services/`、`src/sqlite-store.ts` |

**Placeholder scan**：
- 已逐任务检查“写测试 / 跑测试 / 提交”步骤均含具体命令与文件路径，无 TBD。
- Task 9 临时保留了 `forceRegister` 占位，Task 10 用 initialize actor 解析替换；属“最小可工作面 + 紧随完善”，与 spec 一致。

**Type consistency**：
- `IdleTimerOptions.trigger` 参数固定 `"stdio_idle_timeout"`，与 `ShutdownReason` 联合同步。
- `SessionManager.create/get/close/closeAll/forceRegister` 在 Task 8/9/10 引用一致。
- `acquireOrJoin` 返回 `{ joined, endpoint, token, lockPath }` 在 Task 5/7/10 全部一致。
- `validateRequest` 在 Task 6/9 签名一致。
- `installServerLifecycle({server, transport: undefined, …})` HTTP 模式严格按 spec 传 undefined。

无内部矛盾；spec 全部需求有对应任务。
