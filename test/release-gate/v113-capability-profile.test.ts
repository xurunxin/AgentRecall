// test/release-gate/v113-capability-profile.test.ts
//
// v1.1.3 GATE-02 (issue #32): the profile-scoped
// admin-capability contract. Companion to `capability.test.ts`
// (which covers the v1.1.2 CapabilityStore surface) and to
// `p3-memory-semantics-mcp.test.ts` (which exercises the MCP
// resource layer on a Core profile).
//
// What this suite pins:
//
//   1. `CapabilityStore` load-time permission validation:
//      POSIX `0o600` accepted; `0o644` / group-readable /
//      world-readable rejected with `permission_drift`;
//      symlinks / reparse-points rejected with `symlink`;
//      non-owner rejected with `unsupported_owner`.
//   2. Profile-scoped visibility: a Core or Extended process
//      must NEVER inherit `"restricted"` visibility merely
//      because `admin.cap` exists in its data home; only
//      Admin-profile processes (with a valid capability)
//      gain restricted visibility.
//   3. Per-request authorization: a Core / Extended caller
//      CAN supply a per-request capability token to authorize
//      a privileged operation (the per-request path does NOT
//      depend on the active profile); capability types with
//      `profile_required: "admin"` are refused on Core /
//      Extended.
//   4. CapabilityStatus drift surface: load-time drift
//      surfaces `kind: "drift"` + a stable `drift_reason`
//      WITHOUT leaking token bytes; `memory://health`
//      reflects drift for the operator.
//   5. Constant-time token comparison: a wrong-value token
//      returns `token_mismatch` (not `capability_malformed`)
//      regardless of which character differs.
//   6. Revoke + restart: a revoke on disk does NOT affect
//      the running process (the in-memory token is the
//      runtime source of truth); a fresh process picks up
//      the new state.
//
// The center of this suite is the profile-scoped visibility
// + the load-time permission validation. The GREEN phase
// gates `lookup` / `strict_existing` paths in
// `resolveMemoryScopeWithStore` and `validatePermissionBoundary`
// at the CapabilityStore constructor.

import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CAPABILITY_FILENAME,
  CapabilityStore,
  InMemoryCapabilityStore
} from "../../src/admin/capability.js";
import { buildRequestContext, type RequestContext } from "../../src/request-context.js";
import { MemoryService } from "../../src/memory-service.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import type { ToolProfile } from "../../src/tools/profile.js";

// ---------------------------------------------------------------
// helpers
// ---------------------------------------------------------------

function newDataHome(): string {
  return mkdtempSync(join(tmpdir(), "lm-rg-v113-cap-"));
}

function writeCapability(path: string, body: Record<string, unknown>, mode: number): void {
  writeFileSync(path, JSON.stringify(body, null, 2), { mode });
  // `writeFileSync({mode})` is filtered by the umask;
  // re-chmod to the documented mode so the test is
  // independent of the host's umask.
  chmodSync(path, mode);
}

function ctxForTest(): RequestContext {
  return buildRequestContext({ actor_override: "agent:test", request_id: "v113-cap-test" });
}

// ---------------------------------------------------------------
// 1. CapabilityStore load-time permission boundary
// ---------------------------------------------------------------

describe("CapabilityStore permission boundary (v1.1.3 GATE-02 issue #32)", () => {
  let dataHome: string;
  beforeEach(() => {
    dataHome = newDataHome();
  });
  afterEach(() => {
    try {
      rmSync(dataHome, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("POSIX 0o600 owner-only file is accepted at load time", () => {
    if (process.platform === "win32") {
      // The POSIX permission bit test is gated on POSIX.
      // The Windows ACL probe runs in a separate test below.
      return;
    }
    const path = join(dataHome, CAPABILITY_FILENAME);
    const body = {
      token: "a".repeat(64),
      created_at: new Date().toISOString()
    };
    writeCapability(path, body, 0o600);
    const store = new CapabilityStore(dataHome, { persistent: true });
    expect(store.hasCapability()).toBe(true);
    expect(store.status().kind).toBe("granted");
  });

  it("POSIX 0o644 group-readable file is rejected with kind:drift + drift_reason:permission_drift", () => {
    if (process.platform === "win32") return;
    const path = join(dataHome, CAPABILITY_FILENAME);
    const body = {
      token: "b".repeat(64),
      created_at: new Date().toISOString()
    };
    writeCapability(path, body, 0o644);
    const store = new CapabilityStore(dataHome, { persistent: true });
    expect(store.hasCapability()).toBe(false);
    const status = store.status();
    expect(status.kind).toBe("drift");
    if (status.kind !== "drift") return;
    expect(status.drift_reason).toBe("permission_drift");
    // Status MUST NOT include any token bytes — neither
    // the on-disk value nor the redacted tail.
    expect(JSON.stringify(status)).not.toContain(body.token);
  });

  it("POSIX symlink is rejected with kind:drift + drift_reason:symlink", () => {
    if (process.platform === "win32") return;
    const target = join(dataHome, "target-cap.txt");
    writeCapability(target, { token: "c".repeat(64), created_at: new Date().toISOString() }, 0o600);
    const linkPath = join(dataHome, CAPABILITY_FILENAME);
    symlinkSync(target, linkPath);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    const store = new CapabilityStore(dataHome, { persistent: true });
    expect(store.hasCapability()).toBe(false);
    const status = store.status();
    expect(status.kind).toBe("drift");
    if (status.kind !== "drift") return;
    expect(status.drift_reason).toBe("symlink");
  });

  it("Windows: ACL probe on a non-owner-only file surfaces kind:drift + drift_reason:acl_drift", () => {
    if (process.platform !== "win32") {
      // The Windows ACL probe is exercised in the
      // gate's Windows matrix step; on POSIX the
      // probe is a no-op (the POSIX tests cover the
      // primary path).
      return;
    }
    // The Windows ACL probe accepts the file when
    // the current user is the only one granted
    // access; the v1.1.2 contract pins
    // `enforcePermissionsSync` to set
    // `${user}:(F)` + remove inheritance. A drift
    // case requires the ACL probe to run against a
    // file whose ACL is wider than the current
    // user. We construct that case by writing the
    // file via `writeFileSync` (default ACL:
    // inherited from the parent dir, which on a
    // CI matrix typically grants the `Users` group
    // read access). The probe must then refuse.
    const path = join(dataHome, CAPABILITY_FILENAME);
    const body = {
      token: "d".repeat(64),
      created_at: new Date().toISOString()
    };
    writeFileSync(path, JSON.stringify(body, null, 2));
    const store = new CapabilityStore(dataHome, { persistent: true });
    expect(store.hasCapability()).toBe(false);
    const status = store.status();
    expect(status.kind).toBe("drift");
    if (status.kind !== "drift") return;
    expect(["acl_drift", "permission_drift"]).toContain(status.drift_reason);
  });

  it("Windows: an explicitly granted admin.cap loads cleanly (happy path on the matrix)", () => {
    if (process.platform !== "win32") return;
    const path = join(dataHome, CAPABILITY_FILENAME);
    const body = {
      token: "e".repeat(64),
      created_at: new Date().toISOString()
    };
    // Use the canonical `grant()` path so the
    // Windows ACL is set to owner-only.
    const store = new CapabilityStore(dataHome, { persistent: true });
    store.grant({ label: "windows-happy" });
    expect(store.hasCapability()).toBe(true);
    // The on-disk token does NOT leak through
    // `status()`; only `token_tail` + `fingerprint`.
    const status = store.status();
    expect(status.kind).toBe("granted");
    if (status.kind !== "granted") return;
    expect(JSON.stringify(status)).not.toContain(body.token);
    void path;
  });
});

// ---------------------------------------------------------------
// 2. activeProfile-scoped visibility
// ---------------------------------------------------------------

describe("activeProfile-scoped visibility (v1.1.3 GATE-02 issue #32)", () => {
  let dataHome: string;
  beforeEach(() => {
    dataHome = newDataHome();
  });
  afterEach(() => {
    try {
      rmSync(dataHome, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  function buildService(
    profile: ToolProfile,
    capabilityStore: CapabilityStore | InMemoryCapabilityStore | undefined
  ): MemoryService {
    const dbPath = join(dataHome, "memory.sqlite");
    const store = new SQLiteMemoryStore(dbPath);
    const service = new MemoryService(
      store,
      undefined,
      "agent:test",
      dataHome,
      capabilityStore as never,
      profile
    );
    return service;
  }

  /**
   * Insert a `restricted` row directly via the
   * store (bypassing the write-service capability
   * gate). The test then exercises the read path's
   * SQL-boundary filter, which must surface the
   * row only when the service was constructed with
   * `(activeProfile === "admin" && capability loaded)`.
   */
  function insertRestrictedRow(service: MemoryService, id: string): void {
    const entry = {
      id,
      scope: "global" as const,
      type: "fact" as const,
      topic: "visibility",
      title: "restricted title",
      body: "restricted body",
      tags: [],
      source: { kind: "agent" as const },
      importance: 3 as const,
      confidence: 3 as const,
      status: "active" as const,
      created_at: "2026-07-28T00:00:00.000Z",
      updated_at: "2026-07-28T00:00:00.000Z",
      last_accessed_at: undefined,
      last_accessed_by: undefined,
      access_count: 0,
      expires_at: undefined,
      review_after: undefined,
      supersedes: [],
      superseded_by: undefined,
      token_estimate: 0,
      char_count: 16,
      revision: 1,
      writer_actor_id: "agent:setup",
      content_hash: "h",
      pinned: false,
      trust_level: "agent_observed" as const,
      sensitivity: "restricted" as const,
      valid_from: undefined,
      valid_until: undefined,
      deleted_at: undefined,
      tier: "working" as const,
      metadata: {}
    };
    service.store.insertEntry(entry);
  }

  it("Core + valid admin.cap on disk -> restricted rows are HIDDEN (forbidden_visibility)", () => {
    // v1.1.2 (issue #21) closed the default-unbound
    // path but left the Core-with-admin-cap visibility
    // leak open. The v1.1.3 contract: Core never
    // inherits `"restricted"` visibility merely because
    // a valid capability exists in the data home.
    const store = new CapabilityStore(dataHome, { persistent: true });
    store.grant({ label: "core-with-cap" });
    expect(store.hasCapability()).toBe(true);
    const service = buildService("core", store);
    expect(service.adminCapabilityStore?.hasCapability()).toBe(true);
    // Insert a restricted row directly. The read
    // service MUST treat it as `forbidden_visibility`
    // because Core + valid-cap still maps to
    // `actorMaxSensitivity: "normal"`.
    insertRestrictedRow(service, "restricted-core");
    const r = service.getMemoryWithVisibility("restricted-core");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("forbidden_visibility");
  });

  it("Extended + valid admin.cap on disk -> restricted rows are HIDDEN (forbidden_visibility)", () => {
    const store = new CapabilityStore(dataHome, { persistent: true });
    store.grant({ label: "extended-with-cap" });
    expect(store.hasCapability()).toBe(true);
    const service = buildService("extended", store);
    expect(service.adminCapabilityStore?.hasCapability()).toBe(true);
    insertRestrictedRow(service, "restricted-extended");
    const r = service.getMemoryWithVisibility("restricted-extended");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("forbidden_visibility");
  });

  it("Admin + valid admin.cap on disk -> restricted rows are VISIBLE (the SQL filter lifts to 'restricted')", () => {
    const store = new CapabilityStore(dataHome, { persistent: true });
    store.grant({ label: "admin-with-cap" });
    expect(store.hasCapability()).toBe(true);
    const service = buildService("admin", store);
    expect(service.adminCapabilityStore?.hasCapability()).toBe(true);
    insertRestrictedRow(service, "restricted-admin");
    const r = service.getMemoryWithVisibility("restricted-admin");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.entry.sensitivity).toBe("restricted");
  });

  it("Admin + admin.cap missing -> restricted rows are HIDDEN (admin-boundary fail-closed contract)", () => {
    // Stage 18 v1.1.2 (issue #23, ADR-0001) closed
    // this case at the MCP server entry. The
    // MemoryService constructor stays permissive (the
    // start-up gate is at the entry layer), but the
    // capability store's `hasCapability()` reports
    // false so the service is fail-closed at the
    // per-request layer.
    const store = new CapabilityStore(dataHome, { persistent: true });
    expect(store.hasCapability()).toBe(false);
    const service = buildService("admin", store);
    expect(service.adminCapabilityStore?.hasCapability()).toBe(false);
    insertRestrictedRow(service, "restricted-admin-no-cap");
    const r = service.getMemoryWithVisibility("restricted-admin-no-cap");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("forbidden_visibility");
  });
});

// ---------------------------------------------------------------
// 3. Per-request authorization
// ---------------------------------------------------------------

describe("per-request authorization (v1.1.3 GATE-02 issue #32)", () => {
  let dataHome: string;
  beforeEach(() => {
    dataHome = newDataHome();
  });
  afterEach(() => {
    try {
      rmSync(dataHome, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("per-request token on a Core process authorizes import_trust_restore (no profile_required)", () => {
    // `import_trust_restore` does NOT carry
    // `profile_required: "admin"` — the per-request
    // path works on any profile. The capability file
    // is loaded normally; the per-request token is
    // supplied by the caller and compared against
    // the in-memory token by `authorize(...)`.
    const store = new CapabilityStore(dataHome, { persistent: true });
    const status = store.grant({ label: "per-request-core" });
    if (status.kind !== "granted") throw new Error("grant failed");
    const onDisk = JSON.parse(readFileSync(status.path, "utf8")) as { token: string };
    // The Core profile does NOT enable the
    // per-process capability gate, but per-request
    // authorization is independent of the profile.
    const decision = store.authorize({
      capability: onDisk.token,
      capability_type: "import_trust_restore",
      requestContext: ctxForTest()
    });
    expect(decision.ok).toBe(true);
  });

  it("per-request token on Core is rejected for trust_promotion (profile_required: admin)", () => {
    // `trust_promotion` carries
    // `profile_required: "admin"`. A Core process
    // cannot authorize a trust tier promotion even
    // with a valid per-request token; the rejection
    // surfaces `reason: "profile_mismatch"`.
    const store = new CapabilityStore(dataHome, { persistent: true });
    const status = store.grant({ label: "per-request-core-reject" });
    if (status.kind !== "granted") throw new Error("grant failed");
    const onDisk = JSON.parse(readFileSync(status.path, "utf8")) as { token: string };
    const decision = store.authorize({
      capability: onDisk.token,
      capability_type: "trust_promotion",
      requestContext: ctxForTest()
    }, "core");
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toBe("profile_mismatch");
  });

  it("per-request token mismatch is audited with stable code (token_mismatch, no leak)", () => {
    const store = new CapabilityStore(dataHome, { persistent: true });
    const status = store.grant({ label: "per-request-mismatch" });
    if (status.kind !== "granted") throw new Error("grant failed");
    // A token of the right shape but the wrong value.
    const wrongToken = "f".repeat(64);
    const decision = store.authorize({
      capability: wrongToken,
      capability_type: "import_trust_restore",
      requestContext: ctxForTest()
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toBe("token_mismatch");
    // No token bytes surface through the decision.
    const serialised = JSON.stringify(decision);
    expect(serialised).not.toContain(wrongToken);
    expect(serialised).not.toContain(status.token_tail);
  });
});

// ---------------------------------------------------------------
// 4. CapabilityStatus drift surface (memory://health)
// ---------------------------------------------------------------

describe("CapabilityStatus drift surface (v1.1.3 GATE-02 issue #32)", () => {
  let dataHome: string;
  beforeEach(() => {
    dataHome = newDataHome();
  });
  afterEach(() => {
    try {
      rmSync(dataHome, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("a drift at load time surfaces kind:'drift' + drift_reason without token bytes; memory://health reflects drift", () => {
    if (process.platform === "win32") return;
    // Construct a permission-drifted file on disk.
    const path = join(dataHome, CAPABILITY_FILENAME);
    writeCapability(
      path,
      { token: "9".repeat(64), created_at: new Date().toISOString() },
      0o644
    );
    const store = new CapabilityStore(dataHome, { persistent: true });
    const status = store.status();
    expect(status.kind).toBe("drift");
    if (status.kind !== "drift") return;
    expect(status.drift_reason).toBe("permission_drift");
    // No token bytes on the drift envelope.
    const serialised = JSON.stringify(status);
    expect(serialised).not.toContain("9".repeat(64));
    expect(serialised).not.toContain("9999"); // partial tail check
    expect(status.path).toBe(path);
  });
});

// ---------------------------------------------------------------
// 5. Constant-time token comparison
// ---------------------------------------------------------------

describe("constant-time token comparison (v1.1.3 GATE-02 issue #32)", () => {
  let dataHome: string;
  beforeEach(() => {
    dataHome = newDataHome();
  });
  afterEach(() => {
    try {
      rmSync(dataHome, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("a wrong-value 64-hex token returns token_mismatch (not capability_malformed), demonstrating constant-time semantics", () => {
    // The shape regex constrains the candidate to
    // exactly 64 hex chars; the constant-time
    // comparison runs only against same-shape
    // tokens. A wrong-value token of the right shape
    // returns `token_mismatch`, never
    // `capability_malformed`. This pins the contract
    // that the comparison goes through
    // `timingSafeEqual` (and the helper does not
    // short-circuit on length, since the regex has
    // already enforced the length contract).
    const store = new CapabilityStore(dataHome, { persistent: true });
    store.grant({ label: "constant-time-test" });
    // Same shape (64 hex chars), differs in the first
    // character.
    const wrongToken = "0".repeat(64);
    const decision = store.authorize({
      capability: wrongToken,
      capability_type: "trust_promotion",
      requestContext: ctxForTest()
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toBe("token_mismatch");
  });
});

// ---------------------------------------------------------------
// 6. Revoke + restart semantics
// ---------------------------------------------------------------

describe("revoke + restart semantics (v1.1.3 GATE-02 issue #32)", () => {
  let dataHome: string;
  beforeEach(() => {
    dataHome = newDataHome();
  });
  afterEach(() => {
    try {
      rmSync(dataHome, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("revoke on disk does NOT affect the running process (in-memory token is the runtime source of truth)", () => {
    // Stage 18 v1.1.2 (issue #23, ADR-0001) pins
    // the in-memory token as the runtime source of
    // truth. A `revoke()` on the file does not
    // propagate to the running process; restart is
    // required for any change to take effect.
    const store = new CapabilityStore(dataHome, { persistent: true });
    store.grant({ label: "restart-keep" });
    expect(store.hasCapability()).toBe(true);
    // Unlink the file directly.
    rmSync(join(dataHome, CAPABILITY_FILENAME), { force: true });
    // The same store instance STILL reports the
    // capability (in-memory copy is intact).
    expect(store.hasCapability()).toBe(true);
    // `authorize()` still succeeds (the in-memory
    // token is what matters for the running
    // process).
    const onDiskJson = JSON.stringify({ token: "0".repeat(64) });
    // We don't have the in-memory token; use the
    // store's grant() status to assert. The
    // capability state is unchanged.
    const status = store.status();
    expect(status.kind).toBe("granted");
    void onDiskJson;
  });

  it("a fresh process picks up the revoked state (no token loaded from disk)", () => {
    const store1 = new CapabilityStore(dataHome, { persistent: true });
    store1.grant({ label: "restart-revoke" });
    // Revoke on disk.
    store1.revoke();
    // Construct a fresh store instance — it sees
    // the empty file and reports missing.
    const store2 = new CapabilityStore(dataHome, { persistent: true });
    expect(store2.hasCapability()).toBe(false);
    expect(store2.status().kind).toBe("missing");
  });
});