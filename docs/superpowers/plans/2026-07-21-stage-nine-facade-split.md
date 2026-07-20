# Stage 9 — MemoryService Facade Split — Implementation Plan

Date: 2026-07-21
Branch: `feat/stage9-facade-split`
Worktree: `G:\Projects\MetronX\local-memory-mcp\.worktrees\stage9-facade-split`
Baseline: 320/320 tests green, `main` at `3fb3ec7`

See [spec](../specs/2026-07-21-stage-nine-facade-split.md) for
design rationale and scope.

## Task list

- [x] **T0** — Spec + plan (this document)
- [ ] **T1** — Extract shared helpers to
  `src/services/memory-service-helpers.ts`. Pure
  refactor; no behavior change.
- [ ] **T2** — Extract read path to
  `src/services/memory-read-service.ts`.
- [ ] **T3** — Extract write path to
  `src/services/memory-write-service.ts`.
- [ ] **T4** — Extract maintenance path to
  `src/services/memory-maintenance-service.ts`.
- [ ] **T5** — `MemoryService` becomes a façade
  delegating to the three sub-services. Public API
  unchanged.
- [ ] **T6** — Docs: CHANGELOG, README, closure report.
- [ ] **T7** — Verify (`npm run typecheck && npm test
  && git diff --check`), push branch, `--no-ff` merge
  to `main`, push `main` to origin.

## T1 — Shared helpers (red → green → commit)

This step is a pure refactor with no new tests. We move
free functions and class-method helpers to
`src/services/memory-service-helpers.ts` and re-export
them where needed. After the move, `memory-service.ts`
imports the helpers instead of defining them locally.

### Functions to move

From `src/memory-service.ts`:

- `compareText` (line 261)
- `parseTimestamp` (line 265)
- `isDue` (line 273)
- `queryTokens` (line 281)
- `contextQueryScore` (line 287)
- `compareContextScores` (line 303)
- `compareLowValueCandidates` (line 327)
- `normalizeDuplicateText` (in dedup helpers)
- `duplicateFingerprint` (in dedup helpers)
- `parseEnvFloat` (T3 in Stage 7)
- `safeScopeFromInput`, `safeProjectIdFromInput`,
  `isRecord`
- `DEFAULT_STRONG_TRUST_BOOST`, `DEFAULT_SOFT_TRUST_BOOST`,
  `ENV_TRUST_STRONG`, `ENV_TRUST_SOFT`
- `computeTrustBoost` (exported, must stay exported)

Class methods that need the `MemoryService` instance
(this / store / defaultActor) become static-style
functions that take the needed pieces as parameters:

- `actorForEntry(entry, resolveActor)` — takes the
  resolver as a parameter
- `appendAudit` — takes the store as a parameter
- `auditRejected*` — take the store
- `evaluateEntryBudget`, `budgetFor`, `activeEntriesFor`,
  `usageFromActiveEntries`, `ensureProjectScope`,
  `buildEntry` — take the store
- `matchesReplacementScope` — pure function over
  two entries
- `rejectionMetadata` — pure

### Implementation

```ts
// src/services/memory-service-helpers.ts

import { createHash } from "node:crypto";
import { ... } from "...";

// Free functions (no class state).
export function compareText(a: string, b: string): number { ... }
export function parseTimestamp(value: string | undefined): number | undefined { ... }
export function isDue(timestamp: string | undefined, now: string): boolean { ... }
export function queryTokens(query: string | undefined): string[] { ... }
export function contextQueryScore(entry: MemoryEntry, tokens: string[]): number { ... }
export function compareContextScores(a: ContextScore, b: ContextScore): number { ... }
export function compareLowValueCandidates(a: MemoryEntry, b: MemoryEntry): number { ... }
export function normalizeDuplicateText(value: string): string { ... }
export function duplicateFingerprint(reason: DuplicateGroup["reason"], key: string): string { ... }
export function parseEnvFloat(name: string, fallback: number): number { ... }
export function isRecord(value: unknown): value is Record<string, unknown> { ... }
export function safeScopeFromInput(input: unknown): MemoryScope { ... }
export function safeProjectIdFromInput(input: unknown): string | undefined { ... }
export function matchesReplacementScope(old: MemoryEntry, replacement: MemoryEntry): boolean { ... }
export function rejectionMetadata(error: string, details: Record<string, unknown> | undefined): Record<string, unknown> { ... }
export function computeTrustBoost(...): number { ... }  // exported
export const DEFAULT_STRONG_TRUST_BOOST = 0.3;
export const DEFAULT_SOFT_TRUST_BOOST = 0.1;
export const ENV_TRUST_STRONG = "AGENT_RECALL_TRUST_STRONG";
export const ENV_TRUST_SOFT = "AGENT_RECALL_TRUST_SOFT";

// State-taking functions (store, defaultActor passed in).
export function actorForEntry(
  entry: MemoryEntry,
  resolveActor: (override?: string) => string
): string { ... }

export function appendAudit(
  store: SQLiteMemoryStore,
  event: Omit<MemoryAuditEvent, "id" | "created_at" | "actor"> & { actor?: string }
): void { ... }

export function auditRejected(...): void { ... }
export function auditRejectedForEntry(...): void { ... }
export function auditRejectedForScope(...): void { ... }

export function budgetFor(entry: MemoryEntry): MemoryBudget { ... }
export function evaluateEntryBudget(...): { ok: true; value: BudgetAccepted } | { ok: false; error: ...; details: ... } { ... }
export function activeEntriesFor(
  store: SQLiteMemoryStore,
  entry: Pick<MemoryEntry, "scope" | "project_id">
): MemoryEntry[] { ... }
export function usageFromActiveEntries(entries: MemoryEntry[]): BudgetUsage { ... }
export function ensureProjectScope(
  store: SQLiteMemoryStore,
  project_id: string,
  project_path: string,
  display_name: string
): ProjectScope { ... }
export function buildEntry(...): MemoryEntry { ... }
```

### Commit

```bash
git add src/memory-service.ts src/services/memory-service-helpers.ts
git commit -m "refactor(stage9): extract shared helpers to services/memory-service-helpers.ts"
```

## T2 — Read path extraction

Create `src/services/memory-read-service.ts` with the
read methods. `MemoryService` keeps delegating to
private methods; we then change the private methods
to delegate to a `MemoryReadService` instance.

### Implementation

```ts
// src/services/memory-read-service.ts

import type { SQLiteMemoryStore, ... } from "../sqlite-store.js";
import type {
  MemoryEntry, ...
} from "../domain.js";
import { actorForEntry, compareText, ... } from "./memory-service-helpers.js";

export type MemoryReadContext = {
  store: SQLiteMemoryStore;
  defaultActor: string;
  resolveActor: (override?: string) => string;
  actorForEntry: (entry: MemoryEntry) => string;
};

export class MemoryReadService {
  constructor(private readonly ctx: MemoryReadContext) {}

  getMemory(id: string, accessedBy?: string): MemoryEntry | undefined { ... }
  listMemories(filters: ListServiceFilters): ListResult | InvalidScopeResult { ... }
  searchMemories(filters: SearchServiceFilters): SearchResult | InvalidScopeResult { ... }
  getMemoryBudget(input: ...): MemoryBudgetResult | Result<never, "invalid_scope"> { ... }
  exportMemoryContext(input: ExportMemoryContextInput): string { ... }
  recallContext(input: RecallContextInput): RecallContextResult { ... }

  // Private helpers (read-only, no state mutation).
  private activeEntriesForScope(scope: ResolvedReadScope): MemoryEntry[] { ... }
  private allEntriesForScope(scope: ResolvedReadScope): MemoryEntry[] { ... }
  private usageForScope(scope: ResolvedReadScope): BudgetUsage { ... }
  private entryFiltersForRead<T>(...) { ... }
  private collectContextEntries(...) { ... }
  private contextEntriesForScope(...) { ... }
  private matchesContextFilters(...) { ... }
}
```

### Commit

```bash
git add src/memory-service.ts src/services/memory-read-service.ts
git commit -m "refactor(stage9): extract read path to services/memory-read-service.ts"
```

## T3 — Write path extraction

Same pattern for write.

### Commit

```bash
git add src/memory-service.ts src/services/memory-write-service.ts
git commit -m "refactor(stage9): extract write path to services/memory-write-service.ts"
```

## T4 — Maintenance path extraction

Same pattern for maintenance. The maintenance service
gets the `dataHome`, `MarkdownExporter` (or factory),
and the shared context.

### Commit

```bash
git add src/memory-service.ts src/services/memory-maintenance-service.ts
git commit -m "refactor(stage9): extract maintenance path to services/memory-maintenance-service.ts"
```

## T5 — Façade

Replace the body of `MemoryService` with delegation.

### Commit

```bash
git add src/memory-service.ts
git commit -m "refactor(stage9): MemoryService becomes a façade delegating to the three sub-services"
```

## T6 — Closure docs

Same pattern as previous stages.

### Commit

```bash
git add CHANGELOG.md README.md \
        docs/superpowers/plans/2026-07-21-stage-nine-facade-split-closure.md
git commit -m "docs(stage9): add CHANGELOG entry, closure report, README note"
```

## T7 — Verify, push, merge

```bash
npm run typecheck
npm test -- --pool=forks --poolOptions.forks.singleFork=true
git diff --check
git push -u origin feat/stage9-facade-split
cd ../..
git checkout main
git merge --no-ff feat/stage9-facade-split -m "Merge branch 'feat/stage9-facade-split'"
git push origin main
```

After the merge: ask the user whether to clean the
stage 9 worktree, and surface the Stage 10 candidates
(semantic dedup, import CLI, secret-detector PII).

## Expected outcome

- 320 → 320 tests (pure refactor; no new tests)
- 1 file (`memory-service.ts`) shrinks from 1670 to
  ~200 lines
- 4 new files in `src/services/`:
  - `memory-service-helpers.ts` (helpers)
  - `memory-read-service.ts` (read)
  - `memory-write-service.ts` (write)
  - `memory-maintenance-service.ts` (maintenance)
- 0 user-visible changes
- 0 schema changes
- 0 new CLI flags or env vars
- All 320 prior tests still pass
