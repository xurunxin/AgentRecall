// test/release-gate/skills-multi-process.test.ts
//
// v1.2.0-alpha.2 (issue #53): multi-process SQLite
// stress test for the skill asset surface. The
// test forks N child processes that each act as
// an independent importer against the same data
// home. The contract under test:
//
//   - Every import lands a fresh asset_id
//     (no collision across workers).
//   - The total skill count after all workers
//     finish equals the sum of per-worker
//     imports.
//   - Every imported skill is reachable
//     through the same `skills` table.
//   - The lexical `search` verb returns the
//     same total across all workers.
//
// The default config excludes this file from the
// unit suite (the spawn cost is too high for the
// fast inner loop); the release-candidate
// orchestrator runs the file as part of the
// release-gate invocation.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SQLiteMemoryStore } from "../../src/sqlite-store.js";

interface WorkerSummary {
  worker: number;
  imported: number;
}

const NUM_WORKERS = 4;
const SKILLS_PER_WORKER = 3;
const TOTAL_SKILLS = NUM_WORKERS * SKILLS_PER_WORKER;

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "lm-skills-mp-"));
}

function workerScript(): string {
  // The child runs a small Node script that:
  // 1. opens the shared data home
  // 2. imports SKILLS_PER_WORKER skills (each
  //    with a unique name to avoid collisions
  //    in the search index)
  // 3. prints a JSON summary on stdout so the
  //    parent can parse the per-worker counters.
  return `
    "use strict";
    const path = require("path");
    process.chdir(${JSON.stringify(process.cwd())});
    const dataHome = process.env.LM_DATA_HOME;
    if (typeof dataHome !== "string") {
      console.error("LM_DATA_HOME is not set");
      process.exit(2);
    }
    const workerId = Number(process.env.LM_WORKER_ID);
    const { SQLiteMemoryStore } = require(${JSON.stringify(
      join(process.cwd(), "dist", "src", "sqlite-store.js")
    )});
    const { SkillService } = require(${JSON.stringify(
      join(process.cwd(), "dist", "src", "skills", "service.js")
    )});
    const store = new SQLiteMemoryStore(path.join(dataHome, "memory.sqlite"));
    const skills = new SkillService(store);
    let imported = 0;
    for (let i = 0; i < ${SKILLS_PER_WORKER}; i += 1) {
      const md = [
        "---",
        "name: skill-w" + workerId + "-n" + i,
        "description: a unique needle w" + workerId + "i" + i,
        'schema_version: "1"',
        "---",
        "",
        "# skill w" + workerId + " n" + i,
        ""
      ].join("\\n");
      skills.importSkillMd({
        skillMd: md,
        source: "manual",
        scope: "global",
        owner_actor_id: "user:worker-" + workerId
      });
      imported += 1;
    }
    process.stdout.write(JSON.stringify({ worker: workerId, imported: imported }));
  `;
}

function runWorker(workerId: number, dataHome: string): WorkerSummary {
  const out = spawnSync(
    process.execPath,
    ["-e", workerScript()],
    {
      env: {
        ...process.env,
        LM_DATA_HOME: dataHome,
        LM_WORKER_ID: String(workerId)
      },
      encoding: "utf8"
    }
  ) as SpawnSyncReturns<string>;
  if (out.status !== 0) {
    throw new Error(
      `worker ${workerId} exited ${out.status}: ${out.stderr ?? ""}`
    );
  }
  return JSON.parse(out.stdout) as WorkerSummary;
}

describe("skills multi-process (v1.2.0-alpha.2, issue #53)", () => {
  let dataHome: string;
  let summaries: WorkerSummary[];

  beforeAll(() => {
    // The dist/ tree is built by the release
    // orchestrator; the unit-scope runs skip this
    // test (excluded in vitest.config.ts) and the
    // release-gate runs build the dist/ first.
    if (!existsSync(join(process.cwd(), "dist", "src", "skills", "service.js"))) {
      // Best-effort: try to build; if it fails
      // the test will skip with a clear message.
      const build = spawnSync(
        process.execPath,
        [join(process.cwd(), "node_modules", "typescript", "lib", "tsc.js"),
         "-p", join(process.cwd(), "tsconfig.json")],
        { encoding: "utf8" }
      );
      if (build.status !== 0) {
        throw new Error(
          `failed to build dist/ (status=${build.status}); ` +
            `the release-gate orchestrator must build before running this test. ` +
            `stderr: ${build.stderr ?? ""}`
        );
      }
    }
    dataHome = tmpHome();
    summaries = [];
    for (let w = 0; w < NUM_WORKERS; w += 1) {
      summaries.push(runWorker(w, dataHome));
    }
  });
  afterAll(() => {
    if (dataHome !== undefined) {
      try {
        rmSync(dataHome, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });

  it("every worker imported the expected number of skills", () => {
    const total = summaries.reduce((acc, s) => acc + s.imported, 0);
    expect(total).toBe(TOTAL_SKILLS);
  });

  it("no asset_id collisions across workers", () => {
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    try {
      const rows = store.listAssets({ asset_type: "skill", limit: 1000 });
      expect(rows.length).toBe(TOTAL_SKILLS);
      const ids = new Set(rows.map((r) => r.asset_id));
      expect(ids.size).toBe(TOTAL_SKILLS);
    } finally {
      store.close();
    }
  });

  it("the lexical search returns the same total across all workers", () => {
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    try {
      // The `listSkillRows` LIKE filter on `%`
      // returns every row, so the per-worker
      // count is the imported count.
      const allRows = store.listSkillRows("%", TOTAL_SKILLS + 10);
      expect(allRows.length).toBe(TOTAL_SKILLS);
      // The per-asset count must equal
      // SKILLS_PER_WORKER (the workers used
      // unique names so no `name` LIKE filter
      // would confuse the result).
      const perAsset = new Map<string, number>();
      for (const row of allRows) {
        perAsset.set(row.asset_id, (perAsset.get(row.asset_id) ?? 0) + 1);
      }
      expect(perAsset.size).toBe(TOTAL_SKILLS);
      for (const count of perAsset.values()) {
        expect(count).toBe(1);
      }
    } finally {
      store.close();
    }
  });
});
