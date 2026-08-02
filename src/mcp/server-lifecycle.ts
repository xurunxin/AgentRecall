// src/mcp/server-lifecycle.ts
//
// Bug fix: the MCP stdio server previously had NO
// graceful-shutdown wiring. The startup path was a
// bare `await server.connect(transport)` and the
// function returned, leaving the Node process parked
// on the open `process.stdin` stream indefinitely.
// The SDK's `StdioServerTransport` listens for
// `data` / `error` on stdin but NOT for `end` /
// `close`, so when the parent process closed the
// stdio pipe (or died) the child kept running idle.
// On `SIGTERM` / `SIGINT` Node's default handler
// killed the child without closing the SQLite
// handle first.
//
// This module wires a small, focused shutdown path:
//
//   1. Idle residency is PRESERVED. The server only
//      exits when the stdio pipe is genuinely gone,
//      never on mere inactivity (no traffic timer).
//   2. When the client closes its end of the pipe,
//      the server shuts down cleanly. We watch
//      `process.stdin` `end` AND `close`: the
//      former fires when the parent's write end is
//      closed cleanly, the latter when the kernel
//      reports the pipe gone (a SIGPIPE /
//      ECONNRESET). Belt-and-braces so neither mode
//      leaves the child stranded.
//   3. SIGINT and SIGTERM trigger the same clean
//      path. Adding a listener overrides Node's
//      default termination behaviour, so the
//      shutdown sequence can run before the
//      process is reaped.
//   4. Stdout stays protocol-clean. This module
//      NEVER calls `console.log` /
//      `process.stdout.write`; the hot path is
//      silent. The caller routes shutdown errors
//      through `onShutdownError` if it wants any
//      diagnostic. The default is a no-op so the
//      module is a drop-in for a stdout-bound
//      MCP process.
//
// Shutdown order (matters for audit integrity):
//
//   1. `transport.close()` — drop the stdio pipe
//      so in-flight handlers stop flushing late
//      frames.
//   2. `server.close()` — the McpServer aborts
//      in-flight request handlers via the SDK's
//      internal `AbortController` and fires its
//      `onclose` hook. Final audit events land
//      here.
//   3. `onShutdown()` — caller-supplied hook. The
//      MCP server entry passes
//      `service.store.close()` so the SQLite
//      handle is released AFTER the audit row is
//      written.
//   4. Listeners detached, `closed` flips to
//      `true`. The event loop drains naturally
//      because the stdio handles are gone.
//
// Process termination + ceiling + escape hatch:
//
//   - `process.exit(0)` is called on a clean
//     shutdown. Without an explicit exit the Node
//     process would stay alive parked on the
//     SQLite / stdio handles even after the
//     shutdown sequence completes.
//   - The shutdown sequence is raced against a
//     1500 ms ceiling (`shutdownTimeoutMs`). If
//     the sequence overruns (a hung handler, a
//     slow DB close), the lifecycle module
//     hard-exits with code 1 so the host can
//     reap the process instead of waiting
//     indefinitely.
//   - Second-signal escape: if a SIGINT /
//     SIGTERM arrives WHILE the shutdown sequence
//     is in flight, the module bypasses the
//     sequence and hard-exits with code 1. This
//     matches the conventional "Ctrl-C twice to
//     force-quit" UX: the first signal is
//     graceful, the second is immediate.
//   - Verbose reason log: a one-shot stderr
//     line is emitted via the caller's
//     `onShutdownStart(reason)` callback. The
//     MCP entry wires this to
//     `AGENT_RECALL_VERBOSE_STDIO` so the hot
//     path stays silent unless the operator
//     opts in.
//
// Idempotency: a shutdown guard collapses
// concurrent triggers (end + close + SIGTERM +
// SIGINT in the same tick) into a single sequence.
// The handle still reports `closed` even when the
// shutdown errors out, so the event loop drains
// instead of re-entering the path on every
// subsequent signal.
//
// Zero new dependencies: Node stdlib only.

import type { ReadStream } from "node:tty";

/**
 * Minimal contract every "closeable" collaborator
 * the lifecycle touches must satisfy. Both the MCP
 * `Server` and the stdio `Transport` happen to expose
 * `close()` returning a (possibly `void`) promise;
 * the SQLite store exposes the same shape. We avoid
 * importing the MCP SDK types here so the unit
 * tests stay decoupled from a heavyweight
 * transitive surface.
 */
type Closeable = { close(): Promise<void> | void };

/**
 * Signal-emitting EventEmitter stand-in. The
 * production caller passes `process`; tests pass
 * a mock EventEmitter. The structural shape
 * matches the subset of `NodeJS.Process` the
 * lifecycle touches.
 */
type SignalEmitter = Pick<
  NodeJS.EventEmitter,
  "addListener" | "removeListener"
>;

/**
 * Stable reason codes the lifecycle module passes
 * to the `onShutdownStart` callback. The MCP
 * entry formats these into the verbose stderr
 * line; the lifecycle module itself stays
 * generic.
 */
export type ShutdownReason =
  | "stdio_end"
  | "stdio_close"
  | "SIGINT"
  | "SIGTERM";

export type ServerLifecycleOptions = {
  /**
   * The MCP server. Closed AFTER the transport
   * so in-flight handlers can flush their final
   * audit / response frames onto the (still open)
   * pipe, then the SDK aborts the remaining
   * in-flight handlers via its internal
   * AbortController.
   */
  server: Closeable;

  /**
   * The active transport (stdio or otherwise).
   * Closed FIRST so the server doesn't try to
   * flush late frames onto a dead pipe. Optional
   * for callers that want to drive the server's
   * lifecycle without exposing the transport.
   */
  transport?: Closeable;

  /**
   * Caller-supplied cleanup hook. Invoked AFTER
   * `server.close()` so any final audit events
   * the server emits can land before the SQLite
   * handle is released. The MCP server entry
   * passes `() => service.store.close()`.
   */
  onShutdown?: () => Promise<void> | void;

  /**
   * Caller-supplied diagnostic sink. Invoked ONCE
   * if any step in the shutdown sequence throws.
   * Default is a no-op so the module is silent on
   * the hot path. The caller decides whether to
   * route the error to stderr / a logger / etc.
   */
  onShutdownError?: (error: unknown) => void;

  /**
   * Optional one-shot diagnostic sink fired
   * immediately after the first trigger lands
   * (BEFORE the shutdown sequence runs). The MCP
   * entry wires this to the verbose stderr log
   * gated behind `AGENT_RECALL_VERBOSE_STDIO=1`
   * so the hot path stays silent unless the
   * operator opts in. The lifecycle module
   * itself never writes to stdout OR stderr;
   * the caller owns formatting.
   */
  onShutdownStart?: (reason: ShutdownReason) => void;

  /**
   * The `process.exit`-shaped function the
   * lifecycle calls to terminate the Node
   * process after the shutdown sequence.
   * Default: `process.exit`. Tests pass a mock
   * so they can assert the exit code without
   * actually exiting the worker.
   *
   * The function MUST be effectively
   * synchronous (the return value is ignored).
   * Production callers use `process.exit`; the
   * exit call is a fire-and-forget terminal
   * operation that the OS finishes after the
   * current microtask.
   */
  exitFn?: (code: number) => void;

  /**
   * The ceiling on the shutdown sequence. If
   * the sequence (transport.close → server.close
   * → onShutdown) takes longer than this, the
   * module abandons the sequence and hard-exits
   * with code 1 so the host can reap the
   * process. Default: 1500 ms. Tests pass a
   * smaller value to keep the suite fast.
   */
  shutdownTimeoutMs?: number;

  /**
   * The readable stream to watch for `end` /
   * `close`. Defaults to `process.stdin`. Tests
   * pass a mock `Readable` so they can drive the
   * events without touching the real stdio.
   */
  stdin?: NodeJS.ReadStream;

  /**
   * The `EventEmitter`-shaped target the module
   * listens on for `SIGINT` / `SIGTERM`. Defaults
   * to `[process]`. Tests pass a single-element
   * array with a mock EventEmitter so a
   * misconfigured install can't intercept the
   * test worker's own signals.
   */
  signalTargets?: SignalEmitter[];

  /**
   * The process to read signals from. Kept
   * separate from `signalTargets` for backwards
   * compatibility with the previous shape
   * (callers may have used `process: process`).
   * When `signalTargets` is supplied, `process`
   * is ignored.
   */
  process?: NodeJS.Process;
};

export type ServerLifecycleHandle = {
  /**
   * Triggers the shutdown sequence synchronously
   * (idempotent). Returns the in-flight shutdown
   * promise if a shutdown is already running, so
   * callers can `await` the same handle from
   * multiple call sites. The `reason` is
   * forwarded to `onShutdownStart` for
   * diagnostic routing.
   */
  shutdown(reason: ShutdownReason): Promise<void>;

  /**
   * Removes every listener the lifecycle
   * installed. Idempotent. Safe to call after
   * `shutdown` has completed. Intended for the
   * test suite; production code rarely needs it.
   */
  uninstall(): void;

  /**
   * True after the first shutdown trigger has
   * fired (regardless of whether the sequence
   * succeeded). Useful for tests that want to
   * assert the handle flipped without awaiting
   * the in-flight promise.
   */
  readonly closed: boolean;
};

/**
 * Default shutdown ceiling. Picked to be long
 * enough for a healthy SQLite WAL checkpoint +
 * final audit append + close, and short enough
 * that a hung handler can't strand the host
 * forever. The pre-existing plan (issue #38)
 * pins 1500 ms; tests override it to 50 ms.
 */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1500;

/**
 * Installs the graceful-shutdown wiring and
 * returns a handle the caller can use to drive
 * shutdown explicitly or to detach the listeners
 * for testing.
 *
 * The function is intentionally tiny: it owns no
 * state beyond the listeners it installs and the
 * single in-flight shutdown promise. The caller
 * passes the server / transport / cleanup hook
 * directly so the lifecycle module has zero
 * coupling to the rest of the codebase beyond
 * the `Closeable` shape.
 */
export function installServerLifecycle(
  options: ServerLifecycleOptions
): ServerLifecycleHandle {
  const stdin: NodeJS.ReadStream = options.stdin ?? process.stdin;
  // v1.1.4 (graceful shutdown fix): honour both
  // `signalTargets` (the explicit list) and the
  // legacy `process` shortcut. When neither is
  // supplied, fall back to `[process]`. The cast
  // is safe because we only call
  // `addListener` / `removeListener`.
  const targets: SignalEmitter[] =
    options.signalTargets ??
    (options.process !== undefined
      ? [options.process as unknown as SignalEmitter]
      : [(process as unknown) as SignalEmitter]);

  const onShutdown = options.onShutdown;
  const onShutdownError = options.onShutdownError ?? ((): void => {});
  const onShutdownStart = options.onShutdownStart;
  const exitFn = options.exitFn ?? process.exit;
  const shutdownTimeoutMs =
    options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

  let closed = false;
  let inFlight: Promise<void> | undefined;
  // Pending trigger waiting for the next
  // microtask cycle. Concurrent triggers fired
  // in the same synchronous tick (e.g. stdin
  // `end` + `close` arriving together when the
  // parent closes its write end) collapse into a
  // single scheduled start. Triggers arriving in
  // a LATER microtask cycle (after the sequence
  // has genuinely started, e.g. a second Ctrl-C
  // during a hung shutdown) fire the escape
  // hatch.
  let pendingTrigger: ShutdownReason | undefined;

  const runShutdown = async (reason: ShutdownReason): Promise<void> => {
    // `closed` is the "sequence has started"
    // flag. It is set FIRST so the
    // second-signal escape logic at the
    // trigger level (see below) can detect a
    // trigger arriving in a LATER microtask
    // cycle (i.e. the sequence is genuinely
    // in flight, not just a concurrent
    // trigger in the same tick as the first).
    closed = true;
    // Verbose reason log: fire the caller's
    // diagnostic sink BEFORE the sequence runs
    // so a hung shutdown doesn't suppress the
    // reason. The callback is wrapped in a
    // try/catch so a buggy sink cannot block
    // the shutdown.
    if (onShutdownStart !== undefined) {
      try {
        onShutdownStart(reason);
      } catch {
        // Diagnostic sinks must never block the
        // shutdown sequence. Swallow silently.
      }
    }
    try {
      // 1.5 s ceiling: race the shutdown
      // sequence against an unref'd timer so
      // the host can reap the process if the
      // sequence hangs. The timer is unref'd so
      // a successful sequence doesn't have to
      // clear it before exit.
      const ceiling = new Promise<"timeout">((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), shutdownTimeoutMs);
        timer.unref();
      });
      const sequence = (async (): Promise<"done"> => {
        // 1. Transport first: stop the stdio
        //    pipe so no late frames can leak
        //    into a half-closed session.
        if (options.transport !== undefined) {
          await options.transport.close();
        }
        // 2. Server next: the SDK aborts
        //    in-flight handlers and fires its
        //    own `onclose`. Final audit events
        //    land in this window.
        await options.server.close();
        // 3. Caller-supplied cleanup (e.g.
        //    SQLite handle release). After
        //    this returns the file is fully
        //    flushed + closed.
        if (onShutdown !== undefined) {
          await onShutdown();
        }
        return "done";
      })();
      const winner = await Promise.race([sequence, ceiling]);
      if (winner === "timeout") {
        // Ceiling exceeded: route through the
        // error sink (stderr in the MCP entry)
        // and hard-exit so the host can reap
        // the process.
        onShutdownError(
          new Error(
            `server lifecycle: shutdown sequence exceeded ${shutdownTimeoutMs}ms ceiling`
          )
        );
        exitFn(1);
        return;
      }
      // Clean exit. Code 0 signals the host
      // that the child exited on its own
      // (no SIGTERM kill was needed).
      exitFn(0);
    } catch (error) {
      // 4. Diagnostics route through the
      //    caller's sink; we DO NOT log here.
      //    Stdout stays protocol-clean even on
      //    the failure path.
      onShutdownError(error);
      exitFn(1);
    } finally {
      // Detach every listener we installed so
      // the event loop drains and a late
      // signal can't re-enter the shutdown
      // path.
      cleanup();
    }
  };

  // External trigger (OS-level event: stdin EOF,
  // signal). Concurrent triggers fired in the
  // same synchronous tick collapse into a
  // single scheduled start (one sequence). A
  // trigger arriving AFTER the sequence has
  // genuinely started fires the escape hatch:
  // bypass the sequence and hard-exit so the
  // host can reap the process immediately.
  // This matches the conventional "Ctrl-C
  // twice to force-quit" UX.
  const triggerExternal = (reason: ShutdownReason): void => {
    if (inFlight !== undefined) {
      // The sequence is genuinely in flight
      // (the first trigger's microtask has
      // already run and set `inFlight`).
      // Escape hatch: bypass the sequence and
      // hard-exit so the host can reap the
      // process immediately.
      exitFn(1);
      return;
    }
    if (pendingTrigger !== undefined) {
      // A previous trigger in the SAME
      // synchronous tick already scheduled
      // the start. Collapse: no-op.
      return;
    }
    pendingTrigger = reason;
    // Defer to the next microtask so any
    // additional triggers fired in the same
    // synchronous tick (concurrent) collapse
    // into a single start. Triggers fired in
    // a LATER microtask cycle (after the
    // sequence has started) hit the `inFlight`
    // branch above and fire the escape hatch.
    queueMicrotask(() => {
      const r = pendingTrigger;
      pendingTrigger = undefined;
      if (r !== undefined) {
        inFlight = runShutdown(r);
      }
    });
  };

  // Explicit shutdown via the handle. Idempotent:
  // the first call starts the sequence;
  // subsequent calls return the in-flight
  // promise. Does NOT fire the escape hatch —
  // the escape hatch is for OS-level signals
  // where the operator hits Ctrl-C twice to
  // force-quit, not for programmatic shutdown.
  const shutdown = (reason: ShutdownReason): Promise<void> => {
    if (inFlight === undefined) {
      inFlight = runShutdown(reason);
    }
    return inFlight;
  };

  // `end` fires when the parent's write end is
  // closed cleanly (EOF). `close` fires when the
  // kernel reports the pipe gone (a broken pipe,
  // ECONNRESET, parent crash). Listening for both
  // is the canonical pattern: the first one that
  // fires triggers shutdown, the other is a no-op
  // thanks to the idempotency guard.
  const onStdinEnd = (): void => {
    triggerExternal("stdio_end");
  };
  const onStdinClose = (): void => {
    triggerExternal("stdio_close");
  };
  // The signal handlers capture the signal NAME
  // so the verbose reason log can surface which
  // signal triggered the shutdown.
  const onSigint = (): void => {
    triggerExternal("SIGINT");
  };
  const onSigterm = (): void => {
    triggerExternal("SIGTERM");
  };

  stdin.on("end", onStdinEnd);
  stdin.on("close", onStdinClose);
  for (const target of targets) {
    target.addListener("SIGINT", onSigint);
    target.addListener("SIGTERM", onSigterm);
  }

  const cleanup = (): void => {
    stdin.off("end", onStdinEnd);
    stdin.off("close", onStdinClose);
    for (const target of targets) {
      target.removeListener("SIGINT", onSigint);
      target.removeListener("SIGTERM", onSigterm);
    }
  };

  return {
    shutdown,
    uninstall: cleanup,
    get closed(): boolean {
      return closed;
    }
  };
}

// `ReadStream` is imported above for the
// `stdin` option type. The named import keeps
// the type tied to `node:tty`'s canonical shape
// without dragging in the heavyweight `tty`
// module at runtime.
export type ServerLifecycleStdin = ReadStream;