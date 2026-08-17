// test/unit/sqlite-store-busy-retry.test.ts
//
// v1.1.6 follow-up B1 (issue #42, spec d67fc45,
// plan bfbd2cb): unit test for the
// `withBusyRetry` async retry helper +
// `SQLiteBusyError` exported class. The v1.1.3
// design referenced a `runWithBusyRetry` on
// `SQLiteMemoryStore` (still present as a sync
// class method, line 3724 of
// `src/sqlite-store.ts`); the v1.1.6 B1 helper
// is a separate, top-level `async` helper that
// any caller can use without holding a
// `SQLiteMemoryStore` instance — the unit
// test below drives it with synthetic
// SQLITE_BUSY errors to verify the retry
// trigger, the exhaustion path, and the
// non-retry path on unrelated errors.
//
// The deeper fix for the Windows-latest stress
// flake (release.yml's
// `if: matrix.os != 'windows-latest'` skip)
// is the `release.yml` change in the same
// commit; the helper itself is the contract
// for any future caller that wants retry
// behaviour on a `db.prepare(...).run()` /
// `.all()` / `.get()` call that may
// `SQLITE_BUSY` under contention.

import { describe, expect, it, vi } from "vitest";

import { withBusyRetry, SQLiteBusyError } from "../../src/sqlite-store.js";

describe("withBusyRetry (v1.1.6 B1, top-level async retry helper)", () => {
  it("retries on SQLITE_BUSY and succeeds on attempt 3", async () => {
    let calls = 0;
    const op = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        const e: any = new Error("database is busy");
        e.code = "SQLITE_BUSY";
        throw e;
      }
      return "ok";
    });
    const result = await withBusyRetry(op);
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("retries on SQLITE_LOCKED (code 6) the same as SQLITE_BUSY", async () => {
    let calls = 0;
    const op = vi.fn(async () => {
      calls += 1;
      if (calls < 2) {
        const e: any = new Error("database is locked");
        e.code = "SQLITE_LOCKED";
        throw e;
      }
      return "ok-locked";
    });
    const result = await withBusyRetry(op);
    expect(result).toBe("ok-locked");
    expect(calls).toBe(2);
  });

  it("throws SQLiteBusyError with attempts after maxRetries", async () => {
    const op = vi.fn(async () => {
      const e: any = new Error("database is busy");
      e.code = "SQLITE_BUSY";
      throw e;
    });
    let caught: unknown = null;
    try {
      await withBusyRetry(op, { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 1, backoff: 1 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SQLiteBusyError);
    expect((caught as SQLiteBusyError).attempts).toBe(3); // initial + 2 retries
    expect((caught as SQLiteBusyError).lastError).toBeDefined();
    expect((caught as SQLiteBusyError).message).toMatch(/busy after 3 attempts/);
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("does not retry on non-BUSY errors", async () => {
    const op = vi.fn(async () => {
      throw new Error("some other error");
    });
    let caught: unknown = null;
    try {
      await withBusyRetry(op);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("some other error");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("exponential backoff: delays grow up to maxDelayMs", async () => {
    // Capture wall-clock elapsed between attempts to
    // confirm the backoff sequence is at least
    // monotonically non-decreasing up to the cap.
    const stamps: number[] = [];
    const op = vi.fn(async () => {
      stamps.push(Date.now());
      const e: any = new Error("busy");
      e.code = "SQLITE_BUSY";
      throw e;
    });
    let caught: unknown = null;
    try {
      // 3 retries with initialDelayMs=20, backoff=2,
      // maxDelayMs=40. Expected delays: 20, 40, 40
      // (capped). Total expected: ~100ms.
      await withBusyRetry(op, {
        maxRetries: 3,
        initialDelayMs: 20,
        maxDelayMs: 40,
        backoff: 2
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SQLiteBusyError);
    expect(stamps.length).toBe(4); // initial + 3 retries
    const deltas = [];
    for (let i = 1; i < stamps.length; i += 1) {
      deltas.push(stamps[i] - stamps[i - 1]);
    }
    // Each delta is at least the configured delay
    // (allowing for 5ms scheduler noise).
    expect(deltas[0]).toBeGreaterThanOrEqual(15); // ~20ms
    expect(deltas[1]).toBeGreaterThanOrEqual(35); // ~40ms
    expect(deltas[2]).toBeGreaterThanOrEqual(35); // ~40ms (capped)
  });
});
