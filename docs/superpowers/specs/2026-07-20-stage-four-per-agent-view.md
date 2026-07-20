# Stage 4 — Per-Agent Memory View

Date: 2026-07-20
Branch: `feat/stage4-per-agent-view`
Predecessor: Stage 3 (commit `91c22b4`)

## Why

Stage 3 added the structured `actor` field and the `last_accessed_by` map
so the database can answer "who wrote this?" and "who last touched
this?". But the read surface (`list_memories`, `search_memories`, the
CLI `list` / `search` commands) has no way to ask that question from
the outside. The user manages memories written by `claude-code`,
`cursor`, and `codex` in one shared database; without an `actor`
filter, they can't answer basic ownership questions:

- "What did claude-code remember last week?"
- "What memories haven't I (mavis) touched in a while?"
- "Is this duplicate candidate from another agent or my own stale write?"

The data is there; the surface is missing. Stage 4 closes that gap.

## What this stage ships

An `actor` filter on every memory read path:

1. `SQLiteMemoryStore.listEntries(filters)` — new optional `actor`
2. `SQLiteMemoryStore.searchEntries(filters)` — new optional `actor`
3. `MemoryService.listMemories` / `searchMemories` — forward the new
   field from `ListServiceFilters` / `SearchServiceFilters`
4. `list_memories` and `search_memories` MCP tool schemas — new
   optional `actor` field
5. `agent-recall list --actor X` and `agent-recall search --actor X`
   CLI flags
6. New `actor_ownership` doctor check — per-actor entry count and
   percentage, with a distribution table

The filter narrows results to memories whose "created" audit row was
written by the given actor. For backward compatibility, omitting the
field returns the existing behavior.

## Data model changes

None. The `actor` lives in `audit_events.actor` and is read via a
subquery. No new columns.

## API changes

### `EntryFilters` (in `src/sqlite-store.ts`)

```ts
export type EntryFilters = {
  scope?: MemoryScope;
  project_id?: string;
  // ... existing fields ...
  actor?: string;  // NEW: filter to memories whose "created" audit row has this actor
};
```

### `list_memories` MCP tool

```ts
listMemoriesToolSchema = z.object({
  // ... existing fields ...
  actor: nonEmptyString.optional()
}).strict();
```

### `search_memories` MCP tool

Same `actor` field added.

### CLI

```bash
agent-recall list --actor "agent:claude-code"
agent-recall search "postgres" --actor "agent:claude-code"
```

## SQL strategy

Use a subquery in the WHERE clause to avoid joining on every read:

```sql
SELECT * FROM memory_entries
WHERE ...existing...
  AND id IN (
    SELECT memory_id FROM audit_events
    WHERE event = 'created' AND actor = ?
  )
```

For FTS search, the same subquery is added to the WHERE on the
joined `m` alias.

## Behavior

- Omitting `actor` → existing behavior (all actors)
- Specifying `actor` → only memories whose "created" audit row has
  that actor are returned
- An invalid actor (one that's never written) returns an empty list
  (not an error)
- The doctor check reports the distribution of entries per writer
  actor (e.g. "5 entries: 3 by agent:claude-code, 1 by agent:cursor,
  1 by user:cli"), ignoring rows with no "created" event (defensive
  for pre-v2 data)

## Tests added

- `test/sqlite-store.test.ts` — extend with `actor` filter cases on
  `listEntries` and `searchEntries`
- `test/memory-service.test.ts` — extend list/search to forward the
  filter
- `test/tool-registration.test.ts` — new `actor` field on
  list/search schemas
- `test/cli/list.test.ts` and `test/cli/search.test.ts` — CLI flag
- `test/doctor.test.ts` — `actor_ownership` 11th check

Expected test count: 239 → ~252 (+ ~13 new tests).

## Acceptance criteria

1. `list_memories({ actor: "agent:claude-code" })` returns only
   memories written by claude-code
2. `search_memories({ query: "postgres", actor: "agent:claude-code" })`
   returns only claude-code's matching memories
3. `agent-recall list --actor X` mirrors the MCP filter on the CLI
4. `agent-recall doctor` runs 11 checks, all OK on a healthy DB
5. `actor_ownership` distribution matches the audit log's
   `actor_distribution` (which is event-based) modulo pre-v2
   "missing created" rows
6. Existing 239 tests still pass; typecheck clean

## Out of scope (deferred to Stage 5+)

- Recall ranking weighted by actor trust (own writes boost in
  `recall_context`)
- `actor` filter on `get_memory_budget`, `forget_memory`,
  `update_memory` — those are single-id operations; ownership is
  a list/search concern
- Per-actor time-window filters (e.g. "memories by cursor in the
  last 7 days")
- Inverted index / bucketing for `find_duplicates` N×N loop
- T2/T4 facade split
- Semantic dedup (embedding-based)

## Risks

- **Subquery performance**: at 1k memories and a small audit log
  (one created event per memory), the subquery is essentially free.
  At 10k memories with many audit events per memory, the planner
  should still be fast because the audit log is small relative to
  the entries. Stage 5+ can introduce a denormalized
  `created_by_actor` column on `memory_entries` if this becomes a
  problem.
- **`created` event missing**: pre-v2 databases may have memories
  without a `created` audit row (defensive read in
  `actorForEntry` already handles this for warnings; the new doctor
  check just skips those rows).
