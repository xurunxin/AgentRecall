// test/unit/mcp-server-lifecycle.test.ts
//
// Bug fix: the MCP stdio server currently has NO
// graceful-shutdown wiring. The startup path is
//
//   await server.connect(transport);
//
// and the function returns. The Node process then
// stays alive forever, parked on the open stdin
// stream. When the parent process closes the stdio
// pipe (or kills the host), the child does not
// notice: the SDK's `StdioServerTransport` only
// listens for `data` / `error` on stdin, NOT for
// `end` / `close`. The server keeps running idle.
// On SIGTERM / SIGINT the default Node handler
// kills the child without closing the SQLite handle
// first.
//
// Desired behaviour:
//
//   1. Idle residency is PRESERVED. The server only
//      exits when the stdio pipe is genuinely gone,
//      never on mere inactivity.
//   2. When the client closes its end of the pipe,
//      the server shuts down cleanly: transport
//      closes, server closes, the SQLite store
//      closes (via the onShutdown hook), the
//      process drains and exits.
//   3. SIGINT and SIGTERM trigger the same clean
//      path. Node's default SIGTERM / SIGINT
//      termination is overridden.
//   4. Stdout stays protocol-clean. The lifecycle
//      module never writes to stdout; diagnostics
//      route through `stderr` only if the caller
//      explicitly opts in via `onShutdownError`.
//
// This file pins the contract end-to-end against a
// fresh install of `installServerLifecycle(...)`.
// The current state is RED: the module does not
// exist yet, so importing it throws a module-
// resolution error and every test fails. Once the
// module is implemented under `src/mcp/`, the
// suite flips to GREEN.

import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installServerLifecycle } from "../../src/mcp/server-lifecycle.js";

// ---------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------

/**
 * Minimal `process.stdin` stand-in. We only exercise
 * the `EventEmitter` surface (`on` / `off` / `emit`),
 * not the read path. Extending `Readable` keeps the
 * type compatible with the `NodeJS.ReadStream` slot
 * the module's `stdin` option expects.
 */
class MockStdin extends Readable {
  constructor() {
    super();
  }
  // `Readable._read` is required by the abstract base
  // class; tests never pull data, so a no-op is fine.
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  override _read(): void {}
}

/**
 * Stand-in for `process` (which IS an EventEmitter
 * under the hood). Using a mock keeps the test
 * process from intercepting its OWN SIGINT / SIGTERM
 * handlers: a misconfigured install against the real
 * process would make the test worker unkillable.
 */
class MockProcess extends EventEmitter {
  // No overrides; `addListener` / `removeListener` /
  // `emit` come from EventEmitter and that is exactly
  // what `installServerLifecycle` calls.
}

interface FakeServer {
  close: ReturnType<typeof vi.fn>;
}

interface FakeTransport {
  close: ReturnType<typeof vi.fn>;
}

function makeServer(): FakeServer {
  return {
    close: vi.fn().mockResolvedValue(undefined)
  };
}

function makeTransport(): FakeTransport {
  return {
    close: vi.fn().mockResolvedValue(undefined)
  };
}

// ---------------------------------------------------------------
// Suite
// ---------------------------------------------------------------

describe("installServerLifecycle (MCP stdio server graceful shutdown)", () => {
  let stdin: MockStdin;
  let proc: MockProcess;
  let server: FakeServer;
  let transport: FakeTransport;
  let onShutdown: ReturnType<typeof vi.fn>;
  let onShutdownError: ReturnType<typeof vi.fn>;
  let onShutdownStart: ReturnType<typeof vi.fn>;
  let exitFn: ReturnType<typeof vi.fn>;
  // Track the lifecycle handles so `afterEach` can
  // detach every installed listener even if the test
  // short-circuits via `expect().toHaveBeenCalled()`.
  const handles: Array<{ uninstall: () => void }> = [];

  beforeEach(() => {
    stdin = new MockStdin();
    proc = new MockProcess();
    server = makeServer();
    transport = makeTransport();
    onShutdown = vi.fn().mockResolvedValue(undefined);
    onShutdownError = vi.fn();
    onShutdownStart = vi.fn();
    exitFn = vi.fn();
  });

  afterEach(() => {
    // Detach every listener installed during the test
    // so a leftover handle can't fire into the next
    // test's mocked process / stdin.
    for (const handle of handles) {
      handle.uninstall();
    }
    handles.length = 0;
  });

  function install(opts: {
    server?: FakeServer;
    transport?: FakeTransport;
    stdin?: MockStdin;
    proc?: MockProcess;
    onShutdown?: ReturnType<typeof vi.fn>;
    onShutdownError?: ReturnType<typeof vi.fn>;
    onShutdownStart?: ReturnType<typeof vi.fn>;
    exitFn?: ReturnType<typeof vi.fn>;
    shutdownTimeoutMs?: number;
  } = {}) {
    const handle = installServerLifecycle({
      server: opts.server ?? server,
      transport: opts.transport ?? transport,
      stdin: (opts.stdin ?? stdin) as unknown as NodeJS.ReadStream,
      // Cast: `MockProcess` only implements the EventEmitter
      // surface; `installServerLifecycle` only ever calls
      // `addListener` / `removeListener` / `emit`, so the
      // structural contract is satisfied.
      process: (opts.proc ?? proc) as unknown as NodeJS.Process,
      onShutdown: opts.onShutdown ?? onShutdown,
      onShutdownError: opts.onShutdownError ?? onShutdownError,
      onShutdownStart: opts.onShutdownStart ?? onShutdownStart,
      exitFn: opts.exitFn ?? exitFn,
      shutdownTimeoutMs: opts.shutdownTimeoutMs
    });
    handles.push(handle);
    return handle;
  }

  /** Wait for the in-flight shutdown promise (if any)
   *  to settle, plus one extra microtask so the
   *  `finally` block that calls `cleanup()` lands. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  it("shuts down when stdin emits 'end' (the parent closed its write end)", async () => {
    const handle = install();
    stdin.emit("end");
    await settle();
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(onShutdownError).not.toHaveBeenCalled();
    expect(handle.closed).toBe(true);
    // Clean exit: process.exit(0) is called so the
    // Node process actually terminates instead of
    // staying parked on the stdio / SQLite handles.
    expect(exitFn).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it("shuts down when stdin emits 'close' (the kernel reported the pipe gone)", async () => {
    const handle = install();
    stdin.emit("close");
    await settle();
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(handle.closed).toBe(true);
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it("shuts down on SIGTERM", async () => {
    const handle = install();
    proc.emit("SIGTERM");
    await settle();
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(handle.closed).toBe(true);
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it("shuts down on SIGINT", async () => {
    const handle = install();
    proc.emit("SIGINT");
    await settle();
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(handle.closed).toBe(true);
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it("multiple triggers run the shutdown sequence only once (idempotent)", async () => {
    const handle = install();
    stdin.emit("end");
    stdin.emit("close");
    proc.emit("SIGTERM");
    proc.emit("SIGINT");
    await settle();
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(handle.closed).toBe(true);
    // Exit fires exactly once even with four
    // concurrent triggers. The idempotency guard
    // collapses them into a single sequence.
    expect(exitFn).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it("transport.close runs BEFORE server.close (no late frames onto a dead pipe)", async () => {
    const order: string[] = [];
    const orderedTransport = {
      close: vi.fn().mockImplementation(async () => {
        order.push("transport");
      })
    };
    const orderedServer = {
      close: vi.fn().mockImplementation(async () => {
        order.push("server");
      })
    };
    install({ transport: orderedTransport, server: orderedServer });
    proc.emit("SIGTERM");
    await settle();
    expect(order).toEqual(["transport", "server"]);
  });

  it("onShutdown runs AFTER server.close (final audit events land before DB close)", async () => {
    const order: string[] = [];
    const orderedTransport = {
      close: vi.fn().mockImplementation(async () => {
        order.push("transport");
      })
    };
    const orderedServer = {
      close: vi.fn().mockImplementation(async () => {
        order.push("server");
      })
    };
    const orderedShutdown = vi.fn().mockImplementation(async () => {
      order.push("onShutdown");
    });
    install({
      transport: orderedTransport,
      server: orderedServer,
      onShutdown: orderedShutdown
    });
    proc.emit("SIGTERM");
    await settle();
    expect(order).toEqual(["transport", "server", "onShutdown"]);
  });

  it("errors during shutdown are caught, routed to onShutdownError, and exit(1) is called", async () => {
    const failingServer: FakeServer = {
      close: vi.fn().mockRejectedValue(new Error("store close failed"))
    };
    const handle = install({ server: failingServer });
    proc.emit("SIGTERM");
    await settle();
    expect(onShutdownError).toHaveBeenCalledTimes(1);
    const err = onShutdownError.mock.calls[0]?.[0] as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("store close failed");
    // The handle still flips to `closed` so the
    // event loop drains instead of re-entering the
    // shutdown path on every subsequent signal.
    expect(handle.closed).toBe(true);
    // Failure path: exit(1) so the host can
    // distinguish a graceful exit from a crash.
    expect(exitFn).toHaveBeenCalledWith(1);
  });

  it("errors during transport.close are also caught and routed to onShutdownError", async () => {
    const failingTransport: FakeTransport = {
      close: vi.fn().mockRejectedValue(new Error("transport close failed"))
    };
    const handle = install({ transport: failingTransport });
    stdin.emit("end");
    await settle();
    expect(onShutdownError).toHaveBeenCalledTimes(1);
    expect(handle.closed).toBe(true);
    // The error halts the sequence: server.close
    // and onShutdown are skipped because the
    // transport could not flush. The handle still
    // reports `closed` so the event loop drains.
    expect(server.close).not.toHaveBeenCalled();
    expect(onShutdown).not.toHaveBeenCalled();
    expect(exitFn).toHaveBeenCalledWith(1);
  });

  it("second-signal escape: a SIGTERM arriving DURING shutdown bypasses the sequence and hard-exits with code 1", async () => {
    // Build a slow `server.close()` so the FIRST
    // SIGTERM's sequence is still in flight when
    // the SECOND SIGTERM arrives. The expected
    // behaviour: the first sequence keeps running
    // (we don't double-execute), the second signal
    // short-circuits via `exitFn(1)` so the host
    // can reap the process immediately.
    let resolveServerClose: () => void = () => {};
    const slowServer: FakeServer = {
      close: vi.fn().mockImplementation(
        () => new Promise<void>((resolve) => {
          resolveServerClose = resolve;
        })
      )
    };
    const handle = install({ server: slowServer });
    // First signal: shutdown sequence starts.
    proc.emit("SIGTERM");
    // Let the sequence enter `await options.server.close()`.
    await new Promise((resolve) => setImmediate(resolve));
    // Second signal WHILE the first sequence is in flight.
    proc.emit("SIGTERM");
    // The escape hatch fires synchronously (exitFn
    // is synchronous), so we don't need to settle
    // the in-flight shutdown — the second signal
    // calls exitFn(1) immediately.
    await new Promise((resolve) => setImmediate(resolve));
    expect(exitFn).toHaveBeenCalledWith(1);
    // First sequence still owns the flag; second
    // signal bypasses it. server.close() was
    // called exactly ONCE.
    expect(slowServer.close).toHaveBeenCalledTimes(1);
    // Resolve the slow close so the test doesn't
    // leak the pending promise. After this the
    // first sequence's tail runs (exitFn(0) is
    // called but the process has already exited).
    resolveServerClose();
    await settle();
    expect(handle.closed).toBe(true);
  });

  it("1.5s ceiling: a hung server.close() hard-exits with code 1 after shutdownTimeoutMs", async () => {
    // Never-resolving server.close() simulates a
    // hung MCP handler. The ceiling (50 ms for
    // the test) should fire and the lifecycle
    // module should hard-exit instead of waiting
    // forever.
    const hangingServer: FakeServer = {
      close: vi.fn().mockImplementation(
        () => new Promise<void>(() => { /* never resolves */ })
      )
    };
    install({ server: hangingServer, shutdownTimeoutMs: 50 });
    proc.emit("SIGTERM");
    // Wait past the ceiling. Use a slightly
    // generous window so the unref'd timer can
    // resolve and the lifecycle's exit branch
    // can run.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(exitFn).toHaveBeenCalledWith(1);
    expect(onShutdownError).toHaveBeenCalled();
    const err = onShutdownError.mock.calls[0]?.[0] as Error;
    expect(err.message).toMatch(/ceiling|timeout/i);
  });

  it("verbose reason log: onShutdownStart fires with the correct reason code", async () => {
    install();
    expect(onShutdownStart).not.toHaveBeenCalled();
    stdin.emit("end");
    await settle();
    expect(onShutdownStart).toHaveBeenCalledTimes(1);
    expect(onShutdownStart).toHaveBeenCalledWith("stdio_end");
  });

  it("verbose reason log: stdin 'close' surfaces as 'stdio_close'", async () => {
    install();
    stdin.emit("close");
    await settle();
    expect(onShutdownStart).toHaveBeenCalledWith("stdio_close");
  });

  it("verbose reason log: SIGINT surfaces as 'SIGINT'", async () => {
    install();
    proc.emit("SIGINT");
    await settle();
    expect(onShutdownStart).toHaveBeenCalledWith("SIGINT");
  });

  it("verbose reason log: SIGTERM surfaces as 'SIGTERM'", async () => {
    install();
    proc.emit("SIGTERM");
    await settle();
    expect(onShutdownStart).toHaveBeenCalledWith("SIGTERM");
  });

  it("stdout stays protocol-clean: no console.log / console.error leaks from the lifecycle", async () => {
    // The MCP JSON-RPC stream is `process.stdout` and
    // the canonical diagnostic sink is `stderr` (via
    // `console.error`). A `console.log` call inside the
    // lifecycle path would corrupt a JSON-RPC frame in
    // production. The test spies on `console.log` and
    // asserts the lifecycle is silent on the hot path.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      install();
      stdin.emit("end");
      proc.emit("SIGTERM");
      proc.emit("SIGINT");
      stdin.emit("close");
      await settle();
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("uninstall() detaches listeners so a late signal is ignored", async () => {
    const handle = install();
    handle.uninstall();
    proc.emit("SIGTERM");
    stdin.emit("end");
    await settle();
    expect(server.close).not.toHaveBeenCalled();
    expect(transport.close).not.toHaveBeenCalled();
    expect(onShutdown).not.toHaveBeenCalled();
    expect(handle.closed).toBe(false);
    expect(exitFn).not.toHaveBeenCalled();
  });

  it("explicit shutdown(reason) runs the same sequence and is idempotent", async () => {
    const handle = install();
    const p1 = handle.shutdown("stdio_end");
    const p2 = handle.shutdown("SIGTERM");
    const p3 = handle.shutdown("stdio_close");
    await Promise.all([p1, p2, p3]);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(handle.closed).toBe(true);
    expect(exitFn).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(0);
    // The first reason wins (subsequent triggers
    // are collapsed into the in-flight sequence).
    expect(onShutdownStart).toHaveBeenCalledWith("stdio_end");
  });

  it("idle residency is preserved: a quiet stdin that stays open keeps the server alive", async () => {
    // This is the negative half of the contract:
    // merely sitting on an open stdin with no traffic
    // must NOT trigger shutdown. The pre-fix bug was
    // a server that exited on first inactivity; the
    // post-fix behaviour keeps it alive.
    const handle = install();
    // No events fire. A short settle window proves
    // nothing happened.
    await settle();
    expect(server.close).not.toHaveBeenCalled();
    expect(transport.close).not.toHaveBeenCalled();
    expect(onShutdown).not.toHaveBeenCalled();
    expect(handle.closed).toBe(false);
    expect(exitFn).not.toHaveBeenCalled();
  });
});