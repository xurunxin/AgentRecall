# ADR 0008 — Heartbeat suppression removed + deterministic test orchestration

Date: 2026-07-28
Status: Accepted (v1.1.3 GATE-06, issue #36)
Parent gate: [#30](https://github.com/xurunxin/AgentRecall/issues/30)
Sub-issue: [#36](https://github.com/xurunxin/AgentRecall/issues/36)

## Context

The pre-v1.1.3 release-test topology had five concrete
contract violations (reproduced from sub-issue #36):

1. **`test/setup/heartbeat-filter.ts`** installed a
   `globalThis.__vitest_worker__.rpc.onTaskUpdate` Proxy
   that ate `[vitest-worker]: Timeout calling ...`
   rejections and silently resolved them. Every release-
   critical job that ran with this setup file effectively
   swallowed vitest infrastructure failures.

2. **Heavyweight suites were not isolated.** The default
   `vitest.config.ts` ran the multi-process stress,
   the MCP black-box E2E, the migration chain, and the
   extracted-artifact lifecycle alongside the unit /
   integration layer in a single vitest process. A
   failure in any one blocked every other.

3. **The least-invasive stability fix was not
   evaluated.** The heartbeat filter was added in v1.1.2
   as a tactical fix for a specific birpc RPC timeout
   (`DEFAULT_TIMEOUT = 60_000 ms` in vendored
   `node_modules/vitest/dist/chunks/index.B521nVV-.js`);
   no retrospective evaluated whether the simpler
   "don't catch + log + escalate" path would also be
   stable under the actual workload.

4. **Unhandled rejections, worker timeouts, task-update
   timeouts, child-process leaks, and test skips were
   not all release-blocking events.** A worker that
   silently died, a `it.skip` that quietly disabled a
   release-critical assertion, and an orphan temp dir
   from a stress victim were all "successful" in the
   v1.1.2 release gate.

5. **The 10,000-op stress ran on every cleanup / full-
   suite invocation, not once per intended release
   job.** `test/multi-process-stress.test.ts` is
   invoked by `npm test` (default config), the
   monolithic matrix leg, and the cleanup step — each
   invocation paid the full 8-worker / 10,000-op cost
   on the developer's machine and on every CI matrix
   leg (3 OSes × 3 invocations = 9 stress runs per
   candidate).

Plus: cleanup + diagnostic artifacts were discarded on
failure instead of preserved, and the final job
topology + expected durations were undocumented.

## Decision

### Five-job CI topology + matrix leg + aggregate

The v1.1.2 monolithic `matrix` job is replaced by
five segregated per-suite jobs (one per heavyweight
suite), a preserved cross-OS matrix leg, and a
`release-aggregate` job that gates on all six.

| Job | Suite | Vitest config | OS | Node |
|-----|-------|---------------|-----|------|
| `unit-integration` | Unit / integration layer | `vitest.config.ts` | ubuntu-latest | 24 |
| `mcp-blackbox` | MCP black-box E2E | `vitest.blackbox.config.ts` | ubuntu-latest | 24 |
| `migrations` | Migration / backup / import | `vitest.migrations.config.ts` | ubuntu-latest | 24 |
| `stress` | 10,000-op multi-process stress | `vitest.stress.config.ts` | ubuntu-latest | 24 |
| `packaged-artifact` | Extracted-artifact lifecycle | `vitest.packaged-artifact.config.ts` | ubuntu-latest | 24 |
| `matrix` | Full release-critical suite (cross-OS) | `vitest.config.ts` (default) | ubuntu + macOS + Windows | 24 |
| `release-aggregate` | Aggregator + synthetic gate | n/a | ubuntu-latest | 24 |

A failure in one suite does NOT block another. The
matrix leg preserves the 3-OS × 1-Node cross-platform
coverage that the segregated suites (single-OS) do
not give.

### `scripts/run-test-suites.mjs` (deterministic orchestrator)

The orchestrator runs every suite as a separate
`child_process.spawn('npx', ['vitest', ...])` and
captures per-suite:

- stdout + stderr (full buffer, preserved on failure)
- JUnit JSON + JUnit XML (vitest's `reporter=json` +
  `reporter=junit`)
- `cleanup_status` (orphan temp dirs, worker exits,
  test skips)
- `unhandled_rejections` + `worker_timeouts`

Every capture is written to
`<out>/junit-<suite>.{json,xml}` and
`<out>/cleanup-<suite>.json` so CI can upload them as
GitHub Actions artefacts.

The 10,000-op stress runs EXACTLY ONCE per release
job, pinned via `JOB_ID`. Two orchestrator runs inside
the same `JOB_ID` do NOT double-count; the orchestrator
writes `<out>/stress-counter-<jobId>.txt` and the CI
synthetic-gate inspects the file.

### Failure taxonomy

| Code | Trigger |
|------|---------|
| `UNHANDLED_REJECTION` | Synthetic `process.on('unhandledRejection')` in a vitest worker |
| `WORKER_TIMEOUT` | Synthetic vitest worker timeout |
| `TEST_SKIP` | Release-critical `it.skip` / `describe.skip` surfaced |
| `CHILD_PROCESS_LEAK` | Orphan temp dirs / orphan workers after the suite exited |
| `SUITE_EXIT_NONZERO` | Vitest exit code was non-zero |

Any non-zero count in any field is a release-blocking
event. The aggregator
(`scripts/release-evidence.mjs`) promotes the
non-zero count to a release failure.

### `scripts/synthesize-vitest-failures.mjs` (synthetic injector)

The CI synthetic-gate calls the injector in the
`release-aggregate` job:

```
node scripts/synthesize-vitest-failures.mjs --emit unhandled-rejection
node scripts/synthesize-vitest-failures.mjs --emit worker-timeout
```

The injector writes a temporary vitest setup file +
test file + config to a `lm-synth-*` work dir, then
spawns `npx vitest run --config <tmp>/vitest.synthetic.config.ts`.
The setup file emits `Promise.reject(...)` at module
load (so the orchestrator's stderr pattern detector
flags `UNHANDLED_REJECTION`) or schedules a keep-alive
`setInterval(...)` (so the orchestrator's deadline
flags `WORKER_TIMEOUT`).

### `vitest.setup.ts` replaces `test/setup/heartbeat-filter.ts`

The heartbeat-filter Proxy is DELETED. The new
`vitest.setup.ts`:

- `process.on('unhandledRejection', reason)`: log the
  rejection via the canonical `[vitest.setup] FAILURE
  kind=unhandledRejection ...` shape. In release mode
  (`AGENT_RECALL_RELEASE_MODE=1`), THROW the rejection
  so the worker exits non-zero and vitest surfaces the
  failure to the caller.
- `process.on('uncaughtException', err)`: log + re-emit;
  release mode escalates to a thrown error.
- `process.on('exit', ...)`: best-effort cleanup of
  `lm-stress-home-*` + `lm-stress-barrier-*` temp dirs
  under `os.tmpdir()`. Idempotent + never throws.

The setup file is wired into all five vitest configs
(default + 4 per-suite).

### Aggregator extension

`scripts/release-evidence.mjs` reads
`<RUNNER_TEMP>/aggregate.json` (written by the
orchestrator) and surfaces a per-suite breakdown
under `test_summary.suites.<name>`:

```json
{
  "test_summary": {
    "passed": 1234,
    "failed": 0,
    "skipped": 0,
    "total": 1234,
    "totals_from": "actual",
    "suites": {
      "unit-integration":  { "passed": 800, "failed": 0, "skipped": 0, "unhandled_rejections": 0, "worker_timeouts": 0 },
      "mcp-blackbox":      { "passed": 50,  "failed": 0, "skipped": 0, "unhandled_rejections": 0, "worker_timeouts": 0 },
      "migrations":        { "passed": 100, "failed": 0, "skipped": 0, "unhandled_rejections": 0, "worker_timeouts": 0 },
      "stress":            { "passed": 7,   "failed": 0, "skipped": 0, "unhandled_rejections": 0, "worker_timeouts": 0 },
      "packaged-artifact": { "passed": 11,  "failed": 0, "skipped": 0, "unhandled_rejections": 0, "worker_timeouts": 0 }
    }
  }
}
```

A non-zero value in any `unhandled_rejections`,
`worker_timeouts`, `failed`, or `skipped` field fails
the evidence collection.

## Consequences

### Positive

- Release-critical jobs no longer eat vitest infrastructure
  warnings. The heartbeat-filter deletion makes a silent
  `it.skip` or a swallowed worker timeout impossible.
- Heavyweight suites are isolated. A stress-test failure
  does not block the unit / integration layer; a
  packaged-artifact failure does not block the migration
  chain.
- The 10,000-op stress runs once per release job (pinned
  via `JOB_ID`), not 9 times per candidate.
- The synthetic injector + the orchestrator's pattern
  detector give the release-aggregate job a deterministic
  gate against any future regression in the unhandled-
  rejection handling.
- The per-suite `npm run test:<suite>` scripts give
  developers a fast feedback loop (`test:unit`,
  `test:blackbox`, `test:migrations`, `test:stress`,
  `test:packaged-artifact`).

### Negative

- The per-suite configs are explicit file lists (not
  globs). Adding a new test file to a suite requires a
  one-line `include` edit on the corresponding
  `vitest.<suite>.config.ts`.
- The orchestrator's `aggregate.json` is the source of
  truth for the per-suite breakdown; the legacy `test-
  summary-*.json` fragments (from the v1.1.2 monolithic
  `npm test` path) still work but no longer carry the
  per-suite shape.
- The CI job count went from `1 matrix × 3 OSes + 1
  mcp-blackbox-extracted × 3 OSes + 1 verify-artifact-
  globs + 1 record-evidence = 8 jobs` to
  `5 suites × 1 OS + 1 matrix × 3 OSes + 1 aggregate = 9
  jobs`. The cost is the 1 added per-suite job; the win
  is the segregation.

### Compatibility

- The legacy `npm test` keeps running the default
  config (`vitest.config.ts`) for local dev backward
  compatibility. The heavy suites are still excluded
  from the default config (they're hosted by their own
  per-suite configs).
- `scripts/release-evidence.mjs`'s legacy
  `--assert-vitest` path is unchanged. The new
  per-suite `test_summary.suites` field is populated
  only by the main() path (the CI aggregate job
  invokes the orchestrator + then the aggregator).

## Alternatives considered

1. **Add a `--fail-on-unhandled-rejection` flag to vitest
   + remove the heartbeat filter.** Rejected because
   vitest's flag operates at the worker level, not the
   `globalThis` Proxy level. A custom setup file is the
   minimum-viable change.

2. **Run all 5 per-suite jobs on 3 OSes (15 jobs).**
   Rejected because the matrix leg already provides
   cross-OS coverage; running the heavy suites on all
   3 OSes is redundant + triples CI cost.

3. **Run the heavy suites in parallel via a single
   `npm run test:all-suites` invocation.** Rejected
   because a failure in one suite blocks the others'
   JUnit + cleanup bundle uploads; the segregated
   topology is the only way to gate suites
   independently.

## References

- `docs/superpowers/specs/2026-07-28-v1.1.3-gate-06-deterministic-design.md`
- `docs/superpowers/plans/2026-07-28-v1.1.3-gate-06-deterministic-plan.md`
- `scripts/run-test-suites.mjs` (the orchestrator)
- `scripts/synthesize-vitest-failures.mjs` (the synthetic injector)
- `vitest.setup.ts` (replaces `test/setup/heartbeat-filter.ts`)
- `vitest.{blackbox,migrations,stress,packaged-artifact}.config.ts` (per-suite configs)
- `.github/workflows/release-candidate.yml` (5-job topology)
- `test/release-gate/v113-deterministic-orchestration.test.ts` (the GREEN contract)
- `test/release-gate/v113-stress-once.test.ts` (the JOB_ID pinning contract)