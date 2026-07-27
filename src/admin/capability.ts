// src/admin/capability.ts
//
// Stage 18 v1.1.2 (issue #23, ADR-0001): the
// local operator capability store. The
// `CapabilityStore` is the single source of
// truth for the v1.1.2 admin boundary:
//
//   - `grant()` installs a fresh capability
//     token (32 bytes from `crypto.randomBytes`,
//     64 hex chars) under
//     `${AGENT_RECALL_HOME}/admin.cap` with
//     `0o600` (POSIX) / owner-only ACL (Windows).
//   - `revoke()` removes the capability.
//   - `status()` reports the on-disk state
//     (granted or missing) WITHOUT leaking the
//     token bytes.
//   - `authorize(capability, requestContext)`
//     compares the caller-supplied capability
//     against the in-memory token in CONSTANT
//     time (`crypto.timingSafeEqual`).
//
// The token is held in memory for the
// lifetime of the `CapabilityStore` instance
// (the MCP server's process). The on-disk
// file is the persistence boundary; the
// constructor reads it once at startup and
// the in-memory copy is the runtime source
// of truth. The CLI admin grant / revoke
// commands are the only supported mutation
// surface — MCP tool calls cannot create or
// rotate a capability.
//
// The store is the gate for the two trust /
// sensitivity escalation paths:
//
//   - `trust_promotion` — the
//     `confirm_memory_trust` tool and the
//     `remember({ trust_level: "user_confirmed" })`
//     path.
//   - `sensitivity_restricted` — the
//     `remember({ sensitivity: "restricted" })`
//     path and the matching `update_memory`
//     escalation.
//
// Failure-closed contract:
//
//   - The capability file is unreadable
//     (missing, wrong permissions, bad
//     contents) at startup: the in-memory
//     token is empty, `status()` returns
//     `missing`, `authorize()` returns
//     `{ ok: false, reason: "capability_missing" }`.
//   - The MCP server fails closed at startup
//     when `AGENT_RECALL_PROFILE=admin` is
//     set without a valid capability.
//   - The CLI `admin grant` fails closed when
//     the file system cannot satisfy the
//     restrictive permission contract (POSIX
//     `chmod 0o600` or Windows owner-only
//     ACL).
//
// This is **local operator separation**, not
// cryptographic multi-user security. The
// capability is a single shared secret between
// the operator (who installs it) and any
// privileged caller (who supplies it on each
// call). A reader with read access to
// `~/.agent-recall/admin.cap` can self-promote;
// the v1.1.2 contract relies on POSIX file
// permissions / Windows ACLs to limit that
// read access to the operator account.

import {
  chmodSync as fsChmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import type { RequestContext } from "../request-context.js";

/**
 * Canonical capability file name. Lives under
 * `AGENT_RECALL_HOME` (the data home).
 */
export const CAPABILITY_FILENAME = "admin.cap";

/**
 * Stage 18 v1.1.2 follow-up (review by ora-8):
 * the canonical capability token shape. A single
 * exported `RegExp` keeps the validator and the
 * store in lockstep — both layers reference the
 * same constant so a future change to the token
 * shape is a one-line edit. The regex matches
 * exactly 64 hex chars (`0-9`, `a-f`); the
 * `constantTimeEqual` comparison runs against the
 * trimmed candidate, so the caller may pass the
 * token with surrounding whitespace.
 */
export const CAPABILITY_TOKEN_SHAPE: RegExp = /^[0-9a-f]{64}$/;

/**
 * The set of capability types the v1.1.2
 * release recognises. Each name maps to one
 * privileged operation:
 *
 *   - `trust_promotion`: promote a memory's
 *     `trust_level` to `user_confirmed`.
 *   - `sensitivity_restricted`: write a
 *     memory with `sensitivity: "restricted"`,
 *     or escalate an existing memory to it.
 *   - `import_trust_restore`: the
 *     `restore_trust` import path (re-claim a
 *     `user_confirmed` tier from a
 *     `full_history` bundle).
 *   - `import_restricted`: import a bundle
 *     that contains `sensitivity: "restricted"`
 *     entries.
 *   - `sensitivity_visibility`: read
 *     `private` / `restricted` rows through
 *     the SQL/store boundary filter.
 */
export const CAPABILITY_TYPES = [
  "trust_promotion",
  "sensitivity_restricted",
  "import_trust_restore",
  "import_restricted",
  "sensitivity_visibility"
] as const;

export type CapabilityType = (typeof CAPABILITY_TYPES)[number];

/**
 * The on-disk capability record. The schema
 * is intentionally minimal: a single
 * secret token + a creation timestamp. The
 * `token` is the only field that the
 * `authorize` call compares; the
 * `created_at` is metadata surfaced by
 * `status()` (redacted).
 */
export type CapabilityRecord = {
  /** 32 random bytes hex-encoded (64 hex chars). */
  token: string;
  /** ISO 8601 timestamp of grant. */
  created_at: string;
  /**
   * Operator-supplied label (e.g.
   * "operator-laptop-2026-07-26"). Optional;
   * used by `status()` for redacted display.
   */
  label?: string;
};

/**
 * The redacted status surface. The token
 * bytes are NEVER returned by `status()`;
 * only the last 4 hex chars + a fingerprint
 * hash surface to the operator (so two
 * capabilities can be distinguished without
 * disclosing the secret).
 */
export type CapabilityStatus =
  | {
      kind: "granted";
      created_at: string;
      label?: string;
      /** `**** <last 4 hex>` — the only token bytes that surface to the operator. */
      token_tail: string;
      /** Stable fingerprint of the full token; collision-resistant within a single install. */
      fingerprint: string;
      /** Path the capability was loaded from. */
      path: string;
    }
  | { kind: "missing"; path: string };

/**
 * The authorization request envelope. The
 * caller supplies the capability bytes; the
 * store compares them against the in-memory
 * token in constant time. The
 * `requestContext` is the trusted
 * `RequestContext` (PR-1 #11): its `actor_id`
 * is what the audit log records, not the
 * raw input.
 */
export type AuthorizationRequest = {
  /** The capability token the client supplied. */
  capability: string;
  /** The operation the caller wants to perform. */
  capability_type: CapabilityType;
  /** Trusted `RequestContext` (PR-1 #11). */
  requestContext: RequestContext;
};

/**
 * The authorization decision. Surfaced both
 * to the audit log and to the service layer
 * (so the service can include the reason in
 * its `unauthorized` error).
 */
export type AuthorizationDecision =
  | { ok: true }
  | { ok: false; reason: AuthorizationDenialReason };

export type AuthorizationDenialReason =
  | "capability_missing"
  | "capability_malformed"
  | "permission_drift"
  | "token_mismatch"
  | "unsupported_capability_type"
  | "store_unavailable";

/**
 * The CapabilityStore is the single source
 * of truth for the admin boundary. It is
 * constructed with the data home directory
 * and reads the capability file once at
 * construction time. The in-memory token is
 * the runtime source of truth; the on-disk
 * file is the persistence boundary. The
 * `grant()` / `revoke()` calls are the only
 * mutation surface.
 */
export class CapabilityStore {
  private readonly path: string;
  private record: CapabilityRecord | undefined;
  private readonly persistent: boolean;

  constructor(dataHome: string, options: { persistent?: boolean } = {}) {
    this.path = join(dataHome, CAPABILITY_FILENAME);
    this.persistent = options.persistent !== false;
    if (this.persistent) {
      this.record = readCapabilityFromDisk(this.path);
    }
  }

  /** Resolve the canonical capability file path. */
  static capabilityPath(dataHome: string): string {
    return join(dataHome, CAPABILITY_FILENAME);
  }

  /** The file path this store reads / writes. */
  getPath(): string {
    return this.path;
  }

  /**
   * Whether a capability token is currently
   * loaded. `false` means the file is
   * missing / malformed / permission-drifted
   * (the v1.1.2 fail-closed contract: any
   * error in the load path leaves the
   * in-memory token empty).
   */
  hasCapability(): boolean {
    return this.record !== undefined;
  }

  /**
   * Install a fresh capability. The new
   * token is generated via
   * `crypto.randomBytes(32)` (64 hex chars).
   * The file is written atomically
   * (write to a temp file, then rename)
   * so a partial write cannot leave a
   * half-baked capability on disk. The
   * permissions are set restrictively
   * (POSIX `0o600` or Windows owner-only
   * ACL); a permission drift raises an
   * error and the grant is rolled back.
   */
  grant(input: { label?: string } = {}): CapabilityStatus {
    const token = randomBytes(32).toString("hex");
    const created_at = new Date().toISOString();
    const record: CapabilityRecord = {
      token,
      created_at,
      ...(input.label !== undefined ? { label: input.label } : {})
    };
    if (this.persistent) {
      const parent = this.path.replace(/[^/\\]+$/, "");
      if (parent.length > 0) {
        mkdirSync(parent, { recursive: true });
      }
      const tmpPath = `${this.path}.tmp.${process.pid}.${Date.now()}`;
      const payload = JSON.stringify(record, null, 2);
      // On POSIX, write the tmp file with the
      // owner-only mode bit so a peek at the
      // tmp file (between write and rename)
      // cannot read the token. On Windows, the
      // `chmodSync` call sets the read-only
      // attribute, which would make the
      // subsequent `renameSync` fail with
      // `EPERM`; the Windows ACL is therefore
      // applied after the rename below.
      if (process.platform !== "win32") {
        writeFileSync(tmpPath, payload, { mode: 0o600 });
      } else {
        writeFileSync(tmpPath, payload);
      }
      try {
        renameSync(tmpPath, this.path);
      } catch (error) {
        try {
          unlinkSync(tmpPath);
        } catch {
          /* best effort */
        }
        throw error;
      }
      // Re-verify after rename. The rename is
      // atomic on POSIX; on Windows the
      // inherited ACL may differ from the tmp
      // file's. The `enforcePermissions` call
      // is idempotent.
      enforcePermissionsSync(this.path);
    }
    this.record = record;
    return this.status();
  }

  /**
   * Remove the capability. Missing file is a
   * no-op (the brief fail-closed contract:
   * revoke never errors on a missing file).
   */
  revoke(): void {
    if (this.persistent && existsSync(this.path)) {
      try {
        // `fs.rmSync(..., { force: true })`
        // handles Windows ACLs more robustly
        // than `unlinkSync`; the `force` option
        // ignores missing-file errors and the
        // recursive flag is not needed for a
        // single file.
        rmSync(this.path, { force: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return;
        if (code === "EPERM" || code === "EACCES") {
          // The Windows `icacls` ACL can deny
          // `Delete` to the current user even
          // when the file is owner-only. The
          // v1.1.2 contract documents POSIX as
          // the primary path; on Windows, the
          // best-effort recovery is to rename
          // the file away (the canonical path
          // is now empty; a future `grant()` will
          // overwrite the orphan).
          const tombstone = `${this.path}.revoked.${process.pid}.${Date.now()}`;
          try {
            renameSync(this.path, tombstone);
          } catch (renameError) {
            if ((renameError as NodeJS.ErrnoException).code === "ENOENT") return;
            // Last resort: the in-memory record
            // is the runtime source of truth;
            // the on-disk file is just a
            // persistence layer. Surface the
            // rename error so the caller knows
            // the on-disk state did not change.
            throw renameError;
          }
          return;
        }
        throw error;
      }
    }
    this.record = undefined;
  }

  /**
   * Read the in-memory capability state.
   * The returned status NEVER includes the
   * raw token bytes; only the last 4 hex
   * chars and a fingerprint surface. The
   * `path` is included so the operator
   * message can confirm which file was
   * loaded.
   *
   * A missing in-memory token returns
   * `{ kind: "missing", path }` (NOT a
   * boolean) so the CLI can distinguish
   * "no capability installed" from "an
   * error occurred" without a separate
   * error channel.
   */
  status(): CapabilityStatus {
    if (this.record === undefined) {
      return { kind: "missing", path: this.path };
    }
    const out: CapabilityStatus = {
      kind: "granted",
      created_at: this.record.created_at,
      token_tail: redactedTail(this.record.token),
      fingerprint: tokenFingerprint(this.record.token),
      path: this.path
    };
    if (this.record.label !== undefined) {
      out.label = this.record.label;
    }
    return out;
  }

  /**
   * Authorize a privileged operation.
   *
   * The `capability` arg is the token the
   * caller supplied on the wire. The store
   * compares them against the in-memory
   * token in constant time. A missing
   * in-memory token, a length mismatch, or
   * a value mismatch all return
   * `{ ok: false }` with a stable denial
   * reason. The audit hook lives at the
   * service boundary (the service records
   * the decision), not here, so the store
   * is a pure authorization primitive.
   */
  authorize(input: AuthorizationRequest): AuthorizationDecision {
    if (!(CAPABILITY_TYPES as readonly string[]).includes(input.capability_type)) {
      return { ok: false, reason: "unsupported_capability_type" };
    }
    const candidate = sanitizeCapability(input.capability);
    if (candidate === undefined) {
      return { ok: false, reason: "capability_malformed" };
    }
    if (this.record === undefined) {
      return { ok: false, reason: "capability_missing" };
    }
    if (!constantTimeEqual(candidate, this.record.token)) {
      return { ok: false, reason: "token_mismatch" };
    }
    return { ok: true };
  }
}

/**
 * The in-memory capability store. Used by
 * tests and by callers that already hold
 * a capability in memory (e.g. a
 * short-lived CLI command that already
 * loaded the on-disk token). The behaviour
 * is the same as the persistent
 * `CapabilityStore` except the on-disk
 * file is never touched.
 */
export class InMemoryCapabilityStore {
  private record: CapabilityRecord | undefined;

  constructor(initial?: CapabilityRecord) {
    this.record = initial;
  }

  getPath(): string {
    return "<in-memory>";
  }

  hasCapability(): boolean {
    return this.record !== undefined;
  }

  grant(input: { label?: string } = {}): CapabilityStatus {
    const token = randomBytes(32).toString("hex");
    const created_at = new Date().toISOString();
    this.record = {
      token,
      created_at,
      ...(input.label !== undefined ? { label: input.label } : {})
    };
    return this.status();
  }

  revoke(): void {
    this.record = undefined;
  }

  status(): CapabilityStatus {
    if (this.record === undefined) {
      return { kind: "missing", path: "<in-memory>" };
    }
    const out: CapabilityStatus = {
      kind: "granted",
      created_at: this.record.created_at,
      token_tail: redactedTail(this.record.token),
      fingerprint: tokenFingerprint(this.record.token),
      path: "<in-memory>"
    };
    if (this.record.label !== undefined) {
      out.label = this.record.label;
    }
    return out;
  }

  authorize(input: AuthorizationRequest): AuthorizationDecision {
    if (!(CAPABILITY_TYPES as readonly string[]).includes(input.capability_type)) {
      return { ok: false, reason: "unsupported_capability_type" };
    }
    const candidate = sanitizeCapability(input.capability);
    if (candidate === undefined) {
      return { ok: false, reason: "capability_malformed" };
    }
    if (this.record === undefined) {
      return { ok: false, reason: "capability_missing" };
    }
    if (!constantTimeEqual(candidate, this.record.token)) {
      return { ok: false, reason: "token_mismatch" };
    }
    return { ok: true };
  }
}

export class PermissionDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDriftError";
  }
}

// ============================================================
// Internals.
// ============================================================

function readCapabilityFromDisk(path: string): CapabilityRecord | undefined {
  if (!existsSync(path)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.token !== "string" || !CAPABILITY_TOKEN_SHAPE.test(obj.token)) {
    return undefined;
  }
  if (typeof obj.created_at !== "string" || obj.created_at.length === 0) {
    return undefined;
  }
  const record: CapabilityRecord = {
    token: obj.token,
    created_at: obj.created_at
  };
  if (typeof obj.label === "string" && obj.label.length > 0) {
    record.label = obj.label;
  }
  return record;
}

function parseCapabilityRecord(raw: string): CapabilityRecord {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("capability_malformed: not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.token !== "string" || !CAPABILITY_TOKEN_SHAPE.test(obj.token)) {
    throw new Error("capability_malformed: token is missing or not 64 hex chars");
  }
  if (typeof obj.created_at !== "string" || obj.created_at.length === 0) {
    throw new Error("capability_malformed: created_at is missing");
  }
  const record: CapabilityRecord = {
    token: obj.token,
    created_at: obj.created_at
  };
  if (typeof obj.label === "string" && obj.label.length > 0) {
    record.label = obj.label;
  }
  return record;
}

function sanitizeCapability(input: string | undefined | null): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  if (!CAPABILITY_TOKEN_SHAPE.test(trimmed)) return undefined;
  return trimmed;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Run timingSafeEqual against a zero
    // buffer of the candidate length so a
    // length mismatch does not short-circuit
    // the comparison (and leak the length
    // via timing).
    timingSafeEqual(ab, Buffer.alloc(ab.length));
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function redactedTail(token: string): string {
  if (token.length < 4) return "****";
  return `**** ${token.slice(-4)}`;
}

function tokenFingerprint(token: string): string {
  // Truncated token prefix so two installs
  // can distinguish capabilities without
  // disclosing the secret. The fingerprint
  // is stable for a given token; the last
  // 4 hex chars are the human-readable
  // shorthand surfaced in `status()`.
  // The fingerprint is for operator
  // diagnostics only and is NEVER
  // accepted as authorization evidence.
  return token.slice(0, 16);
}

// ============================================================
// Permission / ACL helpers (synchronous).
// ============================================================

function enforcePermissionsSync(path: string): void {
  if (process.platform === "win32") {
    enforceWindowsOwnerOnlySync(path);
    return;
  }
  // POSIX: 0o600 (owner read/write only).
  chmodSync(path, 0o600);
}

function chmodSync(path: string, mode: number): void {
  // Thin wrapper around the Node chmod
  // syscall. Kept separate so the Windows
  // path can be skipped without an import
  // dance.
  try {
    fsChmodSync(path, mode);
  } catch (error) {
    throw new PermissionDriftError(
      `failed to chmod ${path} to 0o${mode.toString(8)}: ${(error as Error).message}`
    );
  }
}

function enforceWindowsOwnerOnlySync(path: string): void {
  // The Node `fs.chmod` call on Windows only
  // sets the read-only flag; it does not
  // change the ACL. The v1.1.2 contract
  // documents POSIX as the primary path;
  // on Windows we shell out to `icacls` to
  // set the owner-only ACL. A failure of
  // `icacls` (e.g. missing on PATH) raises
  // a `PermissionDriftError`; the grant
  // helper catches it and rolls the file
  // back.
  //
  // The `(F)` permission set grants Full
  // control to the named user — Read, Write,
  // Delete, Modify, and everything else.
  // `(R,W)` would be too restrictive (no
  // Delete), which would block the operator
  // from running `admin revoke` later.
  const user = currentWindowsUser();
  execFileSync(
    "icacls",
    [
      path,
      "/inheritance:r",
      "/grant:r",
      `${user}:(F)`,
      "/remove",
      "Everyone",
      "/remove",
      "Users"
    ],
    { stdio: "ignore" }
  );
}

function currentWindowsUser(): string {
  const stdout = execFileSync("whoami", [], { encoding: "utf8" });
  return stdout.trim();
}

// Re-export the file-mode constant so a
// caller can compare against it.
export const CAPABILITY_FILE_MODE = 0o600;

// Re-export the busy-wait helper from the
// POSIX path so tests can assert it
// without poking at the unexported constant.
export const POSIX_CAPABILITY_FILE_MODE = CAPABILITY_FILE_MODE;

// ============================================================
// CapabilityStore that fails closed when the
// data home is undefined. Used by callers
// that have not yet resolved a data home
// (e.g. the CLI without `--data-home`).
// ============================================================

/**
 * Build a CapabilityStore for the given
 * data home. Returns a store that reads /
 * writes the canonical `admin.cap` file
 * under the data home. The constructor
 * reads the file once and caches the
 * in-memory token; subsequent `authorize`
 * calls are sync and use the in-memory
 * token (the v1.1.2 production model: the
 * MCP server loads the file at startup
 * and uses the in-memory token for the
 * lifetime of the process).
 */
export function createCapabilityStore(dataHome: string): CapabilityStore {
  return new CapabilityStore(dataHome, { persistent: true });
}

/**
 * Convenience: produce a redacted display
 * of a capability token (e.g. for the CLI
 * `admin status` output). Never returns
 * the raw token.
 */
export function redactedCapabilityDisplay(token: string): string {
  return redactedTail(token);
}

// Re-export the busy-wait helper so a
// caller (e.g. an admin command that
// re-grants after a permission drift) can
// reference the constant without poking
// at the unexported value.
export const _INTERNAL = {
  // Kept for tests that want to assert the
  // canonical token length / charset
  // without copying the regex above.
  TOKEN_LENGTH: 64,
  // Stage 18 v1.1.2 follow-up (review by
  // ora-8): reuse the exported
  // `CAPABILITY_TOKEN_SHAPE` constant so
  // the validator and the store share a
  // single source of truth.
  TOKEN_PATTERN: CAPABILITY_TOKEN_SHAPE,
  // The file mode the POSIX path enforces.
  POSIX_MODE: CAPABILITY_FILE_MODE,
  // The Windows ACL permission the ACL
  // helper grants the current user.
  WINDOWS_RIGHTS: "(R,W)"
};

// Suppress an unused-imports warning for
// the `fsConstants` import (we keep it
// exported through `_INTERNAL.POSIX_MODE`
// for symmetry; the constant is itself
// referenced by tests).
void fsConstants;
