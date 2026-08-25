// test/cli/assets.test.ts
//
// v1.2.0-alpha.1 (issue #51): CLI smoke tests for
// the `agent-recall assets ...` subcommand.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { assetsCommand } from "../../src/cli/commands/assets.js";
import { parseArgs } from "../../src/cli/arg-parser.js";
import { ProjectIdentityResolver } from "../../src/scope-resolver.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import { buildRequestContext } from "../../src/request-context.js";
import { resolveAuthorization } from "../../src/services/auth-context.js";
import { resolveActiveProfile } from "../../src/tools/profile.js";
import { CapabilityStore } from "../../src/admin/capability.js";
import type { CliContext } from "../../src/cli/index.js";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "lm-cli-assets-"));
}

function makeContext(dataHome: string): {
  ctx: CliContext;
  store: SQLiteMemoryStore;
  cleanup: () => void;
} {
  const dbPath = join(dataHome, "memory.sqlite");
  const store = new SQLiteMemoryStore(dbPath);
  const identityResolver = new ProjectIdentityResolver(store, "user:cli", false);
  const ctx = buildRequestContext({
    actor_override: "user:cli",
    client_name: "agent-recall-cli",
    client_version: "0.0.0",
    session_id: `cli-pid-${process.pid}`,
    request_id: randomUUID()
  });
  const activeProfile = resolveActiveProfile({});
  const capability = new CapabilityStore(dataHome, { persistent: true });
  const authorization = resolveAuthorization(
    { activeProfile, hasCapability: capability.hasCapability() },
    { kind: "read", restrictedAllowed: false }
  );
  return {
    ctx: {
      dataHome,
      args: parseArgs([]),
      store,
      identityResolver,
      ctx,
      authorization,
      actorMaxSensitivity: authorization.max_sensitivity
    },
    store,
    cleanup: () => {
      try {
        store.close();
      } catch {
        // already closed
      }
    }
  };
}

function seedMemory(store: SQLiteMemoryStore): string {
  const id = "mem_aaaaaaaaaaaaaaaaaaaaaaaa";
  const now = "2026-08-25T10:00:00.000Z";
  store.insertEntry({
    id,
    scope: "global",
    project_id: null,
    project_path: null,
    type: "fact",
    topic: "test",
    title: "seed",
    body: "seed body",
    tags: [],
    source: { kind: "user", ref: "test" },
    importance: 3,
    confidence: 5,
    status: "active",
    created_at: now,
    updated_at: now,
    last_accessed_at: null,
    last_accessed_by: undefined,
    access_count: 0,
    expires_at: null,
    review_after: null,
    supersedes: [],
    superseded_by: null,
    token_estimate: 1,
    char_count: 9,
    revision: 1,
    writer_actor_id: "user:test",
    content_hash: null,
    pinned: 0,
    trust_level: "agent_observed",
    sensitivity: "normal",
    valid_from: null,
    valid_until: null,
    deleted_at: null,
    tier: "working",
    metadata: {}
  });
  return id;
}

describe("assetsCommand (v1.2.0-alpha.1, issue #51)", () => {
  let dataHome: string;
  let env: ReturnType<typeof makeContext>;

  beforeEach(() => {
    dataHome = tmpHome();
    env = makeContext(dataHome);
  });
  afterEach(() => {
    env.cleanup();
    try {
      rmSync(dataHome, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("prints help when no subcommand is given", async () => {
    const args = parseArgs(["assets"]);
    const result = await assetsCommand({ ...env.ctx, args });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("agent-recall assets");
  });

  it("creates a memory_ref asset and round-trips through list / show / history", async () => {
    seedMemory(env.store);

    const createArgs = parseArgs([
      "assets",
      "create-memory-ref",
      "--scope", "global",
      "--memory-id", "mem_aaaaaaaaaaaaaaaaaaaaaaaa",
      "--memory-revision", "1",
      "--json"
    ]);
    const create = await assetsCommand({ ...env.ctx, args: createArgs });
    expect(create.exitCode).toBe(0);
    const created = JSON.parse(create.stdout);
    expect(created.asset_id).toMatch(/^asset_/);
    expect(created.version).toBe(1);

    const listArgs = parseArgs(["assets", "list", "--json"]);
    const list = await assetsCommand({ ...env.ctx, args: listArgs });
    expect(list.exitCode).toBe(0);
    const listJson = JSON.parse(list.stdout);
    expect(listJson.assets.length).toBe(1);

    const showArgs = parseArgs(["assets", "show", created.asset_id, "--json"]);
    const show = await assetsCommand({ ...env.ctx, args: showArgs });
    expect(show.exitCode).toBe(0);
    const showJson = JSON.parse(show.stdout);
    expect(showJson.asset.asset_id).toBe(created.asset_id);
    expect(showJson.payload.memory_id).toBe("mem_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(showJson.current_version.version).toBe(1);

    const historyArgs = parseArgs(["assets", "history", created.asset_id, "--json"]);
    const history = await assetsCommand({ ...env.ctx, args: historyArgs });
    expect(history.exitCode).toBe(0);
    const historyJson = JSON.parse(history.stdout);
    expect(historyJson.versions.length).toBe(1);
  });

  it("transitions the lifecycle through draft -> active -> archived", async () => {
    seedMemory(env.store);
    const createArgs = parseArgs([
      "assets",
      "create-memory-ref",
      "--scope", "global",
      "--memory-id", "mem_aaaaaaaaaaaaaaaaaaaaaaaa",
      "--memory-revision", "1",
      "--json"
    ]);
    const create = await assetsCommand({ ...env.ctx, args: createArgs });
    const { asset_id } = JSON.parse(create.stdout);

    const activateArgs = parseArgs(["assets", "lifecycle", asset_id, "active", "--json"]);
    const activate = await assetsCommand({ ...env.ctx, args: activateArgs });
    expect(activate.exitCode).toBe(0);

    const archiveArgs = parseArgs(["assets", "lifecycle", asset_id, "archived", "--json"]);
    const archive = await assetsCommand({ ...env.ctx, args: archiveArgs });
    expect(archive.exitCode).toBe(0);

    const reverseArgs = parseArgs(["assets", "lifecycle", asset_id, "active"]);
    const reverse = await assetsCommand({ ...env.ctx, args: reverseArgs });
    expect(reverse.exitCode).toBe(1);
    expect(reverse.stderr).toMatch(/asset_already_terminal/);
  });

  it("rejects an unknown subcommand", async () => {
    const args = parseArgs(["assets", "explode"]);
    const result = await assetsCommand({ ...env.ctx, args });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown assets subcommand");
  });

  it("rejects create-memory-ref with a missing --scope", async () => {
    const args = parseArgs([
      "assets",
      "create-memory-ref",
      "--memory-id", "mem_aaaaaaaaaaaaaaaaaaaaaaaa",
      "--memory-revision", "1"
    ]);
    const result = await assetsCommand({ ...env.ctx, args });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/--scope/);
  });
});
