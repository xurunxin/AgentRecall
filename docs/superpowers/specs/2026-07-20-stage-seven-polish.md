# Stage 7 — Maintenance & Polish

Date: 2026-07-20
Branch: `feat/stage7-polish`
Predecessor: Stage 6 (commit `898ccb6` on `main`)

## Why

Stages 1-6 shipped the user-facing surface that came out of the
multi-stage review. We now have 12 MCP tools, 12 doctor checks,
12 CLI subcommands, a working smoke test, and 273/273 green
tests. The user-facing experience is solid.

But there are six things on the rough edges that this stage
cleans up. None of them are "new features" — they are
maintenance and polish that make the system easier to live with
as the data set grows and as more agents share the same store.

The six tasks (in user-listed order):

1. **`updated_at` filter** (parity with `since`/`until`).
2. **Configurable staleness threshold** (env var for the
   90-day constant in `stale_memories`).
3. **Configurable trust_boost weights** (env vars for the
   `0.3` / `0.1` constants in `computeTrustBoost`).
4. **Inverted index for `find_duplicates`** (drop N×N
   comparison to token-bucketed).
5. **Maintenance operation chunking** (off-lock-path).
6. **T2/T4 facade split** (deferred from Stage 2: split
   `MemoryService` into `Read`, `Write`, `Maintenance`
   services for ~1500 lines of accumulated responsibilities).

The Stage 7 spec deliberately **deferes** true semantic dedup
via embeddings (would need a new dependency on `@xenova/
transformers` or similar; user policy is "no new deps" for
this personal tool). It is listed as the first candidate for
a future Stage 8 if the user wants to revisit the dep policy.

## What this stage ships

### T1 — `updated_at` filter

`EntryFilters` gains an `updated_since` / `updated_until` pair
(matching the Stage 6 `since` / `until` pair on `created_at`).

- `list_memories` and `search_memories` MCP tools accept the
  pair via the shared `entryFilterFields`.
- `agent-recall list` accepts `--updated-since` /
  `--updated-until`; `agent-recall search` accepts
  `--updated-since` (no `--updated-until` for search; FTS
  sorts by relevance, so the upper bound is not useful in
  the same way).
- No new doctor check; the data is already in
  `memory_entries.updated_at`.

Use case: "what memories have I touched in the last week?"
combined with the existing `actor` filter.

### T2 — Configurable staleness threshold

The `STALE_DAYS = 90` constant in
`src/doctor/checks/stale-memories.ts` becomes configurable
via the `AGENT_RECALL_STALE_DAYS` environment variable. The
default stays at 90 for backward compatibility. Values that
parse as a positive integer are accepted; anything else
falls back to 90 with a one-line console warning
(`process.stderr.write`).

The doctor check reads the env var at check time (not at
module load), so the env can change between runs without
restarting the process. The MCP tool and CLI both expose
the same `stale_memories` result; nothing else changes.

### T3 — Configurable trust_boost weights

`computeTrustBoost` returns either `STRONG_TRUST_BOOST = 0.3`
(same writer) or `SOFT_TRUST_BOOST = 0.1` (recently touched).
These become `AGENT_RECALL_TRUST_STRONG` and
`AGENT_RECALL_TRUST_SOFT`, parsed at recall time. Default
0.3 / 0.1; non-numeric values fall back to the defaults with
a one-line stderr warning.

The export pipeline is unchanged; only the numeric values
move. The exporter, `compareEntries`, and the recall context
path do not know the env var exists; they just receive the
boost value the service computed.

### T4 — Inverted index for `find_duplicates`

Stage 3's `similarDuplicateGroups` runs an N×N loop over
`textSimilarity` calls. For 1k entries that's 500k pairs; for
10k it's 50M. At the personal-tool scale this is bearable
but obviously not scalable.

This task replaces the N×N loop with a token-bucket
inverted index:

1. Tokenize every entry's title + body (use the same
   `tokenize` from `src/text-similarity.ts` so the Jaccard
   sets match).
2. For each token, build a `Map<token, entryId[]>`.
3. For each pair (a, b) that shares **at least one** token,
   compute the actual Jaccard similarity. The pair set is
   bounded by the number of token co-occurrences, not by
   N².
4. Pairs already covered by an exact-match group are still
   skipped (the existing `coveredPairKeys` helper
   continues to work).

The expected win: in a realistic 1k-entry store with
~200 unique tokens per entry, the pair count drops from
500k to roughly 50-200k (a 5-10x reduction) for the
"share a token" subset. For stores with very common tokens
(stop-word-only titles) the win is smaller; the
implementation adds a per-bucket cap to bound worst-case
work.

A unit test seeds 1000 entries with random English titles
and asserts the `find_duplicates` call returns in < 5s
(was: tens of seconds at N=1000 with the N×N loop on
token Jaccard).

### T5 — Maintenance operation chunking

Maintenance actions (`archive_low_value`, `expire_due`,
`find_duplicates`) currently run in a single transaction
that holds the database write lock for the full duration.
At 10k memories, `find_duplicates` runs for many seconds
and blocks every other agent's `remember` / `getMemory`
call.

This task introduces chunking:

- Maintenance actions accept an internal `batchSize`
  parameter (default 500).
- The action processes the dataset in chunks of
  `batchSize` rows, each chunk in its own transaction.
- A `progress` callback reports `(processed, total)` so
  the MCP tool can return a partial result.
- The MCP tool schema's `maintain_memories` gains an
  optional `batch_size` field (default 500, min 50,
  max 5000).

Read operations (search, list, get) are unaffected;
SQLite is configured with WAL-mode would be ideal but
`node:sqlite` doesn't expose that knob, so we rely on
short transactions instead.

The implementation lands as a new private helper
`runMaintenanceInBatches(action, opts)` in
`MemoryService`. Existing actions are refactored to use
it; no public API change for the action keys.

### T6 — T2/T4 facade split

`MemoryService` has grown to ~1500 lines since Stage 1
because every stage bolted more responsibilities onto the
same class. This task splits it into three smaller
collaborators that all live behind the existing public
`MemoryService` API:

- **`MemoryReadService`**: `recallContext`,
  `exportMemoryContext`, `getMemory`, `listMemories`,
  `searchMemories`, `getMemoryBudget`, `findDuplicates`
  helper for the maintenance path, plus the trust-boost
  annotations.
- **`MemoryWriteService`**: `remember`, `updateMemory`,
  `supersedeMemory`, `mergeMemories`, `forgetMemory`,
  audit-event appending, dedup advisory.
- **`MemoryMaintenanceService`**: `maintainMemories`
  (now chunked per T5), plus the `find_duplicates`
  action (now token-bucketed per T4).
- **`MemoryService`** stays as the public façade, holding
  the shared `SQLiteMemoryStore` and `defaultActor`,
  delegating to the three services.

This is a pure refactor; no user-facing behavior changes.
The split is justified because the maintenance code path
has a very different shape (chunked, batched, longer
wall-clock) from the write path (transactional, fast) and
the read path (stateless, budgeted). Keeping them in one
class obscures that.

The draft files `src/services/memory-read-service.ts` and
`src/services/memory-service-helpers.ts` from Stage 2 are
replaced by the four-file split; no other code touches
those drafts.

## Data model changes

None. All four sub-tasks read existing columns or
process data in-memory. No new tables, no new columns, no
schema version bump.

## API changes

### `EntryFilters` (T1)

```ts
export type EntryFilters = {
  // ... existing ...
  updated_since?: string;       // ISO 8601, filters updated_at >=
  updated_until?: string;       // ISO 8601, filters updated_at <=
};
```

### `list_memories` and `search_memories` (T1)

Add the two new optional fields to `entryFilterFields`.

### `maintain_memories` (T5)

```ts
{
  action: "find_duplicates" | "archive_low_value" | "expire_due" | ...,
  scope: "global" | "project",
  project_id?: string,
  batch_size?: number   // NEW; default 500, min 50, max 5000
}
```

### Env vars (T2, T3)

```
AGENT_RECALL_STALE_DAYS       (default 90)
AGENT_RECALL_TRUST_STRONG     (default 0.3)
AGENT_RECALL_TRUST_SOFT       (default 0.1)
```

Invalid values fall back to the default with a one-line
`process.stderr.write` warning so the user knows.

## Tests added

T1: `test/sqlite-store-updated-at.test.ts` (~6 tests,
parallel to Stage 6's time-window suite). Forward tests
through service and CLI.

T2: `test/stale-memories-config.test.ts` (~3 tests).
Sets and unsets the env var; checks `runDoctor` picks up
the change.

T3: `test/trust-boost-config.test.ts` (~3 tests).
Same shape; checks `computeTrustBoost` and the
`recallContext` path.

T4: `test/find-duplicates-bucketed.test.ts` (~4 tests).
Seeds a 1000-entry store with overlapping tokens; asserts
the result is correct and fast. Plus a correctness test
that the bucketed detector returns the same pair set as
the N×N detector (within a tolerance for tie-breaking).

T5: `test/maintenance-chunking.test.ts` (~4 tests).
Asserts `find_duplicates` calls the `progress` callback
multiple times for a 1000-row store, and that each chunk
is a separate transaction (assertable via a
`transactionCount` mock on the store).

T6: No new tests. The facade split is a refactor; all
273 existing tests must still pass.

Expected test count: 273 → ~293 (+ ~20 new across T1-T5;
T6 is net-zero).

## Documentation updates

- `CHANGELOG.md` — `[Unreleased] — Stage 7` entry; promote
  Stage 6 to `[0.6.0]`.
- `docs/superpowers/plans/2026-07-20-stage-seven-polish.md` —
  this plan, filled in with actual task breakdown.
- `docs/superpowers/plans/2026-07-20-stage-seven-polish-closure.md` —
  closure report after the merge.
- `README.md` — Tools table: mention `updated_since` /
  `updated_until` on list/search, `batch_size` on
  `maintain_memories`. New "Configuration" section
  listing the three env vars with their defaults and
  fall-through behavior.

## Acceptance criteria

1. `list_memories({ updated_since: "2026-07-13" })`
   returns only memories whose `updated_at` is on or
   after that date. The mirror CLI flag works.
2. `AGENT_RECALL_STALE_DAYS=30 agent-recall doctor`
   reports stale entries older than 30 days; setting it
   to a non-integer falls back to 90 with a warning.
3. `AGENT_RECALL_TRUST_STRONG=0.5` causes same-writer
   recall to boost entries by 0.5 instead of 0.3; the
   effect is visible in the recall context's
   `trust_boost` field.
4. `maintain_memories` with `action: "find_duplicates"`
   completes in < 5s on a 1000-entry seeded store (was:
   minutes at N×N).
5. `maintain_memories` with `batch_size: 50` calls its
   internal `progress` callback at least 20 times for a
   1000-entry store.
6. `MemoryService` is split into `MemoryReadService`,
   `MemoryWriteService`, `MemoryMaintenanceService`; the
   public `MemoryService` API is unchanged; all 273 prior
   tests pass.
7. Existing 273 tests still pass; typecheck clean.

## Out of scope (deferred to Stage 8+)

- **True semantic dedup via embeddings** (T7 of the
  user's list). Would require a new dependency
  (`@xenova/transformers` or `onnxruntime-node`); the
  user's "no new deps" policy blocks it for this stage.
  If the user wants to revisit the dep policy, this
  becomes Stage 8.
- **Secret-detector / PII redaction on `body`** (was a
  Stage 2+ candidate; the user has not asked for it).
- **Markdown export format switch** (JSON / YAML
  alongside Markdown).
- **Import / backup-restore CLI** (read a JSON dump
  into a fresh store).
- **Per-agent workspace isolation** (separate
  `AGENT_RECALL_HOME` per agent, no shared global
  scope).
- **Live "what's stale now" tail / follow mode** (vs
  one-shot `doctor`).

## Risks

- **T2/T3 env var parsing**: invalid values must not
  crash the process. The fallback to the default with a
  stderr warning is the safety valve. The
  `process.stderr.write` is one line; if the user wants
  it logged to the audit table instead, that's a
  follow-up.
- **T4 inverted index memory**: building the
  `Map<token, entryId[]>` for 10k entries with
  ~200 tokens each is ~2M map entries, ~100MB resident.
  For the personal-tool scale this is fine. If the user
  pushes to 100k entries, this becomes a real concern
  and we'd want to switch to an on-disk token table.
- **T5 chunking + the existing `transactionDepth`**: the
  store's `transaction` helper recurses for nested
  transactions (returns the inner work without
  BEGIN/COMMIT). The chunked maintenance path needs to
  call `transaction` once per chunk; nested calls from
  helpers (e.g. `appendAudit` inside `forgetMemory`) are
  still safe.
- **T6 facade split**: the public `MemoryService` API
  is preserved, but private methods move. Tests that
  reach into `service["dataHome"]` (bracket access)
  still work because `dataHome` stays on the façade. Any
  test that uses `service as unknown as { ... }` casts
  to private members needs to be updated to cast to the
  appropriate sub-service.
- **T6 circular deps**: the three sub-services share the
  `SQLiteMemoryStore` and `defaultActor` (held by the
  façade). The façade passes itself or the shared
  pieces via constructor injection. No circular
  imports; the sub-services don't import each other.
