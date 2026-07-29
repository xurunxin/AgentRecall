// vitest.setup.ts
//
// v1.1.3 GATE-06 (issue #36): minimal vitest setup
// file. Replaces the v1.1.2 heartbeat-filter proxy
// (`test/setup/heartbeat-filter.ts`) which ate
// `[vitest-worker]: Timeout calling ...` rejections
// and silently resolved them. The new setup:
//
//   1. Registers `process.on('unhandledRejection', ...)`
//      that LOGS every rejection. In release mode
//      (`AGENT_RECALL_RELEASE_MODE=1`), the handler
//      ALSO THROWS so the worker exits non-zero and
//      vitest surfaces the failure to the caller.
//   2. Registers `process.on('uncaughtException', ...)`
//      that LOGS + re-emits. In release mode, the
//      handler escalates to a thrown error so the
//      worker exits non-zero.
//   3. Registers `process.on('exit', ...)` for
//      best-effort cleanup of temp dirs the worker
//      created. The cleanup is idempotent + never
//      throws.
//
// The setup is dependency-free (Node stdlib only) and
// is referenced from every per-suite vitest config +
// the default config. The heartbeat filter is GONE;
// every unhandled rejection is now a real failure in
// release mode.

import { existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

declare global {
  // eslint-disable-next-line no-var
  var __agentRecallVitestSetupInstalled: boolean | undefined;
}

const RELEASE_MODE = process.env.AGENT_RECALL_RELEASE_MODE === "1";

interface UnhandledFailure {
  readonly kind: "unhandledRejection" | "uncaughtException" | "workerTimeout" | "testSkip";
  readonly reason: string;
  readonly stack?: string | undefined;
  readonly at: string;
}

/**
 * Serialise the failure into a stable log line. The
 * format is the canonical `kind | reason | at` shape
 * the orchestrator (`scripts/run-test-suites.mjs`)
 * greps for when aggregating JUnit + cleanup bundles.
 */
function formatFailure(failure: UnhandledFailure): string {
  const stack = failure.stack === undefined ? "" : `\n${failure.stack}`;
  return `[vitest.setup] FAILURE kind=${failure.kind} at=${failure.at} reason=${failure.reason}${stack}`;
}

function reasonString(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

function stackString(reason: unknown): string | undefined {
  if (reason instanceof Error && typeof reason.stack === "string") return reason.stack;
  return undefined;
}

function shouldEscalate(failure: UnhandledFailure): boolean {
  // The handler escalates to throw in release mode.
  // Local dev keeps the historical behaviour: log only,
  // do NOT throw (so an unrelated infrastructure
  // warning cannot block the test pass).
  if (!RELEASE_MODE) return false;
  // The orchestrator's synthetic injector (issue #36,
  // commit 5) emits real `unhandledRejection` +
  // real worker-timeout events. We always escalate
  // those in release mode.
  return true;
}

if (!globalThis.__agentRecallVitestSetupInstalled) {
  // Idempotency flag: a setup file may be evaluated
  // twice (once per worker + once per test file). We
  // install each handler exactly once per process.
  globalThis.__agentRecallVitestSetupInstalled = true;

  process.on("unhandledRejection", (reason) => {
    const failure: UnhandledFailure = {
      kind: "unhandledRejection",
      reason: reasonString(reason),
      stack: stackString(reason),
      at: new Date().toISOString()
    };
    // eslint-disable-next-line no-console
    console.error(formatFailure(failure));
    if (shouldEscalate(failure)) {
      // Throwing inside the handler rejects the
      // process's pending microtasks queue; the
      // worker exits non-zero and vitest surfaces the
      // failure to the caller.
      throw reason instanceof Error ? reason : new Error(failure.reason);
    }
  });

  process.on("uncaughtException", (err) => {
    const failure: UnhandledFailure = {
      kind: "uncaughtException",
      reason: reasonString(err),
      stack: stackString(err),
      at: new Date().toISOString()
    };
    // eslint-disable-next-line no-console
    console.error(formatFailure(failure));
    if (shouldEscalate(failure)) {
      throw err;
    }
    // Non-release: log + re-emit. Node's default
    // uncaughtException handler prints the stack
    // and exits; the re-emit preserves that path.
    throw err;
  });

  process.on("exit", () => {
    // Best-effort cleanup. We do NOT throw from
    // here (Node ignores errors from the exit
    // handler). The orchestrator's cleanup_status
    // field captures any leftover temp dirs.
    // The cleanup is intentionally minimal — every
    // test owns its temp dirs under `tmpdir()` and
    // the `MultiProcessStressTest` driver already
    // removes the `lm-stress-home-*` directories
    // via its own `afterAll`. We just clear any
    // obvious orphans.
    const base = tmpdir();
    if (!existsSync(base)) return;
    for (const entry of readdirSync(base)) {
      if (entry.startsWith("lm-stress-home-") || entry.startsWith("lm-stress-barrier-")) {
        try {
          rmSync(join(base, entry), { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    }
  });
}

export {};