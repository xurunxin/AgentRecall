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
import { PassThrough } from "node:stream";

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
  | "SIGTERM"
  | "stdio_idle_timeout";

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
   * v1.1.6 follow-up D1: optional one-shot sink
   * fired immediately before the clean `exitFn(0)`
   * (BEFORE the process is reaped). The MCP entry
   * wires this to write `[lifecycle] idle-sentinel\n`
   * on stderr so a blackbox test can wait for the
   * sentinel on `child.stderr` instead of racing
   * against a 2.5 s cap on cold-start + idle. The
   * test then asserts both `exitCode === 0` and
   * `stderr.includes("idle-sentinel")`. The
   * lifecycle never writes to stderr itself; the
   * caller owns formatting (consistent with
   * `onShutdownStart` above). Receives the same
   * `reason` argument `onShutdownStart` gets, so
   * the caller can gate the sentinel on a
   * specific reason (the MCP entry only emits
   * when `reason === "stdio_idle_timeout"` so
   * the "no stderr leak" blackbox assertions on
   * the SIGTERM / EOF / SIGINT paths still pass).
   * Not fired on the ceiling-timeout / error path
   * — those exit with code 1 and the test's
   * sentinel assertion is about the idle-exit
   * happy path.
   */
  onShutdownComplete?: (reason: ShutdownReason) => void;

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
   *
   * Ignored when `disableStdin: true` is set
   * (the v1.1.5 HTTP daemon opts in so a
   * supervisor-launched daemon with closed /
   * redirected stdin — `agent-recall --http
   * </dev/null` — does not trip a spurious
   * stdio-EOF shutdown on the first event-loop
   * tick after `listen`).
   */
  stdin?: NodeJS.ReadStream;

  /**
   * v1.1.5 (review by chatgpt-codex-connector on
   * PR #40): opt-out switch for the `end` / `close`
   * / `data` listeners on the stdin stream. The
   * shared-HTTP daemon is NOT a stdio transport;
   * it runs until SIGINT / SIGTERM, not on EOF.
   * Installing the default stdin listeners caused
   * supervisors and `</dev/null` launches to
   * trigger the stdio-EOF shutdown path
   * immediately and tear the daemon down before
   * the first HTTP request. When `true`, the
   * lifecycle skips installing the stdin listeners
   * AND skips the idle-timer wiring (the idle
   * timer re-arms on `data` events, so a stdin-less
   * install has no input stream to observe). The
   * stdio idle-exit feature is therefore mutually
   * exclusive with this flag; callers wanting both
   * must wire the idle timer themselves. The HTTP
   * daemon does not use the idle timer, so the
   * combination is the canonical "HTTP lifecycle
   * mode".
   */
  disableStdin?: boolean;

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

  /**
   * Idle residency ceiling in milliseconds.
   * When set to a positive value, the lifecycle
   * starts an internal `unref`'d timer on every
   * `data` event on `stdin` (and on install);
   * if the timer fires AND `isMessageInFlight`
   * reports `false`, the lifecycle triggers
   * shutdown with reason `"stdio_idle_timeout"`.
   * When `0` (or omitted), idle residency is
   * preserved: the server only exits when the
   * stdio pipe is genuinely gone, matching the
   * pre-idle behaviour. Task 3 wires the
   * `idle-timer.ts` `IdleTimerHandle` into this
   * option from the MCP entry; the lifecycle
   * itself owns the trigger wiring.
   */
  idleTimeoutMs?: number;

  /**
   * Caller-supplied gate consulted when the
   * idle timer fires. Returning `true` means a
   * request is mid-flight: the timer is
   * re-armed (NOT lost) so the deadline is
   * pushed out and the server keeps running.
   * Returning `false` (or `undefined`) lets the
   * idle trigger fire. Optional; when omitted
   * the idle trigger fires unconditionally at
   * the deadline. Ignored when `idleTimeoutMs`
   * is `0` or omitted.
   */
  isMessageInFlight?: () => boolean;
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
  // v1.1.5 (review by chatgpt-codex-connector on
  // PR #40, item "Stop treating HTTP daemon stdin
  // EOF as shutdown"): the HTTP daemon opts out of
  // stdin listening so a closed / redirected stdin
  // (e.g. `agent-recall --http </dev/null`) does
  // not trip the stdio-EOF shutdown path. The flag
  // also gates the idle-timer wiring (the timer
  // re-arms on `data` events, so a stdin-less
  // install has no input stream to observe). The
  // `disableStdin: true` path is therefore the
  // canonical "HTTP lifecycle mode" — a sentinel
  // `PassThrough` stdin stream is constructed so
  // the optional `stdin` argument can still be
  // passed by tests for type compatibility, but no
  // listeners are installed on it. The cast is
  // safe: a `PassThrough` is a `Readable` (the
  // structural supertype of `NodeJS.ReadStream`)
  // and the lifecycle only invokes the
  // `EventEmitter` surface (`on` / `off`).
  const stdin: NodeJS.ReadStream = (options.disableStdin
    ? (options.stdin ?? new PassThrough())
    : options.stdin ?? process.stdin) as unknown as NodeJS.ReadStream;
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
  // v1.1.6 follow-up D1: extract the idle-sentinel
  // sink so the runShutdown() closure can fire it
  // immediately before the clean `exitFn(0)`. See
  // the type-doc above for the sentinel contract.
  const onShutdownComplete = options.onShutdownComplete;
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
        // v1.1.6 follow-up D2: parallelize
        // transport close + server close. The
        // pre-D2 serial ordering
        // (`await transport.close()` →
        // `await server.close()`) was safe but
        // ~2x slower on the busy release-
        // candidate orchestrator VM (the same
        // VM that runs the 5-suite vitest pass
        // + multi-process stress back-to-back).
        // Both now run via `Promise.all`. The
        // SDK's `StdioServerTransport.close()`
        // is idempotent and safe to call while
        // `server.close()` is in flight; the
        // server's internal `AbortController`
        // does not depend on the transport
        // being already closed; the
        // `server.close()`'s `onclose` hook
        // (where the final audit events land)
        // still fires before either `Promise`
        // resolves because the SDK's close
        // path is microtask-scheduled. After
        // both resolve, the stdio pipe is
        // closed AND the in-flight handlers
        // are aborted.
        const transportClose = options.transport !== undefined
          ? options.transport.close()
          : Promise.resolve();
        const serverClose = options.server.close();
        await Promise.all([transportClose, serverClose]);
        // Caller-supplied cleanup (e.g.
        // SQLite handle release). After this
        // returns the file is fully flushed
        // + closed. Still serial (after the
        // parallel transport + server close)
        // because the SQLite close is the
        // only operation that MUST land
        // before `process.exit(0)` to avoid
        // losing the final audit append. A
        // caller-supplied fire-and-forget
        // unlink (e.g. a stale lockfile) can
        // be invoked from inside `onShutdown`
        // by the caller; the lifecycle itself
        // never spawns untracked async work.
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
      // v1.1.6 follow-up D1: fire the caller's
      // `onShutdownComplete` sink so a blackbox
      // test can wait for the sentinel on stderr
      // instead of racing against a fixed cap.
      if (onShutdownComplete !== undefined) {
        try { onShutdownComplete(reason); }
        catch { /* sentinel sink must never block the exit */ }
      }
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

  // v1.1.5 (review by chatgpt-codex-connector on
  // PR #40, item "Stop treating HTTP daemon stdin
  // EOF as shutdown"): the `disableStdin: true`
  // install path skips the stdin `end` / `close`
  // listeners so a closed / redirected stdin
  // (e.g. `agent-recall --http </dev/null`) does
  // not trip the stdio-EOF shutdown path on the
  // first event-loop tick after `listen`. The
  // HTTP daemon owns its own signal-draining
  // shutdown path (`runHttpServer` calls
  // `lifecycle.shutdown("SIGTERM")` after closing
  // the `httpServer` + per-session transports /
  // McpServers), so the lifecycle's own signal
  // listeners would race the HTTP daemon's local
  // drain — the HTTP call site passes
  // `signalTargets: []` to opt out of those too.
  // The two opt-outs are independent so a future
  // caller can keep one and drop the other if it
  // needs a mixed-mode install.
  if (!options.disableStdin) {
    stdin.on("end", onStdinEnd);
    stdin.on("close", onStdinClose);
  }
  for (const target of targets) {
    target.addListener("SIGINT", onSigint);
    target.addListener("SIGTERM", onSigterm);
  }

  // Idle wiring (Stage 1 of the lifecycle plan):
  // when `idleTimeoutMs > 0` the lifecycle arms an
  // unref'd timer. On the deadline it consults
  // `isMessageInFlight` and either re-arms (a
  // request is mid-flight, so the deadline is
  // pushed out) or triggers
  // `stdio_idle_timeout`. Every `data` event on
  // `stdin` re-arms the timer so a chatty client
  // never sees a spurious exit. The same
  // re-arm-on-stall fix from `src/mcp/idle-timer.ts`
  // (Task 1) applies here: a one-shot `setTimeout`
  // would lose the deadline when a request is
  // mid-flight, leaving the server unable to exit
  // for the rest of its residency.
  let idlePending: NodeJS.Timeout | undefined;
  const idleClearTimer = (): void => {
    if (idlePending !== undefined) {
      clearTimeout(idlePending);
      idlePending = undefined;
    }
  };
  const idleOnData = (): void => {
    // Traffic on stdin pushes the deadline out.
    idleSchedule();
  };
  const idleSchedule = (): void => {
    if (options.idleTimeoutMs === undefined || options.idleTimeoutMs <= 0) {
      return;
    }
    idleClearTimer();
    idlePending = setTimeout(() => {
      idlePending = undefined;
      if (options.isMessageInFlight?.() === true) {
        // Stalled: a request is mid-flight. Re-arm
        // so the deadline is pushed out instead of
        // being lost. Mirrors `idle-timer.ts`.
        idleSchedule();
        return;
      }
      triggerExternal("stdio_idle_timeout");
    }, options.idleTimeoutMs);
    // `unref()` so a pending timer never blocks
    // the event loop from draining (e.g. when
    // the stdio pipe closes the same tick).
    idlePending.unref();
  };
  stdin.on("data", idleOnData);
  idleSchedule();

  // v1.1.5 (review by chatgpt-codex-connector on
  // PR #40): when `disableStdin: true` the
  // `data` listener + the initial `idleSchedule`
  // are skipped. The idle timer re-arms on
  // `data` events, so a stdin-less install has no
  // input stream to observe; the HTTP daemon
  // pairs this flag with `idleTimeoutMs` omitted
  // (the canonical "HTTP lifecycle mode" — no
  // stdio EOF, no idle timer, no signal
  // listeners).
  if (options.disableStdin) {
    stdin.off("data", idleOnData);
  }

  const cleanup = (): void => {
    // v1.1.5 (review by chatgpt-codex-connector
    // on PR #40): `stdin.off(...)` on a
    // `PassThrough` stream that never had a
    // `data` listener attached is a safe no-op
    // (Node matches by reference). The
    // `disableStdin` install path therefore
    // tears down the same way; the only
    // difference is that no `end` / `close` /
    // `data` listeners were ever attached to
    // begin with. Guarding each `off` on the
    // flag keeps the cleanup symmetric and
    // makes a future flag-flip visible in
    // code review.
    if (!options.disableStdin) {
      stdin.off("end", onStdinEnd);
      stdin.off("close", onStdinClose);
      stdin.off("data", idleOnData);
    }
    idleClearTimer();
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