// test/eval-lifecycle/index.ts
//
// v1.2.0-alpha.2 (issue #55): public surface of the
// lifecycle evaluation harness. The CLI entry
// (`scripts/eval-lifecycle.mjs`) and the unit test
// (`test/eval-lifecycle.test.ts`) both import from
// here so the integration is identical.

export {
  runCorpus,
  runCorpusAndWriteReports,
  loadFixture,
  loadManifest,
  type RunCorpusOptions
} from "./runner.js";

export {
  formatReportJson,
  formatReportMarkdown
} from "./report.js";

export {
  LifecycleFixtureSchema,
  LifecycleCorpusManifestSchema,
  CorpusReportSchema,
  FixtureResultSchema,
  ExpectedOutcomesSchema,
  LifecycleDimensionSchema,
  WorkstreamSchema,
  FixtureClassSchema,
  DeterminismKindSchema,
  type LifecycleFixture,
  type LifecycleCorpusManifest,
  type CorpusReport,
  type FixtureResult,
  type LifecycleDimension,
  type Workstream,
  type FixtureClass
} from "./schemas.js";
