# AgentRecall Stage Two Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the three stage 2 deliverables from the [Stage 2 spec](../specs/2026-07-19-stage-two-conflict-and-structure.md): `merge_memories` MCP tool, forced-confirm flow for `remember` duplicates, and the `MemoryService` façade split. Add the small `last_accessed_by` schema change and a tenth `doctor` check as part of the same stage.

**Architecture:** Pure additions on top of stage 1's single-store, single-service layout. The façade split is a refactor; the rest is additive. New modules under `src/services/`. One schema migration v2 → v3 for `last_accessed_by`. The MCP tool surface gains one new tool (`merge_memories`); the existing `remember` gains an optional `confirm_write` field.

**Tech Stack:** Node.js 24+, TypeScript, `@modelcontextprotocol/sdk`, `zod/v4`, built-in `node:sqlite`, Vitest. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-07-19-stage-two-conflict-and-structure.md`](../specs/2026-07-19-stage-two-conflict-and-structure.md)

**Working directory:** `G:\Projects\MetronX\local-memory-mcp`

---

## Commit Hygiene

Each task ends with a `git add` + `git commit` of the listed files. Use
conventional commit prefixes:

- `feat(stage2):` for new modules / new MCP tools
- `refactor(stage2):` for the façade split
- `feat(stage2):` for the schema migration
- `docs(stage2):` for the changelog / closure

---

## Task 1: Add `last_accessed_by` Schema Column (v2 → v3 Migration)

**Files:**
- Modify: `src/sqlite-store.ts`
- Create: `test/sqlite-store-migration-v3.test.ts`
- Modify: `src/memory-service.ts` (add `accessedBy` parameter to `getEntry`)

Schema gains a single nullable `last_accessed_by TEXT` column. The new
column is JSON-encoded, written by the read path, surfaced through
`decodeEntry`, and consumed by a new `doctor` check (added in Task 5).

- [ ] **Step 1.1: Bump `CURRENT_SCHEMA_VERSION` to 3**

In `src/sqlite-store.ts`, change:

```ts
export const CURRENT_SCHEMA_VERSION = 2;
```

to:

```ts
export const CURRENT_SCHEMA_VERSION = 3;
```

- [ ] **Step 1.2: Add the column to the base DDL**

In the same file, find the `CREATE TABLE IF NOT EXISTS memory_entries`
block inside `runBaseDdl()` (or the `migrate()` method if you have not
yet split the methods). Add `last_accessed_by TEXT` to the column
list, after `last_accessed_at`. Also add the column to the
`insertEntry` INSERT statement, the `decodeEntry` read path, and the
`entryParams` helper. The new field is a JSON-encoded
`Record<string, string>` and is nullable; pass `null` from
`entryParams` when the entry has no value.

- [ ] **Step 1.3: Add `migrate_v2_to_v3()` and register it**

In `src/sqlite-store.ts`, extend the `migrateToVersion` switch:

```ts
private migrateToVersion(version: number): void {
  if (version === 1) {
    this.setUserVersion(1);
    return;
  }
  if (version === 2) {
    this.migrate_v1_to_v2();
    return;
  }
  if (version === 3) {
    this.migrate_v2_to_v3();
    return;
  }
  throw new Error(`No migration registered for schema version ${version}`);
}

private migrate_v2_to_v3(): void {
  // The `last_accessed_by` column is nullable JSON; we only need to
  // ALTER TABLE ADD COLUMN. No data backfill is necessary because
  // the read path defaults to an empty map.
  this.db.exec("ALTER TABLE memory_entries ADD COLUMN last_accessed_by TEXT");
  this.db.exec("PRAGMA user_version = 3");
}
```

- [ ] **Step 1.4: Expose `last_accessed_by` on `MemoryEntry`**

In `src/domain.ts`, add the optional field to the `MemoryEntry` type:

```ts
export type MemoryEntry = {
  ...existing fields,
  last_accessed_by?: Record<string, string>;
};
```

- [ ] **Step 1.5: Write the migration test**

Create `test/sqlite-store-migration-v3.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, SQLiteMemoryStore } from "../src/sqlite-store.js";

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "lm-mig-v3-")), "memory.sqlite");
}

describe("SQLiteMemoryStore v2 -> v3 migration", () => {
  let dbPath: string;
  let store: SQLiteMemoryStore;

  beforeEach(() => { dbPath = tmpDbPath(); });
  afterEach(() => { store?.close(); });

  it("creates a v3 schema on first run", () => {
    store = new SQLiteMemoryStore(dbPath);
    expect(store.getUserVersion()).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBe(3);
  });

  it("migrates a v2 database (with audit_events.actor already loosened) to v3", () => {
    // Bootstrap a v2-shaped database.
    const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
    db.exec(`
      CREATE TABLE memory_entries (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        type TEXT NOT NULL,
        topic TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source_json TEXT NOT NULL,
        importance INTEGER NOT NULL,
        confidence INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_accessed_at TEXT,
        access_count INTEGER NOT NULL,
        expires_at TEXT,
        review_after TEXT,
        supersedes_json TEXT NOT NULL,
        superseded_by TEXT,
        token_estimate INTEGER NOT NULL,
        char_count INTEGER NOT NULL
      ) STRICT;
      INSERT INTO memory_entries (id, scope, type, topic, title, body, tags_json, source_json, importance, confidence, status, created_at, updated_at, access_count, supersedes_json, token_estimate, char_count)
        VALUES ('mem_v2', 'global', 'fact', 't', 't', 'b', '[]', '{"kind":"agent"}', 3, 3, 'active', '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z', 0, '[]', 1, 2);
      PRAGMA user_version = 2;
    `);
    db.close();

    store = new SQLiteMemoryStore(dbPath);
    expect(store.getUserVersion()).toBe(3);

    // The pre-existing row is preserved.
    const handle = new DatabaseSync(dbPath, { readOnly: true });
    const row = handle.prepare("SELECT id, last_accessed_by FROM memory_entries WHERE id = 'mem_v2'").get() as { id: string; last_accessed_by: string | null };
    expect(row.id).toBe("mem_v2");
    expect(row.last_accessed_by).toBeNull();
    handle.close();
  });
});
```

- [ ] **Step 1.6: Run typecheck + tests**

```bash
cd G:\Projects\MetronX\local-memory-mcp
npm run typecheck
npm test -- test/sqlite-store-migration-v3.test.ts
npm test -- test/sqlite-store.test.ts
npm test -- test/memory-service.test.ts
npm test -- test/e2e.test.ts
```

Expected: all green. The new column is nullable, so every existing
`entryParams` call site continues to work.

- [ ] **Step 1.7: Commit**

```bash
git add src/sqlite-store.ts src/domain.ts test/sqlite-store-migration-v3.test.ts
git commit -m "feat(stage2): add last_accessed_by column and v2->v3 migration"
```

---

## Task 2: Extract `MemoryService` Internal Helpers

**Files:**
- Create: `src/services/memory-service-helpers.ts`
- Modify: `src/memory-service.ts` (delegate to the new module)

This is the precursor to the façade split in Task 4. The internal
helpers today are private methods on `MemoryService`; they need to be
extractable into a plain-function module so the future sub-services
can share them.

- [ ] **Step 2.1: Create the helpers module**

Create `src/services/memory-service-helpers.ts` with these exports,
each a pure function of the store + budget + input:

```ts
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_GLOBAL_BUDGET,
  DEFAULT_MEMORY_KIND_POLICIES,
  computeEntrySize,
  createAuditId,
  createMemoryId,
  err,
  nowIso,
  ok,
  type MemoryAuditEvent,
  type MemoryBudget,
  type MemoryEntry,
  type MemoryKind,
  type MemoryScope,
  type ProjectScope,
  type Result
} from "../domain.js";
import { evaluateBudget, estimateIndexChars, type BudgetAccepted } from "../budget-governor.js";
import { resolveActor } from "../actor.js";
import { resolveMemoryScope } from "../scope-resolver.js";
import type { BudgetUsage, SQLiteMemoryStore } from "../sqlite-store.js";
import type { RememberInput, UpdateInput, ValidatedRememberInput, validateRememberInput, validateUpdateInput } from "../write-validator.js";

export type ResolvedReadScope = {
  scope: MemoryScope;
  project_id?: string;
};

export function resolveReadScope(
  input: { scope: MemoryScope; project_id?: string; project_path?: string },
  resolve: typeof resolveMemoryScope
): Result<ResolvedReadScope, "invalid_scope"> {
  const resolved = resolve(input);
  if (!resolved.ok) return resolved;
  if (resolved.value.scope === "project" && resolved.value.project_id === undefined) {
    return err("invalid_scope", "project scope requires project_id or project_path");
  }
  return ok({
    scope: resolved.value.scope,
    ...(resolved.value.project_id !== undefined ? { project_id: resolved.value.project_id } : {})
  });
}

export function ensureProjectScope(
  store: SQLiteMemoryStore,
  project_id: string,
  project_path: string,
  display_name: string,
  defaultBudget: MemoryBudget
): ProjectScope {
  const existing = store.getProjectScope(project_id);
  return existing ?? upsertProjectScope(store, project_id, project_path, display_name, defaultBudget);
}

export function upsertProjectScope(
  store: SQLiteMemoryStore,
  project_id: string,
  project_path: string,
  display_name: string,
  defaultBudget: MemoryBudget
): ProjectScope {
  const now = nowIso();
  const scope: ProjectScope = {
    project_id,
    canonical_path: project_path,
    display_name,
    budget: defaultBudget,
    created_at: existing_or_now(store, project_id, now),
    updated_at: now
  };
  store.upsertProjectScope(scope);
  return scope;
}

function existing_or_now(store: SQLiteMemoryStore, project_id: string, now: string): string {
  return store.getProjectScope(project_id)?.created_at ?? now;
}

export function buildEntry(
  input: ValidatedRememberInput,
  scope: MemoryScope,
  timestamp: string,
  project: { project_id?: string; project_path?: string }
): MemoryEntry { ... }

export function expiresAtFor(
  memoryKind: MemoryKind,
  timestamp: string,
  explicitExpiresAt: string | undefined
): string | undefined { ... }

export function activeEntriesFor(
  store: SQLiteMemoryStore,
  entry: Pick<MemoryEntry, "scope" | "project_id">
): MemoryEntry[] { ... }

export function usageFromActiveEntries(entries: MemoryEntry[]): BudgetUsage { ... }

export function memoryKindPolicy(
  memoryKind: MemoryKind,
  budget: MemoryBudget
): { default_expires_after_days?: number; max_writes_per_day: number } { ... }

export function evaluateEntryBudget(
  entry: MemoryEntry,
  budget: MemoryBudget,
  existingEntries: MemoryEntry[]
): Result<BudgetAccepted, "capacity_exceeded"> { ... }

export function evaluateWriteRate(
  store: SQLiteMemoryStore,
  entry: MemoryEntry,
  budget: MemoryBudget
): Result<{ writes_today: number; max_writes_per_day: number }, "rate_limited"> { ... }

export function budgetFor(
  store: SQLiteMemoryStore,
  entry: Pick<MemoryEntry, "scope" | "project_id">,
  defaultProjectBudget: MemoryBudget
): MemoryBudget { ... }
```

Each function is moved verbatim from `src/memory-service.ts`. The
private helpers that depend on `this` (the class) become plain
functions that take the store and the budget as parameters.

- [ ] **Step 2.2: Replace private method calls with helper imports**

In `src/memory-service.ts`, replace each `this.buildEntry(...)` call
with `buildEntry(...)` from the new module, and similarly for the
other helpers. The class still owns the public methods
(`remember`, `updateMemory`, etc.) but delegates the building blocks
to the helper module.

- [ ] **Step 2.3: Run typecheck + tests**

```bash
cd G:\Projects\MetronX\local-memory-mcp
npm run typecheck
npm test
```

Expected: all green. The refactor is invisible from outside the
class.

- [ ] **Step 2.4: Commit**

```bash
git add src/services/memory-service-helpers.ts src/memory-service.ts
git commit -m "refactor(stage2): extract MemoryService internal helpers to a shared module"
```

---

## Task 3: Forced-Confirm Flow on `remember`

**Files:**
- Modify: `src/tools/schemas.ts` (add `confirm_write` to the remember schema)
- Modify: `src/write-validator.ts` (accept and propagate the field)
- Modify: `src/memory-service.ts` (the `prepareRemember` short-circuits on duplicate without confirm)
- Modify: `src/tools/register-tools.ts` (propagate `confirm_write` through to the service)
- Create: `test/remember-confirm.test.ts`

A duplicate candidate that previously appeared as a soft warning
now causes a hard rejection unless the caller passes
`confirm_write: true`.

- [ ] **Step 3.1: Add `confirm_write` to the remember input type**

In `src/write-validator.ts`, add the field:

```ts
export type RememberInput = {
  ...existing fields,
  confirm_write?: boolean;
};
```

Validated input does not need to carry the field; it's a write-path
concern.

- [ ] **Step 3.2: Add `confirm_write` to the Zod schema**

In `src/tools/schemas.ts`, extend the `remember` schema with:

```ts
confirm_write: z.boolean().optional()
```

- [ ] **Step 3.3: Propagate `confirm_write` through the handler**

In `src/tools/register-tools.ts`, locate the `remember` handler and
extend the `serviceInput` call to include the field when present. The
cleanest pattern: use a generic pass-through that picks up any new
schema field automatically. If that is in place, no edit is needed
here; verify by running the typecheck.

- [ ] **Step 3.4: Add the rejection logic in `prepareRemember`**

In `src/memory-service.ts`, modify the public `remember` method:

```ts
remember(input: RememberInput): Result<RememberResult, RememberError> {
  const prepared = this.prepareRemember(input, true);
  if (!prepared.ok) {
    return prepared;
  }
  // Forced confirm: if a duplicate candidate was detected and the caller
  // did not explicitly confirm, reject.
  if (input.confirm_write !== true) {
    const matching = prepared.value.budget.warnings
      .filter((w) => w.code === "duplicate_candidate")
      .map((w) => w.memory_id);
    if (matching.length > 0) {
      // We must also undo the side effects of the prepared write — but
      // prepareRemember has not yet committed anything to the store.
      // The decision is purely a return-value flip; no rollback needed.
      this.auditRejected(input, "duplicate_candidate", { matching_ids: matching });
      return err("duplicate_candidate",
        "existing active memory has the same title or body; pass confirm_write: true to proceed",
        { matching_ids: matching });
    }
  }
  return this.store.transaction(() => ok(this.commitPreparedRemember(prepared.value)));
}
```

Add `"duplicate_candidate"` to the `RememberError` union at the top
of the file.

- [ ] **Step 3.5: Write the test**

Create `test/remember-confirm.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../src/memory-service.js";
import { SQLiteMemoryStore } from "../src/sqlite-store.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-confirm-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const service = new MemoryService(store, undefined, "user:cli", dataHome);
  return { service, store };
}

describe("remember forced-confirm", () => {
  let service: MemoryService;
  let store: SQLiteMemoryStore;

  beforeEach(() => ({ service, store } = setup()));
  afterEach(() => store.close());

  it("accepts the first write", () => {
    const result = service.remember({
      scope: "global",
      type: "fact",
      topic: "tooling",
      title: "use pnpm",
      body: "the project uses pnpm, not npm",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 4
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a second write with the same title without confirm_write", () => {
    const input = {
      scope: "global" as const,
      type: "fact" as const,
      topic: "tooling",
      title: "use pnpm",
      body: "the project uses pnpm, not npm",
      tags: [] as string[],
      source: { kind: "agent" as const },
      importance: 3,
      confidence: 4
    };
    service.remember(input);
    const result = service.remember({ ...input, body: "the project uses pnpm, not npm. install with pnpm i." });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("duplicate_candidate");
      const details = result.details as { matching_ids: string[] };
      expect(details.matching_ids.length).toBe(1);
    }
  });

  it("accepts the second write when confirm_write is true", () => {
    const input = {
      scope: "global" as const,
      type: "fact" as const,
      topic: "tooling",
      title: "use pnpm",
      body: "the project uses pnpm, not npm",
      tags: [] as string[],
      source: { kind: "agent" as const },
      importance: 3,
      confidence: 4
    };
    service.remember(input);
    const result = service.remember({ ...input, body: "the project uses pnpm, not npm. install with pnpm i.", confirm_write: true });
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 3.6: Run typecheck + tests**

```bash
cd G:\Projects\MetronX\local-memory-mcp
npm run typecheck
npm test -- test/remember-confirm.test.ts
npm test
```

Expected: all green. The new tests verify the new behaviour. Existing
tests that do not use duplicates keep passing because
`BudgetAccepted.warnings` is empty in the non-duplicate case.

- [ ] **Step 3.7: Commit**

```bash
git add src/tools/schemas.ts src/write-validator.ts src/memory-service.ts src/tools/register-tools.ts test/remember-confirm.test.ts
git commit -m "feat(stage2): require confirm_write on remember to bypass duplicate-candidate"
```

---

## Task 4: Split `MemoryService` into Read / Write / Maintenance Sub-Services

**Files:**
- Create: `src/services/memory-read-service.ts`
- Create: `src/services/memory-write-service.ts`
- Create: `src/services/memory-maintenance-service.ts`
- Create: `src/services/memory-service-factory.ts`
- Modify: `src/memory-service.ts` (becomes the façade)

Pure refactor. The class structure of `MemoryService` is preserved on
the outside; internally, the body of each public method moves to the
appropriate sub-service. After this task, the new
`mergeMemories` method has a natural home in `MemoryWriteService`.

- [ ] **Step 4.1: Create `MemoryReadService`**

Move `getMemory`, `listMemories`, `searchMemories`,
`exportMemoryContext`, `getMemoryBudget` into a new class. The class
constructor takes the store and the exporter; the methods are
copied verbatim from the existing `MemoryService`.

- [ ] **Step 4.2: Create `MemoryMaintenanceService`**

Move `maintainMemories`, `backup`, and the maintenance-specific
helpers (`rebuildMarkdownIndex`, `expireDueMemories`,
`archiveLowValueMemories`, `vacuumFts`, `findDuplicateGroups`,
`appendMaintenanceAudit`, `maybeBackup`) into a new class. The class
constructor takes the store, the exporter, and `dataHome`.

- [ ] **Step 4.3: Create `MemoryWriteService`**

Move `remember`, `updateMemory`, `supersedeMemory`, `forgetMemory`
into a new class. Add the new `mergeMemories` method here too (Task
5 will fill the body; in this task, declare the method signature and
a placeholder that throws "not implemented"). The class constructor
takes the store, the read service (needed for budget lookups), and
the maintenance service (for backup hooks after a merge).

- [ ] **Step 4.4: Create the factory**

In `src/services/memory-service-factory.ts`:

```ts
export function createMemoryService(store: SQLiteMemoryStore, exporter: MarkdownExporter, dataHome?: string): MemoryService {
  const read = new MemoryReadService(store, exporter);
  const maintenance = new MemoryMaintenanceService(store, exporter, dataHome);
  const write = new MemoryWriteService(store, read, maintenance, "agent");
  return new MemoryService(write, read, maintenance, "agent");
}
```

- [ ] **Step 4.5: Replace `MemoryService` with the façade**

In `src/memory-service.ts`, the class becomes:

```ts
export class MemoryService {
  constructor(
    private readonly write: MemoryWriteService,
    private readonly read: MemoryReadService,
    private readonly maintenance: MemoryMaintenanceService,
    private readonly defaultActor: string = "agent"
  ) {}

  getMemory(id) { return this.read.getMemory(id); }
  listMemories(filters) { return this.read.listMemories(filters); }
  searchMemories(filters) { return this.read.searchMemories(filters); }
  exportMemoryContext(input) { return this.read.exportMemoryContext(input); }
  getMemoryBudget(input) { return this.read.getMemoryBudget(input); }

  remember(input) { return this.write.remember(input); }
  updateMemory(id, input) { return this.write.updateMemory(id, input); }
  supersedeMemory(input) { return this.write.supersedeMemory(input); }
  forgetMemory(id, reason) { return this.write.forgetMemory(id, reason); }
  mergeMemories(input) { return this.write.mergeMemories(input); }

  maintainMemories(input) { return this.maintenance.maintainMemories(input); }
  backup() { return this.maintenance.backup(); }
}
```

- [ ] **Step 4.6: Update `createService` in `src/index.ts`**

```ts
export function createService(dataHome = resolveDataHome()): MemoryService {
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const exporter = new MarkdownExporter(join(dataHome, "exports"));
  return createMemoryService(store, exporter, dataHome);
}
```

- [ ] **Step 4.7: Run typecheck + full test suite**

```bash
cd G:\Projects\MetronX\local-memory-mcp
npm run typecheck
npm test
```

Expected: all 194 + new tests pass. The refactor is invisible from
the outside.

- [ ] **Step 4.8: Commit**

```bash
git add src/services/ src/memory-service.ts src/index.ts
git commit -m "refactor(stage2): split MemoryService into read/write/maintenance sub-services"
```

---

## Task 5: `merge_memories` MCP Tool

**Files:**
- Create: `src/services/memory-write-service.ts` (extend; created in Task 4)
- Modify: `src/tools/schemas.ts` (add `merge_memories` schema)
- Modify: `src/tools/register-tools.ts` (register the tool)
- Modify: `src/tools/descriptions.ts` (add a three-segment description)
- Create: `test/merge-memories.test.ts`

The new tool collapses N near-duplicate memories into one, marking
the rest as superseded, all in a single transaction.

- [ ] **Step 5.1: Add the schema**

In `src/tools/schemas.ts`, add the `merge_memories` schema. It
mirrors `supersede_memory` plus a `strategy` and an array of old
ids. Use the strict Zod pattern already in use for `supersede_memory`.

- [ ] **Step 5.2: Add the description**

In `src/tools/descriptions.ts`, add a `merge_memories` entry to the
`TEXT` map. The description follows the existing
`[TRIGGER] / [INPUT] / [OUTPUT] / [FAILURE]` form and stays under
the 400-character total / 80-character per-segment budgets.

- [ ] **Step 5.3: Implement `mergeMemories`**

In `src/services/memory-write-service.ts`, the method does:

1. Validate input (≥ 2 old ids, replacement passes write
   validation, project identity if scope=project).
2. Resolve scope via `resolveMemoryScope`.
3. Peek each old id; reject if any is missing, not in the resolved
   scope, or in `forgotten` / `superseded` state.
4. Build a budget "with the old ids excluded" so the merge passes
   the budget. Use the existing `evaluateBudget` machinery with
   `existingEntries` filtered to exclude the old ids.
5. In a single store transaction:
   a. `commitPreparedRemember` for the replacement.
   b. For each old id, `updateEntry({ status: "superseded", superseded_by: <new id>, updated_at: now })`.
   c. Append one `created` audit event for the new entry, one
      `superseded` audit event per old entry, and one
      `maintenance_run` event tagged with the merge action.
6. Trigger auto-backup if `changed > 0`.

Return `{ memory_id, merged_from: string[] }` on success.

- [ ] **Step 5.4: Register the tool**

In `src/tools/register-tools.ts`, add `merge_memories` to the
`memoryToolNames` array and dispatch the handler. The handler
forwards to `service.mergeMemories(...)`.

- [ ] **Step 5.5: Write the tests**

Create `test/merge-memories.test.ts` covering:

- Happy path: 2 entries + replacement → 1 new, 2 superseded, audit
  chain correct.
- Reject path: 1 old id (too few), missing id, cross-scope
  replacement, `forgotten` source entry.
- Budget relaxation: memory at 500/500 + 1 replacement + 2 old ids
  → succeeds.
- Strategy: `keep_first` keeps the oldest old id as the canonical
  reference in audit metadata; `keep_newest` keeps the newest.

- [ ] **Step 5.6: Run typecheck + tests**

```bash
cd G:\Projects\MetronX\local-memory-mcp
npm run typecheck
npm test -- test/merge-memories.test.ts
npm test -- test/tool-registration.test.ts
npm test
```

Expected: all green. The new tool passes the description budget
check (run the existing `test/tools-descriptions.test.ts`).

- [ ] **Step 5.7: Commit**

```bash
git add src/services/memory-write-service.ts src/tools/schemas.ts src/tools/register-tools.ts src/tools/descriptions.ts test/merge-memories.test.ts
git commit -m "feat(stage2): add merge_memories MCP tool with budget relaxation"
```

---

## Task 6: `last_accessed_by` Read Path and Doctor Check

**Files:**
- Modify: `src/sqlite-store.ts` (`getEntry` accepts `accessedBy`)
- Modify: `src/memory-service.ts` (or `MemoryReadService` after Task 4; pass `actor` through)
- Modify: `src/tools/register-tools.ts` (pass the resolved actor)
- Modify: `src/doctor/checks/last-accessed-by.ts` (new check)
- Modify: `src/doctor/index.ts` (register the new check)
- Modify: `test/doctor.test.ts` (assert 10 results, not 9)

- [ ] **Step 6.1: Update `getEntry` to accept and update `accessedBy`**

In `src/sqlite-store.ts`, change the signature:

```ts
getEntry(id: string, accessedBy?: string): MemoryEntry | undefined { ... }
```

Inside the method, when `accessedBy` is provided, also update
`last_accessed_by` by parsing the existing JSON (or starting from
`{}`), setting `map[accessedBy] = new Date().toISOString()`, and
writing the result back as JSON.

- [ ] **Step 6.2: Wire the read-side through to the handler**

In `src/tools/register-tools.ts` (or `MemoryReadService.getMemory` after
Task 4), pass `accessedBy: resolveActor(undefined)` to the store.
The MCP handler already has the actor; this is the easiest place to
resolve it.

- [ ] **Step 6.3: Add the doctor check**

Create `src/doctor/checks/last-accessed-by.ts`:

```ts
import type { CheckContext, CheckResult } from "../types.js";

export function checkLastAccessedBy(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();
  const rows = handle
    .prepare("SELECT last_accessed_by FROM memory_entries WHERE last_accessed_by IS NOT NULL")
    .all() as Array<{ last_accessed_by: string }>;
  const agents = new Set<string>();
  for (const r of rows) {
    try {
      const map = JSON.parse(r.last_accessed_by) as Record<string, string>;
      for (const k of Object.keys(map)) agents.add(k);
    } catch { /* ignore malformed rows */ }
  }
  return {
    name: "last_accessed_by",
    status: "ok",
    message: `${rows.length} entries, ${agents.size} agents seen`,
    details: { entries_with_history: rows.length, agents: [...agents].sort() }
  };
}
```

- [ ] **Step 6.4: Register the new check**

In `src/doctor/index.ts`, add the new check to the `CHECKS` array.

- [ ] **Step 6.5: Update the doctor test**

In `test/doctor.test.ts`, change `expect(report.results.length).toBe(9)`
to `expect(report.results.length).toBe(10)` and add a small assertion
that the new check is present.

- [ ] **Step 6.6: Run typecheck + tests**

```bash
cd G:\Projects\MetronX\local-memory-mcp
npm run typecheck
npm test -- test/doctor.test.ts
npm test
```

Expected: all green.

- [ ] **Step 6.7: Commit**

```bash
git add src/sqlite-store.ts src/memory-service.ts src/tools/register-tools.ts src/doctor/checks/last-accessed-by.ts src/doctor/index.ts test/doctor.test.ts
git commit -m "feat(stage2): track per-agent last_accessed_by and add a doctor check"
```

---

## Task 7: Final Closure — CHANGELOG, Closure Report, Push

- [ ] **Step 7.1: Update `CHANGELOG.md`**

Add a new `## [Unreleased] — Stage 2 ...` section covering `merge_memories`,
forced-confirm, façade split, and `last_accessed_by`. Follow the
existing format from stage 1.

- [ ] **Step 7.2: Write `docs/superpowers/plans/2026-07-19-stage-two-closure.md`**

Follow the stage 1 closure template: outcome, commit trail, plan vs
actual, test inventory, performance smoke, open questions.

- [ ] **Step 7.3: Update `README.md`**

Add a brief mention of `merge_memories` and the `confirm_write` flag
to the Tools table.

- [ ] **Step 7.4: Run the full verification suite**

```bash
cd G:\Projects\MetronX\local-memory-mcp
npm run typecheck
npm test
git diff --check
node dist/bin/agent-recall.js doctor
node dist/bin/agent-recall.js list --limit 5
```

Expected: typecheck clean, all tests passing, doctor 10/10 OK,
`list` works.

- [ ] **Step 7.5: Commit and push**

```bash
git add CHANGELOG.md docs/superpowers/plans/2026-07-19-stage-two-closure.md README.md
git commit -m "docs(stage2): add CHANGELOG entry, closure report, and README updates"
git push origin main
```

---

## Acceptance Checklist

By the end of Task 7, the following must all be true:

- [ ] `npm test` is fully green
- [ ] `npm run typecheck` is clean
- [ ] `npm run build` produces `dist/src/index.js` and `dist/bin/agent-recall.js` without errors
- [ ] `node dist/bin/agent-recall.js doctor` reports 10 OK, 0 WARN, 0 FAIL
- [ ] `merge_memories` is registered as an MCP tool with a 3-segment description under the 400-char budget
- [ ] `remember` rejects duplicate matches without `confirm_write: true`
- [ ] `last_accessed_by` is populated on `getEntry` reads and surfaced through `doctor`
- [ ] `git log` shows 7 stage2 commits, each with a `feat/refactor/docs/stage2` prefix
- [ ] `git diff --check` reports no issues
- [ ] README, CHANGELOG, and the closure report are updated

## Out of Scope (Stage 3+)

- Maintenance operation chunking / off-lock-path
- PII detection in `secret-detector.ts`
- Markdown export format switch (`agent_friendly` vs `human_friendly`)
- Soft-conflict detection between high-confidence memories
- Import / backup-restore CLI subcommands
- Per-agent analytics dashboards
