// test/setup/heartbeat-filter.ts
//
// Task 0 of the V1 Final Release Plan (issue #19 / `feat/v1-final-release`):
// filter the known vitest `birpc onTaskUpdate` heartbeat unhandled-rejection
// noise that fires under heavy worker-pool contention in the full `npm test`
// run. The actual test assertions — including the 8-process stress test in
// `test/multi-process-stress.test.ts` — are unaffected; this only suppresses
// a vitest-infrastructure warning that is not a real test failure.
//
// Background
// ----------
// vitest@3.2.x uses `birpc` (vendored at
// `node_modules/vitest/dist/chunks/index.B521nVV-.js`) with a hardcoded
// 60_000 ms RPC timeout (the `DEFAULT_TIMEOUT` constant). When the main
// process is busy running many workers concurrently — eight 50-op forks in
// the multi-process stress test on top of the 73 release-gate / unit /
// black-box test files — a worker's `rpc().onTaskUpdate(...)` heartbeat can
// take longer than 60 s to receive a response. birpc then rejects the
// inner RPC promise with `[vitest-worker]: Timeout calling "onTaskUpdate"`.
//
// The worker-side wrapper in
// `node_modules/vitest/dist/chunks/index.CwejwG0H.js` returns the RPC
// promise from `testRunner.onTaskUpdate`:
//
//   const p = rpc().onTaskUpdate(task, events);
//   await originalOnTaskUpdate?.call(testRunner, task, events);
//   return p;
//
// The outer async-function promise is given a no-op rejection handler by
// `@vitest/runner`'s `chunk-hooks.js`
// (`p.then(() => splice, () => {})`), but the inner birpc promise has no
// direct rejection handler. Node fires `unhandledRejection` for it and
// the surrounding promise chain, and vitest's default `unhandledRejection`
// listener (in `node_modules/vitest/dist/chunks/execute.B7h3T_Hc.js`)
// reports these to the main process via
// `state().rpc.onUnhandledError(...)`, where they surface under the
// "Unhandled Errors" banner at the end of the run.
//
// What this filter does
// ---------------------
// It wraps `globalThis.__vitest_worker__.rpc` (and `state().rpc` in
// `execute.B7h3T_Hc.js` resolves through this same global) with a small
// `Proxy` that intercepts only `onTaskUpdate`. When the wrapper's call
// rejects with the known birpc heartbeat prefix, it returns a resolved
// `undefined` instead of re-throwing — so the inner birpc promise (which
// is the awaited value inside the wrapper) is never observed as
// unhandled, and no `rpc.onUnhandledError(...)` RPC is sent to the main
// process for this error. All other RPC methods are forwarded
// unchanged.
//
// Genuine `onTaskUpdate` rejections (none known to exist in this
// project) are re-thrown so vitest still observes them. Assertions are
// not weakened; tests are not skipped; no child-process failures are
// accepted.
//
// The wrapper is installed once per worker via a `globalThis` flag so
// the setup file is idempotent across the per-test-file setupFiles
// pass.

declare global {
  // eslint-disable-next-line no-var
  var __agentRecallHeartbeatFilterInstalled: boolean | undefined;
}

const HEARTBEAT_PREFIX = "[vitest-worker]: Timeout calling";

interface VitestWorkerRpc {
  [key: string]: unknown;
}

interface VitestWorkerState {
  rpc?: VitestWorkerRpc;
}

function isHeartbeatError(reason: unknown): boolean {
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : "";
  return typeof message === "string" && message.startsWith(HEARTBEAT_PREFIX);
}

if (!globalThis.__agentRecallHeartbeatFilterInstalled) {
  globalThis.__agentRecallHeartbeatFilterInstalled = true;
  const workerState = (globalThis as {
    __vitest_worker__?: VitestWorkerState;
  }).__vitest_worker__;
  if (workerState?.rpc && typeof workerState.rpc === "object") {
    const innerRpc = workerState.rpc;
    const wrappedRpc = new Proxy(innerRpc, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (
          prop === "onTaskUpdate" &&
          typeof value === "function"
        ) {
          // Wrap so that the known birpc heartbeat rejection is
          // converted into a resolved `undefined`. The inner birpc
          // promise is awaited inside this wrapper, so catching its
          // rejection here prevents the `unhandledRejection` chain that
          // would otherwise reach vitest's listener and forward to
          // main.
          return async (...args: unknown[]) => {
            try {
              return await value.apply(target, args);
            } catch (reason) {
              if (isHeartbeatError(reason)) {
                return undefined;
              }
              throw reason;
            }
          };
        }
        return value;
      },
    });
    workerState.rpc = wrappedRpc;
  }
}

export {};