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
    stalled = false;
    clear();
    pending = setTimeout(() => {
      pending = undefined;
      if (opts.isMessageInFlight()) {
        stalled = true;
        schedule();
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
