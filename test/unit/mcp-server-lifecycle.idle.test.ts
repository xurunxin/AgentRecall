// test/unit/mcp-server-lifecycle.idle.test.ts
//
// Pins the contract for the `idleTimeoutMs` +
// `isMessageInFlight` options on
// `installServerLifecycle`. These options let the
// caller (Task 3: `src/index.ts`) wire the
// stdio-idle-exit behaviour from the existing
// `src/mcp/idle-timer.ts` (Task 1) into the
// lifecycle module's shutdown path. The lifecycle
// module itself owns the trigger wiring; the
// integration call into `startIdleTimer(...)` is
// staged for Task 3.
//
// Two scenarios:
//
//   1. `idleTimeoutMs: 0` keeps idle residency.
//      Regression for the pre-fix behaviour: a
//      quiet stdin must not trigger shutdown.
//   2. `idleTimeoutMs: 30` + `isMessageInFlight`
//      returning `false` after the deadline
//      triggers `stdio_idle_timeout` and runs the
//      normal shutdown sequence.
//
// Real timers (no `vi.useFakeTimers`) because
// the existing lifecycle's ceiling path uses
// unref'd `setTimeout` instances and the
// faked-timer interactions with the trigger
// guard are non-trivial to get right.

import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installServerLifecycle } from "../../src/mcp/server-lifecycle.js";

/**
 * Minimal `process.stdin` stand-in. Extending
 * `Readable` keeps the type compatible with the
 * `NodeJS.ReadStream` slot the module's `stdin`
 * option expects; we never pull data, so the
 * no-op `_read` is fine.
 */
class MockStdin extends Readable {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  override _read(): void {}
}

/**
 * Stand-in for `process`. Using a mock keeps
 * the test process from intercepting its OWN
 * SIGINT / SIGTERM handlers: a misconfigured
 * install against the real process would make
 * the test worker unkillable.
 */
class MockProcess extends EventEmitter {}

describe("installServerLifecycle idle option", () => {
  // Track the lifecycle handles so `afterEach`
  // can detach every installed listener even if
  // the test short-circuits via
  // `expect().toHaveBeenCalled()`.
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
    // 60 ms is comfortably past the 30 ms
    // deadline used by the negative case in
    // `idle-timer.ts`. If `idleTimeoutMs: 0`
    // accidentally enabled a real timer, the
    // server would have started closing by now.
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
    // 120 ms is past the 30 ms deadline; the
    // idle trigger should have fired by now and
    // the shutdown sequence should be complete.
    await new Promise((r) => setTimeout(r, 120));
    expect(onShutdownStart).toHaveBeenCalledWith("stdio_idle_timeout");
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(0);
  });
});
