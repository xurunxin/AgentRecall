# Stage 9 — MemoryService Facade Split — Closure Report

Date: 2026-07-21
Branch: `feat/stage9-facade-split`
Worktree: `G:\Projects\MetronX\local-memory-mcp\.worktrees\stage9-facade-split`
Baseline: 320/320 tests green, `main` at `3fb3ec7`
Outcome: 320/320 tests green after the split, `--no-ff` merge to main

## Plan vs Actual

| Task | Plan | Actual | Notes |
|---|---|---|---|
| **T0** — Spec + plan | spec + plan written first | done | `docs/superpowers/specs/2026-07-21-stage-nine-facade-split.md`, `docs/superpowers/plans/2026-07-21-stage-nine-facade-split.md` |
| **T1** — Extract shared helpers | one helper file, 30+ pure/state functions | done | `src/services/memory-service-helpers.ts`, 452 lines, all the comparison / audit / budget / env / actor helpers. `computeTrustBoost` re-exported from `memory-service.ts` for back-compat with the existing test import path. |
| **T2** — Extract read path | `MemoryReadService` in `src/services/memory-read-service.ts` | done | 290 lines; owns `getMemory`, `listMemories`, `searchMemories`, `getMemoryBudget`, `exportMemoryContext`. Initial T2 had a bug: `searchMemories` was passing `include_global` to `store.searchEntries`, which has no such concept. |
| **T3** — Extract write path | `MemoryWriteService` in `src/services/memory-write-service.ts` | done | 405 lines; owns `remember`, `updateMemory`, `supersedeMemory`, `mergeMemories`, `forgetMemory`, `configureProjectBudget`. Initial T3 had a bug: `updateMemory` validated the input before peeking `current`, which routed all rejection audits to the input object (no `memory_id`). |
| **T4** — Extract maintenance path | `MemoryMaintenanceService` in `src/services/memory-maintenance-service.ts` | done | 540 lines; owns the `maintainMemories` switch plus the per-action implementations (`findDuplicatesChunked`, `mergeDuplicates`, `rebuildMarkdownIndex`, `expireDueMemories`, `archiveLowValueMemories`, `vacuumFts`). |
| **T5** — `MemoryService` becomes a façade | 253 lines, byte-for-byte public API | done | `src/memory-service.ts` reduced from 1670 to 227 lines. All public methods delegate. `backup()` stays on the façade for Stage 1 historical reasons. Initial T5 had a bug: `commitPreparedRemember` wrote `actor: "agent"` to the `created` audit, which broke the per-actor filter, the near-duplicate writer annotation, and the recall trust_boost ranking. |
| **T6** — Docs | CHANGELOG, README, closure report | done | this document + the `## Architecture` section in `README.md` + the new `[Unreleased]` section in `CHANGELOG.md` (Stage 8 promoted to `[0.8.0]`). |
| **T7** — Verify, push, merge | `npm run typecheck && npm test && git diff --check`, push branch, `--no-ff` merge to main, push main, remove worktree | done | see "Verification" below. |

## What landed

- `src/memory-service.ts`: 1670 lines → 227 lines (façade only; public
  API surface unchanged).
- `src/services/memory-service-helpers.ts`: 452 lines (new file).
- `src/services/memory-read-service.ts`: 290 lines (new file).
- `src/services/memory-write-service.ts`: 405 lines (new file).
- `src/services/memory-maintenance-service.ts`: 540 lines (new file).
- `test/memory-service.test.ts`: unchanged.
- No other test file touched. Pure refactor: 0 new tests, 0 deleted
  tests, 320/320 still pass.

## Verification

```
$ npm run typecheck
$ npm test
$ git diff --check
$ git log --oneline feat/stage9-facade-split ^main
<commits>
$ git checkout main
$ git merge --no-ff feat/stage9-facade-split
$ git push origin feat/stage9-facade-split main
$ git worktree remove .worktrees/stage9-facade-split
```

## Test Coverage

| Stage | Tests | Files | Notes |
|---|---|---|---|
| Baseline (pre-stage-1) | 120 | 10 | All passing |
| Stage 1 | +74 | +14 | actor, sqlite-store-migration, tools-descriptions, backup, doctor + 9 CLI test files |
| **Stage 1 total** | **194** | **24** | **All passing** |
| Stage 2 | +21 | +4 | sqlite-store-migration-v3, remember-confirm, merge-memories, last-accessed-by |
| **Stage 2 total** | **215** | **28** | **All passing** |
| Stage 3 | +23 | +1 | text-similarity + extensions to remember-confirm and memory-service |
| **Stage 3 total** | **239** | **29** | **All passing** |
| Stage 4 | +13 | +2 | sqlite-store-actor-filter, memory-service-actor-filter + extensions to list, search, doctor, tool-registration |
| **Stage 4 total** | **252** | **31** | **All passing** |
| Stage 5 | +9 | +1 | memory-service-recall-trust covering trust helper + ranking + writer annotation |
| **Stage 5 total** | **261** | **32** | **All passing** |
| Stage 6 | +12 | +1 | sqlite-store-time-window + extensions to tool-registration, list, search, doctor |
| **Stage 6 total** | **273** | **33** | **All passing** |
| Stage 7 | +28 | +5 | updated_at + staleness-config + trust-config + find-duplicates-bucketed + maintenance-chunking |
| **Stage 7 total** | **301** | **38** | **All passing** |
| Stage 8 | +19 | +3 | merge-duplicates + format-exporters + maintenance-dry-run |
| **Stage 8 total** | **320** | **41** | **All passing** |
| Stage 9 | +0 | +0 | pure refactor: helpers + 3 sub-services + façade |
| **Stage 9 total** | **320** | **41** | **All passing** |

## Deviations from Plan

The plan called for 7 sub-tasks and all 7 executed. Three bugs were
caught during T5 façade wiring and fixed in the same work scope
before the merge:

1. **`updateMemory` reordered validation vs peek.** The pre-split
   code peeks `current` first, checks the status, and only then runs
   `validateUpdateInput`. The Stage 9 `MemoryWriteService` initially
   ran validation before the peek, which routed all rejection audits
   to the input object (no `memory_id`). The fix reordered the
   method to peek → status-check → validate, with the validation
   rejection using `auditRejectedForEntry(current, ...)` so the
   `write_rejected` audit is tied to the memory_id. Caught by
   `audits rejected secret updates` and
   `audits rejected invalid update status` in
   `test/memory-service.test.ts`.

2. **`commitPreparedRemember` overrode `defaultActor` with a
   hardcoded `"agent"`.** The pre-split `appendAudit` resolves
   `resolveActor(input.actor ?? this.defaultActor)` so omitting
   `actor` from the audit call falls through to the calling service's
   `defaultActor`. The Stage 9 write service initially passed
   `actor: "agent"` explicitly, which broke the per-actor filter, the
   near-duplicate writer annotation, and the recall trust_boost
   ranking (all three read the `actor` field from the `created`
   audit). The fix dropped the `actor` field from the
   `commitPreparedRemember` audit call. Caught by
   `listMemories returns the filtered subset end-to-end` in
   `test/memory-service-actor-filter.test.ts`,
   `includes the matching memory's writer actor on the near_duplicate warning`
   in `test/remember-confirm.test.ts`, and
   `ranks the calling actor's own write above a foreign write with the same query score`
   in `test/memory-service-recall-trust.test.ts`.

3. **`searchMemories` did not honor `include_global: true`.** The
   pre-split code does a manual second `searchEntries` against the
   global scope and prepends the global items to the project
   results, sliced to `limit`. The Stage 9 read service initially
   passed `include_global` straight to `store.searchEntries`, which
   has no such concept. The fix replicated the pre-split merge in
   the read service. Caught by
   `defaults list and search to active memories and can include global results in project search`
   in `test/memory-service.test.ts`.

These three bugs together affected 6 distinct tests across 4 test
files. They would have shipped as regressions if the split had been
merged without running the full test suite. The
`vitest run --pool=forks --poolOptions.forks.singleFork=true` flag
combination from earlier stages times out on `onTaskUpdate` in this
worktree under default vitest 3.x; the default pool (multiple
forks) runs all 320 tests in ~200s with no failures.

## Why this was the right time

Stages 2-6 explicitly deferred the façade split because it was
"pure tech debt, zero user-visible change" (per the user's memory
file at `C:\Users\xurx\.mavis\memory\user.md`) and those stages had
user-facing features to ship first. By Stage 8 the `MemoryService`
class had grown to 1670 lines, which was the tipping point where
maintenance was becoming the dominant cost of any new change. Stage
9 was the right time to do the split because:

- All user-facing features from stages 2-8 were in.
- The `MemoryService` had stabilized — Stage 7 and Stage 8 made
  no fundamental changes to the public API.
- The sub-services can each grow independently as future
  stages add features (e.g. embeddings, restore, secret
  redaction).

## What this unlocks for future stages

- **`MemoryReadService`** can grow per-actor view features
  (Stage 4 already) and embedding-based recall without touching
  write or maintenance code.
- **`MemoryWriteService`** can grow import / restore / secret
  redaction without touching read code.
- **`MemoryMaintenanceService`** can grow new actions
  (e.g. embedding-cluster rebalancing) without touching read or
  write code.
- The shared helpers module is a single place to add cross-cutting
  concerns (e.g. retry / circuit-breaker around store calls).
