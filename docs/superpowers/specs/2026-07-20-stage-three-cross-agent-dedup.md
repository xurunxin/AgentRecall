# Stage 3 — Cross-Agent Smarter Dedup

Date: 2026-07-20
Branch: `feat/stage3-cross-agent-dedup`
Predecessor: Stage 2 (commit `feff83a`)

## Why

The current dedup story only catches **exact-match rephrasings** because both
the live `remember` warning (`budget-governor.ts:128`) and the maintenance
`findDuplicateGroups` (`memory-service.ts:1175`) use string equality after
`trim + lowercase + whitespace-fold`. The 3 grouping strategies are:

- `same_title_and_body` — concat title+body, exact match
- `same_title` — title exact match
- `same_body` — body exact match

For a single user with one agent, that's acceptable. For a cross-agent
shared memory (the actual use case per the user profile), it breaks down:

> agent `claude-code` writes `project uses postgres`
> agent `cursor` writes `db is postgres`
>
> Both pass dedup. Both are written. Neither sees the other.

The user wants the second write to either merge or warn, not silently
duplicate.

## What this stage ships

A near-duplicate detector based on **token-set Jaccard similarity** with a
**default threshold of 0.7**, plumbed into both surfaces that already
detect duplicates. The exact-match path stays — a strong match is still
stronger than a near match, so both warning codes are emitted, ranked.

The warning payload also gains `actor` and `last_accessed_by` so the agent
can decide on its own whether the candidate is a stale write of its own
(high confidence) or a fresh write by another agent (medium confidence).

### Out of scope (deferred to Stage 4+)

- Per-agent ownership view (`list_memories --actor`, search by actor)
- Recall ranking weighted by actor trust
- `MemoryService` facade split (T2/T4 from Stage 2)
- Embedding-based semantic dedup (would require a new dep or local model)

## Data model changes

None. The new logic operates on existing `title` + `body` text and reads
`last_accessed_by` (already present from Stage 2 v3).

## API changes

### `BudgetWarning` (in `budget-governor.ts`)

New warning code alongside the existing `duplicate_candidate`:

```ts
type BudgetWarning = {
  code: "duplicate_candidate" | "near_duplicate";
  memory_id: string;
  reason: string;
  similarity?: number;          // 0..1, only for near_duplicate
  actor?: string;                // writer of the matching memory
  last_accessed_by?: Record<string, string>;  // ISO timestamps per agent
};
```

`duplicate_candidate` (exact match) and `near_duplicate` (Jaccard ≥ 0.7)
are both returned in `warnings` if both apply. `confirm_write: true`
bypasses all of them (existing behavior).

### `DuplicateGroup` (in `memory-service.ts`)

New reason alongside the existing three:

```ts
type DuplicateGroupReason =
  | "same_title_and_body"
  | "same_title"
  | "same_body"
  | "similar_title_and_body";  // Jaccard >= 0.7
```

The new reason returns a similarity field too, in `details`.

## Internal additions

### `src/text-similarity.ts` (new file)

Pure functions, no dependencies on the rest of the codebase:

- `tokenizeForSimilarity(text: string): Set<string>`
  - lowercase, strip punctuation, fold whitespace
  - drop a small built-in stop-word set (en: `the, a, an, is, are, of, in, on, ...`)
  - returns a set of surviving tokens
- `jaccard(a: Set<string>, b: Set<string>): number`
  - standard `|a ∩ b| / |a ∪ b|`, returns 0 for two empty sets
- `textSimilarity(a: string, b: string): number`
  - convenience: `jaccard(tokenizeForSimilarity(a), tokenizeForSimilarity(b))`

### `src/text-similarity.test.ts` (new file)

Unit tests covering:

- `tokenizeForSimilarity` drops stop words, folds case, strips punctuation
- `jaccard` returns 1 for identical sets, 0 for disjoint, intermediate for overlap
- `textSimilarity("project uses postgres", "db is postgres") >= 0.5` (catches the motivating example, even if not above 0.7)
- `textSimilarity("project uses postgres", "user prefers tabs")` < 0.2 (false-positive guard)
- Empty string inputs return 0

### Threshold

`SIMILARITY_THRESHOLD = 0.7` exported from `src/text-similarity.ts`,
applied in both consumers (`evaluateBudget` and `findDuplicateGroups`).
Not user-configurable in this stage — keeping the surface small. A
follow-up could expose it as a write-validator option if false positives
become a real problem.

## Behavior changes

### Live `remember` flow

Today: only exact `duplicate_candidate` is returned; agent sees
`matching_ids` and can call `merge_memories`.

After: BOTH exact AND near-duplicate warnings are returned. The agent
sees:

- `matching_ids` for the exact set (still bypassed by `confirm_write: true`)
- `near_matching_ids` for the near set, with `similarity`, `actor`,
  `last_accessed_by` per match
- `confirm_write: true` continues to bypass both
- A new `confirm_write: "merge_into:<id>"` shortcut is **not** introduced
  in this stage (out of scope; `merge_memories` already covers it)

### Maintenance `detect_duplicates` action

Today: returns `groups: DuplicateGroup[]` covering only exact matches.

After: adds `similar_title_and_body` groups, with `details.similarity`
populated. Existing groups unchanged.

## Tests added

- `test/text-similarity.test.ts` — new unit tests
- `test/remember-confirm.test.ts` — extend with `near_duplicate` cases
- `test/memory-service.test.ts` — extend `findDuplicateGroups` cases
  (likely in `test/detect-duplicates.test.ts` or inline)

Expected test count: 215 → ~230 (+ ~15 new tests).

## Documentation updates

- `CHANGELOG.md` — new `[Unreleased] — Stage 3` entry
- `docs/superpowers/plans/2026-07-20-stage-three-cross-agent-dedup.md` —
  full TDD plan (T1..T7 with checkboxes)
- `docs/superpowers/plans/2026-07-20-stage-three-closure.md` — closure
  report (template from Stage 2)
- `README.md` — note in the Memory Hygiene section about near-duplicate
  detection; new example in the agent prompt snippet (optional)

## Acceptance criteria

1. **Motivating example works**: writing "db is postgres" after "project
   uses postgres" is reported as `near_duplicate` with `similarity >= 0.5`
2. **False-positive guard holds**: writing "user prefers tabs" after
   "project uses postgres" reports NO warning
3. **Existing exact-match path unchanged**: 215 prior tests still pass
4. **Confirm-write still bypasses both**: `confirm_write: true` proceeds
   regardless of warnings
5. **Per-agent info surfaced**: warnings include `actor` and
   `last_accessed_by` of the matching memory, so the agent can decide
6. **No new dependencies**: similarity is pure JS, no embeddings, no
   new npm packages
7. **Typecheck clean, build clean, 230-ish tests passing, doctor 10/10 OK**

## Risks

- **False positives in noisy text**: e.g., short project-name-only
  memories with overlapping tags could over-trigger. Mitigation: the
  threshold is fixed at 0.7 in this stage, but the surface is small
  enough to tune in a follow-up if needed.
- **Stop word list is English-only**: this is a personal tool used
  primarily with English-language agent output, so a small English
  stop list is acceptable. Non-English text will simply have higher
  Jaccard (more shared content tokens), which is mildly conservative
  (fewer false negatives) but not wrong.
- **`last_accessed_by` may be empty for old memories** (pre-Stage-2
  writes never had an actor recorded). The warning payload tolerates
  this — the field is just absent.
