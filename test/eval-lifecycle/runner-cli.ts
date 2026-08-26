// test/eval-lifecycle/runner-cli.ts
//
// v1.2.0-alpha.2 (issue #55): the runner CLI entry
// point (invoked by `scripts/eval-lifecycle.mjs`).
// Kept as a tiny wrapper so the harness's pure
// API (`runCorpusAndWriteReports`) stays unit-
// testable independently of the Node CLI shim.

import { runCorpusAndWriteReports } from "./runner.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let corpusDir = "test/eval-lifecycle";
  let outDir = "artifacts/eval-lifecycle";
  let bail = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--corpus" && args[i + 1] !== undefined) {
      corpusDir = args[i + 1]!;
      i += 1;
    } else if (arg === "--out" && args[i + 1] !== undefined) {
      outDir = args[i + 1]!;
      i += 1;
    } else if (arg === "--bail") {
      bail = true;
    }
  }
  const report = await runCorpusAndWriteReports({ corpusDir, outDir, bailOnFailure: bail });
  // v1.2.0-alpha.3 (issue #55c): the runner now
  // fails closed on quality baselines as well as
  // on per-fixture failures. A baseline miss is
  // a release-blocking event; the exit code is 1
  // for either failure mode so CI surfaces the
  // problem without having to inspect
  // `report.json`. The two reasons arrays
  // (`safety_gate.reasons` and `baselines.reasons`)
  // are written to the report for human review.
  if (report.totals.failed > 0) {
    process.exit(1);
  }
  if (report.baselines !== undefined && !report.baselines.passed) {
    console.error(
      "Quality baselines failed:\n" +
        report.baselines.reasons.map((r) => `  - ${r}`).join("\n")
    );
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("eval-lifecycle harness crashed:", err);
  process.exit(2);
});
