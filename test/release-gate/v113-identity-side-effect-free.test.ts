// test/release-gate/v113-identity-side-effect-free.test.ts
//
// v1.1.3 GATE-01 (issue #31): side-effect-free project identity
// resolution. Companion to `p3-project-identity-strict.test.ts`
// (which covers v1.1.2 #21's strict-by-default contract).
//
// What this suite pins:
//
//   1. `ProjectIdentityResolver.resolve(..., "lookup")` is a pure
//      read — zero writes to `project_identities` /
//      `project_aliases_new` on any input.
//   2. `ProjectIdentityResolver.resolve(..., "strict_existing")`
//      on a path-supplied unknown binding REFUSES with
//      `project_identity_conflict` and writes nothing.
//   3. `ProjectIdentityResolver.resolve(..., "register")` is the
//      only mode allowed to insert into `project_identities` /
//      `project_aliases_new`.
//
// This is the RED scaffold. The tests at the centre of the suite
// (suite 2) fail against the current v1.1.2 implementation
// because `resolveMemoryScopeWithStore` does not consult the
// `mode` argument and silently upserts identity / alias rows on
// every path-supplied call regardless of mode.
//
// The GREEN commit gates the `mode` argument through
// `resolveMemoryScopeWithStore`.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import { ProjectIdentityResolver } from "../../src/scope-resolver.js";

// ---------------------------------------------------------------
// helpers
// ---------------------------------------------------------------

function freshStore(): { store: SQLiteMemoryStore; dataHome: string } {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-v113-id-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  return { store, dataHome };
}

function rowCount(store: SQLiteMemoryStore, table: string): number {
  const row = store
    .backupHandle()
    .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
    .get() as { n: number };
  return row.n;
}

function projectSnapshot(store: SQLiteMemoryStore): {
  identities: number;
  aliases: number;
  scopes: number;
} {
  return {
    identities: rowCount(store, "project_identities"),
    aliases: rowCount(store, "project_aliases_new"),
    scopes: rowCount(store, "project_scopes")
  };
}

// ---------------------------------------------------------------
// suite 1: lookup mode is a pure read on path-supplied calls
// (the path-only branch of `resolve()`)
// ---------------------------------------------------------------

describe("ProjectIdentityResolver.resolve(..., 'lookup') path-supplied is side-effect free", () => {
  let store: SQLiteMemoryStore;
  let dataHome: string;
  let resolver: ProjectIdentityResolver;

  beforeEach(() => {
    ({ store, dataHome } = freshStore());
    resolver = new ProjectIdentityResolver(store, "agent:test");
  });
  afterEach(() => {
    try { store.close(); } catch { /* already closed */ }
  });

  it("path-only lookup on an unregistered path writes nothing", () => {
    // v1.1.2 (#31 central bug repro): a `lookup` call on an
    // unregistered path must NOT insert into project_identities
    // or project_aliases_new. The current implementation goes
    // through `resolveMemoryScopeWithStore(input, undefined, ...)`
    // for lookup mode (store-less), so this should already pass.
    // The test pins the contract.
    const before = projectSnapshot(store);
    const r = resolver.resolve(
      { scope: "project", project_path: "/tmp/lookup-fresh" },
      "lookup"
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The lookup path returns the canonical path without
    // mutating. The resolver does NOT carry `identity_status`
    // for this code path (store-less); we accept the absence.
    expect(r.value.project_path).toBeDefined();
    const after = projectSnapshot(store);
    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------
// suite 2: strict_existing mode refuses path-supplied unknown
// bindings — THIS is the RED centre of the lane.
// ---------------------------------------------------------------

describe("ProjectIdentityResolver.resolve(..., 'strict_existing') refuses unknown path bindings", () => {
  let store: SQLiteMemoryStore;
  let dataHome: string;
  let resolver: ProjectIdentityResolver;

  beforeEach(() => {
    ({ store, dataHome } = freshStore());
    resolver = new ProjectIdentityResolver(store, "agent:test");
  });
  afterEach(() => {
    try { store.close(); } catch { /* already closed */ }
  });

  it("path-only strict on an unregistered path refuses and writes nothing", () => {
    // v1.1.2 (#31): the central bug. Current behaviour silently
    // upserts the identity because `resolveMemoryScopeWithStore`
    // does not consult the `mode` argument. The fix gates
    // upserts on `mode === "register"`.
    const before = projectSnapshot(store);
    const r = resolver.resolve(
      { scope: "project", project_path: "/tmp/strict-fresh" },
      "strict_existing"
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("project_identity_conflict");
    const after = projectSnapshot(store);
    expect(after).toEqual(before);
  });

  it("id-only strict on an unknown project_id refuses and writes nothing", () => {
    // v1.1.2 (#21): strict-by-default. Already correct; the test
    // pins the contract.
    const before = projectSnapshot(store);
    const r = resolver.resolve(
      { scope: "project", project_id: "unknown-strict-id" },
      "strict_existing"
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_scope");
    const after = projectSnapshot(store);
    expect(after).toEqual(before);
  });

  it("id+path strict with a mismatch refuses and writes nothing", () => {
    // Pre-register two distinct identities.
    resolver.resolve(
      { scope: "project", project_id: "id-x", project_path: "/tmp/x" },
      "register"
    );
    resolver.resolve(
      { scope: "project", project_id: "id-y", project_path: "/tmp/y" },
      "register"
    );
    const before = projectSnapshot(store);
    // Strict call claiming id "id-x" lives at /tmp/y — conflict.
    const r = resolver.resolve(
      { scope: "project", project_id: "id-x", project_path: "/tmp/y" },
      "strict_existing"
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("project_identity_conflict");
    const after = projectSnapshot(store);
    expect(after).toEqual(before);
  });

  it("strict_existing on a registered path returns the bound identity", () => {
    // Pre-register an identity.
    const reg = resolver.resolve(
      { scope: "project", project_id: "id-known", project_path: "/tmp/known" },
      "register"
    );
    expect(reg.ok).toBe(true);
    const before = projectSnapshot(store);
    const r = resolver.resolve(
      { scope: "project", project_path: "/tmp/known" },
      "strict_existing"
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.project_id).toBe("id-known");
    expect(r.value.identity_status).toBe("bound");
    const after = projectSnapshot(store);
    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------
// suite 3: register mode is the only mutator (sanity pins)
// ---------------------------------------------------------------

describe("ProjectIdentityResolver.resolve(..., 'register') inserts when expected", () => {
  let store: SQLiteMemoryStore;
  let dataHome: string;
  let resolver: ProjectIdentityResolver;

  beforeEach(() => {
    ({ store, dataHome } = freshStore());
    resolver = new ProjectIdentityResolver(store, "agent:test");
  });
  afterEach(() => {
    try { store.close(); } catch { /* already closed */ }
  });

  it("register on an unknown path inserts one identity row and one alias row", () => {
    const before = projectSnapshot(store);
    const r = resolver.resolve(
      { scope: "project", project_id: "reg-a", project_path: "/tmp/reg-a" },
      "register"
    );
    expect(r.ok).toBe(true);
    const after = projectSnapshot(store);
    expect(after.identities - before.identities).toBe(1);
    expect(after.aliases - before.aliases).toBe(1);
  });

  it("register on a path already bound to a different id refuses", () => {
    resolver.resolve(
      { scope: "project", project_id: "id-b1", project_path: "/tmp/reg-b" },
      "register"
    );
    const before = projectSnapshot(store);
    const r = resolver.resolve(
      { scope: "project", project_id: "different-id", project_path: "/tmp/reg-b" },
      "register"
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("project_identity_conflict");
    const after = projectSnapshot(store);
    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------
// suite 4: cross-platform determinism (2 tests)
// ---------------------------------------------------------------

describe("ProjectIdentityResolver cross-platform determinism", () => {
  let store: SQLiteMemoryStore;
  let dataHome: string;

  beforeEach(() => {
    ({ store, dataHome } = freshStore());
  });
  afterEach(() => {
    try { store.close(); } catch { /* already closed */ }
  });

  it("Windows case-folded alias resolves to the same identity (Stage 15 PR-M1-2 preserved)", () => {
    if (process.platform !== "win32") {
      // Skip on POSIX: the resolver intentionally does NOT silently
      // merge case-different paths there (POSIX is case-sensitive).
      return;
    }
    const resolver = new ProjectIdentityResolver(store, "agent:test");
    const a = resolver.resolve(
      { scope: "project", project_id: "id-win", project_path: "C:\\Repo-Mixed" },
      "register"
    );
    expect(a.ok).toBe(true);
    const b = resolver.resolve(
      { scope: "project", project_path: "c:\\repo-mixed" },
      "strict_existing"
    );
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    if (a.ok) {
      expect(b.value.project_id).toBe(a.value.project_id);
    }
  });

  it("POSIX case-sensitive paths do NOT silently merge", () => {
    if (process.platform === "win32") return;
    const resolver = new ProjectIdentityResolver(store, "agent:test");
    const a = resolver.resolve(
      { scope: "project", project_id: "id-posix", project_path: "/tmp/repo-upper" },
      "register"
    );
    expect(a.ok).toBe(true);
    const b = resolver.resolve(
      { scope: "project", project_path: "/tmp/Repo-Upper" },
      "strict_existing"
    );
    // On POSIX, the case-different path is unknown — strict mode refuses.
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.error).toBe("project_identity_conflict");
  });
});
