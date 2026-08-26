// test/unit/bootstrap-cli.test.ts
//
// v1.2.0-alpha.2 (issue #54): end-to-end CLI test
// for the `agent-recall bootstrap ...` surface.
// The test wires the CLI dispatch with a real
// `SQLiteMemoryStore` + a real `BootstrapService`
// + a temp project root, runs the four
// documented verbs (configure / scan / plan show /
// plan cancel), and asserts the output.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/index.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";

function tmpDataHome(): string {
  return mkdtempSync(join(tmpdir(), "lm-bootstrap-cli-"));
}

function newDataHome(): { dataHome: string; projectRoot: string } {
  const dataHome = tmpDataHome();
  const projectRoot = mkdtempSync(join(tmpdir(), "lm-bootstrap-cli-proj-"));
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, "AGENTS.md"), "# project AGENTS\nThis is a test project.\n");
  writeFileSync(join(projectRoot, "package.json"), '{"name":"x","version":"1.0.0"}');
  // Register the project identity directly through
  // the CLI's data home. The CLI does not have a
  // `projects register` verb, so the test seeds the
  // row via a direct SQLite write on a fresh store.
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  try {
    store.createProjectIdentity({
      project_id: "proj_alpha",
      canonical_path: projectRoot,
      created_by: "user:test",
      created_at: "2026-08-25T10:00:00.000Z"
    });
  } finally {
    store.close();
  }
  return { dataHome, projectRoot };
}

describe("bootstrap CLI (v1.2.0-alpha.2, issue #54)", () => {
  let dataHome: string;
  let projectRoot: string;

  beforeEach(() => {
    const env = newDataHome();
    dataHome = env.dataHome;
    projectRoot = env.projectRoot;
  });
  afterEach(() => {
    try {
      rmSync(dataHome, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    try {
      rmSync(projectRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("configure + scan + show + cancel a plan", async () => {
    const env = {
      AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID: "1"
    };

    // configure
    const r1 = await runCli(
      [
        "bootstrap",
        "configure",
        "--project-id",
        "proj_alpha",
        "--source",
        "file:AGENTS.md,file:package.json"
      ],
      { ...process.env, ...env, AGENT_RECALL_HOME: dataHome }
    );
    expect(r1.exitCode).toBe(0);
    expect(r1.stdout).toMatch(/inserted=2/);

    // scan
    const r2 = await runCli(
      ["bootstrap", "scan", "--project-id", "proj_alpha"],
      { ...process.env, ...env, AGENT_RECALL_HOME: dataHome }
    );
    expect(r2.exitCode).toBe(0);
    const m = r2.stdout.match(/plan_id=(\S+) state=(\S+) items=(\d+)/);
    expect(m).not.toBeNull();
    const planId = m![1]!;
    expect(m![2]).toBe("plan_ready");
    expect(Number(m![3])).toBeGreaterThanOrEqual(2);

    // plan show
    const r3 = await runCli(
      ["bootstrap", "plan", "show", planId],
      { ...process.env, ...env, AGENT_RECALL_HOME: dataHome }
    );
    expect(r3.exitCode).toBe(0);
    expect(r3.stdout).toMatch(new RegExp(`plan_id:\\s+${planId}`));
    expect(r3.stdout).toMatch(/state:\s+plan_ready/);
    expect(r3.stdout).toMatch(/items \(/);

    // plan cancel
    const r4 = await runCli(
      ["bootstrap", "plan", "cancel", planId],
      { ...process.env, ...env, AGENT_RECALL_HOME: dataHome }
    );
    expect(r4.exitCode).toBe(0);
    expect(r4.stdout).toMatch(/cancelled/);
  });
});
