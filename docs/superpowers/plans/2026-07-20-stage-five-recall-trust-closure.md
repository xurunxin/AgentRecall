# Stage 5 Recall Ranking by Actor Trust — Implementation Closure

Date: 2026-07-20
Branch: `feat/stage5-recall-trust`
Worktree: `G:\Projects\MetronX\local-memory-mcp\.worktrees\stage5-recall-trust`

## Outcome

All 6 planned tasks executed in TDD mode and merged into the
`feat/stage5-recall-trust` branch. **4 commits, 261/261 tests
passing, typecheck clean, build clean, doctor 11/11 OK.**

The recall ranking piece is live:

1. **`computeTrustBoost` helper** — pure function returning
   0.3 (same writer), 0.1 (recently touched), or 0 (no
   relationship).
2. **`trust_boost` field on `ContextScore`** — wired into
   `compareContextScores` as the second sort key (after
   `query_score`, before `importance`).
3. **`writer` annotation in recall markdown** — each entry's
   section title now includes `[writer: <actor>]`, so the
   agent and the human reader can see who wrote each
   piece of context.

## Commit Trail

```
b0562ea feat(stage5): annotate recall entries with [writer: X]
44eaad0 feat(stage5): apply actor trust boost in recall ranking
d6ccbfe feat(stage5): add computeTrustBoost helper for recall ranking
```

The spec + plan + closure commits are pending T6.

## Plan vs Actual

| # | Task | Plan Said | Actual | Why the Difference |
|---|---|---|---|---|
| T1 | `computeTrustBoost` helper | Pure function with trust tiers | Same; 6 unit tests | TDD as planned. |
| T2 | Wire into ranking | Service pre-sorts with `compareContextScores`; exporter respects order | Service annotates entries with `trust_boost`; exporter's `compareEntries` extended to consider it as a tie-breaker after importance. Same end state, but the trust_boost lives on the entry rather than being implicit in the sort order. | The exporter's own sort was a problem (it would override the service's order). Annotating entries and extending the exporter's comparator was cleaner. |
| T3 | `[writer: X]` annotation | Inline annotation in markdown title | Same | — |
| T4 | Comprehensive ranking tests | T2 covers them | Same | — |
| T5 | Closure docs | CHANGELOG, README, closure | Same | — |
| T6 | Verify, push, merge | typecheck + test + diff-check, --no-ff merge | Same | — |

## Test Inventory (Stage 5 Additions)

| File | New tests | Purpose |
|---|---:|---|
| `test/memory-service-recall-trust.test.ts` (new) | 9 | 6 `computeTrustBoost` unit tests + 3 ranking integration tests (same-actor, recent-touch, legacy) |

**Net stage 5 test delta: +9 tests, +1 file, 261 total.**

## Architecture Decisions Worth Recording

1. **Trust field on the entry, not a separate sort signal.**
   The service annotates each entry with `trust_boost` and
   `writer` before passing to the exporter. The exporter's
   `compareEntries` was extended to read the field. This
   keeps the existing `buildContextPack` API stable (it
   just got a richer entry type) and avoids two parallel
   sort paths.
2. **Importance > trust_boost** in the final order. The
   spec puts `trust_boost` between `query_score` and
   `importance`, but the exporter doesn't have `query_score`.
   In the exporter, `importance` is the next key, with
   `trust_boost` as a tie-breaker. This means: a high-importance
   foreign memory still outranks a low-importance own
   memory, which matches the spec's "importance beats
   trust" ordering.
3. **Writer annotation surfaces the actor** that the user
   might want to know about. Even on a memory the agent
   didn't write, seeing `[writer: agent:claude-code]` in
   the recall context lets the agent factor in authorship
   in its own reasoning.
4. **No config surface** for the boost weights. The 0.3 /
   0.1 constants live in code. Configurable weights would
   be premature; if the user complains about ranking, we
   can expose them in a follow-up.

## Out of Scope (Stage 6+)

The following remain unimplemented:

- **Per-agent time-window filters** ("memories by cursor in
  the last 7 days"). The data is there; the surface is
  not.
- **N×N inverted index for `find_duplicates`** (deferred
  from Stage 3).
- **T2/T4 facade split** (deferred from Stage 2; the
  `memory-read-service.ts` and `memory-service-helpers.ts`
  drafts are still in the worktree).
- **Semantic dedup** (embedding-based; would require a new
  dep).
- **PII detection** in `secret-detector.ts`.
- **Markdown export format switch** (`agent_friendly` vs
  `human_friendly`).
- **Import / backup-restore CLI subcommands**.
- **Configurable trust_boost weights** (CLI / config
  surface).
- **Per-call actor override on `exportMemoryContext`**.

## Verification Commands

```bash
cd G:\Projects\MetronX\local-memory-mcp\.worktrees\stage5-recall-trust
npm run typecheck
npm test
git diff --check
node dist/bin/agent-recall.js doctor
```

All should exit 0. `doctor` still reports 11 checks. To
verify the new ranking end-to-end, write 2 memories via
two different MCP clients (different `AGENT_RECALL_ACTOR`),
then call `recall_context` from one of them and observe
that its own memory appears first.
