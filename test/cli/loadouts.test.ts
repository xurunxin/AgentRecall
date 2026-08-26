// test/cli/loadouts.test.ts
//
// v1.2.0-alpha.2 (issue #52): CLI smoke tests for
// the `agent-recall loadouts ...` subcommand.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { loadoutsCommand } from "../../src/cli/commands/loadouts.js";
import { parseArgs } from "../../src/cli/arg-parser.js";
import { ProjectIdentityResolver } from "../../src/scope-resolver.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import { buildRequestContext } from "../../src/request-context.js";
import { resolveAuthorization } from "../../src/services/auth-context.js";
import { resolveActiveProfile } from "../../src/tools/profile.js";
import { CapabilityStore } from "../../src/admin/capability.js";
import type { CliContext } from "../../src/cli/index.js";
import type { ParsedArgs } from "../../src/cli/arg-parser.js";

function makeContext(dataHome: string, argv: string[]): {
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
  const args: ParsedArgs = parseArgs(argv);
  return {
    ctx: {
      dataHome,
      args,
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

describe("loadouts CLI (v1.2.0-alpha.2, issue #52)", () => {
  let dataHome: string;
  let cleanup: () => void;
  let store: SQLiteMemoryStore;
  let ctx: CliContext;

  beforeEach(() => {
    dataHome = mkdtempSync(join(tmpdir(), "lm-cli-loadouts-"));
    const made = makeContext(dataHome, ["loadouts"]);
    store = made.store;
    ctx = made.ctx;
    cleanup = made.cleanup;
  });
  afterEach(() => {
    cleanup();
    try {
      rmSync(dataHome, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("create + update + bind + resolve round-trip", async () => {
    // create
    const made = makeContext(dataHome, [
      "loadouts",
      "create",
      "--name",
      "test",
      "--scope",
      "global",
      "--actor",
      "agent:claude",
      "--client",
      "opencode"
    ]);
    store = made.store;
    ctx = made.ctx;
    const createResult = await loadoutsCommand(ctx);
    expect(createResult.exitCode).toBe(0);
    const createJson = JSON.parse(createResult.stdout) as { loadout_id: string };
    const loadoutId = createJson.loadout_id;
    expect(loadoutId).toMatch(/^loadout_/);

    // update
    const updateCtx = makeContext(dataHome, [
      "loadouts",
      "update",
      loadoutId,
      "--channel",
      "bootstrap",
      "--max-items",
      "16",
      "--max-chars",
      "4000"
    ]).ctx;
    const updateResult = await loadoutsCommand(updateCtx);
    expect(updateResult.exitCode).toBe(0);
    expect(updateResult.stdout).toMatch(/version 2/);

    // bind
    const bindCtx = makeContext(dataHome, [
      "loadouts",
      "bind",
      loadoutId,
      "--actor",
      "agent:claude",
      "--client",
      "opencode",
      "--priority",
      "5"
    ]).ctx;
    const bindResult = await loadoutsCommand(bindCtx);
    expect(bindResult.exitCode).toBe(0);
    const bindJson = JSON.parse(bindResult.stdout) as { binding_id: string };

    // resolve
    const resolveCtx = makeContext(dataHome, [
      "loadouts",
      "resolve",
      "--actor",
      "agent:claude",
      "--client",
      "opencode"
    ]).ctx;
    const resolveResult = await loadoutsCommand(resolveCtx);
    expect(resolveResult.exitCode).toBe(0);
    const resolvedJson = JSON.parse(resolveResult.stdout) as {
      loadout: { loadout_id: string; version: number };
      matched_rule: string;
      binding: { binding_id: string } | null;
    };
    expect(resolvedJson.loadout.loadout_id).toBe(loadoutId);
    expect(resolvedJson.loadout.version).toBe(2);
    expect(resolvedJson.matched_rule).toBe("actor_project");
    expect(resolvedJson.binding?.binding_id).toBe(bindJson.binding_id);
  });

  it("updateRules cas_mismatch surfaces as a clean exit 1", async () => {
    const made = makeContext(dataHome, [
      "loadouts",
      "create",
      "--name",
      "x",
      "--scope",
      "global"
    ]);
    store = made.store;
    ctx = made.ctx;
    const createResult = await loadoutsCommand(ctx);
    expect(createResult.exitCode).toBe(0);
    const createJson = JSON.parse(createResult.stdout) as { loadout_id: string };
    const loadoutId = createJson.loadout_id;

    // Tamper with the loadout version to simulate a concurrent writer.
    (store as unknown as { db: { exec: (sql: string) => void } }).db.exec(
      `UPDATE agent_loadouts SET version = 99 WHERE loadout_id = '${loadoutId}'`
    );

    const updateCtx = makeContext(dataHome, [
      "loadouts",
      "update",
      loadoutId,
      "--channel",
      "bootstrap"
    ]).ctx;
    const updateResult = await loadoutsCommand(updateCtx);
    expect(updateResult.exitCode).toBe(1);
    expect(updateResult.stderr).toMatch(/cas_mismatch/);
  });

  it("lists loadouts and shows one", async () => {
    const made = makeContext(dataHome, [
      "loadouts",
      "create",
      "--name",
      "x",
      "--scope",
      "global"
    ]);
    store = made.store;
    ctx = made.ctx;
    const createResult = await loadoutsCommand(ctx);
    expect(createResult.exitCode).toBe(0);
    const { loadout_id } = JSON.parse(createResult.stdout) as { loadout_id: string };

    const listCtx = makeContext(dataHome, ["loadouts", "list", "--json"]).ctx;
    const listResult = await loadoutsCommand(listCtx);
    expect(listResult.exitCode).toBe(0);
    const list = JSON.parse(listResult.stdout) as { loadouts: Array<{ loadout_id: string }> };
    expect(list.loadouts.map((l) => l.loadout_id)).toContain(loadout_id);

    const showCtx = makeContext(dataHome, ["loadouts", "show", loadout_id, "--json"]).ctx;
    const showResult = await loadoutsCommand(showCtx);
    expect(showResult.exitCode).toBe(0);
    const shown = JSON.parse(showResult.stdout) as { loadout: { loadout_id: string } };
    expect(shown.loadout.loadout_id).toBe(loadout_id);
  });
});
