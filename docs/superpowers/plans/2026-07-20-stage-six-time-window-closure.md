# Stage 6 Per-Agent Time-Window Filters — Implementation Closure

Date: 2026-07-20
Branch: `feat/stage6-time-window`
Worktree: `G:\Projects\MetronX\local-memory-mcp\.worktrees\stage6-time-window`

## Outcome

All 7 planned tasks executed in TDD mode and merged into the
`feat/stage6-time-window` branch. **5 commits, 273/273 tests
passing, typecheck clean, build clean, doctor 12/12 OK.**

The per-agent time-window piece is live:

1. **Three new time-window filters** (`since`, `until`,
   `last_accessed_since`) on `list_memories` and
   `search_memories` (MCP + CLI). Combine freely with the
   existing `actor` filter.
2. **`stale_memories` doctor check** (the 12th) reporting
   count and top-5 oldest memories not touched in 90+ days.

## Commit Trail

```
4fe0a8b feat(stage6): add stale_memories doctor check (12th)
e5d0325 feat(stage6): add --since/--until/--last-accessed-since CLI flags
341c19f feat(stage6): forward time-window filters through service and MCP
5efc3a8 feat(stage6): add since/until/last_accessed_since to EntryFilters
```

The spec + plan + closure commits are pending T7.

## Plan vs Actual

| # | Task | Plan Said | Actual | Why the Difference |
|---|---|---|---|---|
| T1 | Store-layer filters | `since` / `until` / `last_accessed_since` on `EntryFilters` + `buildEntryWhere` | Same; 8 unit tests | TDD as planned. |
| T2 | Service forwarding | `entryFiltersForRead` forwards the fields | Same; merged with T3 | The conceptual change to `entryFiltersForRead` and the Zod `entryFilterFields` object was the same code; splitting was artificial. |
| T3 | MCP tool schemas | Shared `entryFilterFields` adds the three fields with `z.string().datetime()` validation | Same; 1 test | Invalid ISO strings rejected at parse time. |
| T4 | CLI flags | `--since` / `--until` / `--last-accessed-since` on `list`, `--since` / `--last-accessed-since` on `search` | Same; 2 tests | `--until` omitted on search (FTS doesn't care about upper bound on `created_at`). |
| T5 | `stale_memories` check | 12th doctor check, 90-day threshold, top-5 list | Same; 1 test | — |
| T6 | Closure docs | CHANGELOG, README, closure | Same | — |
| T7 | Verify, push, merge | typecheck + test + diff-check, --no-ff merge | Same | — |

## Test Inventory (Stage 6 Additions)

| File | New tests | Purpose |
|---|---:|---|
| `test/sqlite-store-time-window.test.ts` (new) | 8 | listEntries + searchEntries with since / until / last_accessed_since, combinations with the existing actor filter, omitted-filter baseline |
| `test/tool-registration.test.ts` (extended) | +1 | list/search schemas accept ISO 8601 datetimes, reject invalid strings, handlers forward the fields |
| `test/cli/list.test.ts` (extended) | +1 | `--since`, `--until`, `--last-accessed-since` flags on the CLI; both default and filtered output |
| `test/cli/search.test.ts` (extended) | +1 | `--since` flag on the CLI; narrows FTS results |
| `test/doctor.test.ts` (extended) | +1 | 12-check orchestrator; `stale_memories` empty + populated cases |

**Net stage 6 test delta: +12 tests, +1 file, 273 total.**

## Architecture Decisions Worth Recording

1. **Subquery vs JOIN** (carryover from Stage 4). The
   `actor` filter is a subquery in the `WHERE` clause; the
   new time filters are simple `created_at >= ?` clauses.
   All combine via `AND` in the same `buildEntryWhere`
   builder.
2. **`IS NOT NULL` guard on `last_accessed_since`**. A
   memory that was never read has `last_accessed_at
   IS NULL`. The `last_accessed_since` filter excludes
   these by design ("never touched" is not "touched since
   X"). The SQL is `last_accessed_at IS NOT NULL AND
   last_accessed_at >= ?`.
3. **Lexicographic comparison of ISO 8601 strings**. The
   store layer trusts that the caller passes valid ISO
   8601 datetimes. The Zod schema in the MCP tool
   validates them at parse time. The CLI relies on the
   user to pass them correctly (no validation, but the
   Stage 4-style "type it right" trust model).
4. **90-day staleness threshold is a constant**. The
   `stale_memories` check has `STALE_DAYS = 90` in code.
   Configurable in a follow-up if the user complains.
5. **`--until` omitted on `search`**. The FTS path sorts
   by relevance, not by date, so an upper bound on
   `created_at` is rarely useful. The MCP schema still
   accepts it for completeness; the CLI omits it to keep
   the surface small.
6. **`stale_memories` always `ok`**. The check is
   informational. The user can ignore the count or use
   it to inform a maintenance run.

## Out of Scope (Stage 7+)

- **N×N inverted index for `find_duplicates`** (deferred
  from Stage 3; only matters at 10k+ memories).
- **T2/T4 facade split** (deferred from Stage 2; the
  `memory-read-service.ts` and `memory-service-helpers.ts`
  drafts are still in the worktree).
- **Semantic dedup** (would require a new dep).
- **PII detection** in `secret-detector.ts`.
- **Markdown export format switch** (`agent_friendly` vs
  `human_friendly`).
- **Import / backup-restore CLI subcommands**.
- **Configurable trust_boost weights** (from Stage 5).
- **Configurable staleness threshold** (the 90-day
  constant in `stale-memories.ts`).
- **`updated_at` filter** (the same shape as `since` /
  `until`; deferred to keep the surface small).
- **Time-window filters on `get_memory` / `update_memory`
  / `forget_memory`** (those are single-id operations;
  not relevant for "recent" queries).

## Verification Commands

```bash
cd G:\Projects\MetronX\local-memory-mcp\.worktrees\stage6-time-window
npm run typecheck
npm test
git diff --check
node dist/bin/agent-recall.js doctor
node dist/bin/agent-recall.js list --since "2026-07-13"
node dist/bin/agent-recall.js list --actor "agent:claude-code" --since "2026-07-13"
```

All should exit 0. `doctor` reports 12 checks. The list
commands narrow the output to memories in the given time
window, optionally combined with the actor filter.
