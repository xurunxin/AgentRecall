# Stage 6 — Per-Agent Time-Window Filters — Implementation Plan

Date: 2026-07-20
Branch: `feat/stage6-time-window`
Worktree: `G:\Projects\MetronX\local-memory-mcp\.worktrees\stage6-time-window`
Baseline: 261/261 tests green, `main` at `52be622`

See [spec](../specs/2026-07-20-stage-six-time-window.md) for
design rationale and scope.

## Task list

- [ ] **T1** — `since` / `until` / `last_accessed_since` on
  `EntryFilters`, plumbed into `listEntries` and
  `searchEntries`. Tests cover each filter independently,
  the closed-range combination, and the actor + time
  combination. ~8 unit tests in
  `test/sqlite-store-time-window.test.ts`.
- [ ] **T2** — `MemoryService.entryFiltersForRead` forwards
  the new fields to the store.
- [ ] **T3** — `list_memories` and `search_memories` MCP
  tool schemas accept the three new fields with
  `z.string().datetime({ offset: true })` validation.
  Tool descriptions updated to mention the new filters.
- [ ] **T4** — `--since` / `--until` / `--last-accessed-since`
  on `agent-recall list`; `--since` /
  `--last-accessed-since` on `agent-recall search`. CLI tests
  for both.
- [ ] **T5** — `stale_memories` doctor check (12th). Walks
  `memory_entries` for rows not touched in 90+ days;
  reports count + top-5 oldest. Always `ok`.
  `test/doctor.test.ts` updated to expect 12 results.
- [ ] **T6** — Docs: CHANGELOG `[Unreleased] — Stage 6`,
  closure report, README updates.
- [ ] **T7** — Verify (`npm run typecheck && npm test &&
  git diff --check`), push branch, `--no-ff` merge to
  `main`, push `main` to origin.

## T1 — store-layer filters (red → green)

### Test cases (`test/sqlite-store-time-window.test.ts`)

```ts
describe("listEntries time-window filters (stage 6)", () => {
  it("since filters by created_at", ...);
  it("until filters by created_at", ...);
  it("since + until forms a closed range", ...);
  it("last_accessed_since filters by last_accessed_at and excludes never-read memories", ...);
  it("combines with the existing actor filter from Stage 4", ...);
  it("no filters returns all active entries", ...);
});

describe("searchEntries time-window filters (stage 6)", () => {
  it("since narrows FTS results by created_at", ...);
  it("until narrows FTS results by created_at", ...);
});
```

### Implementation sketch

`src/sqlite-store.ts`:

```ts
export type EntryFilters = {
  // ... existing ...
  since?: string;
  until?: string;
  last_accessed_since?: string;
};

function buildEntryWhere(filters, alias) {
  // ... existing ...
  if (filters.since !== undefined) {
    clauses.push(`${column("created_at")} >= ?`);
    params.push(filters.since);
  }
  if (filters.until !== undefined) {
    clauses.push(`${column("created_at")} <= ?`);
    params.push(filters.until);
  }
  if (filters.last_accessed_since !== undefined) {
    clauses.push(`${column("last_accessed_at")} IS NOT NULL AND ${column("last_accessed_at")} >= ?`);
    params.push(filters.last_accessed_since);
  }
  // ...
}
```

### Commit

```bash
git add src/sqlite-store.ts test/sqlite-store-time-window.test.ts
git commit -m "feat(stage6): add since/until/last_accessed_since to EntryFilters"
```

## T2 — service-layer forwarding (red → green)

`src/memory-service.ts`:

```ts
private entryFiltersForRead(filters, resolved) {
  // ... existing ...
  if (filters.since !== undefined) entryFilters.since = filters.since;
  if (filters.until !== undefined) entryFilters.until = filters.until;
  if (filters.last_accessed_since !== undefined) entryFilters.last_accessed_since = filters.last_accessed_since;
  return entryFilters;
}
```

## T3 — MCP tool schemas (red → green)

`src/tools/schemas.ts`:

```ts
const entryFilterFields = {
  // ... existing ...
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  last_accessed_since: z.string().datetime({ offset: true }).optional()
};
```

`src/tools/descriptions.ts`: update list_memories and
search_memories INPUT segments.

### Combined commit with T2

```bash
git add src/memory-service.ts src/tools/schemas.ts src/tools/descriptions.ts
git commit -m "feat(stage6): forward time-window filters through service and MCP"
```

## T4 — CLI flags (red → green)

`src/cli/commands/list.ts` and `src/cli/commands/search.ts`:

```ts
const since = flagString(ctx.args, "since");
const until = flagString(ctx.args, "until");
const lastAccessedSince = flagString(ctx.args, "last-accessed-since");
// ... attach to filters when defined ...
```

### Commit

```bash
git add src/cli/commands/list.ts src/cli/commands/search.ts test/cli/list.test.ts test/cli/search.test.ts
git commit -m "feat(stage6): add --since/--until/--last-accessed-since CLI flags"
```

## T5 — `stale_memories` doctor check (red → green)

`src/doctor/checks/stale-memories.ts`:

```ts
const STALE_DAYS = 90;

export function checkStaleMemories(ctx) {
  const handle = ctx.store.backupHandle();
  const cutoff = new Date(ctx.now().getTime() - STALE_DAYS * 86400000).toISOString();
  const rows = handle.prepare(
    `SELECT id, last_accessed_at, created_at
     FROM memory_entries
     WHERE status = 'active' AND (last_accessed_at IS NULL OR last_accessed_at < ?)
     ORDER BY (CASE WHEN last_accessed_at IS NULL THEN created_at ELSE last_accessed_at END) ASC
     LIMIT 5`
  ).all(cutoff);
  const count = handle.prepare(
    `SELECT COUNT(*) AS c FROM memory_entries
     WHERE status = 'active' AND (last_accessed_at IS NULL OR last_accessed_at < ?)`
  ).get(cutoff).c;
  // ... return ok with details ...
}
```

`src/doctor/index.ts`: append to `CHECKS`.

`test/doctor.test.ts`: `results.length === 12`, plus a
focused test for the new check.

### Commit

```bash
git add src/doctor/checks/stale-memories.ts src/doctor/index.ts test/doctor.test.ts
git commit -m "feat(stage6): add stale_memories doctor check (12th)"
```

## T6 — Closure docs

Same pattern as Stage 5 closure.

### Commit

```bash
git add CHANGELOG.md README.md docs/superpowers/plans/2026-07-20-stage-six-time-window-closure.md
git commit -m "docs(stage6): add CHANGELOG entry, closure report, and README updates"
```

## T7 — Verify, push, merge

```bash
npm run typecheck
npm test
git diff --check
git push -u origin feat/stage6-time-window
cd ../..
git checkout main
git merge --no-ff feat/stage6-time-window -m "Merge branch 'feat/stage6-time-window'"
git push origin main
```

## Expected outcome

- 261 → ~273 tests (+ ~12: 8 sqlite-store, 1 tool-registration, 2 CLI, 1 doctor)
- 0 schema changes
- 1 new module (`src/doctor/checks/stale-memories.ts`)
- 3 new fields on `EntryFilters` (already-exposed via service)
- `doctor` now reports **12** checks (was 11)
- Stage 7 candidates: N×N inverted index for find_duplicates,
  T2/T4 facade split, semantic dedup, configurable
  trust_boost weights, `updated_at` filter
