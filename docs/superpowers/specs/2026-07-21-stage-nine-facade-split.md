# Stage 9 — MemoryService Facade Split

Date: 2026-07-21
Branch: `feat/stage9-facade-split`
Predecessor: Stage 8 (commit `3fb3ec7` on `main`)

## Why

`src/memory-service.ts` has grown to **1670 lines** since
Stage 1. Every stage bolted more responsibilities onto
the same class:

- Stage 1: actor resolution, budget evaluation, audit
  helpers, list/search/remember/getMemory.
- Stage 2: confirm_write, merge_memories, last_accessed_by.
- Stage 3: text similarity advisory, find_duplicates.
- Stage 4: actor filter, actor_ownership doctor wiring.
- Stage 5: trust_boost, writer annotation.
- Stage 6: time-window filters.
- Stage 7: token-bucketed inverted index, chunked
  maintenance, env-var configuration.
- Stage 8: merge_duplicates, dry_run, export format
  switch wiring.

The class now mixes three distinct concerns:
**read** (stateless, budgeted, recall-ranking),
**write** (transactional, budget-evaluated, audit-emitting),
and **maintenance** (chunked, long-running, mutation-or-
read-only). All three share helpers (audit, actor lookup,
budget evaluation, scope resolution), but the public
methods are clean to partition.

This stage does the pure refactor that was deferred from
Stage 7 T6 and Stage 8 — split `MemoryService` into
three collaborator services plus a façade. **Zero
user-visible change.** The public `MemoryService` API
is preserved; existing tests, MCP tools, and CLI
commands keep working unchanged.

The split makes the maintenance code (now ~500 lines on
its own) testable in isolation from the read and write
code, and gives the read path its own focused surface
for the future semantic-dedup work (Stage 10+).

## What this stage ships

### T1 — `src/services/memory-service-helpers.ts`

Shared helpers that all three sub-services use. These
were private methods on `MemoryService`; they become
free functions in the new module.

Functions extracted:
- `compareText`, `parseTimestamp`, `isDue`
- `queryTokens`, `contextQueryScore`, `compareContextScores`
- `normalizeDuplicateText`, `duplicateFingerprint`
- `parseEnvFloat`
- `actorForEntry`
- `budgetFor`, `evaluateEntryBudget`, `activeEntriesFor`,
  `usageFromActiveEntries`, `ensureProjectScope`
- `buildEntry`
- `appendAudit`, `auditRejected`, `auditRejectedForEntry`,
  `auditRejectedForScope`, `rejectionMetadata`
- `safeScopeFromInput`, `safeProjectIdFromInput`
- `isRecord`

The helpers are pure functions where possible. The
ones that touch the store (e.g. `actorForEntry`,
`appendAudit`) take the store as a parameter. The ones
that take input defaults (e.g. `parseEnvFloat`) keep
their env-var name; no behavior change.

### T2 — `src/services/memory-read-service.ts`

Read path:
- `getMemory`
- `listMemories`
- `searchMemories`
- `getMemoryBudget`
- `exportMemoryContext` (the read-side export to markdown
  string for the MCP `export_memory_context` tool)
- All the helpers used only by these (`entryFiltersForRead`,
  `collectContextEntries`, `contextEntriesForScope`,
  `matchesContextFilters`, `activeEntriesForScope`,
  `allEntriesForScope`, `usageForScope`)

The constructor takes the shared `SQLiteMemoryStore`,
`defaultActor`, and a `MemoryServiceContext` (the
helpers module's façade type for actor / budget /
audit access).

### T3 — `src/services/memory-write-service.ts`

Write path:
- `remember`, `prepareRemember`, `resolveRememberInput`,
  `commitPreparedRemember`
- `updateMemory`
- `supersedeMemory`
- `mergeMemories`
- `forgetMemory`
- `configureProjectBudget`

These methods share the heavy audit / budget / actor
helpers. The split keeps the same shared context.

### T4 — `src/services/memory-maintenance-service.ts`

Maintenance path:
- `maintainMemories` (the public switch)
- `findDuplicatesChunked`, `mergeDuplicates`,
  `pickKeepTarget`, `applySupersede`
- `rebuildMarkdownIndex`, `expireDueMemories`,
  `archiveLowValueMemories`, `vacuumFts`
- `findDuplicateGroups`, `coveredPairKeys`,
  `similarDuplicateGroups`, `duplicateGroupsFor`
- `appendMaintenanceAudit`, `maybeBackup`,
  `markdownExporter`

Plus the write-audit helper that maintenance uses to
emit a `markdown_exported` event after a successful
export (this is in the helpers module).

### T5 — `MemoryService` becomes a façade

```ts
class MemoryService {
  readonly dataHome: string;
  private readonly read: MemoryReadService;
  private readonly write: MemoryWriteService;
  private readonly maintenance: MemoryMaintenanceService;
  private readonly store: SQLiteMemoryStore;
  private readonly exporter?: MarkdownExporter;
  private readonly defaultActor: string;
  private readonly resolveActor: (override?: string) => string;
  private readonly actorForEntry: (entry: MemoryEntry) => string;
  private readonly budgetGovernor: BudgetGovernor;

  constructor(
    store: SQLiteMemoryStore,
    exporter?: MarkdownExporter,
    defaultActor = "agent",
    dataHome?: string
  ) {
    this.dataHome = dataHome ?? "";
    this.store = store;
    this.exporter = exporter;
    this.defaultActor = defaultActor;
    this.resolveActor = (override) => resolveActor(override, defaultActor);
    this.actorForEntry = (entry) => actorForEntry(entry, this.resolveActor);
    this.budgetGovernor = new BudgetGovernor(store);
    this.read = new MemoryReadService(...);
    this.write = new MemoryWriteService(...);
    this.maintenance = new MemoryMaintenanceService(...);
  }

  // Public read methods delegate to this.read.
  getMemory(id, accessedBy?) { return this.read.getMemory(id, accessedBy); }
  listMemories(filters) { return this.read.listMemories(filters); }
  // ... etc

  // Public write methods delegate to this.write.
  remember(input) { return this.write.remember(input); }
  // ... etc

  // Public maintenance methods delegate to this.maintenance.
  maintainMemories(input) { return this.maintenance.maintainMemories(input); }
  // ... etc
}
```

The public API is byte-for-byte preserved. Tests that
`new MemoryService(store, exporter, actor, dataHome)`
keep working.

## Data model changes

None. Pure refactor.

## API changes

None. The public `MemoryService` API is unchanged. The
new modules are private implementation details; nothing
outside the `src/` directory imports them.

## Tests added

**Zero new tests**. The whole point of the split is
that behavior doesn't change. The 320 existing tests
must all still pass after the refactor.

If the existing test suite has a "MemoryService" public-
API surface test, that test continues to pass; the
façade delegates to the same methods with the same
return types.

## Documentation updates

- `CHANGELOG.md` — `[Unreleased] — Stage 9` entry. Pure
  refactor; the user-visible changelog is short. Stage 8
  promoted to `[0.8.0]`.
- `docs/superpowers/plans/2026-07-21-stage-nine-facade-split.md`
  — 7-task implementation plan.
- `docs/superpowers/plans/2026-07-21-stage-nine-facade-split-closure.md`
  — closure report.
- `README.md` — small note that the codebase is now
  organized into Read / Write / Maintenance sub-services
  (one paragraph in the Maintenance section).

## Acceptance criteria

1. `src/memory-service.ts` shrinks from 1670 lines to
   ~200 lines (the façade + type exports).
2. Three new files in `src/services/`:
   - `memory-service-helpers.ts` (shared helpers)
   - `memory-read-service.ts` (read path)
   - `memory-write-service.ts` (write path)
   - `memory-maintenance-service.ts` (maintenance path)
3. The public `MemoryService` constructor signature is
   unchanged: `new MemoryService(store, exporter?, defaultActor?, dataHome?)`.
4. All 320 existing tests still pass on
   `npm test -- --pool=forks --poolOptions.forks.singleFork=true`.
5. `npm run typecheck` is clean.

## Out of scope (deferred to Stage 10+)

- **True semantic dedup via embeddings** (deferred from
  Stage 7). Would require a new dep. The new architecture
  makes this easier: it lands as a new method on
  `MemoryMaintenanceService` plus a new
  `src/semantic-similarity.ts` module.
- **Import / restore CLI** (deferred from Stage 8). Pairs
  with the JSON exporter; the new architecture has a
  clean place for an `MemoryImportService`.
- **Secret-detector PII redaction** (deferred from
  Stage 2+). The new architecture splits the read /
  write paths cleanly, so redaction on read becomes
  a one-line change in `MemoryReadService.getMemory`.
- **Per-agent workspace isolation**.

## Risks

- **Public-API drift**: the façade must be byte-for-byte
  the same. The risk is that some private method I
  forgot to delegate breaks a test that reaches into
  `service["dataHome"]` or `service["store"]`. Mitigation:
  run the full test suite after each split step. The
  `service["dataHome"]` bracket access pattern from
  earlier stages still works because `dataHome` stays
  on the façade.
- **Helper import cycles**: the three sub-services all
  import from `memory-service-helpers.ts`. None of them
  import from each other. The helpers module has no
  imports from the sub-services; the sub-services have
  no imports from `memory-service.ts` (only the
  façade imports them). Verified by `tsc --noEmit`
  after the split.
- **Method re-binding**: tests that use
  `vi.spyOn(service, "methodName")` need the spied
  method to still be reachable through `service.*`. The
  façade pattern is: `service.methodName` → `this.subService.methodName`
  → the real implementation. Vitest's spy on
  `service.methodName` would only catch the façade
  call, not the sub-service call. The risk is mitigated
  by the fact that no current test spies on
  service methods; the existing tests are black-box.
