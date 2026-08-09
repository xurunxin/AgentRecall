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
