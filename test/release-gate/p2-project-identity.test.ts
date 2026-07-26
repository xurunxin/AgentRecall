// test/release-gate/p2-project-identity.test.ts
//
// Stage 15 PR-M1-2 (issue #7, spec § 5.4): locks down
// the strict project identity model:
//
//   1. `project_identities` pins a `project_id` to a
//      `canonical_path`. A second create call with the
//      same `project_id` but a different path is
//      rejected with `project_identity_conflict`.
//   2. `project_aliases_new` registers the raw path the
//      caller resolved. An alias that points to a
//      different `project_id` than the caller's input
//      surfaces `project_identity_conflict` from
//      `resolveMemoryScope`.
//   3. Symlink resolution uses `realpathSync.native` to
//      canonicalise the input path before the identity
//      lookup.
//   4. The resolver flow is the contract: input
//      `project_id` + `project_path` -> identity row ->
//      alias row -> either match (resolve) or conflict.

import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../../src/memory-service.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import {
  resolveMemoryScope,
  resolveMemoryScopeWithStore
} from "../../src/scope-resolver.js";

const IS_WINDOWS = process.platform === "win32";
function aliasKey(path: string): string {
  return IS_WINDOWS ? path.toLowerCase() : path;
}

// Path helper that produces a real, existing path on
// both POSIX and Windows. The test paths used below
// are derived from a real temp dir so the resolver's
// `canonicalizePath` (which calls `realpathSync`)
// returns a path with the platform's separator.
const TEST_BASE = pathResolve(mkdtempSync(join(tmpdir(), "lm-pi-base-")));

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-pi-"));
  const dbPath = join(dataHome, "memory.sqlite");
  const store = new SQLiteMemoryStore(dbPath);
  const service = new MemoryService(store, undefined, "agent:test", dataHome);
  return { service, store, dataHome };
}

describe("release-gate p2-project-identity (issue #7)", () => {
  let service: MemoryService;
  let store: SQLiteMemoryStore;
  let dataHome: string;

  beforeEach(() => {
    ({ service, store, dataHome } = setup());
  });

  afterEach(() => {
    store.close();
    rmSync(dataHome, { recursive: true, force: true });
  });

  it("resolveMemoryScope returns invalid_scope when scope is missing", () => {
    const r = resolveMemoryScope({ scope: "wat" as never });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_scope");
  });

  it("resolveMemoryScope global scope is a no-op (no DB touch)", () => {
    const r = resolveMemoryScope({ scope: "global" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.scope).toBe("global");
  });

  it("createProjectIdentity + getProjectIdentity round-trip", () => {
    store.createProjectIdentity({
      project_id: "phoenix",
      canonical_path: join(TEST_BASE, "phoenix"),
      created_by: "agent:test",
      created_at: "2026-07-26T00:00:00.000Z"
    });
    const got = store.getProjectIdentity("phoenix");
    expect(got).toBeDefined();
    expect(got?.canonical_path).toBe(join(TEST_BASE, "phoenix"));
  });

  it("createProjectIdentity is idempotent on (project_id, canonical_path)", () => {
    const input = {
      project_id: "phoenix",
      canonical_path: join(TEST_BASE, "phoenix"),
      created_by: "agent:test",
      created_at: "2026-07-26T00:00:00.000Z"
    };
    store.createProjectIdentity(input);
    store.createProjectIdentity(input);
    const got = store.getProjectIdentity("phoenix");
    expect(got?.canonical_path).toBe(join(TEST_BASE, "phoenix"));
  });

  it("upsertProjectIdentity accepts a new path under the same project_id (alias addition)", () => {
    // Stage 15 PR-M1-2: a `project_id` may have
    // multiple raw-path aliases (e.g. a symlink
    // target and the canonical repo dir, or a
    // worktree on a separate branch). The identity
    // row's `canonical_path` is set on the first
    // register; subsequent calls with the same
    // `project_id` add a new row in
    // `project_aliases_new`. The conflict surfaces
    // when the *alias path* is already bound to a
    // *different* `project_id`.
    const pathA = join(TEST_BASE, "phoenix");
    const pathB = join(TEST_BASE, "phoenix-other");
    const r1 = resolveMemoryScopeWithStore(
      { scope: "project", project_id: "phoenix", project_path: pathA },
      store,
      "agent:test"
    );
    expect(r1.ok).toBe(true);

    const r2 = resolveMemoryScopeWithStore(
      { scope: "project", project_id: "phoenix", project_path: pathB },
      store,
      "agent:test"
    );
    // Both calls succeed; the second call adds a
    // new alias under the same project_id. The
    // resolver returns the canonical path (the
    // first one registered), not the caller's raw
    // path.
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.project_path).toBe(pathA);
  });

  it("alias binds the raw path so a second call with a different project_id conflicts", () => {
    // First, register the project identity + alias
    // for the test path under `project_id=phoenix`.
    const pathA = join(TEST_BASE, "phoenix");
    const r1 = resolveMemoryScopeWithStore(
      { scope: "project", project_id: "phoenix", project_path: pathA },
      store,
      "agent:test"
    );
    expect(r1.ok).toBe(true);

    // Then try to resolve the same path under a
    // different project_id. The alias already exists
    // and points to `phoenix`; the resolver refuses
    // to bind it to `other`.
    const r2 = resolveMemoryScopeWithStore(
      { scope: "project", project_id: "other", project_path: pathA },
      store,
      "agent:test"
    );
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error).toBe("project_identity_conflict");
  });

  it("symlink resolution: the alias is the canonical path, not the symlink", () => {
    // Create a real directory and a symlink to it.
    // The resolver canonicalises the symlink target
    // before the identity lookup, so the alias is
    // recorded under the canonical path.
    const realDir = mkdtempSync(join(tmpdir(), "lm-pi-real-"));
    const symDir = join(tmpdir(), `lm-pi-sym-${Date.now()}`);
    symlinkSync(realDir, symDir);

    try {
      const r = resolveMemoryScopeWithStore(
        { scope: "project", project_id: "phoenix", project_path: symDir },
        store,
        "agent:test"
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // The resolver returns the canonical path, not
      // the symlink. The alias is also registered
      // under the canonical path (case-folded on
      // Windows so the test stays case-stable).
      const aliasRow = store.getProjectAliasByPath(aliasKey(realDir));
      expect(aliasRow).toBeDefined();
      expect(aliasRow?.project_id).toBe("phoenix");
    } finally {
      rmSync(realDir, { recursive: true, force: true });
      try {
        rmSync(symDir, { recursive: true, force: true });
      } catch {
        // symlink may not have a directory to clean
      }
    }
  });

  it("resolveMemoryScope refuses project_id without a registered identity", () => {
    // Stage 15 PR-M1-2: the read resolver refuses
    // `project_id`-only inputs that have no
    // corresponding identity row, because the agent
    // should not be able to operate on a project that
    // has never been created.
    const r = resolveMemoryScopeWithStore(
      { scope: "project", project_id: "never-registered" },
      store,
      "agent:test"
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_scope");
  });

  it("listProjectAliases returns all aliases for a project", () => {
    const pathA = join(TEST_BASE, "phoenix");
    const pathB = join(TEST_BASE, "phoenix-alias");
    resolveMemoryScopeWithStore(
      { scope: "project", project_id: "phoenix", project_path: pathA },
      store,
      "agent:test"
    );
    resolveMemoryScopeWithStore(
      { scope: "project", project_id: "phoenix", project_path: pathB },
      store,
      "agent:test"
    );
    const list = store.listProjectAliases("phoenix");
    expect(list.length).toBe(2);
    // On Windows, alias keys are case-folded; the
    // comparison is case-insensitive so the test
    // passes on both POSIX and Windows.
    const actual = list.map((a) => aliasKey(a.alias)).sort();
    const expected = [aliasKey(pathA), aliasKey(pathB)].sort();
    expect(actual).toEqual(expected);
  });
});
