# Stage 7 — Maintenance & Polish — Implementation Plan

Date: 2026-07-20
Branch: `feat/stage7-polish`
Worktree: `G:\Projects\MetronX\local-memory-mcp\.worktrees\stage7-polish`
Baseline: 273/273 tests green, `main` at `898ccb6`

See [spec](../specs/2026-07-20-stage-seven-polish.md) for
design rationale and scope.

## Task list

- [x] **T0** — Spec + plan (this document)
- [ ] **T1** — `updated_since` / `updated_until` on
  `EntryFilters`, plumbed through service, MCP tool
  schemas, CLI flags. ~6 store tests + forward tests.
- [ ] **T2** — `AGENT_RECALL_STALE_DAYS` env var read by
  `checkStaleMemories`. Default 90, falls back on
  invalid input. ~3 tests.
- [ ] **T3** — `AGENT_RECALL_TRUST_STRONG` /
  `AGENT_RECALL_TRUST_SOFT` env vars read by
  `computeTrustBoost`. Defaults 0.3 / 0.1, fall back on
  invalid input. ~3 tests.
- [ ] **T4** — Replace N×N `similarDuplicateGroups` loop
  with a token-bucketed inverted index. Correctness
  test: bucketed result is equivalent to N×N for a
  small fixture. Performance test: 1000 entries in
  < 5s. ~4 tests.
- [ ] **T5** — Chunked maintenance: new
  `runMaintenanceInBatches` helper, `batch_size` field
  on `maintain_memories` schema. ~4 tests.
- [ ] **T6** — T2/T4 facade split: extract
  `MemoryReadService`, `MemoryWriteService`,
  `MemoryMaintenanceService`; `MemoryService` becomes
  a façade. Pure refactor, 0 new tests, 273 existing
  tests must still pass.
- [ ] **T7** — Docs: CHANGELOG `[Unreleased] — Stage 7`,
  closure report, README Configuration section.
- [ ] **T8** — Verify (`npm run typecheck && npm test &&
  git diff --check`), push branch, `--no-ff` merge to
  `main`, push `main` to origin.

## T1 — `updated_at` filter (red → green)

### Test cases (`test/sqlite-store-updated-at.test.ts`)

```ts
describe("listEntries updated_at filter (stage 7)", () => {
  it("updated_since filters by updated_at", ...);
  it("updated_until filters by updated_at", ...);
  it("updated_since + updated_until forms a closed range", ...);
  it("updated_since combines with the existing since/actor filters", ...);
  it("no updated_at filters returns all active entries", ...);
});

describe("searchEntries updated_at filter (stage 7)", () => {
  it("updated_since narrows FTS results", ...);
});
```

### Implementation

`src/sqlite-store.ts`:

```ts
export type EntryFilters = {
  // ... existing ...
  updated_since?: string;     // ISO 8601, filters updated_at >=
  updated_until?: string;     // ISO 8601, filters updated_at <=
};

function buildEntryWhere(filters, alias) {
  // ... existing ...
  if (filters.updated_since !== undefined) {
    clauses.push(`${column("updated_at")} >= ?`);
    params.push(filters.updated_since);
  }
  if (filters.updated_until !== undefined) {
    clauses.push(`${column("updated_at")} <= ?`);
    params.push(filters.updated_until);
  }
  // ...
}
```

`src/memory-service.ts` `entryFiltersForRead`: forward
both new fields.

`src/tools/schemas.ts` `entryFilterFields`: add the two
new fields with `z.string().datetime({ offset: true })`.

`src/tools/descriptions.ts`: update list / search INPUT
segments.

`src/cli/commands/list.ts` and `src/cli/commands/search.ts`:
add `--updated-since` / `--updated-until` (list) /
`--updated-since` (search only) flags.

### Commit

```bash
git add src/sqlite-store.ts src/memory-service.ts \
        src/tools/schemas.ts src/tools/descriptions.ts \
        src/cli/commands/list.ts src/cli/commands/search.ts \
        test/sqlite-store-updated-at.test.ts \
        test/memory-service.test.ts test/tool-registration.test.ts \
        test/cli/list.test.ts test/cli/search.test.ts
git commit -m "feat(stage7): add updated_since/updated_until to EntryFilters"
```

## T2 — Configurable staleness threshold (red → green)

### Test cases (`test/stale-memories-config.test.ts`)

```ts
describe("checkStaleMemories config (stage 7)", () => {
  it("uses 90 by default", ...);
  it("reads AGENT_RECALL_STALE_DAYS from env", ...);
  it("falls back to 90 with a stderr warning on invalid input", ...);
});
```

### Implementation

`src/doctor/checks/stale-memories.ts`:

```ts
const DEFAULT_STALE_DAYS = 90;

function parseStaleDays(): number {
  const raw = process.env.AGENT_RECALL_STALE_DAYS;
  if (raw === undefined) return DEFAULT_STALE_DAYS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(
      `agent-recall: invalid AGENT_RECALL_STALE_DAYS="${raw}", using default ${DEFAULT_STALE_DAYS}\n`
    );
    return DEFAULT_STALE_DAYS;
  }
  return n;
}

export function checkStaleMemories(ctx: CheckContext): CheckResult {
  const staleDays = parseStaleDays();
  const cutoff = daysAgoIso(staleDays, ctx.now());
  // ... same query as before, using `cutoff` ...
  return {
    name: "stale_memories",
    status: "ok",
    message: `${countRow.c} memories stale (>${staleDays} days); top 5 oldest listed below`,
    details: { count: countRow.c, threshold_days: staleDays, sample: rows }
  };
}
```

### Commit

```bash
git add src/doctor/checks/stale-memories.ts test/stale-memories-config.test.ts
git commit -m "feat(stage7): make stale_memories threshold configurable via env"
```

## T3 — Configurable trust_boost weights (red → green)

### Test cases (`test/trust-boost-config.test.ts`)

```ts
describe("computeTrustBoost config (stage 7)", () => {
  it("uses 0.3 / 0.1 by default", ...);
  it("reads AGENT_RECALL_TRUST_STRONG/SOFT from env", ...);
  it("falls back to defaults with a stderr warning on invalid input", ...);
});
```

### Implementation

`src/memory-service.ts`:

```ts
const DEFAULT_STRONG_TRUST_BOOST = 0.3;
const DEFAULT_SOFT_TRUST_BOOST = 0.1;

function parseEnvFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    process.stderr.write(
      `agent-recall: invalid ${name}="${raw}", using default ${fallback}\n`
    );
    return fallback;
  }
  return n;
}

export function computeTrustBoost(
  entry: MemoryEntry,
  currentActor: string,
  actorForEntry: (entry: MemoryEntry) => string | undefined
): number {
  const strong = parseEnvFloat("AGENT_RECALL_TRUST_STRONG", DEFAULT_STRONG_TRUST_BOOST);
  const soft = parseEnvFloat("AGENT_RECALL_TRUST_SOFT", DEFAULT_SOFT_TRUST_BOOST);
  const writer = actorForEntry(entry);
  if (writer === currentActor) return strong;
  const lastBy = entry.last_accessed_by?.[currentActor];
  if (lastBy !== undefined) return soft;
  return 0;
}
```

### Commit

```bash
git add src/memory-service.ts test/trust-boost-config.test.ts
git commit -m "feat(stage7): make trust_boost weights configurable via env"
```

## T4 — Inverted index for find_duplicates (red → green)

### Test cases (`test/find-duplicates-bucketed.test.ts`)

```ts
describe("findDuplicateGroups bucketed (stage 7)", () => {
  it("returns the same pairs as the N×N detector on a small fixture", ...);
  it("skips pairs covered by exact-match groups", ...);
  it("caps per-bucket work to bound worst case", ...);
  it("completes 1000 entries in < 5s", ...);
});
```

### Implementation

`src/memory-service.ts`:

```ts
import { tokenize } from "./text-similarity.js";

private similarDuplicateGroups(entries: MemoryEntry[], covered: Set<string>): DuplicateGroup[] {
  // 1. Build inverted index: token -> entries that contain it.
  const bucket = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    const tokens = new Set([
      ...tokenize(entry.title),
      ...tokenize(entry.body)
    ]);
    for (const token of tokens) {
      const arr = bucket.get(token);
      if (arr === undefined) {
        bucket.set(token, [entry]);
      } else {
        arr.push(entry);
      }
    }
  }

  // 2. Walk buckets, gather candidate pairs, dedupe.
  const seen = new Set<string>();
  const groups: DuplicateGroup[] = [];
  for (const entriesInBucket of bucket.values()) {
    // Cap per-bucket work to bound worst case for stop-word-heavy stores.
    if (entriesInBucket.length > 200) continue;
    for (let i = 0; i < entriesInBucket.length; i += 1) {
      const a = entriesInBucket[i];
      if (a === undefined) continue;
      for (let j = i + 1; j < entriesInBucket.length; j += 1) {
        const b = entriesInBucket[j];
        if (b === undefined) continue;
        const pairKey = compareText(a.id, b.id) <= 0
          ? `${a.id}|${b.id}`
          : `${b.id}|${a.id}`;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        if (covered.has(pairKey)) continue;
        const titleSim = textSimilarity(a.title, b.title);
        const bodySim = textSimilarity(a.body, b.body);
        const max = Math.max(titleSim, bodySim);
        if (max < SIMILARITY_THRESHOLD) continue;
        const memory_ids = [a.id, b.id].sort(compareText);
        const titles = [a.title.trim(), b.title.trim()].filter((t) => t.length > 0).sort(compareText);
        groups.push({
          reason: "similar_title_and_body",
          fingerprint: duplicateFingerprint("similar_title_and_body", `${max.toFixed(3)}|${pairKey}`),
          memory_ids,
          titles,
          details: { similarity: max }
        });
      }
    }
  }
  return groups;
}
```

The N×N-correctness test seeds 20 entries with crafted
overlap, runs the new bucketed detector and the old N×N
detector (kept as a private helper for the test), and
asserts the resulting `memory_ids` sets are equal.

The 200-entry bucket cap is the worst-case bound; the test
seeds 1000 entries with a stop-word-heavy token to confirm
the cap engages and the result is still correct (the cap
just means very-broad tokens don't dominate).

### Commit

```bash
git add src/memory-service.ts test/find-duplicates-bucketed.test.ts
git commit -m "perf(stage7): replace N×N find_duplicates with token-bucket inverted index"
```

## T5 — Maintenance operation chunking (red → green)

### Test cases (`test/maintenance-chunking.test.ts`)

```ts
describe("maintainMemories chunking (stage 7)", () => {
  it("find_duplicates processes in batches and reports progress", ...);
  it("each batch is its own transaction", ...);
  it("batch_size schema validates min 50, max 5000", ...);
  it("default batch_size is 500 when omitted", ...);
});
```

### Implementation

`src/memory-service.ts`:

```ts
type MaintenanceProgress = (processed: number, total: number) => void;

private async runMaintenanceInBatches<T>(
  total: number,
  batchSize: number,
  processBatch: (start: number, end: number) => T[],
  onProgress?: MaintenanceProgress
): Promise<T[]> {
  const results: T[] = [];
  for (let start = 0; start < total; start += batchSize) {
    const end = Math.min(start + batchSize, total);
    const batch = this.store.transaction(() => processBatch(start, end));
    results.push(...batch);
    onProgress?.(end, total);
  }
  return results;
}
```

The `find_duplicates` action now reads entries in chunks,
runs the bucketed detector on the chunk, merges results,
and de-duplicates the merged `memory_ids` sets across
chunks.

`maintain_memories` MCP tool schema gains optional
`batch_size: z.number().int().min(50).max(5000).default(500)`.

### Commit

```bash
git add src/memory-service.ts src/tools/schemas.ts \
        test/maintenance-chunking.test.ts test/tool-registration.test.ts
git commit -m "feat(stage7): chunk maintenance operations off the lock path"
```

## T6 — T2/T4 facade split (red → green)

### Tests

No new tests. All 273 existing tests must pass after the
split.

### Implementation

Create `src/services/memory-read-service.ts`,
`src/services/memory-write-service.ts`,
`src/services/memory-maintenance-service.ts`. Each gets
its constructor signature:

```ts
class MemoryReadService {
  constructor(
    private readonly store: SQLiteMemoryStore,
    private readonly defaultActor: string,
    private readonly resolveActor: (...) => string,
    private readonly actorForEntry: (...) => string | undefined,
    private readonly budgetGovernor: BudgetGovernor
  ) {}
  // ... methods moved from MemoryService ...
}
```

The three services share the `BudgetGovernor` (passed in
by the façade); they don't import each other.

`MemoryService` becomes:

```ts
class MemoryService {
  readonly dataHome: string;
  constructor(
    dataHome: string,
    store: SQLiteMemoryStore,
    defaultActor: string,
    budgetGovernor: BudgetGovernor
  ) {
    this.dataHome = dataHome;
    this.read = new MemoryReadService(store, defaultActor, ...);
    this.write = new MemoryWriteService(store, defaultActor, ...);
    this.maintenance = new MemoryMaintenanceService(store, defaultActor, ...);
  }
  // Public API methods just delegate to the right sub-service.
  remember(input) { return this.write.remember(input); }
  getMemory(id, accessedBy) { return this.read.getMemory(id, accessedBy); }
  // ... etc ...
}
```

The split is mechanical: identify which public method
belongs to read vs write vs maintenance, move it, and
update the façade to delegate. The shared helpers
(`actorForEntry`, `resolveActor`, `commitPreparedRemember`,
etc.) move into a `src/services/memory-service-helpers.ts`
file that all three sub-services import.

### Commit

```bash
git add src/services/ src/memory-service.ts
git commit -m "refactor(stage7): split MemoryService into Read/Write/Maintenance services"
```

If the diff is large enough to be scary in one commit,
split into:
- `refactor(stage7): extract shared helpers to services/memory-service-helpers.ts`
- `refactor(stage7): extract read path to services/memory-read-service.ts`
- `refactor(stage7): extract write path to services/memory-write-service.ts`
- `refactor(stage7): extract maintenance path to services/memory-maintenance-service.ts`
- `refactor(stage7): MemoryService becomes a façade delegating to the three`

## T7 — Closure docs

Same pattern as Stage 6 closure:
- CHANGELOG `[Unreleased] — Stage 7` entry
- Stage 6 promoted to `[0.6.0]`
- New `Configuration` section in README listing the three
  env vars with defaults and fall-through behavior
- Closure report

### Commit

```bash
git add CHANGELOG.md README.md docs/superpowers/plans/2026-07-20-stage-seven-polish-closure.md
git commit -m "docs(stage7): add CHANGELOG entry, closure report, and README Configuration section"
```

## T8 — Verify, push, merge

```bash
npm run typecheck
npm test
git diff --check
git push -u origin feat/stage7-polish
cd ../..
git checkout main
git merge --no-ff feat/stage7-polish -m "Merge branch 'feat/stage7-polish'"
git push origin main
```

After the merge: ask the user whether to clean the
stage7 worktree, and surface the Stage 8+ candidates
(true semantic dedup, secret-detector, import/restore,
markdown format switch, per-agent workspace isolation).

## Expected outcome

- 273 → ~293 tests (+ ~20: 6 sqlite-store, 3 stale-config,
  3 trust-config, 4 find-duplicates, 4 maintenance)
- 0 schema changes
- 0 new tables or columns
- 3 new modules: `src/services/memory-read-service.ts`,
  `src/services/memory-write-service.ts`,
  `src/services/memory-maintenance-service.ts`
- 1 new shared helper: `src/services/memory-service-helpers.ts`
- 2 new env vars (T2 + T3)
- 1 new `batch_size` field on `maintain_memories`
- 2 new filter fields on `EntryFilters`
  (`updated_since`, `updated_until`)
- All 273 prior tests still pass
- 12 doctor checks unchanged
- 12 MCP tools unchanged in count; `maintain_memories`
  and `list_memories` / `search_memories` gain fields
