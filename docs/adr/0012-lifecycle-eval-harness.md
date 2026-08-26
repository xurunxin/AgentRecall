# ADR-0012: Lifecycle evaluation harness (issue #55)

## Context

The v1.2 release ships a larger lifecycle surface: session ingestion (#49), derivation jobs (#48), candidate review (#50), asset versions (#51), loadouts (#52), skills (#53), and cold-start bootstrap (#54). The pre-#55 regression test suite measures the individual services in isolation, but the v1.2 release needs an end-to-end harness that exercises the **lifecycle** — capture → derive → review/apply → assemble → use/feedback → maintain/export.

A search-only benchmark (#9) is no longer sufficient; the v1.2 release needs a reproducible suite so architectural changes can be judged by evidence rather than feature count.

Issue #55 (P1) is the agreed scope.

## Decision

We add a versioned, offline-first evaluation harness under `test/eval-lifecycle/`. The harness:

1. Walks a **versioned fixture corpus** with semver-style `corpus_version` (e.g. `v0.1.0`).
2. Each fixture is a self-contained scenario: pre-populated data + ordered service-layer calls + expected outcomes.
3. Fixtures are versioned by `lifecycle.eval.v1` (Zod schema); a v2 can add fields additively.
4. The runner wraps the **public service APIs** — never the CLI shims — so a CLI parsing regression cannot mask a real lifecycle regression.
5. The runner produces two outputs per run: `report.json` (canonical machine-readable artifact) + `report.md` (human-readable summary).
6. Safety counters (cross-project / sensitivity / secret / injection / trust-escalation) are first-class — every release gate fails on any non-zero counter.
7. Quality baselines (supported-claim rate / hallucination-rejection rate / bootstrap-hash byte-determinism) start deliberately conservative; baselines are raised only when the corpus has produced enough data to justify a move.

## Scope (v0.1.0 corpus, shipped in v1.2.0-alpha.2)

The skeleton ships **2 example fixtures**:
- `distill_happy_v1` (B.derivation / distillation / happy) — ingest a JSONL bundle with a `decision_confirmed` event, run the deterministic baseline extractor, assert the job terminates in `succeeded` state with exactly one candidate.
- `loadout_policy_fail_v1` (D.assets_skills_bootstrap / loadouts / policy_fail) — create a loadout with `scope=project, project_id=null`, assert the create throws `project_id_required`.

Both pass green today (`pnpm run eval:lifecycle:quick` exits 0; `report.json` and `report.md` are written under `artifacts/eval-lifecycle/`).

## What the skeleton does NOT do (deferred to subsequent corpus releases)

- **Dimension A (ingestion) fixtures** — land in v0.2.0
- **Dimension C (recall + assembly) fixtures** — land in v0.2.0; require the recall + assembly scorers (separate ADR when scheduled)
- **Dimension E (safety + resilience) fixtures** — land in v0.3.0; the runner infrastructure for safety counters is in place but the dimension-E instrumentation arrives with the fixtures
- **Optional model-provider evaluations** — `eval:lifecycle:provider` script is documented in #55 AC but NOT implemented in v0.1.0 (deferred to a separate ADR)
- **Trend artifact comparison against the last accepted baseline** — CI-side, not harness-side
- **User-facing `agent-recall eval` CLI surface** — Phase 3 follow-up

## Trade-offs

- **Schema over code generation**: fixtures are JSON, not code. JSON is hand-readable + diff-friendly; code generation would let fixtures share more setup logic but the overhead doesn't pay off for the v0.1.0 corpus size (2 fixtures). If the corpus grows past 50 fixtures, the schema can be extended with a `template` field that references a shared base.
- **Service APIs over CLI shims**: the runner calls services directly. This makes a CLI regression invisible to the harness, but the alternative (CLI over spawn) makes the harness slow + flaky on Windows. We mitigate by keeping a separate blackbox E2E suite (`test/blackbox/`) that exercises the CLI directly.
- **Fresh DB per fixture**: every fixture builds a new in-process memory store. The cost is ~1s per fixture for `mkdtempSync` + sqlite open. The benefit is no state leakage between fixtures. Acceptable for the v0.1.0 corpus size.
- **Versioned schema, not AdHoc JSON**: `lifecycle.eval.v1` is a strict Zod schema. The alternative (loose `Record<string, unknown>`) would let the corpus drift silently.

## Alternatives considered

- **Vitest fixtures (`test/fixtures/*.test.ts`)** — would have the harness as a vitest suite. Rejected: vitest isn't a "harness" framework; we need a `pnpm run eval:lifecycle:quick` script that exits with a stable code, doesn't pollute the regular `pnpm test` run, and emits both JSON + Markdown reports. The standalone harness delivers all three.
- **Reuse the existing `test/release-gate/` multi-process tests** — they exercise the lifecycle but are tightly coupled to the CLI / blackbox surface. The new harness complements them rather than replacing them.
- **Build on the `admin` app** — wrong surface; the harness must run without a UI and without credentials.

## Open questions

- **Where do the safety counters come from?** The runner currently surfaces the `expected.safety` row but does not yet observe real counters (the instrumentation arrives with the dimension-E fixtures in v0.3.0).
- **CI integration**: the `:full` script is wired into `package.json` but is not yet called from any workflow. A follow-up commit will add it to `.github/workflows/ci.yml` as a `needs: [release-gate]` job.

## References

- Issue: [#55](https://github.com/xurunxin/AgentRecall/issues/55)
- Implementation plan: [`docs/plans/v1.2-lifecycle-eval-design.md`](../plans/v1.2-lifecycle-eval-design.md)
- Schemas: `test/eval-lifecycle/schemas.ts`
- Runner: `test/eval-lifecycle/runner.ts`
- Fixtures: `test/eval-lifecycle/fixtures/`
- ADR-0008: deterministic orchestration (the runner follows the same no-network-defaults policy)
