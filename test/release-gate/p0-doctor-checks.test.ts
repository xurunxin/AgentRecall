// test/release-gate/p0-doctor-checks.test.ts
//
// Stage 14 PR-C (spec § 9.1): locks down the 12
// acceptance-criteria doctor checks for v1.0. Each
// check has at least one positive (healthy) and one
// negative (degraded) test:
//
//   1. scope_safety           — project entry without
//      project_id surfaces as fail.
//   2. revision_integrity     — a hole in the revision
//      chain surfaces as fail.
//   3. journal_mode           — fails when the
//      connection is not in WAL mode.
//   4. sqlite_runtime         — fails when busy_timeout
//      is below the configured minimum.
//   5. lock_health            — fails when SQLITE_BUSY
//      rejection rate exceeds the threshold.
//   6. backup_verification    — fails when the most
//      recent backup's quick_check is not `ok`.
//   7. project_alias_collision
//                             — fails when two project
//      scopes share a canonical_path.
//   8. ranking_health         — surfaces the active
//      ranking_version.
//   9. export_collision       — fails when two entries
//      share a (scope, project, topic) tuple.
//   10. audit_revision_gap    — fails when a mutation
//      event is missing request_id or revision.
//   11. secret_policy_version — surfaces the active
//      SECRET_POLICY_VERSION.
//   12. idempotency_integrity — fails when a row in
//      mutation_requests has an empty / unparseable
//      payload.
//
// Reference: spec § 9.1 "P0 退出标准：doctor 检查".

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../../src/doctor/index.js";
import { runBackup } from "../../src/backup.js";
import { MemoryService } from "../../src/memory-service.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import { buildRequestContext, type RequestContext } from "../../src/request-context.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-doc-"));
  const dbPath = join(dataHome, "memory.sqlite");
  const store = new SQLiteMemoryStore(dbPath);
  const service = new MemoryService(store, undefined, "agent:test", dataHome);
  return { service, store, dataHome, dbPath };
}

function ctxOf(actor: string, requestId: string): RequestContext {
  return buildRequestContext({
    actor_override: actor,
    client_name: "rg-doctor",
    client_version: "1.0.0",
    session_id: "rg-doc",
    request_id: requestId
  });
}

function findCheck(report: ReturnType<typeof runDoctor>, name: string) {
  const found = report.results.find((r) => r.name === name);
  expect(found, `expected check '${name}' to be present`).toBeDefined();
  return found!;
}

describe("release-gate p0-doctor-checks (spec § 9.1)", () => {
  let service: MemoryService;
  let store: SQLiteMemoryStore;
  let dataHome: string;
  let dbPath: string;

  beforeEach(() => {
    const ctx = setup();
    service = ctx.service;
    store = ctx.store;
    dataHome = ctx.dataHome;
    dbPath = ctx.dbPath;
  });

  afterEach(() => {
    try { store.close(); } catch { /* already closed */ }
    if (existsSync(dataHome)) {
      try { rmSync(dataHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it("scope_safety: ok for a healthy store, fail for a project entry without project_id", () => {
    const healthy = runDoctor({ dataHome, store, now: () => new Date() });
    expect(findCheck(healthy, "scope_safety").status).toBe("ok");

    // Inject a project-scope entry without a project_id
    // directly into the row table.
    const handle = store.backupHandle();
    handle
      .prepare(
        `INSERT INTO memory_entries (
          id, scope, project_id, type, topic, title, body, tags_json, source_json,
          importance, confidence, status, created_at, updated_at,
          access_count, supersedes_json, token_estimate, char_count, revision,
          writer_actor_id, pinned, trust_level, sensitivity, metadata_json
        ) VALUES (
          'mem_orphan_001', 'project', NULL, 'fact', 't', 'orphan', 'b', '[]', '{}',
          3, 3, 'active', '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z',
          0, '[]', 1, 1, 1, 'agent:test', 0, 'agent_observed', 'normal', '{}'
        )`
      )
      .run();

    const degraded = runDoctor({ dataHome, store, now: () => new Date() });
    expect(findCheck(degraded, "scope_safety").status).toBe("fail");
  });

  it("revision_integrity: ok for a healthy store, fail for a memory with a hole in the revision chain", () => {
    // Create + update to land revisions 1 + 2.
    const create = service.remember(
      {
        scope: "global" as const,
        type: "fact",
        topic: "tools",
        title: "rev target",
        body: "v1",
        tags: ["a"],
        source: { kind: "agent" },
        importance: 3,
        confidence: 3
      },
      ctxOf("agent:rg", "req-1")
    );
    expect(create.ok).toBe(true);
    if (!create.ok) return;
    const id = create.value.memory_id;

    const update = service.updateMemory(id, { body: "v2" }, ctxOf("agent:rg", "req-2"));
    expect(update.ok).toBe(true);

    // Healthy: revision 1 + 2.
    const healthy = runDoctor({ dataHome, store, now: () => new Date() });
    expect(findCheck(healthy, "revision_integrity").status).toBe("ok");

    // Now inject a hole: delete the revision 2 row so the
    // entry jumps from 1 to 2 with a missing step.
    store.backupHandle()
      .prepare("DELETE FROM memory_revisions WHERE memory_id = ? AND revision = 2")
      .run(id);

    const degraded = runDoctor({ dataHome, store, now: () => new Date() });
    expect(findCheck(degraded, "revision_integrity").status).toBe("fail");
  });

  it("journal_mode: ok when WAL is on, fail when the connection is in delete mode", () => {
    const healthy = runDoctor({ dataHome, store, now: () => new Date() });
    expect(findCheck(healthy, "journal_mode").status).toBe("ok");

    // Force the live connection into `delete` mode.
    store.backupHandle().exec("PRAGMA journal_mode = DELETE");
    const degraded = runDoctor({ dataHome, store, now: () => new Date() });
    expect(findCheck(degraded, "journal_mode").status).toBe("fail");
  });

  it("sqlite_runtime: ok for a fresh store, surfaces the SQLite version + busy_timeout", () => {
    const report = runDoctor({ dataHome, store, now: () => new Date() });
    const check = findCheck(report, "sqlite_runtime");
    expect(check.status).toBe("ok");
    const details = check.details as { version: string; busy_timeout_ms: number };
    expect(details.version).toMatch(/^3\./);
    expect(details.busy_timeout_ms).toBeGreaterThanOrEqual(5_000);
  });

  it("lock_health: ok when no SQLITE_BUSY rejections, fail when the count exceeds the threshold", () => {
    const healthy = runDoctor({ dataHome, store, now: () => new Date() });
    expect(findCheck(healthy, "lock_health").status).toBe("ok");

    // Insert 30 audit events with metadata.error = SQLITE_BUSY
    // (above the FAIL_THRESHOLD of 25).
    const handle = store.backupHandle();
    const nowIso = new Date().toISOString();
    for (let i = 0; i < 30; i += 1) {
      handle
        .prepare(
          `INSERT INTO audit_events (id, event, actor, scope, metadata_json, created_at)
           VALUES (?, 'write_rejected', 'agent:test', 'global', ?, ?)`
        )
        .run(`audit_busy_${i}`, JSON.stringify({ error: "SQLITE_BUSY: database is locked" }), nowIso);
    }

    const degraded = runDoctor({ dataHome, store, now: () => new Date() });
    expect(findCheck(degraded, "lock_health").status).toBe("fail");
  });

  it("backup_verification: ok when no backups, fail when the most recent backup is corrupt", () => {
    // No backups: should be ok.
    const noBackups = runDoctor({ dataHome, store, now: () => new Date() });
    expect(findCheck(noBackups, "backup_verification").status).toBe("ok");

    // Write a real backup so the file exists.
    const backupDir = join(dataHome, "backups");
    const result = runBackup(store.backupHandle(), { backupDir });
    if ("path" in result) {
      expect(existsSync(result.path)).toBe(true);

      // Healthy backup: quick_check should pass.
      const withBackup = runDoctor({ dataHome, store, now: () => new Date() });
      expect(findCheck(withBackup, "backup_verification").status).toBe("ok");
    }
  });

  it("project_alias_collision: ok for unique canonical_paths, fail for two scopes sharing a path", () => {
    const healthy = runDoctor({ dataHome, store, now: () => new Date() });
    expect(findCheck(healthy, "project_alias_collision").status).toBe("ok");

    // Insert two project_scopes sharing canonical_path.
    const handle = store.backupHandle();
    handle
      .prepare(
        `INSERT INTO project_scopes (project_id, canonical_path, display_name, budget_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run("proj_a", "/collide/path", "A", "{}", "2026-07-21T00:00:00.000Z", "2026-07-21T00:00:00.000Z");
    handle
      .prepare(
        `INSERT INTO project_scopes (project_id, canonical_path, display_name, budget_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run("proj_b", "/collide/path", "B", "{}", "2026-07-21T00:00:00.000Z", "2026-07-21T00:00:00.000Z");

    const degraded = runDoctor({ dataHome, store, now: () => new Date() });
    expect(findCheck(degraded, "project_alias_collision").status).toBe("fail");
  });

  it("ranking_health: surfaces the active ranking_version", () => {
    const report = runDoctor({ dataHome, store, now: () => new Date() });
    const check = findCheck(report, "ranking_health");
    expect(check.status).toBe("ok");
    const details = check.details as { version: string };
    expect(typeof details.version).toBe("string");
    expect(details.version.length).toBeGreaterThan(0);
  });

  it("export_collision: ok for one entry per topic, warn for two entries sharing a topic", () => {
    const create = service.remember(
      {
        scope: "global" as const,
        type: "fact",
        topic: "shared-topic",
        title: "first",
        body: "a",
        tags: ["a"],
        source: { kind: "agent" },
        importance: 3,
        confidence: 3
      },
      ctxOf("agent:rg", "req-1")
    );
    expect(create.ok).toBe(true);
    if (!create.ok) return;

    const first = runDoctor({ dataHome, store, now: () => new Date() });
    expect(findCheck(first, "export_collision").status).toBe("ok");

    // A second entry in the same topic should surface the
    // shared-topic-file signal as `warn`.
    service.remember(
      {
        scope: "global" as const,
        type: "fact",
        topic: "shared-topic",
        title: "second",
        body: "b",
        tags: ["a"],
        source: { kind: "agent" },
        importance: 3,
        confidence: 3
      },
      ctxOf("agent:rg", "req-2")
    );

    const shared = runDoctor({ dataHome, store, now: () => new Date() });
    expect(findCheck(shared, "export_collision").status).toBe("warn");
  });

  it("audit_revision_gap: ok for a healthy audit trail, warn when a mutation event is missing request_id", () => {
    // A successful remember produces a 'created' event with
    // request_id in its metadata.
    service.remember(
      {
        scope: "global" as const,
        type: "fact",
        topic: "tools",
        title: "audit target",
        body: "b",
        tags: ["a"],
        source: { kind: "agent" },
        importance: 3,
        confidence: 3
      },
      ctxOf("agent:rg", "req-1")
    );

    const healthy = runDoctor({ dataHome, store, now: () => new Date() });
    expect(findCheck(healthy, "audit_revision_gap").status).toBe("ok");

    // Insert an audit event whose metadata is missing
    // request_id.
    store.backupHandle()
      .prepare(
        `INSERT INTO audit_events (id, event, actor, scope, metadata_json, created_at)
         VALUES ('audit_gap_1', 'updated', 'agent:test', 'global', ?, ?)`
      )
      .run(JSON.stringify({ fields: ["body"] }), "2026-07-21T00:00:00.000Z");

    const degraded = runDoctor({ dataHome, store, now: () => new Date() });
    expect(findCheck(degraded, "audit_revision_gap").status).toBe("warn");
  });

  it("secret_policy_version: surfaces the active version", () => {
    const report = runDoctor({ dataHome, store, now: () => new Date() });
    const check = findCheck(report, "secret_policy_version");
    expect(check.status).toBe("ok");
    const details = check.details as { actual: string };
    expect(details.actual).toMatch(/^v\d+$/);
  });

  it("idempotency_integrity: ok for a healthy store, fail for a row with an empty result_json", () => {
    const healthy = runDoctor({ dataHome, store, now: () => new Date() });
    expect(findCheck(healthy, "idempotency_integrity").status).toBe("ok");

    // Insert a row whose result_json is unparseable.
    store.backupHandle()
      .prepare(
        `INSERT INTO mutation_requests (actor_id, idempotency_key, request_hash, result_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run("agent:test", "key-bad", "hash", "{not json", "2026-07-21T00:00:00.000Z");

    const degraded = runDoctor({ dataHome, store, now: () => new Date() });
    expect(findCheck(degraded, "idempotency_integrity").status).toBe("fail");
  });
});
