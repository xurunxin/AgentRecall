# Stage 3 Cross-Agent Smarter Dedup — Implementation Closure

Date: 2026-07-20
Branch: `feat/stage3-cross-agent-dedup`
Worktree: `G:\Projects\MetronX\local-memory-mcp\.worktrees\stage3-cross-agent-dedup`

## Outcome

All 7 planned tasks executed in TDD mode and merged into the
`feat/stage3-cross-agent-dedup` branch. **6 commits, 238/238 tests
passing, typecheck clean, build clean, doctor 10/10 OK.**

The core cross-agent dedup piece is live:

1. **Token-set Jaccard similarity module** with a `0.7` threshold,
   used in both the live `remember` warning path and the
   `maintain_memories find_duplicates` action.
2. **`near_duplicate` warning** on `remember` — advisory, with
   `actor` + `last_accessed_by` enrichment.
3. **`similar_title_and_body` group reason** on `find_duplicates`,
   skipping pairs already covered by exact-match groups.

## Commit Trail

```
75c25dd docs(stage3): document near_duplicate and similar_title_and_body
f43c4d9 fix(stage3): satisfy noUncheckedIndexedAccess in similarDuplicateGroups
9a599e5 feat(stage3): include actor and last_accessed_by in dedup warnings
f03b684 feat(stage3): group similar memories in findDuplicateGroups
0e7330e feat(stage3): flag near-duplicate candidates in remember flow
8e8142b feat(stage3): add text-similarity module (token-set Jaccard)
```

The spec + plan commit (T0) is shared with main from before this
branch was created. T1–T5 are feature commits; T6 is docs (this
file + CHANGELOG + README); T7 is the merge.

## Plan vs Actual

| # | Task | Plan Said | Actual | Why the Difference |
|---|---|---|---|---|
| T1 | text-similarity module | `tokenizeForSimilarity`, `jaccard`, `textSimilarity` + `SIMILARITY_THRESHOLD = 0.7` | Same, plus 14 unit tests | TDD as planned; tests pinned the Jaccard range for the motivating example and the failure case. |
| T2 | Wire into `evaluateBudget` | New `near_duplicate` warning | Same, plus reused the existing `warnings: BudgetWarning[]` surface (no `near_matching_ids` shortcut) | Smaller surface, one less field. Agent filters by `code` instead. |
| T3 | Wire into `findDuplicateGroups` | New `similar_title_and_body` reason + N×N comparison | Same + `coveredPairKeys` helper to skip exact-covered pairs | Necessary because the existing "finds deterministic duplicate groups" test had two identical-text memories; Jaccard = 1.0 for them, so without skipping the similar group would duplicate the exact group. |
| T4 | Enrich warning with actor + last_accessed_by | Set the fields from the matching entry | Same + drive-by fix to `commitPreparedRemember` so the audit log actually records structured actors | Without the drive-by fix, every warning's `actor` field would be the legacy `"agent"` regardless of who wrote the matching memory, defeating the cross-agent purpose. |
| T5 | Tool descriptions | Update `remember` + `maintain_memories` OUTPUT | Same, trimmed to fit the 80-char segment budget from Stage 1 | Plan text was illustrative, not constraint-checked. |
| T6 | Closure docs | CHANGELOG, README, closure report | Same | — |
| T7 | Verification, push, merge | `npm run typecheck && npm test && git diff --check`, `--no-ff` merge, push | Same | — |

## Test Inventory (Stage 3 Additions)

| File | New tests | Purpose |
|---|---:|---|
| `test/text-similarity.test.ts` (new) | 14 | `tokenizeForSimilarity` (case fold, whitespace, punctuation, stop-word drop), `jaccard` (identical, disjoint, empty, mixed), `textSimilarity` (motivating / counter / degenerate / completely-different) |
| `test/remember-confirm.test.ts` (extended) | +7 | `near_duplicate` flag in success, no-flag when unrelated, no-flag for completely-different, exact-dup still blocks, `confirm_write: true` strips advisory warnings, actor enrichment, `last_accessed_by` enrichment |
| `test/memory-service.test.ts` (extended) | +2 | `similar_title_and_body` group from `find_duplicates`, no-group for genuinely different memories |

**Net stage 3 test delta: +23 tests, +1 file, 238 total.**

## Architecture Decisions Worth Recording

1. **Pure token-set Jaccard, no embeddings**. The project rule is
   "no new dependencies". A local embedding model (e.g. `@xenova/
   transformers` or a small ONNX runtime) would let us catch
   semantically-different phrasings with one shared content word
   (e.g. "project uses postgres" vs "db is postgres") that
   pure-Jaccard cannot reach. A test case pins the limitation
   (the "does not catch completely-different phrasings" assertion
   in `text-similarity.test.ts`) so future regressions are
   obvious. The limitation is documented in the spec and CHANGELOG.
2. **`near_duplicate` is advisory, not blocking**. The existing
   `duplicate_candidate` warning blocks the `remember` call until
   the caller passes `confirm_write: true`. `near_duplicate`
   surfaces in the success response's `warnings` array but the
   call still succeeds. The agent can then call `merge_memories`
   on the near matches, rewrite the body to be more distinct, or
   accept the duplication. This matches the user's intent
   (inform, don't block) and keeps the existing forced-confirm
   flow scoped to truly exact matches.
3. **`confirm_write: true` strips all warnings from the response**.
   The caller has acknowledged the warnings, so re-emitting them
   in the response is noise. The change is consistent across
   both `duplicate_candidate` and `near_duplicate` codes.
4. **`coveredPairKeys` makes the N×N loop exact-clean**. Without
   it, a pair with Jaccard = 1.0 (i.e. identical text after
   normalization) would be reported both as
   `same_title_and_body` (and `same_title`, `same_body`) and
   as `similar_title_and_body` — four groups for the same pair.
   The skip keeps the result list to one group per "real" reason
   per pair.
5. **`commitPreparedRemember` actor fix**. Stage 1's closure
   report flagged that `commitPreparedRemember` was writing a
   hardcoded `actor: "agent"`, which prevented the structured
   `agent:claude-code` form from being recorded in the audit
   log. Stage 3 T4 fixed this: the field is now omitted, so
   `appendAudit` falls back to the service's `defaultActor`
   (resolved through `resolveActor`). The fix is necessary for
   T4 to actually work — without it, every warning's `actor`
   would be `"agent"` regardless of the actual writer.
6. **N×N complexity is accepted for stage 3**. At 1k memories
   this is 500k pair comparisons; at 10k it's 50M. The current
   personal-tool scale is well under 1k memories, so the cost
   is fine. Stage 4+ should consider an inverted index or
   bucketing if memory count grows.

## Out of Scope (Stage 4+)

The following remain unimplemented and are candidates for Stage 4
or later:

- Per-agent ownership view (`list_memories --actor`,
  `search_memories` filter by actor)
- Recall ranking weighted by actor trust
- `MemoryService` façade split (T2/T4 from Stage 2; the
  `memory-read-service.ts` and `memory-service-helpers.ts`
  draft files in the worktree are still there waiting)
- Maintenance operation chunking / off-lock-path
- PII detection in `secret-detector.ts`
- Markdown export format switch (`agent_friendly` vs
  `human_friendly`)
- Soft-conflict detection between high-confidence memories
- Import / backup-restore CLI subcommands
- Inverted index / bucketing for `findDuplicateGroups` N×N loop
- Semantic dedup (would require a new dependency or local model)

## Verification Commands

```bash
cd G:\Projects\MetronX\local-memory-mcp\.worktrees\stage3-cross-agent-dedup
npm run typecheck
npm test
git diff --check
node dist/bin/agent-recall.js doctor
```

All should exit 0. `doctor` still reports 10 checks (no new checks
in this stage; per-agent view is Stage 4). `remember` and
`maintain_memories` tool descriptions are updated in
`src/tools/descriptions.ts`.
