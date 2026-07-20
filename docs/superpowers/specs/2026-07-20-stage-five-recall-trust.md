# Stage 5 — Recall Ranking by Actor Trust

Date: 2026-07-20
Branch: `feat/stage5-recall-trust`
Predecessor: Stage 4 (commit `9a63a0a`)

## Why

Stage 4 gave the user per-agent view (`list --actor X`,
`search --actor X`). But the day-to-day entry point for an
agent is `recall_context` — a relevance-ranked markdown pack
that gets pasted into the system prompt. Today the ranking is:

1. `query_score` (title/topic/tags/body token overlap with the
   user's query)
2. `importance`
3. `confidence`
4. `updated_at`
5. `id` (deterministic tie-break)

There's no notion of "did I (the calling agent) write this?"
or "did I touch this recently?" — so a foreign agent's stale
write ranks the same as my own recent one when the relevance
score is close. For a cross-agent shared memory (the actual
use case per the user profile), this is a real friction point:
the agent asks "what do I know about postgres tuning?" and
gets back a mix of its own, claude-code's, and cursor's
memories in FTS-relevance order, with no preference for the
agent's own knowledge.

The data is already in the database to do better. The
`last_accessed_by` map (Stage 2 v3) and the audit log
(Stage 1+) together answer both questions. Stage 5 wires them
into the recall ranking.

## What this stage ships

A per-memory `trust_boost` added to the recall context score,
computed at recall time from the calling actor's relationship
to each candidate memory:

- **Strong boost** (+0.3): the memory was written by the
  calling actor — looked up via the audit log's
  `event = 'created'` row.
- **Soft boost** (+0.1): the memory appears in the calling
  actor's `last_accessed_by` map (i.e. the calling agent
  has read or written it recently).
- **No boost** (0): no relationship.

The boost is applied **after** `query_score` (so we still
respect the user's query) and **before** `importance` (so the
agent's own knowledge wins over an old high-importance write
from someone else). Final order:

1. `query_score` desc
2. `trust_boost` desc
3. `importance` desc
4. `confidence` desc
5. `updated_at` desc
6. `id` asc

The recall markdown output adds a small inline annotation
`[writer: <actor>]` to each entry so the agent (and the
human reading the output) can see who wrote the memory at a
glance. The boost is internal — not surfaced in the markdown
itself, but visible via the new order.

## Data model changes

None. The trust boost is computed on the fly from
`audit_events.actor` and `memory_entries.last_accessed_by`,
both of which already exist.

## API changes

No external API changes. The boost is internal to
`MemoryService.exportMemoryContext` and the
`collectContextEntries` / `compareContextScores` helpers.

The schema of the returned markdown gains a `[writer: X]`
annotation per entry. The position and format are stable
(see Implementation).

## Internal additions

### `computeTrustBoost(entry, currentActor, actorForEntry): number`

In `src/memory-service.ts` (or a new helper module):

```ts
const STRONG_BOOST = 0.3;
const SOFT_BOOST = 0.1;

function computeTrustBoost(
  entry: MemoryEntry,
  currentActor: string,
  actorForEntry: (e: MemoryEntry) => string
): number {
  if (currentActor.length === 0) return 0;
  const writer = actorForEntry(entry);
  if (writer === currentActor) return STRONG_BOOST;
  if (entry.last_accessed_by?.[currentActor] !== undefined) return SOFT_BOOST;
  return 0;
}
```

### `ContextScore.trust_boost`

```ts
type ContextScore = {
  entry: MemoryEntry;
  query_score: number;
  trust_boost: number;  // NEW
};
```

### `compareContextScores` updated

After `query_score`, sort by `trust_boost` desc.

## Behavior

- Boost is only applied when `currentActor` is non-empty (i.e.
  the service was constructed with a real `defaultActor`).
  Constructed with the legacy `undefined` default, the boost
  is 0 for every entry (no behavior change for legacy
  callers).
- Boost is purely additive on top of the existing score. A
  memory with no relationship to the calling actor stays
  exactly where it would be today.
- A foreign agent's recent write that the calling actor has
  read still gets the soft boost (0.1) — the "I touched this
  recently" signal.
- An agent's own high-confidence write on a tangentially
  related query can outrank a foreign high-relevance
  write, which is the intended behavior.

## Tests added

- `test/memory-service-recall-trust.test.ts` (new):
  - same-actor memory ranks above foreign memory with the
    same query score
  - recently-touched foreign memory ranks above untouched
    foreign memory
  - no boost when service was constructed with `undefined`
    defaultActor (legacy callers)
  - foreign memory with no relationship retains the old
    ranking (no regression)
  - higher-importance foreign memory can still outrank
    same-actor low-importance memory when trust is the
    only differentiator
- Existing `test/memory-service.test.ts` recall tests
  should still pass (no behavior change for the default
  `agent:test` case where the writer == the caller — boost
  is +0.3 and ties the existing order).

Expected test count: 252 → ~258 (+ ~6 new).

## Documentation updates

- `CHANGELOG.md` — `[Unreleased] — Stage 5` entry above the
  existing Stage 4 section; promote Stage 4 to `[0.4.0]`.
- `docs/superpowers/plans/2026-07-20-stage-five-recall-trust.md`
  — 7-task implementation plan.
- `docs/superpowers/plans/2026-07-20-stage-five-recall-trust-closure.md`
  — closure report (template from prior stages).
- `README.md` — Memory Hygiene section: brief note that
  `recall_context` ranks the calling agent's own knowledge
  first. Tool table: mention the per-entry `[writer: X]`
  annotation in the `recall_context` output.

## Acceptance criteria

1. `recall_context` returns the calling agent's own writes
   before foreign writes with the same query relevance.
2. `recall_context` returns recently-touched foreign writes
   before untouched foreign writes.
3. The `[writer: <actor>]` annotation appears on every
   entry in the markdown output.
4. Boost is 0 when the service was constructed with
   `undefined` defaultActor (no regression for legacy code
   paths).
5. Existing 252 tests still pass; typecheck clean.
6. The cost of the boost is one audit-log lookup per
   memory in the candidate set. For 100 candidates on a
   small audit log, the lookup is O(1) per memory via the
   existing index — sub-millisecond total.

## Out of scope (deferred to Stage 6+)

- Per-agent time-window filters (e.g. "memories by cursor
  in the last 7 days") — different UX, different feature.
- N×N inverted index for `find_duplicates` (Stage 3 debt).
- T2/T4 facade split (Stage 2 debt).
- Semantic dedup (would require a new dep).
- Configurable boost weights (the user can tune the
  constants in code, but no CLI / config surface yet).
- Per-call actor override: the `exportMemoryContext` input
  could take an optional `actor` field to override
  `this.defaultActor` for a specific call. Defer until
  there's a use case.

## Risks

- **N+1 audit lookup**: the boost costs one
  `actorForEntry` call per candidate memory. For 100
  candidates this is 100 lookups via the index. Acceptable
  for a recall that runs once per task-start. If it becomes
  a problem, Stage 6+ can introduce a denormalized
  `last_actor` column.
- **Legacy callers**: services constructed without
  `defaultActor` (or with the legacy `"agent"` value) get
  no boost. The legacy `"agent"` is ambiguous in a
  cross-agent world; the user should set
  `AGENT_RECALL_ACTOR` per agent (already documented in the
  MCP setup section).
- **Tie-breaking**: when two memories have the same
  `query_score + trust_boost`, the next criteria kick in
  (importance, confidence, updated_at). This preserves
  determinism.
