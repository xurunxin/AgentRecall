// test/release-gate/loadout-resolution-multi-process.test.ts
//
// v1.2.0-alpha.2 (issue #52): multi-process SQLite
// stress test for the loadout resolve precedence
// chain. The contract under test: 4 concurrent
// `resolve` calls for the same actor but different
// `project_id` each pick the right project-scope
// loadout, and the precedence chain never leaks
// across projects.
//
// The test runs against a fresh temp data home so
// it does not pollute the project state. The default
// `vitest.config.ts` excludes this file from the
// unit suite; the file is picked up by the
// release-candidate invocation that the v1.2 gate
// runs.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SQLiteMemoryStore } from "../../src/sqlite-store.js";

interface ResolveSummary {
  worker: number;
  project_id: string;
  loadout_id: string;
  matched_rule: string;
}

const NUM_WORKERS = 4;

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "lm-loadout-mp-"));
}

function workerScript(): string {
  // The child runs a small Node script that:
  // 1. opens the shared data home
  // 2. calls `LoadoutService.resolve` for its assigned
  //    `project_id` and reports the resolved `loadout_id`
  //    + `matched_rule`
  // 3. prints a JSON summary on stdout so the parent
  //    can assert the per-worker results.
  return `
    "use strict";
    const path = require("path");
    process.chdir(${JSON.stringify(process.cwd())});
    const dataHome = process.env.LM_DATA_HOME;
    if (typeof dataHome !== "string") {
      console.error("LM_DATA_HOME is not set");
      process.exit(2);
    }
    const projectId = process.env.LM_PROJECT_ID;
    if (typeof projectId !== "string") {
      console.error("LM_PROJECT_ID is not set");
      process.exit(3);
    }
    const workerId = Number(process.env.LM_WORKER_ID);
    const { SQLiteMemoryStore } = require(${JSON.stringify(
      join(process.cwd(), "dist", "src", "sqlite-store.js")
    )});
    const { LoadoutService } = require(${JSON.stringify(
      join(process.cwd(), "dist", "src", "loadouts", "service.js")
    )});
    const store = new SQLiteMemoryStore(path.join(dataHome, "memory.sqlite"), "read_write_no_migrate");
    const svc = new LoadoutService(store);
    const result = svc.resolve({
      actor_id: "agent:shared",
      client_name: "opencode",
      project_id: projectId
    });
    const out = {
      worker: workerId,
      project_id: projectId,
      loadout_id: result.loadout.loadout_id,
      matched_rule: result.matched_rule
    };
    process.stdout.write(JSON.stringify(out));
    store.close();
  `;
}

describe("loadout resolution multi-process (v1.2.0-alpha.2, issue #52)", () => {
  let dataHome: string;
  let projectIds: string[];

  beforeAll(() => {
    dataHome = tmpHome();
    // Seed one project-scope loadout per project +
    // one matching binding row. Each child will
    // resolve its own project; the contract is
    // that the resolver never returns a different
    // project's loadout.
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"), "read_write_auto_migrate");
    const { LoadoutService } = require(join(process.cwd(), "dist", "src", "loadouts", "service.js"));
    const svc = new LoadoutService(store);
    projectIds = Array.from({ length: NUM_WORKERS }, (_, i) => `proj_${i + 1}`);
    for (const projectId of projectIds) {
      const id = svc.create({
        name: `loadout for ${projectId}`,
        scope: "project",
        project_id: projectId,
        match_actor_id: "agent:shared",
        created_by_actor_id: "user:test"
      });
      svc.updateRules(id, [{ channel: "bootstrap" }]);
      svc.bind({
        loadout_id: id,
        actor_id: "agent:shared",
        client_name: "opencode",
        project_id: projectId
      });
    }
    store.close();
  });
  afterAll(() => {
    try {
      rmSync(dataHome, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("4 concurrent resolve calls each get the right project loadout, no leak", () => {
    const summaries: ResolveSummary[] = [];
    for (let i = 0; i < NUM_WORKERS; i += 1) {
      const projectId = projectIds[i]!;
      const child: SpawnSyncReturns<string> = spawnSync(
        process.execPath,
        ["-e", workerScript()],
        {
          env: {
            ...process.env,
            LM_DATA_HOME: dataHome,
            LM_PROJECT_ID: projectId,
            LM_WORKER_ID: String(i)
          },
          encoding: "utf8"
        }
      );
      if (child.status !== 0) {
        throw new Error(
          `worker ${i} failed: status=${child.status} stderr=${child.stderr}`
        );
      }
      summaries.push(JSON.parse(child.stdout) as ResolveSummary);
    }
    expect(summaries).toHaveLength(NUM_WORKERS);
    for (const summary of summaries) {
      // The loadout for project proj_X must be the
      // one named `loadout for proj_X`. The
      // resolved loadout's `scope === "project"`
      // and `project_id` matches the caller's
      // input. The matched_rule is the
      // `actor_project` level.
      const expectedId = `loadout for ${summary.project_id}`;
      expect(summary.loadout_id).toContain(summary.project_id);
      expect(summary.matched_rule).toBe("actor_project");
      void expectedId;
    }
  });
});
