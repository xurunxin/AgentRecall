# Release test topology — operator guide

> **🌏 Language**: English only. 本指南暂无中文版本。  
> **Implementation version**: v1.1.3.

This guide documents the v1.1.3 GATE-06 (issue #36)
release-test topology. It is the operator-facing
companion to `docs/adr/0008-deterministic-orchestration.md`
(the ADR that documents the 5-job topology, the
synthetic-failure protocol, and the heartbeat-deletion
rationale).

## TL;DR

- **Five segregated per-suite jobs** run on ubuntu-latest
  in parallel on every push to a `rc-*` branch. A
  failure in one does NOT block the others.
- **The matrix leg** (3 OSes × 1 Node = 3 jobs) is
  preserved for cross-platform coverage of the
  multi-process stress + the MCP black-box E2E.
- **The `release-aggregate` job** depends on all 5
  segregated suites + the matrix leg. It downloads
  every evidence fragment, runs the orchestrator +
  the aggregator, runs the synthetic-failure smoke,
  and uploads the canonical `release-evidence.json`.
- **The heartbeat-filter proxy is gone.** Every
  unhandled rejection is now a real failure in release
  mode (`AGENT_RECALL_RELEASE_MODE=1`).
- **The 10,000-op stress runs once per release job**,
  pinned via `JOB_ID`. The orchestrator writes a
  counter file; the synthetic gate inspects it.

## Job map

The v1.1.3 release candidate workflow
(`.github/workflows/release-candidate.yml`) defines 7
jobs. Expected durations are the v1.1.3 GATE-06
baseline; faster runners may beat them.

| Job | Suite | Vitest config | OS | Node | Expected duration |
|-----|-------|---------------|-----|------|-------------------|
| `unit-integration` | Unit / integration layer | `vitest.config.ts` | ubuntu-latest | 24 | 1 – 3 min |
| `mcp-blackbox` | MCP black-box E2E | `vitest.blackbox.config.ts` | ubuntu-latest | 24 | 1 – 3 min |
| `migrations` | Migration / backup / import | `vitest.migrations.config.ts` | ubuntu-latest | 24 | 1 – 3 min |
| `stress` | 10,000-op multi-process stress | `vitest.stress.config.ts` | ubuntu-latest | 24 | 3 – 8 min |
| `packaged-artifact` | Extracted-artifact lifecycle | `vitest.packaged-artifact.config.ts` | ubuntu-latest | 24 | 2 – 4 min |
| `matrix` | Full release-critical suite (cross-OS) | `vitest.config.ts` (default) | ubuntu + macOS + Windows | 24 | 5 – 15 min / OS |
| `release-aggregate` | Aggregator + synthetic gate | n/a | ubuntu-latest | 24 | 30 s – 1 min |

The segregated per-suite jobs run in parallel; the
matrix leg runs in parallel with the per-suite jobs
(no `needs:`); the `release-aggregate` waits for all 6.

## What to look at when a job fails

### `unit-integration` / `mcp-blackbox` / `migrations` / `stress` / `packaged-artifact`

Each suite job uploads two artefacts:

- `release-evidence-fragment-<suite>-ubuntu`: the
  per-suite JUnit JSON + the
  `scripts/release-evidence.mjs --assert-vitest`
  summary. The JUnit JSON is the canonical vitest
  failure trace (every failed test's stack trace,
  expected vs actual, file + line number).
- `release-evidence-fragment-<suite>-ubuntu`: also
  carries the `test-summary-<suite>-ubuntu.json` which
  is the `{passed, failed, skipped, total}` tuple the
  aggregator feeds into `release-evidence.json`.

The orchestrator's per-suite
`<out>/cleanup-<suite>.json` carries the `failures[]`
array (one entry per orchestrator-detected failure
code: `UNHANDLED_REJECTION`, `WORKER_TIMEOUT`,
`TEST_SKIP`, `CHILD_PROCESS_LEAK`,
`SUITE_EXIT_NONZERO`). A failure that does NOT show up
in the JUnit JSON but DOES show up in `failures[]` is
a synthetic event — the worker died with a non-test
failure (e.g. uncaught exception, timeout).

### `matrix`

The matrix leg is the legacy monolithic `npm test`
path. It runs on every rc-* push (no `needs:`); the
per-suite jobs run in parallel. The matrix leg exists
solely for the cross-OS coverage that the segregated
suites (single-OS) do not give.

The matrix leg uploads
`release-evidence-fragment-matrix-<os>` for every OS
(ubuntu + macOS + Windows).

### `release-aggregate`

This job is the gate. It downloads every
`release-evidence-fragment-*` artefact, runs
`scripts/run-test-suites.mjs --list --json` to print
the resolved suite table, runs
`scripts/release-evidence.mjs` to aggregate, runs
`scripts/verify-release-evidence.mjs` to verify the
contract, and uploads `release-evidence.json` +
`release-candidate.json`.

The aggregate job also runs the synthetic-failure
smoke (`scripts/synthesize-vitest-failures.mjs`) so
the orchestrator's pattern detector is exercised on
every release candidate. A regression in the
orchestrator's `UNHANDLED_REJECTION` /
`WORKER_TIMEOUT` detection is caught here, not in
the production run.

## What to do when the release-aggregate fails

### "release-aggregate needs must include X" / "needs:<suite>.result != success"

A segregated suite failed. Open the suite's
`release-evidence-fragment-<suite>-ubuntu` artefact,
find the failed test in `junit-<suite>-ubuntu.json`,
and triage per the existing release-gate protocol.

### "test_summary.suites.<name>.unhandled_rejections != 0"

A vitest worker emitted an unhandled rejection. This
is a real failure in release mode (the new
`vitest.setup.ts` throws the rejection so the worker
exits non-zero). Check the suite's
`cleanup-<suite>.json` for the rejection reason +
stack trace.

### "test_summary.suites.<name>.worker_timeouts != 0"

A vitest worker hung past the orchestrator's
deadline. Check the suite's `cleanup-<suite>.json`
for the timeout + the captured stdout / stderr
buffers.

### "test_summary.suites.<name>.skipped != 0"

A release-critical `it.skip` / `describe.skip` was
detected. This is a contract violation — every
release-critical test must run on every release.
Re-enable the test (or remove the skip) and re-push.

### "scripts/verify-release-evidence.mjs failed"

The aggregated `release-evidence.json` did not pass
the v1.1.3 contract. Open the artefact in the
release-aggregate job, locate the field that the
verifier complained about, and triage.

## Local development

The per-suite scripts mirror the CI jobs. To run a
suite locally:

```sh
npm run test:unit              # default config
npm run test:blackbox          # MCP black-box
npm run test:migrations        # migration / backup / import
npm run test:stress            # multi-process stress (10k ops)
npm run test:packaged-artifact # extracted-artifact lifecycle
npm run test:all-suites        # deterministic orchestrator (all 5)
```

The orchestrator's `--list` mode prints the resolved
suite table without running anything:

```sh
node scripts/run-test-suites.mjs --list
node scripts/run-test-suites.mjs --list --json   # machine-readable
```

The orchestrator's `--inspect-stress` mode prints the
stress counter for the supplied `JOB_ID`:

```sh
JOB_ID=my-local-dev-run node scripts/run-test-suites.mjs --inspect-stress
```

The synthetic injector emits real vitest-side failures
on demand:

```sh
node scripts/synthesize-vitest-failures.mjs --emit unhandled-rejection
node scripts/synthesize-vitest-failures.mjs --emit worker-timeout --timeout-ms 10000
node scripts/synthesize-vitest-failures.mjs --emit both
```

A successful synthetic run exits 0; a regression in
the orchestrator's pattern detector surfaces as a
non-zero exit (the orchestrator's
`UNHANDLED_REJECTION` / `WORKER_TIMEOUT` regex
matches the synthetic injector stderr).

## References

- `docs/adr/0008-deterministic-orchestration.md` — the
  5-job topology + the synthetic-failure protocol.
- `docs/superpowers/specs/2026-07-28-v1.1.3-gate-06-deterministic-design.md` — the design spec.
- `docs/superpowers/plans/2026-07-28-v1.1.3-gate-06-deterministic-plan.md` — the implementation plan.
- `scripts/run-test-suites.mjs` — the orchestrator.
- `scripts/synthesize-vitest-failures.mjs` — the synthetic injector.
- `.github/workflows/release-candidate.yml` — the
  CI workflow.