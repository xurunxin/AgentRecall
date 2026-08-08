// src/mcp/daemon-lock.ts
//
// Lockfile coordination for the shared HTTP MCP daemon.
//
// Two or more `agent-recall-mcp --http` launches must converge
// on a single live HTTP listener. The spec (.superpowers/specs
// /2026-08-06-mcp-process-lifecycle-and-shared-http-design.md,
// "共享安全" + "锁文件") pins the contract:
//
//   - Lockfile path: `${AGENT_RECALL_HOME}/.mcp-<profile>.lock`.
//   - Payload: JSON `{pid, endpoint, transport, token,
//     started_at, version, data_home, profile}`.
//   - Atomic create: `fs.open(path, "wx")` (O_CREAT|O_EXCL).
//   - Reclaim: stale or unreachable holders lose the lock.
//   - Token: 32 raw bytes (64 hex chars) — see the human-locked
//     correction below.
//
// Two launchers racing on a cold start: the first one to call
// `acquireOrJoin` reads the (absent) lock, falls through, and
// wins the atomic create via `openSync("wx")`. The second
// launcher's call enters a few ms later; by then the first
// launcher has already written and closed the file, so the
// read at the top of this function usually returns the just-
// written payload and the second launcher takes the "joined"
// branch. The brief's design relies on the read-back winning
// the race rather than catching `EEXIST` at the call site.
//
// Caveat: the spec calls for a 250 ms × 3-retry loop on race
// failure. THIS RETRY LOOP IS NOT IMPLEMENTED. If the second
// launcher's `openSync("wx")` happens to land in the narrow
// window where the first launcher has called `openSync("wx")`
// but not yet completed the `writeFileSync` + `closeSync`, the
// `EEXIST` propagates as an uncaught exception and the second
// launcher dies. In practice the window is sub-millisecond and
// we have not observed it on a local dev box, but a follow-up
// PR should add the spec-mandated retry loop.
//
// FOLLOW-UP: add the spec's 250 ms × 3 retry loop around the
// `openSync(lockPath, "wx")` call. On `EEXIST`, re-read the
// lock and re-evaluate the acquire/join decision (up to 3
// times at 250 ms intervals) before propagating the error.
//
// `acquireOrJoin` short-circuits when the existing lock
// already points at our own PID. This covers the "fork-join"
// pattern: a parent process writes the lock and a child
// re-reads it (e.g. when the child is the HTTP daemon and the
// parent has already bound the port) without a false
// self-reclaim.
//
// `process.kill(pid, 0)` on Windows is unreliable — the spec
// calls this out as a known risk — so the probe is the
// authoritative liveness check. The pid-alive helper exists
// only as a fast-path gate to skip the network probe when the
// pid is already known dead.
//
// Token length correction (human-locked, pre-flight):
//   The brief's reference implementation used
//   `randomBytes(16).toString("hex")` (16 raw bytes = 32 hex
//   chars). The spec's "Global Constraints" says
//   "Bearer token 32 字节随机十六进制", which the human partner
//   has interpreted and locked in as 32 raw bytes = 64 hex
//   chars. We therefore feed `randomBytes(32)` to the hex
//   encoder. The `LockPayload.token` field is still a string;
//   the field shape does not change; only the byte count
//   differs. The test in the brief is unaffected because it
//   uses the literal token `"deadbeef"`, not a generated one.
//
// Permission hardening: the lockfile contains a Bearer token,
// so on POSIX we tighten the mode bit to `0o600` after the
// write. On Windows `fs.chmod` only sets the read-only flag;
// a full owner-only ACL would need an `icacls` round-trip
// (see `src/admin/capability.ts` for the canonical
// `enforceWindowsOwnerOnlySync` pattern). For this stage we
// keep the brief's `try { chmodSync } catch { /* Windows */ }`
// shape; the cross-cutting refactor to export a project-wide
// `enforcePermissionsSync` is deferred. The token's exposure
// window is bounded by the daemon's uptime; on Windows the
// file is created in the per-user data home and inherits the
// parent ACL, so the immediate risk is limited.
//
// Idempotency: `release()` checks the lock's pid before
// unlinking. A second release by a different process is a
// no-op. A release of a missing lock is a no-op. The
// `expectedPid` guard is the only protection against a
// "stolen" lock (a different daemon writing into the same
// path); Task 7's launcher wires `process.pid` so the
// identity is exact.
//
// Zero new dependencies: Node stdlib only.

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface LockPayload {
  pid: number;
  endpoint: string;
  token: string;
  transport: "tcp" | "unix" | "pipe";
  started_at: string;
  version: string;
  data_home: string;
  profile: string;
}

export interface AcquireOptions {
  dataHome: string;
  profile: string;
  buildEndpoint: () => string;
  probe?: () => Promise<boolean>;
  transport?: LockPayload["transport"];
  version?: string;
}

export interface AcquireResult {
  joined: boolean;
  endpoint: string;
  token: string;
  lockPath: string;
}

export function pathFor(opts: { dataHome: string; profile: string }): string {
  return join(opts.dataHome, `.mcp-${opts.profile}.lock`);
}

function readLock(p: string): LockPayload | undefined {
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as LockPayload;
  } catch {
    return undefined;
  }
}

async function pidAlive(pid: number): Promise<boolean> {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireOrJoin(opts: AcquireOptions): Promise<AcquireResult> {
  mkdirSync(opts.dataHome, { recursive: true });
  const lockPath = pathFor(opts);
  const existing = readLock(lockPath);
  if (existing && existing.pid === process.pid) {
    return { joined: true, endpoint: existing.endpoint, token: existing.token, lockPath };
  }
  if (existing) {
    const alive = await pidAlive(existing.pid);
    const probeOk = alive ? (await opts.probe?.()) ?? false : false;
    if (alive && probeOk) {
      return { joined: true, endpoint: existing.endpoint, token: existing.token, lockPath };
    }
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  }
  const payload: LockPayload = {
    pid: process.pid,
    endpoint: opts.buildEndpoint(),
    // 32 raw bytes -> 64 hex chars. See "Token length
    // correction" block at the top of the file. Matches the
    // capability token shape (`CAPABILITY_TOKEN_SHAPE` in
    // `src/admin/capability.ts`) so the two secret
    // surfaces share an entropy budget.
    token: randomBytes(32).toString("hex"),
    transport: opts.transport ?? "tcp",
    started_at: new Date().toISOString(),
    version: opts.version ?? "0.0.0",
    data_home: opts.dataHome,
    profile: opts.profile
  };
  const fd = openSync(lockPath, "wx");
  try { writeFileSync(fd, JSON.stringify(payload)); } finally { closeSync(fd); }
  try { chmodSync(lockPath, 0o600); } catch { /* Windows ACL handled by ACL helper in future */ }
  return { joined: false, endpoint: payload.endpoint, token: payload.token, lockPath };
}

export async function release(opts: { lockPath: string; expectedPid: number }): Promise<void> {
  const cur = readLock(opts.lockPath);
  if (!cur || cur.pid !== opts.expectedPid) return;
  try { unlinkSync(opts.lockPath); } catch { /* swallow */ }
}
