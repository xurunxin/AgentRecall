# Stage 3 — Cross-Agent Smarter Dedup — Implementation Plan

Date: 2026-07-20
Branch: `feat/stage3-cross-agent-dedup`
Worktree: `G:\Projects\MetronX\local-memory-mcp\.worktrees\stage3-cross-agent-dedup`
Baseline: 215/215 tests green, `main` at `feff83a`

See [spec](../specs/2026-07-20-stage-three-cross-agent-dedup.md) for the
design rationale and scope.

## Task list

- [ ] **T1** — Extract `src/text-similarity.ts` with `tokenizeForSimilarity`,
  `jaccard`, and `textSimilarity`. Unit tests in
  `test/text-similarity.test.ts`. Red → green.
- [ ] **T2** — Wire Jaccard into `evaluateBudget` in `src/budget-governor.ts`.
  Emit a second `BudgetWarning` with code `"near_duplicate"` when
  `textSimilarity(title or body) >= 0.7` and the exact-match path didn't
  fire. Extend `test/remember-confirm.test.ts` (or add cases inline).
- [ ] **T3** — Wire Jaccard into `MemoryService.findDuplicateGroups`.
  Add `similar_title_and_body` to the `DuplicateGroupReason` union and
  emit a group whenever Jaccard ≥ 0.7 (and the existing exact-match
  groups didn't already cover the pair). Extend the maintain-flow
  duplicate tests.
- [ ] **T4** — Enrich the `BudgetWarning` payload with `actor` and
  `last_accessed_by`. Requires `MemoryService.remember` to read the
  matching memory and surface those fields on the warning before
  returning. The store already has the data (`MemoryEntry.source` and
  `last_accessed_by`).
- [ ] **T5** — Update tool descriptions for `remember` and
  `maintain_memories` in `src/tools/descriptions.ts` so callers know
  about the new `near_duplicate` and `similar_title_and_body` signals.
  Re-run `test/tools-descriptions.test.ts` to keep the 80/400 char
  budget.
- [ ] **T6** — Docs: `CHANGELOG.md` `[Unreleased] — Stage 3` entry,
  `docs/superpowers/plans/2026-07-20-stage-three-closure.md` closure
  report, and `README.md` hygiene-section update.
- [ ] **T7** — Final verification (`npm run typecheck && npm test &&
  git diff --check`), push branch + merge `feat/stage3-cross-agent-dedup`
  to `main` with `--no-ff`, push `main` to origin.

## T1 — text-similarity module (red → green)

### Test cases (`test/text-similarity.test.ts`, ~7 tests)

```ts
import { describe, expect, it } from "vitest";
import { jaccard, textSimilarity, tokenizeForSimilarity } from "../src/text-similarity.js";

describe("tokenizeForSimilarity", () => {
  it("lowercases and folds whitespace", () => {
    expect(tokenizeForSimilarity("  Foo  BAR  baz ")).toEqual(new Set(["foo", "bar", "baz"]));
  });
  it("strips basic punctuation", () => {
    expect(tokenizeForSimilarity("hello, world!")).toEqual(new Set(["hello", "world"]));
  });
  it("drops a built-in stop-word set", () => {
    expect(tokenizeForSimilarity("this is a test of the thing"))
      .toEqual(new Set(["test", "thing"]));
  });
  it("returns an empty set for stop-word-only input", () => {
    expect(tokenizeForSimilarity("the a an of in")).toEqual(new Set());
  });
});

describe("jaccard", () => {
  it("returns 1 for identical sets", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
  });
  it("returns 0 for disjoint sets", () => {
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
  });
  it("returns 0 when both inputs are empty", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
  it("computes |intersect| / |union|", () => {
    // a={x,y,z}, b={y,z,w}; |I|=2, |U|=4, jaccard=0.5
    expect(jaccard(new Set(["x", "y", "z"]), new Set(["y", "z", "w"]))).toBe(0.5);
  });
});

describe("textSimilarity (end-to-end)", () => {
  it("catches the motivating example", () => {
    // project uses postgres / db is postgres — should be >= 0.5
    const s = textSimilarity("project uses postgres", "db is postgres");
    expect(s).toBeGreaterThanOrEqual(0.5);
  });
  it("does not flag unrelated memories", () => {
    const s = textSimilarity("project uses postgres", "user prefers tabs");
    expect(s).toBeLessThan(0.2);
  });
  it("returns 1 for two identical strings", () => {
    expect(textSimilarity("hello world", "hello world")).toBe(1);
  });
  it("returns 0 for two empty strings", () => {
    expect(textSimilarity("", "")).toBe(0);
  });
});
```

### Module (`src/text-similarity.ts`)

```ts
// src/text-similarity.ts
//
// Pure token-set Jaccard similarity. Used by budget-governor and
// findDuplicateGroups to surface near-duplicate memories that the
// exact-match path would miss. No external dependencies.

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
  "has", "have", "in", "is", "it", "its", "of", "on", "or", "that",
  "the", "this", "to", "was", "were", "will", "with"
]);

export function tokenizeForSimilarity(text: string): Set<string> {
  const out = new Set<string>();
  const lowered = text.toLowerCase();
  // Split on any non-letter/digit/underscore run. Keeps CJK characters
  // (which are individual code points, not word-broken by spaces).
  const tokens = lowered.split(/[^\p{L}\p{N}_]+/u);
  for (const t of tokens) {
    if (t.length === 0) continue;
    if (STOP_WORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const token of a) if (b.has(token)) intersect += 1;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

export function textSimilarity(a: string, b: string): number {
  return jaccard(tokenizeForSimilarity(a), tokenizeForSimilarity(b));
}

export const SIMILARITY_THRESHOLD = 0.7;
```

### Commit

```bash
git add src/text-similarity.ts test/text-similarity.test.ts
git commit -m "feat(stage3): add text-similarity module (token-set Jaccard)"
```

## T2 — Wire Jaccard into `evaluateBudget` (red → green)

### Test cases (extend `test/remember-confirm.test.ts`)

```ts
it("flags near-duplicate title when Jaccard >= 0.7", () => {
  const first = service.remember({ ...baseInput({ title: "project uses postgres", body: "primary datastore is postgres" }) });
  if (!first.ok) throw new Error("setup");
  // The second title has 0/3 overlap with the first — should not flag.
  // The second body rephrases the first body — should flag.
  const second = service.remember({ ...baseInput({ title: "totally different", body: "primary db is postgres" }) });
  expect(second.ok).toBe(false);
  if (second.ok) return;
  expect(second.error).toBe("duplicate_candidate");
  expect(second.details).toMatchObject({ near_matching_ids: [first.value.memory_id] });
});

it("does not flag a near-duplicate on confirm_write: true", () => {
  // setup a first memory
  const first = service.remember({ ...baseInput({ title: "p1", body: "primary db is postgres" }) });
  if (!first.ok) throw new Error("setup");
  const second = service.remember({ ...baseInput({ title: "p2", body: "primary db is postgres", confirm_write: true }) });
  expect(second.ok).toBe(true);
});
```

### Implementation

`src/budget-governor.ts`:

```ts
import { SIMILARITY_THRESHOLD, textSimilarity } from "./text-similarity.js";

export type BudgetWarning = {
  code: "duplicate_candidate" | "near_duplicate";
  memory_id: string;
  reason: string;
  similarity?: number;
  actor?: string;
  last_accessed_by?: Record<string, string>;
};

// inside evaluateBudget:
const existingEntries = input.existingEntries ?? [];
const warnings: BudgetWarning[] = [];
for (const entry of existingEntries) {
  if (entry.status !== "active") continue;
  if (sameText(entry.title, input.candidate.title) || sameText(entry.body, input.candidate.body)) {
    warnings.push({ code: "duplicate_candidate", memory_id: entry.id, reason: "..." });
    continue;
  }
  const titleSim = textSimilarity(entry.title, input.candidate.title);
  const bodySim = textSimilarity(entry.body, input.candidate.body);
  const max = Math.max(titleSim, bodySim);
  if (max >= SIMILARITY_THRESHOLD) {
    warnings.push({ code: "near_duplicate", memory_id: entry.id, reason: "...", similarity: max });
  }
}
```

`src/memory-service.ts` (in `remember`, after `evaluateBudget`):

```ts
const result = evaluateBudget({ ... });
if (!result.ok) return result;
const nearMatching = result.value.warnings
  .filter((w) => w.code === "near_duplicate")
  .map((w) => w.memory_id);
const matchingIds = result.value.warnings
  .filter((w) => w.code === "duplicate_candidate")
  .map((w) => w.memory_id);
if (matchingIds.length > 0 && input.confirm_write !== true) {
  return err("duplicate_candidate", "...", { matching_ids: matchingIds });
}
if (nearMatching.length > 0) {
  // Append to details — do not block; the agent can choose to call
  // merge_memories or rewrite before retrying.
  // NOTE: surfaced as a "warning" not an "error" — the spec calls for
  // this to be advisory. (deferred to T4 for actor/last_accessed_by
  // enrichment; T2 only adds the IDs).
}
```

Wait — re-reading the spec: the warning payload is advisory, not a
blocking error. So T2 just makes the IDs surface. T4 enriches with
actor + last_accessed_by. T2 doesn't return an error; it just lets the
agent see `near_matching_ids` in the success response (e.g., as
`details`). Decide the exact surface when implementing.

### Commit

```bash
git add src/budget-governor.ts src/memory-service.ts test/remember-confirm.test.ts
git commit -m "feat(stage3): flag near-duplicate candidates in remember flow"
```

## T3 — Wire Jaccard into `findDuplicateGroups` (red → green)

### Test cases (extend `test/memory-service.test.ts` or add inline)

```ts
it("groups similar title_and_body via Jaccard", () => {
  const r1 = service.remember({ ...baseInput({ title: "project uses postgres", body: "primary datastore is postgres" }) });
  if (!r1.ok) throw new Error("setup");
  const r2 = service.remember({ ...baseInput({ title: "totally new", body: "primary db is postgres", confirm_write: true }) });
  if (!r2.ok) throw new Error("setup");
  const result = service.maintainMemories({ action: "find_duplicates", scope: "global" });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const groups = (result.value.details as { groups: Array<{ reason: string; memory_ids: string[]; details?: { similarity?: number } }> }).groups;
  const simGroup = groups.find((g) => g.reason === "similar_title_and_body");
  expect(simGroup).toBeDefined();
  expect(simGroup?.memory_ids).toContain(r1.value.memory_id);
  expect(simGroup?.memory_ids).toContain(r2.value.memory_id);
  expect(simGroup?.details?.similarity).toBeGreaterThanOrEqual(0.7);
});
```

### Implementation

`src/memory-service.ts` (`DuplicateGroup` type + `findDuplicateGroups`):

```ts
export type DuplicateGroupReason =
  | "same_title_and_body"
  | "same_title"
  | "same_body"
  | "similar_title_and_body";

export type DuplicateGroup = {
  reason: DuplicateGroupReason;
  fingerprint: string;
  memory_ids: string[];
  titles: string[];
  details?: { similarity?: number };
};

// in findDuplicateGroups:
const similarGroups: DuplicateGroup[] = [];
const seen = new Set<string>(); // pair key
for (let i = 0; i < sortedEntries.length; i += 1) {
  for (let j = i + 1; j < sortedEntries.length; j += 1) {
    const a = sortedEntries[i];
    const b = sortedEntries[j];
    const pairKey = `${a.id}|${b.id}`;
    if (seen.has(pairKey)) continue;
    if (a.status !== "active" || b.status !== "active") continue;
    const titleSim = textSimilarity(a.title, b.title);
    const bodySim = textSimilarity(a.body, b.body);
    const max = Math.max(titleSim, bodySim);
    if (max < SIMILARITY_THRESHOLD) continue;
    similarGroups.push({
      reason: "similar_title_and_body",
      fingerprint: `sim:${max.toFixed(3)}:${pairKey}`,
      memory_ids: [a.id, b.id],
      titles: [a.title, b.title],
      details: { similarity: max }
    });
    seen.add(pairKey);
  }
}
// ... append similarGroups to the return, after sorting by reason rank
```

### Commit

```bash
git add src/memory-service.ts test/memory-service.test.ts
git commit -m "feat(stage3): group similar memories in findDuplicateGroups"
```

## T4 — Enrich warning payload with actor + last_accessed_by

### Test cases (extend `test/remember-confirm.test.ts`)

```ts
it("surfaces the matching memory's actor in near_duplicate details", () => {
  // Write as a different actor (use a custom service actor)
  const claudeService = new MemoryService(store, undefined, "agent:claude-code", dataHome);
  const first = claudeService.remember(baseInput({ title: "p1", body: "primary db is postgres" }));
  if (!first.ok) throw new Error("setup");
  const second = service.remember({ ...baseInput({ title: "p2", body: "primary db is postgres" }) });
  // ... assert second.details.near_duplicate_warnings[0].actor === "agent:claude-code"
});
```

### Implementation

Tweak `evaluateBudget` to accept a way to look up the matching memory's
`source` and `last_accessed_by`. Two options:

- (A) Pass the full `MemoryEntry` to `evaluateBudget` (it already accepts
  `existingEntries: MemoryEntry[]`). The function already sees the full
  entry. Just include `actor` (from `entry.source`) and
  `last_accessed_by` on the warning.

Option A is the right one — no API change. The `MemoryEntry.source`
type is `{ kind: "user" } | { kind: "agent"; agent?: string } | ...`,
so the warning's `actor` is `entry.source.agent ?? entry.source.kind`.

### Commit

```bash
git add src/budget-governor.ts test/remember-confirm.test.ts
git commit -m "feat(stage3): include actor and last_accessed_by in dedup warnings"
```

## T5 — Tool descriptions

Update `src/tools/descriptions.ts` for `remember` and `maintain_memories`.
`remember` OUTPUT segment gains a line about `near_matching_ids`.
`maintain_memories` action `find_duplicates` OUTPUT segment gains a line
about `similar_title_and_body` groups.

Re-run `test/tools-descriptions.test.ts` to keep the 80/400 char budget.

### Commit

```bash
git add src/tools/descriptions.ts
git commit -m "docs(stage3): document near_duplicate and similar_title_and_body"
```

## T6 — Closure docs

- `CHANGELOG.md` — add `[Unreleased] — Stage 3 Cross-Agent Smarter Dedup`
  section above the existing `[0.1.0] — Stage 1` entry. Promote Stage 2
  to `[0.2.0] — 2026-07-19 — Stage 2 Conflict and Structure` for clean
  version ordering.
- `docs/superpowers/plans/2026-07-20-stage-three-closure.md` —
  plan-vs-actual, test inventory, architecture decisions, scope for
  Stage 4.
- `README.md` — short note in the Memory Hygiene section about
  near-duplicate detection; the example of two agents writing similar
  facts.

### Commit

```bash
git add CHANGELOG.md README.md docs/superpowers/plans/2026-07-20-stage-three-closure.md
git commit -m "docs(stage3): add CHANGELOG entry, closure report, and README updates"
```

## T7 — Verification, push, merge

```bash
npm run typecheck
npm test
git diff --check
git push -u origin feat/stage3-cross-agent-dedup
# back in main worktree
cd ../..
git checkout main
git merge --no-ff feat/stage3-cross-agent-dedup -m "Merge branch 'feat/stage3-cross-agent-dedup'"
git push origin main
```

## Expected outcome

- 215 → ~230 tests (+ ~15 from `test/text-similarity.test.ts` and the
  extended confirm/dedup suites)
- 0 schema changes, 1 new module, 1 new warning code, 1 new group reason
- `doctor` still 10/10 OK (no new checks in this stage — per-agent view
  is Stage 4)
- Stage 4 candidate: `list_memories --actor`, `search_memories` ranking
  weighted by actor trust, recall-by-actor in the doctor

## Risks

- **Stop-word list is English-only**: zh / ja / ko text will not be
  stop-filtered, which makes Jaccard higher (more shared content
  tokens). Conservatively biased toward more matches, not fewer. This
  is fine for the user's primary use case (English-language agent
  output) and can be revisited if non-English noise becomes a problem.
- **Jaccard on tags-only short titles may over-trigger**: e.g., two
  memories with title `"postgres"` and `"postgres"` will hit 1.0 even
  though their bodies differ. The body-similarity branch of the
  warning helps but doesn't fully fix it. Acceptable for Stage 3; if
  it bites, raise the threshold to 0.8 in Stage 4.
- **N×N comparison in `findDuplicateGroups`**: at 10k memories, that's
  50M comparisons. Stage 2 baseline is well under 1k active memories;
  the closure report should note this and Stage 4+ should consider
  bucketing or inverted index.
