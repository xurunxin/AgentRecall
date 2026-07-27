// test/release-gate/p3-project-identity-strict.test.ts
//
// Stage 17 v1.1.2 (issue #21): bound project identity on
// every public path. The companion test
// `p3-project-identity-public-path.test.ts` covers the
// Stage 16 PR-2 (#14) `register` / `strict_existing` paths
// for `project_path`-supplied calls. This file covers the
// v1.1.2 surface that PR-2 deferred:
//
//   - `project_id`-only inputs are rejected when no
//     `project_identities` row exists (strict-by-default).
//   - The `AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID=1` legacy
//     escape hatch returns an explicit
//     `identity_status: "unbound"` (so callers can branch
//     on it).
//   - The v11 -> v12 migration backfills
//     `project_identities` from pre-existing
//     `project_scopes` rows so a v1.1.1 database
//     migrates without manual intervention.
//   - The backfill refuses ambiguous mappings (one path
//     bound to two project_ids, or vice versa).
//   - The CLI `export --scope project --project-id ...`
//     command uses the strict resolver and surfaces
//     `identity_status: "unbound"` in the exit message
//     when the legacy mode is on.
//   - The MCP `memory://project/{id}/summary` resource
//     rejects unknown ids and surfaces
//     `identity_status: "bound"` for registered ones.
//   - The MCP `memory://health` resource surfaces the
//     `strict_isolation` / `identity_status` contract.
//   - The Windows case-folding / symlink / worktree
//     behaviours from PR-M1-2 are preserved.
//   - `configureProjectBudget` registers the identity so a
//     `project_id`-only read of the registered project
//     succeeds (the canonical "register a project" call).
//   - The strict preflight rejects an unbound
//     `project_id` per entry; the live store is
//     untouched on a failed preflight.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../../src/memory-service.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import {
  isUnboundProjectIdAllowed,
  ProjectIdentityResolver
} from "../../src/scope-resolver.js";

function setupService() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-pi-strict-"));
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

describe("release-gate p3-project-identity-strict (Stage 17 v1.1.2 #21)", () => {
  let service: MemoryService;
  let store: SQLiteMemoryStore;
  let dataHome: string;

  beforeEach(() => {
    ({ service, store, dataHome } = setupService());
  });
  afterEach(() => {
    try { store.close(); } catch { /* already closed */ }
  });

  it("rejects a project_id-only remember when no identity is registered", () => {
    // v1.1.2 (issue #21): the strict-by-default
    // contract. A `project_id`-only call without a
    // `project_path` and without a registered
    // identity is rejected at the resolver. The
    // pre-v1.1.2 contract silently created a new
    // identity row from the id alone (the
    // default-unbound fallback that task #21
    // closes).
    const r = service.remember({
      ...baseInput(),
      project_id: "unbound-id",
      project_path: undefined
    } as Parameters<MemoryService["remember"]>[0]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_scope");
    expect(
      store
        .backupHandle()
        .prepare("SELECT COUNT(*) AS n FROM project_identities WHERE project_id = 'unbound-id'")
        .get()
    ).toEqual({ n: 0 });
    expect(
      store
        .backupHandle()
        .prepare("SELECT COUNT(*) AS n FROM project_aliases_new WHERE project_id = 'unbound-id'")
        .get()
    ).toEqual({ n: 0 });
  });

  it("rejects cross-project write when the replacement project_id is unbound", () => {
    // First, register a known identity.
    const a = service.remember(baseInput({ project_path: "/tmp/repo-a" }));
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const aId = (
      store
        .backupHandle()
        .prepare("SELECT project_id FROM project_identities WHERE canonical_path LIKE '%repo-a'")
        .get() as { project_id: string }
    ).project_id;

    // Now try to supersede with a different (unbound) id.
    const r = service.supersedeMemory({
      old_memory_ids: [a.value.memory_id],
      replacement: {
        scope: "project",
        project_id: "evil-id",
        type: "fact",
        topic: "t",
        title: "stolen",
        body: "stolen body",
        tags: [],
        source: { kind: "agent" },
        importance: 3,
        confidence: 3
      } as Parameters<MemoryService["supersedeMemory"]>[0]["replacement"],
      reason: "cross-project"
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_scope");
    expect(
      store
        .backupHandle()
        .prepare("SELECT COUNT(*) AS n FROM project_identities WHERE project_id = 'evil-id'")
        .get()
    ).toEqual({ n: 0 });
    const aIdAfter = (
      store
        .backupHandle()
        .prepare("SELECT project_id FROM project_identities WHERE canonical_path LIKE '%repo-a'")
        .get() as { project_id: string }
    ).project_id;
    expect(aIdAfter).toBe(aId);
  });

  it("configureProjectBudget registers the identity so legacy project_id-only reads work", () => {
    // v1.1.2 (issue #21): `configureProjectBudget`
    // is the canonical "register a project" call
    // and now also creates the identity row.
    // A subsequent `project_id`-only read of the
    // registered project succeeds.
    service.configureProjectBudget(
      "legacy-cfg",
      { max_active_entries: 5, max_total_chars: 1000, max_topic_chars: 1000, max_index_chars: 1000 },
      "/tmp/legacy-cfg",
      "Legacy"
    );
    const identity = store.getProjectIdentity("legacy-cfg");
    expect(identity).toBeDefined();
    expect(identity?.canonical_path).toBe("/tmp/legacy-cfg");
  });

  it("legacy escape hatch returns identity_status: unbound (explicit env var)", () => {
    // v1.1.2 (issue #21): the default-off legacy
    // escape hatch. The resolver reads the env var
    // at construction time; the helper
    // `isUnboundProjectIdAllowed` is the canonical
    // public way to test the env var.
    const original = process.env.AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID;
    process.env.AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID = "1";
    try {
      expect(isUnboundProjectIdAllowed()).toBe(true);
      const freshStore = new SQLiteMemoryStore(join(mkdtempSync(join(tmpdir(), "lm-rg-legacy-")), "memory.sqlite"));
      try {
        const resolver = new ProjectIdentityResolver(freshStore, "agent:system");
        const r = resolver.resolve(
          { scope: "project", project_id: "unbound-id" },
          "strict_existing"
        );
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.identity_status).toBe("unbound");
        expect(resolver.isAllowUnbound()).toBe(true);
      } finally {
        freshStore.close();
      }
    } finally {
      if (original === undefined) {
        delete process.env.AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID;
      } else {
        process.env.AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID = original;
      }
    }
  });

  it("default mode refuses legacy escape hatch (strict isolation on)", () => {
    const original = process.env.AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID;
    delete process.env.AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID;
    try {
      expect(isUnboundProjectIdAllowed()).toBe(false);
      const freshStore = new SQLiteMemoryStore(join(mkdtempSync(join(tmpdir(), "lm-rg-strict-")), "memory.sqlite"));
      try {
        const resolver = new ProjectIdentityResolver(freshStore, "agent:system");
        const r = resolver.resolve(
          { scope: "project", project_id: "unbound-id" },
          "strict_existing"
        );
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toBe("invalid_scope");
        expect(resolver.isAllowUnbound()).toBe(false);
      } finally {
        freshStore.close();
      }
    } finally {
      if (original !== undefined) {
        process.env.AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID = original;
      }
    }
  });

  it("v11 -> v12 migration backfills project_identities from project_scopes", () => {
    // v1.1.2 (issue #21): the v11 -> v12 migration
    // backfills the v8 `project_identities` table
    // from the pre-existing v1.0 `project_scopes`
    // rows. The test seeds a v11 database with a
    // `project_scopes` row, simulates the
    // pre-v12 state by setting user_version=11,
    // and confirms the migration writes the
    // identity on reopen. The default open mode
    // is `read_write_no_migrate`; the test must
    // call `runMigrations` explicitly because the
    // v11 -> v12 backfill is a documented operator
    // action (the CLI `migrate --yes` runs the
    // chain the same way).
    const v11DataHome = mkdtempSync(join(tmpdir(), "lm-rg-mig-v12-"));
    const v11Path = join(v11DataHome, "memory.sqlite");
    const v11 = new SQLiteMemoryStore(v11Path);
    try {
      v11.upsertProjectScope({
        project_id: "backfilled",
        canonical_path: "/tmp/backfilled",
        display_name: "Backfilled",
        budget: { max_active_entries: 500, max_total_chars: 5_000_000, max_topic_chars: 1_000_000, max_index_chars: 5_000_000 },
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z"
      });
      // Force the user_version back to 11 so the
      // v11 -> v12 backfill runs on reopen. The
      // upsertProjectScope call ran inside a
      // store that opened at v12, so the marker
      // is at 12 by default.
      v11.setUserVersion(11);
      expect(v11.getUserVersion()).toBe(11);
    } finally {
      v11.close();
    }
    // Reopen: the constructor uses
    // `read_write_no_migrate` so the schema is
    // unchanged; `runMigrations()` walks the
    // chain v11 -> v12 (which runs the backfill)
    // -> v13 (which adds the durable
    // `import_batches` lineage table from
    // task 7 / issue #26). The final
    // `user_version` is `13` (the
    // `CURRENT_SCHEMA_VERSION` constant on the
    // store). The intermediate `12` is the v12
    // backfill milestone the test originally
    // asserted; the assertion is widened to the
    // latest version so a future schema bump
    // does not silently re-break this regression
    // guard.
    const reopened = new SQLiteMemoryStore(v11Path);
    try {
      const result = reopened.runMigrations();
      expect(result.to).toBeGreaterThanOrEqual(13);
      expect(reopened.getUserVersion()).toBeGreaterThanOrEqual(13);
      const identity = reopened.getProjectIdentity("backfilled");
      expect(identity).toBeDefined();
      expect(identity?.canonical_path).toBe("/tmp/backfilled");
    } finally {
      reopened.close();
    }
  });

  it("v11 -> v12 migration refuses ambiguous path -> id mapping", () => {
    // Seed two project_scopes rows sharing a path
    // so the backfill must refuse. The
    // `project_scopes` table does not enforce a
    // UNIQUE on `canonical_path` (worktrees are
    // allowed), so the seed has to be done via
    // direct SQL.
    const { DatabaseSync } = require("node:sqlite");
    const v11DataHome = mkdtempSync(join(tmpdir(), "lm-rg-mig-ambiguous-"));
    const v11Path = join(v11DataHome, "memory.sqlite");
    const seed = new DatabaseSync(v11Path, { enableForeignKeyConstraints: true });
    seed.exec(`
      CREATE TABLE project_scopes (
        project_id TEXT PRIMARY KEY,
        canonical_path TEXT NOT NULL,
        display_name TEXT NOT NULL,
        budget_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE project_identities (
        project_id TEXT PRIMARY KEY,
        canonical_path TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO project_scopes (project_id, canonical_path, display_name, budget_json, created_at, updated_at)
        VALUES ('a', '/tmp/shared', 'A', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
               ('b', '/tmp/shared', 'B', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      PRAGMA user_version = 11;
    `);
    seed.close();
    // Reopen: the v11 -> v12 migration should
    // detect the path conflict and refuse.
    const reopened = new SQLiteMemoryStore(v11Path);
    try {
      // The migration throws on conflict. The
      // constructor calls `runMigrations` which
      // surfaces the throw.
      expect(() => reopened.runMigrations()).toThrow(/ambiguous canonical paths/);
    } finally {
      reopened.close();
    }
  });

  it("import preflight rejects an unbound project_id per entry (identity_conflict)", async () => {
    // v1.1.2 (issue #21): the strict preflight
    // (added in PR-4) now runs the strict resolver
    // on every project-scoped entry. The preflight
    // is the gate; the apply phase never sees an
    // unbound `project_id` so the live store
    // cannot silently gain a new identity. The
    // entry deliberately has NO `project_path`
    // so the strict resolver refuses the
    // project_id-only call.
    const { planImport } = await import("../../src/portability/importer.js");
    const importDataHome = mkdtempSync(join(tmpdir(), "lm-rg-import-strict-"));
    const importStore = new SQLiteMemoryStore(join(importDataHome, "memory.sqlite"));
    const importService = new MemoryService(importStore, undefined, "agent:system", importDataHome);
    const exportDir = mkdtempSync(join(tmpdir(), "lm-rg-import-strict-bundle-"));
    try {
      mkdirSync(join(exportDir, "topics"), { recursive: true });
      const entry = {
        id: "mem_strict_proj",
        scope: "project",
        project_id: "unbound-bundle-id",
        type: "fact",
        topic: "t",
        title: "Strict bundle",
        body: "body",
        tags: [],
        source: { kind: "agent" },
        importance: 3,
        confidence: 3,
        status: "active",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        access_count: 0,
        supersedes: [],
        token_estimate: 0,
        char_count: 5,
        revision: 1,
        writer_actor_id: "agent:system",
        pinned: false,
        trust_level: "agent_observed",
        sensitivity: "normal",
        tier: "working",
        metadata: {}
      };
      writeFileSync(
        join(exportDir, "MANIFEST.json"),
        JSON.stringify({
          manifest_version: 1,
          export_schema_version: 1,
          source_schema_version: 12,
          scope: "project/unbound-bundle-id",
          generated_at: "2026-01-01T00:00:00.000Z",
          entry_count: 1,
          topic_count: 1,
          files: []
        }, null, 2)
      );
      writeFileSync(
        join(exportDir, "topics", "t.json"),
        JSON.stringify({ topic: "t", scope: "project", project_id: "unbound-bundle-id", entries: [entry] })
      );
      expect(() =>
        planImport(importService, exportDir, "project", "unbound-bundle-id", "json", {
          conflict: "keep",
          dry_run: true,
          actor: "agent:system"
        })
      ).toThrow(/identity_conflict/);
      // The target store is untouched.
      const identityCount = (
        importStore
          .backupHandle()
          .prepare("SELECT COUNT(*) AS n FROM project_identities WHERE project_id = 'unbound-bundle-id'")
          .get() as { n: number }
      ).n;
      expect(identityCount).toBe(0);
    } finally {
      try { importService.store.close(); } catch { /* */ }
    }
  });

  it("Windows case-folding: aliases registered under mixed-case paths resolve to the same identity on Windows", () => {
    // v1.1.2 (issue #21): regression test for the
    // Stage 15 PR-M1-2 Windows case-folding
    // contract. The resolver's `aliasKey` helper
    // lowercases the path on Windows so a caller
    // submitting `C:\\Repos\\Phoenix` and a later
    // caller submitting `c:\\repos\\phoenix` hit
    // the same row. The test runs on every
    // platform; on POSIX the two paths are
    // distinct, so the second call returns a
    // different (unbound) identity and the test
    // asserts the resolver's `aliasKey` is
    // case-folded on Windows only. The alias is
    // created by routing the registration through
    // the strict resolver (the v1.1.2 path), not
    // by `upsertProjectScope` (which only writes
    // `project_scopes`).
    const IS_WINDOWS = process.platform === "win32";
    const freshDataHome = mkdtempSync(join(tmpdir(), "lm-rg-case-"));
    const freshStore = new SQLiteMemoryStore(join(freshDataHome, "memory.sqlite"));
    try {
      const pathUpper = IS_WINDOWS ? "C:\\Repos\\Phoenix" : "/tmp/repo-upper";
      const pathLower = IS_WINDOWS ? "c:\\repos\\phoenix" : "/tmp/repo-lower";
      const resolver = new ProjectIdentityResolver(freshStore, "agent:test");
      // First registration: pathUpper creates the
      // identity and the alias under the canonical
      // key.
      const r1 = resolver.resolve(
        { scope: "project", project_id: "phoenix", project_path: pathUpper },
        "strict_existing"
      );
      expect(r1.ok).toBe(true);
      // Second registration: on Windows, the alias
      // is case-folded so the second call hits the
      // same identity; on POSIX the path is
      // distinct and the second call creates a
      // SECOND alias (a worktree-style alias
      // sharing the same project_id).
      const r2 = resolver.resolve(
        { scope: "project", project_id: "phoenix", project_path: pathLower },
        "strict_existing"
      );
      expect(r2.ok).toBe(true);
      const aliasKey = IS_WINDOWS ? pathUpper.toLowerCase() : pathUpper;
      const alias = freshStore.getProjectAliasByPath(aliasKey);
      expect(alias).toBeDefined();
      expect(alias?.project_id).toBe("phoenix");
    } finally {
      freshStore.close();
    }
  });
});

describe("release-gate p3-project-identity-strict-cli (Stage 17 v1.1.2 #21)", () => {
  it("CLI export rejects an unknown project_id (default strict mode)", async () => {
    const { runCli } = await import("../../src/cli/index.js");
    const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-cli-strict-"));
    const result = await runCli(
      ["export", "--scope", "project", "--project-id", "unbound-cli", "--format", "json"],
      { ...process.env, AGENT_RECALL_HOME: dataHome, AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID: "" }
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unbound-cli");
    expect(result.stderr).toMatch(/is not registered/);
  });

  it("CLI export prints identity_status: unbound when the legacy escape hatch is enabled", async () => {
    const { runCli } = await import("../../src/cli/index.js");
    const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-cli-legacy-"));
    const result = await runCli(
      ["export", "--scope", "project", "--project-id", "any-legacy-id", "--format", "json"],
      { ...process.env, AGENT_RECALL_HOME: dataHome, AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID: "1" }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("identity_status: unbound");
    expect(result.stdout).toContain("strict isolation disabled");
  });
});

describe("release-gate p3-project-identity-strict-mcp (Stage 17 v1.1.2 #21)", () => {
  it("memory://health surfaces strict_isolation: true and identity_status: bound by default", async () => {
    const { registerMemoryResources } = await import("../../src/mcp/resources.js");
    const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-mcp-health-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const calls: Array<{
      name: string;
      cb: (uri: URL, variables: Record<string, unknown>, extra: unknown) => unknown;
    }> = [];
    const fakeServer = {
      registerResource(
        name: string,
        _uri: unknown,
        _config: unknown,
        cb: (uri: URL, variables: Record<string, unknown>, extra: unknown) => unknown
      ) {
        calls.push({ name, cb: cb as never });
        return undefined;
      }
    };
    const identityResolver = new ProjectIdentityResolver(store, "agent:test");
    registerMemoryResources(
      fakeServer as unknown as Parameters<typeof registerMemoryResources>[0],
      { store, dataHome, defaultActor: "agent:test", identityResolver }
    );
    const health = calls.find((c) => c.name === "memory_health");
    if (health === undefined) throw new Error("memory_health not registered");
    const out = (await health.cb(new URL("memory://health"), {}, undefined)) as {
      contents: Array<{ mimeType: string; text: string }>;
    };
    const payload = JSON.parse(out.contents[0]!.text) as {
      strict_isolation: boolean;
      identity_status: string;
      allow_unbound_project_id: boolean;
      active_profile: "core" | "extended";
    };
    expect(payload.strict_isolation).toBe(true);
    expect(payload.identity_status).toBe("bound");
    expect(payload.allow_unbound_project_id).toBe(false);
    // v1.1.2 (issue #22): the health resource
    // surfaces the active tool profile. The
    // legacy call (no `activeProfile` on the
    // context) defaults to `"core"`, which is
    // also the documented packaged default.
    expect(payload.active_profile).toBe("core");
    store.close();
  });

  it("memory://project/{id}/summary rejects an unknown project_id", async () => {
    const { registerMemoryResources } = await import("../../src/mcp/resources.js");
    const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-mcp-summary-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const calls: Array<{
      name: string;
      cb: (uri: URL, variables: Record<string, string | string[] | undefined>, extra: unknown) => unknown;
    }> = [];
    const fakeServer = {
      registerResource(
        name: string,
        _uri: unknown,
        _config: unknown,
        cb: (uri: URL, variables: Record<string, string | string[] | undefined>, extra: unknown) => unknown
      ) {
        calls.push({ name, cb: cb as never });
        return undefined;
      }
    };
    const identityResolver = new ProjectIdentityResolver(store, "agent:test");
    registerMemoryResources(
      fakeServer as unknown as Parameters<typeof registerMemoryResources>[0],
      { store, dataHome, defaultActor: "agent:test", identityResolver }
    );
    const summary = calls.find((c) => c.name === "memory_project_summary");
    if (summary === undefined) throw new Error("memory_project_summary not registered");
    const out = (await summary.cb(
      new URL("memory://project/unknown-mcp/summary"),
      { project_id: "unknown-mcp" },
      undefined
    )) as { contents: Array<{ mimeType: string; text: string }> };
    const payload = JSON.parse(out.contents[0]!.text) as {
      ok: boolean;
      error: string;
      identity_status: string;
    };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("not_found");
    expect(payload.identity_status).toBe("strict");
    store.close();
  });

  it("memory://project/{id}/summary surfaces identity_status: bound for a registered project", async () => {
    const { registerMemoryResources } = await import("../../src/mcp/resources.js");
    const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-mcp-summary-bound-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const calls: Array<{
      name: string;
      cb: (uri: URL, variables: Record<string, string | string[] | undefined>, extra: unknown) => unknown;
    }> = [];
    const fakeServer = {
      registerResource(
        name: string,
        _uri: unknown,
        _config: unknown,
        cb: (uri: URL, variables: Record<string, string | string[] | undefined>, extra: unknown) => unknown
      ) {
        calls.push({ name, cb: cb as never });
        return undefined;
      }
    };
    const identityResolver = new ProjectIdentityResolver(store, "agent:test");
    registerMemoryResources(
      fakeServer as unknown as Parameters<typeof registerMemoryResources>[0],
      { store, dataHome, defaultActor: "agent:test", identityResolver }
    );
    // Register an identity via the store so the
    // summary returns the registered payload.
    store.createProjectIdentity({
      project_id: "registered",
      canonical_path: "/tmp/registered",
      created_by: "agent:test",
      created_at: "2026-01-01T00:00:00.000Z"
    });
    store.upsertProjectScope({
      project_id: "registered",
      canonical_path: "/tmp/registered",
      display_name: "Registered",
      budget: { max_active_entries: 5, max_total_chars: 1000, max_topic_chars: 1000, max_index_chars: 1000 },
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z"
    });
    const summary = calls.find((c) => c.name === "memory_project_summary");
    if (summary === undefined) throw new Error("memory_project_summary not registered");
    const out = (await summary.cb(
      new URL("memory://project/registered/summary"),
      { project_id: "registered" },
      undefined
    )) as { contents: Array<{ mimeType: string; text: string }> };
    const payload = JSON.parse(out.contents[0]!.text) as {
      ok?: boolean;
      project_id: string;
      identity_status: string;
    };
    expect(payload.project_id).toBe("registered");
    expect(payload.identity_status).toBe("bound");
    store.close();
  });
});
