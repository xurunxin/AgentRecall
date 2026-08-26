// test/eval-lifecycle.test.ts
//
// v1.2.0-alpha.2 (issue #55): smoke test for the
// lifecycle evaluation harness. The harness
// fixtures are checked in; the runner must
// materialise them, execute the operations
// against an in-process memory store, and emit
// a structured report. This test guards the
// harness from regressions as we add the rest
// of the 12+ fixtures in subsequent releases.

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { runCorpus, CorpusReportSchema, LifecycleCorpusManifestSchema } from "./eval-lifecycle/index.js";
import { CURRENT_SCHEMA_VERSION } from "../src/sqlite-store.js";

const corpusDir = resolve(__dirname, "eval-lifecycle");

describe("Lifecycle evaluation harness (v1.2.0-alpha.2, issue #55)", () => {
  it("parses the manifest with the v1 schema", () => {
    const manifest = LifecycleCorpusManifestSchema.parse({
      schema_version: "lifecycle.corpus.v1",
      corpus_version: "v0.1.0",
      description: "smoke test manifest",
      baselines: {},
      fixtures: ["distill-happy.json"]
    });
    expect(manifest.corpus_version).toBe("v0.1.0");
  });

  it("runs the current corpus and emits a schema-valid report", async () => {
    const report = await runCorpus({ corpusDir });
    expect(CorpusReportSchema.safeParse(report).success).toBe(true);
    // The skeleton ships 2 fixtures (distill-happy
    // + loadout-policy-fail). The runner may not
    // PASS both yet — that's the whole point of
    // growing the fixture set incrementally — but
    // the report MUST contain an entry per fixture
    // and the totals must add up.
    expect(report.results.length).toBeGreaterThanOrEqual(2);
    expect(report.totals.passed + report.totals.failed).toBe(
      report.totals.fixture_count
    );
  }, 30_000);

  it("rejects a fixture with an unknown schema version", () => {
    const result = import("./eval-lifecycle/schemas.js")
      .then((m) => m.LifecycleFixtureSchema.safeParse({
        schema_version: "lifecycle.eval.v999",
        fixture_id: "bad",
        dimension: "B.derivation",
        workstream: "distillation",
        fixture_class: "happy",
        operations: []
      }));
    return expect(result).resolves.toMatchObject({ success: false });
  });

  it("exposes the schema-version gate so a stale corpus cannot run against a too-new fixture", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(20);
  });
});
