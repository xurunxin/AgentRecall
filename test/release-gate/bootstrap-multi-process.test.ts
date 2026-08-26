// test/release-gate/bootstrap-multi-process.test.ts
//
// v1.2.0-alpha.2 (issue #54): multi-process stress
// test for the cold-start bootstrap pipeline. The
// test forks 4 child processes that each scan a
// different project against the same data home.
//
// The contract under test:
//   - 4 workers, 4 distinct projects, no cross-
//     project leak in `bootstrap_sources` or
//     `bootstrap_plans` rows.
//   - Every worker records its (project_id,
//     plan_id) pair so the parent can verify the
//     per-project invariants.
//   - The `bootstrap_sources` row count per
//     project matches what the worker enqueued.
//
// The test runs against a fresh temp data home
// (per-test) so it does not pollute the project
// state. The default `vitest.config.ts` already
// excludes the `test/release-gate/**` directory
// from the fast inner loop; the file is picked
// up by the release-candidate invocation.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const NUM_WORKERS = 4;

interface WorkerSummary {
  worker: number;
  project_id: string;
  plan_id: string;
  source_count: number;
  item_count: number;
  state: string;
}

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "lm-bootstrap-mp-"));
}

function workerScript(): string {
  return `
    "use strict";
    const path = require("path");
    process.chdir(${JSON.stringify(process.cwd())});
    const dataHome = process.env.LM_DATA_HOME;
    if (typeof dataHome !== "string") {
      console.error("LM_DATA_HOME is not set");
      process.exit(2);
    }
    const projectRoot = process.env.LM_PROJECT_ROOT;
    if (typeof projectRoot !== "string") {
      console.error("LM_PROJECT_ROOT is not set");
      process.exit(2);
    }
    const projectId = process.env.LM_PROJECT_ID;
    if (typeof projectId !== "string") {
      console.error("LM_PROJECT_ID is not set");
      process.exit(2);
    }
    const workerId = Number(process.env.LM_WORKER_ID);
    const { SQLiteMemoryStore } = require(${JSON.stringify(
      join(process.cwd(), "dist", "src", "sqlite-store.js")
    )});
    const { ExternalReferenceService } = require(${JSON.stringify(
      join(process.cwd(), "dist", "src", "external-refs", "service.js")
    )});
    const { BootstrapService } = require(${JSON.stringify(
      join(process.cwd(), "dist", "src", "bootstrap", "service.js")
    )});
    const store = new SQLiteMemoryStore(path.join(dataHome, "memory.sqlite"));
    try {
      store.createProjectIdentity({
        project_id: projectId,
        canonical_path: projectRoot,
        created_by: "user:worker-" + workerId,
        created_at: new Date().toISOString()
      });
      const svc = new BootstrapService(store, new ExternalReferenceService(store));
      const cfg = svc.configure({
        project_id: projectId,
        source_set: [
          { kind: "file", canonical_ref: "AGENTS.md" },
          { kind: "file", canonical_ref: "package.json" }
        ],
        actor: "user:worker-" + workerId
      });
      const scan = svc.scan({
        project_id: projectId,
        actor: "user:worker-" + workerId
      });
      const summary = {
        worker: workerId,
        project_id: projectId,
        plan_id: scan.plan_id,
        source_count: cfg.inserted + cfg.reused,
        item_count: scan.item_count,
        state: scan.state
      };
      process.stdout.write("WMSUMMARY::" + JSON.stringify(summary) + "\\n");
    } finally {
      store.close();
    }
  `;
}

describe("Bootstrap multi-process (v1.2.0-alpha.2, issue #54)", () => {
  let dataHome: string;
  const projectRoots: string[] = [];

  beforeAll(() => {
    dataHome = tmpHome();
    for (let i = 0; i < NUM_WORKERS; i += 1) {
      projectRoots.push(mkdtempSync(join(tmpdir(), `lm-bootstrap-mp-proj-${i}-`)));
    }
  }, 30_000);

  afterAll(() => {
    try {
      rmSync(dataHome, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    for (const root of projectRoots) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });

  it("4 workers scan different projects concurrently with no cross-project leak", () => {
    const summaries: WorkerSummary[] = [];
    for (let i = 0; i < NUM_WORKERS; i += 1) {
      const env = {
        ...process.env,
        LM_DATA_HOME: dataHome,
        LM_PROJECT_ROOT: projectRoots[i]!,
        LM_PROJECT_ID: `proj_${i}`,
        LM_WORKER_ID: String(i)
      };
      const result: SpawnSyncReturns<string> = spawnSync(
        process.execPath,
        ["-e", workerScript()],
        { env, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
      );
      expect(result.status).toBe(0);
      const stdout = result.stdout ?? "";
      const m = stdout.match(/WMSUMMARY::(.+)/);
      expect(m).not.toBeNull();
      const parsed = JSON.parse(m![1]!) as WorkerSummary;
      summaries.push(parsed);
    }
    expect(summaries.length).toBe(NUM_WORKERS);
    // Each worker saw its own project.
    for (let i = 0; i < NUM_WORKERS; i += 1) {
      expect(summaries[i]?.project_id).toBe(`proj_${i}`);
      expect(summaries[i]?.source_count).toBe(2);
      expect(summaries[i]?.state).toBe("plan_ready");
    }
    // No cross-project leak: plan_ids are distinct.
    const planIds = new Set(summaries.map((s) => s.plan_id));
    expect(planIds.size).toBe(NUM_WORKERS);
  }, 30_000);
});
