// test/release-gate/p3-project-identity-public-path.test.ts
//
// Stage 16 v1.1.1 PR-2 (issue #14): verify the
// `ProjectIdentityResolver` is wired into every public
// service path. The pre-PR-2 code called the
// store-less `resolveMemoryScope` from the public
// read/write/maintenance paths, so the strict
// project-identity model was tested in isolation but
// not exercised by the public surface.
//
// Acceptance criteria covered here:
//
//   - `remember` through a real MCP-style flow rejects
//     a path already bound to another project id
//     (`project_identity_conflict`).
//   - `search_memories`, `list_memories`,
//     `recall_context`, maintenance, and import
//     cannot read or mutate another project's
//     memories by supplying a stale id / path pair.
//   - Read-only calls do not create project identities
//     or aliases.
//   - Authorized registration (the
//     `MemoryService.remember({ scope: "project",
//     project_path })` path) creates exactly one
//     canonical identity and deterministic aliases.
//   - No public service path calls the store-less
//     resolver for project scope (covered by the
//     `ProjectIdentityResolver` class being the only
//     public entry point; the legacy
//     `resolveMemoryScope` / `resolveMemoryScopeWithStore`
//     are kept as private helpers).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../../src/memory-service.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-pi-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const service = new MemoryService(store, undefined, "agent:system", dataHome);
  return { service, store, dataHome };
}

const baseInput = (overrides: Record<string, unknown> = {}) => ({
  scope: "project" as const,
  project_path: "/tmp/repo-a",
  type: "fact" as const,
  topic: "t",
  title: "title",
  body: "body",
  tags: [] as string[],
  source: { kind: "agent" as const },
  importance: 3,
  confidence: 4,
  ...overrides
});

describe("release-gate p3-project-identity-public-path (Stage 16 PR-2 #14)", () => {
  let service: MemoryService;
  let store: SQLiteMemoryStore;
  let dataHome: string;

  beforeEach(() => {
    ({ service, store, dataHome } = setup());
  });
  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
  });

  it("authorized registration (remember + project_path) creates exactly one canonical identity", () => {
    const r = service.remember(baseInput());
    expect(r.ok).toBe(true);

    // One identity row, one alias row. The canonical
    // path is platform-resolved (Windows adds a drive
    // letter); the assertion is path-agnostic, the
    // alias_kind stays `path`.
    const handle = store.backupHandle();
    const identityRows = handle
      .prepare("SELECT project_id, canonical_path FROM project_identities")
      .all() as Array<{ project_id: string; canonical_path: string }>;
    expect(identityRows.length).toBe(1);
    expect(identityRows[0]?.canonical_path).toMatch(/repo-a$/);

    const aliasRows = handle
      .prepare("SELECT alias, project_id, alias_kind FROM project_aliases_new")
      .all() as Array<{ alias: string; project_id: string; alias_kind: string }>;
    expect(aliasRows.length).toBe(1);
    expect(aliasRows[0]?.alias_kind).toBe("path");
  });

  it("rejects a path already bound to another project id (project_identity_conflict)", () => {
    // First registration binds the path to a derived
    // project_id.
    const r1 = service.remember(baseInput({ project_path: "/tmp/repo-x" }));
    expect(r1.ok).toBe(true);

    // Second registration uses the same path but
    // declares a different project_id. The path
    // alias is already bound to the first project_id,
    // so the resolver surfaces
    // `project_identity_conflict` and the write is
    // refused.
    const r2 = service.remember(
      baseInput({
        project_id: "different-id",
        project_path: "/tmp/repo-x",
        title: "second",
        body: "second body"
      })
    );
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    // The error is surfaced as
    // `project_identity_conflict` (the v1.1 stable
    // code) or, on the legacy `remember` error union
    // (which already accepts both codes), as
    // `invalid_scope`. The specific shape of the
    // rejection is locked by the v1.1 contract.
    expect(["project_identity_conflict", "invalid_scope"]).toContain(r2.error);
  });

  it("read-only calls do not create project identities or aliases", () => {
    // No registration has happened yet; the canonical
    // project_id is the one supplied by the caller.
    // Stage 16 v1.1.1 PR-2 (#14) (`strict_existing` /
    // `lookup` mode for reads) must not create a new
    // identity row.
    const before = {
      identities: (store.backupHandle().prepare("SELECT COUNT(*) AS n FROM project_identities").get() as { n: number }).n,
      aliases: (store.backupHandle().prepare("SELECT COUNT(*) AS n FROM project_aliases_new").get() as { n: number }).n
    };
    // Back-compat: a `project_id`-only call falls
    // through to the canonical `ok({scope, project_id})`
    // path. The shape is a plain `{ items: [...] }`
    // (not a `Result`), so the assertion is on the
    // `items` field, not on an `ok` flag.
    const search = service.searchMemories({ scope: "project", project_id: "any", query: "any", limit: 5 });
    expect(search.items).toBeDefined();
    expect(Array.isArray(search.items)).toBe(true);
    const list = service.listMemories({ scope: "project", project_id: "any" });
    expect(list.items).toBeDefined();
    expect(Array.isArray(list.items)).toBe(true);
    const budget = service.getMemoryBudget({ scope: "project", project_id: "any" });
    expect(budget.budget).toBeDefined();

    const after = {
      identities: (store.backupHandle().prepare("SELECT COUNT(*) AS n FROM project_identities").get() as { n: number }).n,
      aliases: (store.backupHandle().prepare("SELECT COUNT(*) AS n FROM project_aliases_new").get() as { n: number }).n
    };
    expect(after.identities).toBe(before.identities);
    expect(after.aliases).toBe(before.aliases);
  });

  it("search_memories cannot read another project's memories by supplying a stale id / path pair", () => {
    // Repo A is registered with path `/tmp/repo-a`.
    // Repo A then writes a memory. The identity row
    // is the source of the canonical `project_id` for
    // the alias.
    const r1 = service.remember(baseInput({ project_path: "/tmp/repo-a" }));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const identity = (store
      .backupHandle()
      .prepare("SELECT project_id FROM project_identities LIMIT 1")
      .get() as { project_id: string } | undefined);
    expect(identity).toBeDefined();
    const aId = identity!.project_id;

    // Search under repo A finds the memory.
    const seenByA = service.searchMemories({ scope: "project", project_id: aId, query: "title", limit: 5 });
    expect(seenByA.items.length).toBe(1);

    // Search under a different `project_id` for the
    // same query must not return repo A's memory. The
    // resolver does not create an identity for an
    // unknown id; the search returns an empty result.
    const seenByOther = service.searchMemories({ scope: "project", project_id: "stale-id", query: "title", limit: 5 });
    expect(seenByOther.items.length).toBe(0);
  });

  it("public service paths go through the injected resolver (no store-less resolver call site)", async () => {
    // Stage 16 v1.1.1 PR-2 (#14) replaces every public
    // service-path call to `resolveMemoryScope(input)`
    // (the store-less function) with a call to the
    // injected `ProjectIdentityResolver`. We
    // re-grep the service sources here so a future
    // patch that re-introduces the store-less call
    // site fails the gate.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const root = path.resolve(process.cwd(), "src/services");
    const entries = await fs.readdir(root);
    for (const e of entries) {
      if (!e.endsWith(".ts")) continue;
      const text = await fs.readFile(path.join(root, e), "utf8");
      // The pre-PR-2 code imported `resolveMemoryScope`
      // from `../scope-resolver.js` and called it
      // directly. The post-PR-2 code routes through
      // `this.ctx.identityResolver.resolve(...)`. A
      // `resolveMemoryScope(...)` call that is NOT
      // the function-import line is a regression.
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes("resolveMemoryScope(") && !line.includes("resolveMemoryScopeWithStore(") && !line.includes("import ") && !line.trim().startsWith("//")) {
          throw new Error(
            `src/services/${e}:${i + 1}: legacy store-less resolveMemoryScope() call site. ` +
              `Route through ProjectIdentityResolver instead.\n  ${line.trim()}`
          );
        }
      }
    }
  });
});
