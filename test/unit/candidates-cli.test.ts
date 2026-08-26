// test/unit/candidates-cli.test.ts
//
// v1.2.0-alpha.2 (issue #50): CLI tests for the
// `agent-recall candidates ...` subcommand and the
// `agent-recall sessions distill <id>` path. The CLI
// surface is the only place an operator can review +
// apply a candidate end-to-end without going through
// the MCP server.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { candidatesCommand } from "../../src/cli/commands/candidates.js";
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
  return mkdtempSync(join(tmpdir(), "lm-cli-candidates-"));
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

function writeBundleWithDecision(dir: string): string {
  const header = {
    schema_version: "1",
    bundle_id: "bundle-cand-1",
    source_kind: "opencode",
    source_version: "1.0.0",
    source_instance_id: "instance-cand",
    source_session_id: `oc-cand-${Date.now()}`,
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
  const decisionEvent = {
    schema_version: "1",
    source_kind: "opencode",
    source_version: "1.0.0",
    source_instance_id: "instance-cand",
    source_session_id: header.source_session_id,
    project_id: null,
    actor_id: "user:tester",
    client_name: "opencode",
    client_version: "1.0.0",
    event_id: "evt_cand_1",
    sequence: 0,
    turn_id: "turn_1",
    event_type: "decision_confirmed",
    role: "assistant",
    content: "Use ripgrep for fast text search.",
    content_digest: "sha256:" + "c".repeat(64),
    timestamp: "2026-08-25T10:00:00.000Z",
    sensitivity: "normal",
    redaction_flags: [],
    metadata: {}
  };
  const file = join(dir, "bundle.jsonl");
  writeFileSync(
    file,
    JSON.stringify(header) + "\n" + JSON.stringify(decisionEvent) + "\n",
    "utf8"
  );
  return file;
}

describe("candidates + sessions distill (v1.2.0-alpha.2, issue #50)", () => {
  let dataHome: string;
  let env: ReturnType<typeof makeContext>;
  let workDir: string;

  beforeEach(() => {
    dataHome = tmpHome();
    env = makeContext(dataHome);
    workDir = mkdtempSync(join(tmpdir(), "lm-cli-candidates-bundle-"));
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

  it("prints help when no candidates subcommand is given", async () => {
    const args = parseArgs(["candidates"]);
    const result = await candidatesCommand({ ...env.ctx, args });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("agent-recall candidates");
  });

  it("runs the full sessions-distill + candidates list / show / accept / reject / apply path", async () => {
    // 1. Ingest a JSONL bundle.
    const file = writeBundleWithDecision(workDir);
    const ingest = await sessionsCommand({
      ...env.ctx,
      args: parseArgs(["sessions", "ingest", file, "--json"])
    });
    expect(ingest.exitCode).toBe(0);
    const ingestJson = JSON.parse(ingest.stdout) as { session_id: string };
    expect(ingestJson.session_id).toMatch(/^sess_/);

    // 2. Distill the session.
    const distill = await sessionsCommand({
      ...env.ctx,
      args: parseArgs(["sessions", "distill", ingestJson.session_id, "--json"])
    });
    expect(distill.exitCode).toBe(0);
    const distillJson = JSON.parse(distill.stdout) as { job_id: string; state: string };
    expect(distillJson.state).toBe("succeeded");

    // 3. List candidates for the distill job.
    const list = await candidatesCommand({
      ...env.ctx,
      args: parseArgs(["candidates", "list", "--job", distillJson.job_id, "--json"])
    });
    expect(list.exitCode).toBe(0);
    const listJson = JSON.parse(list.stdout) as { candidates: Array<{ candidate_id: string; state: string }> };
    expect(listJson.candidates.length).toBe(1);
    const candidateId = listJson.candidates[0]!.candidate_id;
    expect(listJson.candidates[0]!.state).toBe("proposed");

    // 4. Show a single candidate.
    const show = await candidatesCommand({
      ...env.ctx,
      args: parseArgs(["candidates", "show", candidateId, "--json"])
    });
    expect(show.exitCode).toBe(0);
    const showJson = JSON.parse(show.stdout) as { candidate: { candidate_id: string }; evidence: unknown[]; actions: unknown[] };
    expect(showJson.candidate.candidate_id).toBe(candidateId);
    expect(showJson.evidence.length).toBe(1);
    expect(showJson.actions.length).toBe(1);

    // 5. Reject the candidate (a different path from
    // accept/apply so we exercise both).
    const reject = await candidatesCommand({
      ...env.ctx,
      args: parseArgs(["candidates", "reject", candidateId, "--json"])
    });
    expect(reject.exitCode).toBe(0);
    const rejectJson = JSON.parse(reject.stdout) as { state: string };
    expect(rejectJson.state).toBe("rejected");

    // 6. Apply on a rejected candidate must fail.
    const apply = await candidatesCommand({
      ...env.ctx,
      args: parseArgs(["candidates", "apply", candidateId, "--json"])
    });
    expect(apply.exitCode).toBe(1);
    expect(apply.stderr).toMatch(/candidate_not_accepted/);
  });

  it("runs an accept + apply happy path", async () => {
    const file = writeBundleWithDecision(workDir);
    const ingest = await sessionsCommand({
      ...env.ctx,
      args: parseArgs(["sessions", "ingest", file, "--json"])
    });
    const ingestJson = JSON.parse(ingest.stdout) as { session_id: string };
    const distill = await sessionsCommand({
      ...env.ctx,
      args: parseArgs(["sessions", "distill", ingestJson.session_id, "--json"])
    });
    const distillJson = JSON.parse(distill.stdout) as { job_id: string };
    const list = await candidatesCommand({
      ...env.ctx,
      args: parseArgs(["candidates", "list", "--job", distillJson.job_id, "--json"])
    });
    const listJson = JSON.parse(list.stdout) as { candidates: Array<{ candidate_id: string }> };
    const candidateId = listJson.candidates[0]!.candidate_id;
    const accept = await candidatesCommand({
      ...env.ctx,
      args: parseArgs(["candidates", "accept", candidateId, "--json"])
    });
    expect(accept.exitCode).toBe(0);
    const apply = await candidatesCommand({
      ...env.ctx,
      args: parseArgs(["candidates", "apply", candidateId, "--json"])
    });
    expect(apply.exitCode).toBe(0);
    const applyJson = JSON.parse(apply.stdout) as { applied: number; applied_memory_ids: string[] };
    expect(applyJson.applied).toBe(1);
    expect(applyJson.applied_memory_ids).toHaveLength(1);
  });

  it("rejects a missing candidate_id on show / accept / reject / apply", async () => {
    const show = await candidatesCommand({
      ...env.ctx,
      args: parseArgs(["candidates", "show"])
    });
    expect(show.exitCode).toBe(1);
    expect(show.stderr).toContain("usage_error");

    const accept = await candidatesCommand({
      ...env.ctx,
      args: parseArgs(["candidates", "accept"])
    });
    expect(accept.exitCode).toBe(1);
    expect(accept.stderr).toContain("usage_error");

    const reject = await candidatesCommand({
      ...env.ctx,
      args: parseArgs(["candidates", "reject"])
    });
    expect(reject.exitCode).toBe(1);
    expect(reject.stderr).toContain("usage_error");

    const apply = await candidatesCommand({
      ...env.ctx,
      args: parseArgs(["candidates", "apply"])
    });
    expect(apply.exitCode).toBe(1);
    expect(apply.stderr).toContain("usage_error");
  });

  it("returns a candidate_not_found for an unknown id on show", async () => {
    const show = await candidatesCommand({
      ...env.ctx,
      args: parseArgs(["candidates", "show", "cand_does_not_exist", "--json"])
    });
    expect(show.exitCode).toBe(1);
    expect(show.stderr).toMatch(/candidate_not_found/);
  });

  it("rejects an unknown candidates subcommand", async () => {
    const result = await candidatesCommand({
      ...env.ctx,
      args: parseArgs(["candidates", "explode"])
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown candidates subcommand");
  });
});
