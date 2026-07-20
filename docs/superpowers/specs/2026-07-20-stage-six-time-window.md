# Stage 6 — Per-Agent Time-Window Filters

Date: 2026-07-20
Branch: `feat/stage6-time-window`
Predecessor: Stage 5 (commit `52be622`)

## Why

Stage 4 added the `actor` filter to `list_memories` and
`search_memories`. The user can ask "what did claude-code
write?" but not "what did claude-code write in the last
week?" or "what memories have I been reading recently?"

The data is already in the database:
- `memory_entries.created_at` (Stage 1+)
- `memory_entries.updated_at` (Stage 1+)
- `memory_entries.last_accessed_at` (Stage 2 v3 — the same
  column the `last_accessed_by` JSON map lives in)

For a personal cross-agent memory tool, "recent" is often
what the user actually wants. Stage 6 closes that gap.

## What this stage ships

Three new optional time-window filters on the read path
(`list_memories`, `search_memories`, the CLI `list` and
`search` commands, and the doctor check):

- **`since`**: ISO 8601 date or datetime. Filters to
  memories with `created_at >= since`. Default: unset
  (no lower bound).
- **`until`**: ISO 8601 date or datetime. Filters to
  memories with `created_at <= until`. Default: unset
  (no upper bound).
- **`last_accessed_since`**: ISO 8601 date or datetime.
  Filters to memories whose `last_accessed_at` is set
  and `>= last_accessed_since`. Use case: "what have
  I been reading lately?"

These combine freely with the existing `actor` filter
(from Stage 4) and with each other. The store layer
implements them as `WHERE` clauses; the service layer
forwards the values; the MCP tool schemas and CLI flags
expose the surface.

A new **`stale_memories` doctor check** (the 12th) reports
the count and top-N list of memories not touched in 90+
days. Always `ok`; informational only. The 90-day threshold
is a constant in code; the user can ignore the check.

## Data model changes

None. `created_at`, `updated_at`, and `last_accessed_at`
already exist on `memory_entries`; we read them.

## API changes

### `EntryFilters` (in `src/sqlite-store.ts`)

```ts
export type EntryFilters = {
  // ... existing fields ...
  since?: string;                 // ISO 8601, filters created_at >=
  until?: string;                 // ISO 8601, filters created_at <=
  last_accessed_since?: string;   // ISO 8601, filters last_accessed_at >=
};
```

### `list_memories` and `search_memories` MCP tools

Add the three optional fields to the shared
`entryFilterFields` object (same pattern as the Stage 4
`actor` field).

### CLI

```bash
agent-recall list --since "2026-07-13"
agent-recall list --actor "agent:claude-code" --since "2026-07-13"
agent-recall list --until "2026-07-20"
agent-recall search "postgres" --last-accessed-since "2026-07-13"
```

### Doctor check

`stale_memories` walks `memory_entries` for rows with
`last_accessed_at IS NULL OR last_accessed_at < now -
interval '90 days'`. Reports count + top 5 by id. Always
`ok`.

## SQL strategy

```sql
-- since / until apply to created_at
WHERE created_at >= ?
WHERE created_at <= ?

-- last_accessed_since applies to last_accessed_at
WHERE last_accessed_at IS NOT NULL AND last_accessed_at >= ?

-- combined with the existing actor subquery from Stage 4
AND id IN (SELECT memory_id FROM audit_events
          WHERE event = 'created' AND actor = ?)
```

For the search path (FTS), the same WHERE clauses are
added to the joined `m` alias. The audit subquery is
unchanged.

## Behavior

- All three filters are optional. Omitting any of them
  preserves the existing behavior.
- ISO 8601 strings are compared lexicographically (which
  is correct for ISO 8601 since the format is
  year-month-day[-time] with fixed-width fields).
- Invalid ISO strings (e.g. "yesterday") cause the
  schema parser to reject them. The MCP tool returns
  `invalid_schema`; the CLI returns exit 1 with a usage
  message.
- The `last_accessed_since` filter only returns memories
  that have been read at least once. Memories with
  `last_accessed_at IS NULL` are excluded by design
  ("never touched" is not "touched since X").

## Tests added

- `test/sqlite-store-time-window.test.ts` (new):
  - `since` filters by `created_at`
  - `until` filters by `created_at`
  - `last_accessed_since` filters by `last_accessed_at`
  - combination of all three with the existing `actor`
    filter from Stage 4
  - omitted filters preserve all rows
- `test/memory-service.test.ts` (extended) — forward tests
  for the new fields
- `test/tool-registration.test.ts` (extended) — schema
  tests for the new MCP fields
- `test/cli/list.test.ts` and `test/cli/search.test.ts`
  (extended) — CLI flag tests
- `test/doctor.test.ts` (extended) — `stale_memories`
  check, 12th in the orchestrator

Expected test count: 261 → ~272 (+ ~11 new).

## Documentation updates

- `CHANGELOG.md` — `[Unreleased] — Stage 6` entry;
  promote Stage 5 to `[0.5.0]`.
- `docs/superpowers/plans/2026-07-20-stage-six-time-window.md`
  — 7-task implementation plan.
- `docs/superpowers/plans/2026-07-20-stage-six-time-window-closure.md`
  — closure report.
- `README.md` — Memory Hygiene section: brief note about
  recency queries; Tools table: mention `since` / `until` /
  `last_accessed_since` on list/search.

## Acceptance criteria

1. `list_memories({ since: "2026-07-13" })` returns only
   memories created on or after that date.
2. `list_memories({ until: "2026-07-20" })` returns only
   memories created on or before that date.
3. `list_memories({ last_accessed_since: "2026-07-13" })`
   returns only memories that were read on or after that
   date; memories never read are excluded.
4. `list_memories({ actor: "agent:claude-code", since: "2026-07-13" })`
   combines the actor filter and the time filter with
   AND semantics.
5. `agent-recall list --since "2026-07-13"` mirrors the
   MCP filter on the CLI.
6. `agent-recall doctor` runs 12 checks; the new
   `stale_memories` check is always `ok` and shows the
   count + top-5 list of stale entries.
7. Existing 261 tests still pass; typecheck clean.

## Out of scope (deferred to Stage 7+)

- Time-window filters on `updated_at` (the same shape as
  `created_at`; the schema work is identical, but the
  user-facing surface stays small in Stage 6).
- Time-window filters on `get_memory`, `update_memory`,
  `forget_memory` (those are single-id operations; not
  relevant for "recent" queries).
- Configurable staleness threshold (the 90-day constant
  lives in code for now; if the user wants it
  configurable, it's a 1-line change in
  `src/doctor/checks/stale-memories.ts`).
- N×N inverted index for `find_duplicates` (deferred
  from Stage 3).
- T2/T4 facade split (deferred from Stage 2).
- Semantic dedup (would require a new dep).
- Import / backup-restore CLI.
- Configurable trust_boost weights.

## Risks

- **Date parsing**: invalid ISO strings break the
  schema. We rely on Zod's `iso.datetime()` validator
  in the MCP tool schemas, and the CLI's arg parser
  surfaces a clear error. The store layer assumes
  valid ISO and trusts the caller.
- **Lexicographic comparison**: works for ISO 8601
  but not for arbitrary date formats. Documented
  above; the test suite pins the format.
- **Performance**: the `created_at` and `last_accessed_at`
  columns are not indexed. For the personal-tool scale
  (sub-10k memories) this is fine. Stage 7+ can add
  indexes if needed.
- **`last_accessed_at` is only updated when the entry
  is read with an `accessed_by` argument** (Stage 2 v3
  wiring). Memories read before that wiring (or
  through the legacy `getMemory(id)` path) will have
  `last_accessed_at IS NULL` and be excluded by the
  `last_accessed_since` filter. This is the correct
  behavior but worth knowing.
