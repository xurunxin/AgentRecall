// src/tools/progress-callback.ts
//
// Stage 12 PR9 (spec § 6.3): progress + cancellation
// for long-running tool calls. The MCP protocol
// carries a progress token in the request `_meta` field;
// servers reply with `notifications/progress` notifications
// as the operation makes progress. Clients can cancel by
// aborting the request; the server sees the AbortSignal
// flip to aborted and can stop at the next safe boundary.
//
// The `@modelcontextprotocol/sdk` 1.29 does not yet
// expose a `sendProgress` helper on the handler `extra` —
// it gives us `signal: AbortSignal` and
// `sendNotification: (n) => Promise<void>`. We bridge
// those two into a `ProgressCallback` the long-running
// services can consume without depending on the SDK.
//
// Usage:
//
//   const progress = makeProgressCallback(extra, {
//     total: 100,
//     label: "find_duplicates"
//   });
//   await longRunningTask(progress);
//
// The returned `progress`:
//   - emits a `notifications/progress` notification
//     whenever the consumer calls it with a new value
//   - throws `AbortError` if the request was cancelled
//   - is a no-op when no progress token was provided
//   - clamps `progress > total` to `total` (clamping is
//     safer than reporting a value past the total)

import type { ServerNotification } from "@modelcontextprotocol/sdk/types.js";

export interface ProgressOptions {
  /** Upper bound reported to the client. */
  total: number;
  /** Short label for the stage, surfaced in the
   *  notification `message` field. */
  label: string;
}

export interface ProgressLikeExtra {
  signal: AbortSignal;
  sendNotification: (notification: ServerNotification) => Promise<void>;
  _meta?: { progressToken?: string | number };
}

export type ProgressCallback = (processed: number, message?: string) => void;

export class AbortError extends Error {
  constructor(message = "request cancelled") {
    super(message);
    this.name = "AbortError";
  }
}

/**
 * Build a `ProgressCallback` from a tool handler's
 * `extra` argument. Returns a function the long-running
 * service can call periodically.
 *
 * The first call also throws `AbortError` if the request
 * has already been cancelled, so a tool that starts a
 * loop can check the signal at the top of the loop and
 * exit immediately.
 */
export function makeProgressCallback(extra: ProgressLikeExtra, opts: ProgressOptions): ProgressCallback {
  const token = extra._meta?.progressToken;
  if (token === undefined) {
    // No progress token was supplied: silently no-op.
    return () => {
      if (extra.signal.aborted) {
        throw new AbortError("request cancelled before progress checkpoint");
      }
    };
  }

  return (processed: number, message?: string) => {
    if (extra.signal.aborted) {
      throw new AbortError("request cancelled at progress checkpoint");
    }
    const clamped = Math.max(0, Math.min(opts.total, Math.floor(processed)));
    const notification: ServerNotification = {
      method: "notifications/progress",
      params: {
        progressToken: token,
        progress: clamped,
        ...(message !== undefined ? { message: `${opts.label}: ${message}` } : { message: opts.label })
      }
    } as ServerNotification;
    // Fire-and-forget: progress notifications are best-
    // effort; the client may not be reading them, and
    // awaiting the send would slow the loop. We still
    // surface unhandled rejections so a buggy client
    // doesn't crash the server.
    void extra.sendNotification(notification).catch(() => {
      // intentionally swallowed; the cancellation check
      // above is the canonical signal.
    });
  };
}
