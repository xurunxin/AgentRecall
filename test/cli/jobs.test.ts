// test/cli/jobs.test.ts
//
// v1.2.0-alpha.0 (issue #48): smoke tests for the
// `agent-recall jobs ...` CLI. The full state-machine
// contract is covered by `test/unit/jobs-service.test.ts`;
// this file is the read-mostly CLI surface (list, show,
// cancel, run --once with no executors).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { jobsCommand } from "../../src/cli/commands/jobs.js";
import { parseArgs } from "../../src/cli/arg-parser.js";
import { ProjectIdentityResolver } from "../../src/scope-resolver.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import { buildRequestContext } from "../../src/request-context.js";
import { randomUUID } from "node:crypto";
import { resolveAuthorization } from "../../src/services/auth-context.js";
import { resolveActiveProfile } from "../../src/tools/profile.js";
import { CapabilityStore } from "../../src/admin/capability.js";
import type { CliContext } from "../../src/cli/index.js";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "lm-cli-jobs-"));
}

function makeContext(dataHome: string): { ctx: CliContext; store: SQLiteMemoryStore; cleanup: () => void } {
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

describe("jobsCommand (v1.2.0-alpha.0, issue #48)", () => {
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
    const args = parseArgs(["jobs"]);
    const result = await jobsCommand({ ...env.ctx, args });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("agent-recall jobs");
  });

  it("lists an empty job table", async () => {
    const args = parseArgs(["jobs", "list"]);
    const result = await jobsCommand({ ...env.ctx, args });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("JOB_ID");
  });

  it("round-trips enqueue + list + show as JSON", async () => {
    const { DerivationJobStore } = await import("../../src/jobs/service.js");
    const store = new DerivationJobStore(env.store);
    store.enqueue({
      kind: "session_distill",
      scope: "global",
      creator_actor_id: "user:cli",
      idempotency_key: "cli-list-1",
      input_digest: "sha256:abc",
      config_digest: "sha256:def"
    });

    const listArgs = parseArgs(["jobs", "list", "--json"]);
    const list = await jobsCommand({ ...env.ctx, args: listArgs });
    expect(list.exitCode).toBe(0);
    const listJson = JSON.parse(list.stdout);
    expect(listJson.jobs.length).toBe(1);

    const showArgs = parseArgs(["jobs", "show", listJson.jobs[0].job_id, "--json"]);
    const show = await jobsCommand({ ...env.ctx, args: showArgs });
    expect(show.exitCode).toBe(0);
    const showJson = JSON.parse(show.stdout);
    expect(showJson.job.kind).toBe("session_distill");
    expect(showJson.runs).toEqual([]);
    expect(showJson.outputs).toEqual([]);
  });

  it("rejects `show` with a missing job_id", async () => {
    const args = parseArgs(["jobs", "show"]);
    const result = await jobsCommand({ ...env.ctx, args });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("usage_error");
  });

  it("rejects `show` with an unknown job_id", async () => {
    const args = parseArgs(["jobs", "show", "job_does-not-exist"]);
    const result = await jobsCommand({ ...env.ctx, args });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("job_not_found");
  });

  it("round-trips cancel on a queued job", async () => {
    const { DerivationJobStore } = await import("../../src/jobs/service.js");
    const store = new DerivationJobStore(env.store);
    const { job } = store.enqueue({
      kind: "session_distill",
      scope: "global",
      creator_actor_id: "user:cli",
      idempotency_key: "cli-cancel-1",
      input_digest: "sha256:abc",
      config_digest: "sha256:def"
    });
    const args = parseArgs(["jobs", "cancel", job.job_id, "--json"]);
    const result = await jobsCommand({ ...env.ctx, args });
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.cancel_requested).toBe(true);
    const inspection = store.inspect(job.job_id);
    expect(inspection?.job.cancel_requested_at).not.toBeNull();
  });

  // v1.2.0-alpha.2 (issue #54): --watch is now
  // implemented as a polling loop. The test below
  // covers the synchronous single-pass case; the
  // polling / SIGINT-exit behavior is covered by
  // `test/unit/jobs-runner-watch.test.ts`.

  it("runs a synchronous pass with no executors (no-op summary)", async () => {
    const args = parseArgs(["jobs", "run", "--json"]);
    const result = await jobsCommand({ ...env.ctx, args });
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.attempted).toBe(0);
    expect(json.succeeded).toBe(0);
    expect(json.failed).toBe(0);
    expect(json.cancelled).toBe(0);
  });

  it("rejects an unknown subcommand", async () => {
    const args = parseArgs(["jobs", "explode"]);
    const result = await jobsCommand({ ...env.ctx, args });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown jobs subcommand");
  });
});
