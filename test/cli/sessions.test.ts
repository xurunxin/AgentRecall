// test/cli/sessions.test.ts
//
// v1.2.0-alpha.1 (issue #49): CLI smoke tests for
// the `agent-recall sessions ...` subcommand. The
// state-machine contract is covered by
// `test/unit/sessions-service.test.ts`; this file
// is the read-mostly CLI surface.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { sessionsCommand } from "../../src/cli/commands/sessions.js";
import { parseArgs } from "../../src/cli/arg-parser.js";
import { ProjectIdentityResolver } from "../../src/scope-resolver.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import { buildRequestContext } from "../../src/request-context.js";
import { resolveAuthorization } from "../../src/services/auth-context.js";
import { resolveActiveProfile } from "../../src/tools/profile.js";
import { CapabilityStore } from "../../src/admin/capability.js";
import type { CliContext } from "../../src/cli/index.js";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "lm-cli-sessions-"));
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

function writeBundle(dir: string): string {
  const header = {
    schema_version: "1",
    bundle_id: "bundle-test-1",
    source_kind: "opencode",
    source_version: "1.0.0",
    source_instance_id: "instance-1",
    source_session_id: `oc-session-${Date.now()}`,
    project_id: null,
    actor_id: "user:tester",
    client_name: "opencode",
    client_version: "1.0.0",
    scope: "global",
    sensitivity: "normal",
    started_at: "2026-08-25T10:00:00.000Z",
    ended_at: "2026-08-25T10:01:00.000Z",
    adapter_id: "jsonl",
    adapter_version: "1.0.0",
    events: []
  };
  const ev = {
    schema_version: "1",
    source_kind: "opencode",
    source_version: "1.0.0",
    source_instance_id: "instance-1",
    source_session_id: header.source_session_id,
    project_id: null,
    actor_id: "user:tester",
    client_name: "opencode",
    client_version: "1.0.0",
    event_id: "evt_1",
    sequence: 0,
    turn_id: "turn_1",
    event_type: "user_message",
    role: "user",
    content: "hello",
    content_digest: "sha256:" + "a".repeat(64),
    timestamp: "2026-08-25T10:00:00.000Z",
    sensitivity: "normal",
    redaction_flags: [],
    metadata: {}
  };
  const file = join(dir, "bundle.jsonl");
  writeFileSync(file, JSON.stringify(header) + "\n" + JSON.stringify(ev) + "\n", "utf8");
  return file;
}

describe("sessionsCommand (v1.2.0-alpha.1, issue #49)", () => {
  let dataHome: string;
  let env: ReturnType<typeof makeContext>;
  let workDir: string;

  beforeEach(() => {
    dataHome = tmpHome();
    env = makeContext(dataHome);
    workDir = mkdtempSync(join(tmpdir(), "lm-cli-sessions-bundle-"));
  });
  afterEach(() => {
    env.cleanup();
    try {
      rmSync(dataHome, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("prints help when no subcommand is given", async () => {
    const args = parseArgs(["sessions"]);
    const result = await sessionsCommand({ ...env.ctx, args });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("agent-recall sessions");
  });

  it("inspects a JSONL bundle without ingesting", async () => {
    const file = writeBundle(workDir);
    const args = parseArgs(["sessions", "inspect", file]);
    const result = await sessionsCommand({ ...env.ctx, args });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("events: 1");
  });

  it("ingests a JSONL bundle and lists it", async () => {
    const file = writeBundle(workDir);
    const ingestArgs = parseArgs(["sessions", "ingest", file, "--json"]);
    const ingest = await sessionsCommand({ ...env.ctx, args: ingestArgs });
    expect(ingest.exitCode).toBe(0);
    const json = JSON.parse(ingest.stdout);
    expect(json.session_id).toMatch(/^sess_/);

    const listArgs = parseArgs(["sessions", "list", "--json"]);
    const list = await sessionsCommand({ ...env.ctx, args: listArgs });
    expect(list.exitCode).toBe(0);
    const listJson = JSON.parse(list.stdout);
    expect(listJson.sessions.length).toBe(1);

    const showArgs = parseArgs(["sessions", "show", json.session_id, "--json"]);
    const show = await sessionsCommand({ ...env.ctx, args: showArgs });
    expect(show.exitCode).toBe(0);
    const showJson = JSON.parse(show.stdout);
    expect(showJson.events.length).toBe(1);
    expect(showJson.events[0].event_id).toBe("evt_1");
  });

  it("rejects a missing bundle path on inspect", async () => {
    const args = parseArgs(["sessions", "inspect"]);
    const result = await sessionsCommand({ ...env.ctx, args });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("usage_error");
  });

  it("rejects a malformed bundle on ingest", async () => {
    const file = join(workDir, "bad.jsonl");
    writeFileSync(file, "{not valid json}\n", "utf8");
    const args = parseArgs(["sessions", "ingest", file]);
    const result = await sessionsCommand({ ...env.ctx, args });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/adapter_error/);
  });

  it("forgets a session and removes it from the list", async () => {
    const file = writeBundle(workDir);
    const ingestArgs = parseArgs(["sessions", "ingest", file, "--json"]);
    const ingest = await sessionsCommand({ ...env.ctx, args: ingestArgs });
    const json = JSON.parse(ingest.stdout);
    const forgetArgs = parseArgs(["sessions", "forget", json.session_id]);
    const forget = await sessionsCommand({ ...env.ctx, args: forgetArgs });
    expect(forget.exitCode).toBe(0);
    const showArgs = parseArgs(["sessions", "show", json.session_id]);
    const show = await sessionsCommand({ ...env.ctx, args: showArgs });
    expect(show.exitCode).toBe(1);
    expect(show.stderr).toMatch(/session_not_found/);
  });

  it("rejects an unknown subcommand", async () => {
    const args = parseArgs(["sessions", "explode"]);
    const result = await sessionsCommand({ ...env.ctx, args });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown sessions subcommand");
  });
});
