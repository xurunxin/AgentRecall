# Stage 5 — Recall Ranking by Actor Trust — Implementation Plan

Date: 2026-07-20
Branch: `feat/stage5-recall-trust`
Worktree: `G:\Projects\MetronX\local-memory-mcp\.worktrees\stage5-recall-trust`
Baseline: 252/252 tests green, `main` at `9a63a0a`

See [spec](../specs/2026-07-20-stage-five-recall-trust.md) for
design rationale and scope.

## Task list

- [ ] **T1** — `computeTrustBoost` helper + `ContextScore.trust_boost`.
  Pure function: takes an entry, the calling actor, and an
  `actorForEntry` callback. Returns 0.3 (same writer), 0.1
  (recently touched), or 0. Tests in
  `test/memory-service-recall-trust.test.ts`.
- [ ] **T2** — Wire the boost into `collectContextEntries` and
  update `compareContextScores` so trust_boost is the
  second sort key (after query_score, before importance).
  Also pass `this.defaultActor` as the calling actor.
- [ ] **T3** — Markdown exporter gains a `[writer: X]`
  annotation per entry. Update
  `test/markdown-exporter.test.ts` and
  `test/memory-service.test.ts` recall tests.
- [ ] **T4** — Tests covering the new ranking order:
  same-actor > foreign-touched > foreign-untouched;
  no-actor legacy case; equal-score tie-break. Reuse the
  test file from T1.
- [ ] **T5** — Docs: CHANGELOG `[Unreleased] — Stage 5`,
  closure report, README Memory Hygiene note about
  per-agent recall preference, Tools table entry for the
  new annotation.
- [ ] **T6** — Verify (`npm run typecheck && npm test &&
  git diff --check`), push branch, `--no-ff` merge to
  main, push main to origin.

## T1 — `computeTrustBoost` helper (red → green)

### Test cases (`test/memory-service-recall-trust.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { computeTrustBoost } from "../src/memory-service.js";

describe("computeTrustBoost", () => {
  it("returns strong boost (0.3) when writer matches current actor", () => {
    const entry = { /* ... */ } as any;
    const result = computeTrustBoost(entry, "agent:claude-code", () => "agent:claude-code");
    expect(result).toBe(0.3);
  });

  it("returns soft boost (0.1) when current actor appears in last_accessed_by", () => {
    const entry = { last_accessed_by: { "agent:claude-code": "2026-07-20T00:00:00.000Z" } } as any;
    const result = computeTrustBoost(entry, "agent:claude-code", () => "agent:other");
    expect(result).toBe(0.1);
  });

  it("returns 0 when no relationship", () => {
    const entry = { last_accessed_by: { "agent:other": "..." } } as any;
    const result = computeTrustBoost(entry, "agent:claude-code", () => "agent:other");
    expect(result).toBe(0);
  });

  it("returns 0 when current actor is empty", () => {
    const entry = { last_accessed_by: { "agent:claude-code": "..." } } as any;
    const result = computeTrustBoost(entry, "", () => "agent:claude-code");
    expect(result).toBe(0);
  });

  it("strong boost takes precedence over soft boost", () => {
    const entry = { last_accessed_by: { "agent:claude-code": "..." } } as any;
    const result = computeTrustBoost(entry, "agent:claude-code", () => "agent:claude-code");
    expect(result).toBe(0.3); // not 0.1
  });
});
```

### Implementation

`src/memory-service.ts`:

```ts
type ContextScore = {
  entry: MemoryEntry;
  query_score: number;
  trust_boost: number;
};

const STRONG_TRUST_BOOST = 0.3;
const SOFT_TRUST_BOOST = 0.1;

export function computeTrustBoost(
  entry: MemoryEntry,
  currentActor: string,
  actorForEntry: (e: MemoryEntry) => string
): number {
  if (currentActor.length === 0) return 0;
  const writer = actorForEntry(entry);
  if (writer === currentActor) return STRONG_TRUST_BOOST;
  if (entry.last_accessed_by?.[currentActor] !== undefined) return SOFT_TRUST_BOOST;
  return 0;
}
```

### Commit

```bash
git add src/memory-service.ts test/memory-service-recall-trust.test.ts
git commit -m "feat(stage5): add computeTrustBoost helper"
```

## T2 — Wire into the ranking (red → green)

### Test cases (extend the same file)

```ts
it("same-actor memory ranks above foreign memory with same query score", () => {
  // 2 memories, identical query score, importance, confidence, updated_at
  // The first was written by current actor, the second by another agent
  // After Stage 5: first ranks first
});

it("recently-touched foreign memory ranks above untouched foreign memory", () => {
  // Same as above but the foreign memory has last_accessed_by[caller]
});

it("no boost when service was constructed with undefined defaultActor (legacy)", () => {
  // Use a service constructed with no defaultActor
  // All entries have the same trust_boost = 0
  // Order matches pre-Stage-5 behavior
});
```

### Implementation

`src/memory-service.ts`:

```ts
private collectContextEntries(scope: ResolvedReadScope, input: ExportMemoryContextInput): MemoryEntry[] {
  // ... existing collection ...
  const tokens = queryTokens(input.query);
  return [...byId.values()]
    .map((entry) => ({
      entry,
      query_score: contextQueryScore(entry, tokens),
      trust_boost: computeTrustBoost(entry, this.defaultActor, (e) => this.actorForEntry(e))
    }))
    .sort(compareContextScores)
    .map(({ entry }) => entry);
}

function compareContextScores(a: ContextScore, b: ContextScore): number {
  const queryOrder = b.query_score - a.query_score;
  if (queryOrder !== 0) return queryOrder;

  const trustOrder = b.trust_boost - a.trust_boost;  // NEW
  if (trustOrder !== 0) return trustOrder;

  const importanceOrder = b.entry.importance - a.entry.importance;
  if (importanceOrder !== 0) return importanceOrder;
  // ... rest unchanged ...
}
```

Note: `actorForEntry` is the existing private method from
Stage 3 T4. It walks the audit log to find the
`event = 'created'` row.

### Commit

```bash
git add src/memory-service.ts test/memory-service-recall-trust.test.ts
git commit -m "feat(stage5): apply actor trust boost in recall ranking"
```

## T3 — `[writer: X]` annotation in markdown

### Test cases (extend `test/markdown-exporter.test.ts` and the recall tests)

```ts
it("recall_context includes [writer: X] annotation per entry", () => {
  // call exportMemoryContext, assert "[writer: agent:claude-code]" appears
});
```

### Implementation

`src/markdown-exporter.ts`:

```ts
// In the entry rendering, after the title:
const writer = actorForEntry(entry);  // pass in or look up here
const titleLine = `## ${entry.id} (${entry.title}) [writer: ${writer}]`;
```

Or, if the writer lookup is in the service, pass it as a
field on the rendered entry. Simpler: have the
`exportMemoryContext` method pre-render the writer into a
`writer` field on the entry, and the exporter just reads
`entry.writer`.

Actually cleanest: extend `MemoryEntry` display with an
optional `writer: string` field, populated by the service
when building the pack.

### Commit

```bash
git add src/markdown-exporter.ts src/memory-service.ts test/markdown-exporter.test.ts test/memory-service.test.ts
git commit -m "feat(stage5): annotate recall entries with writer actor"
```

## T4 — Comprehensive ranking tests

Already covered in T1+T2. Run full suite; add any edge cases
that surface during integration.

### Commit

(rolled into T2/T3)

## T5 — Docs

- `CHANGELOG.md` — add `[Unreleased] — Stage 5 Recall
  Ranking by Actor Trust` above Stage 4; promote Stage 4
  to `[0.4.0] — 2026-07-20 — Stage 4 Per-Agent Memory View`.
- `docs/superpowers/plans/2026-07-20-stage-five-recall-trust-closure.md`
  — plan-vs-actual, test inventory, architecture
  decisions, scope for Stage 6.
- `README.md` — Memory Hygiene section: brief note about
  per-agent recall preference. Tool table: mention the
  `[writer: X]` annotation.

### Commit

```bash
git add CHANGELOG.md README.md docs/superpowers/plans/2026-07-20-stage-five-recall-trust-closure.md
git commit -m "docs(stage5): add CHANGELOG entry, closure report, and README updates"
```

## T6 — Verify, push, merge

```bash
npm run typecheck
npm test
git diff --check
git push -u origin feat/stage5-recall-trust
cd ../..
git checkout main
git merge --no-ff feat/stage5-recall-trust -m "Merge branch 'feat/stage5-recall-trust'"
git push origin main
```

## Expected outcome

- 252 → ~258 tests (+ ~6 new)
- 0 schema changes
- 1 new exported function (`computeTrustBoost`)
- 1 new field on `ContextScore` (`trust_boost`)
- 1 new annotation in the recall markdown (`[writer: X]`)
- Order: same-actor memories rank above foreign ones with
  the same query relevance
- Stage 6 candidates: per-agent time windows,
  N×N inverted index for find_duplicates, T2/T4 facade
  split, semantic dedup, configurable boost weights
