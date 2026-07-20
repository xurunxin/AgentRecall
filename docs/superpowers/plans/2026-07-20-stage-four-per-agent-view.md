# Stage 4 — Per-Agent Memory View — Implementation Plan

Date: 2026-07-20
Branch: `feat/stage4-per-agent-view`
Worktree: `G:\Projects\MetronX\local-memory-mcp\.worktrees\stage4-per-agent-view`
Baseline: 239/239 tests green, `main` at `91c22b4`

See [spec](../specs/2026-07-20-stage-four-per-agent-view.md) for the
design rationale and scope.

## Task list

- [ ] **T1** — `actor` filter on `EntryFilters`, `listEntries`,
  `searchEntries`. Implementation uses an `id IN (SELECT memory_id
  FROM audit_events WHERE event='created' AND actor=?)` subquery to
  avoid the cost of a join on every read. Tests cover both empty
  and populated filters.
- [ ] **T2** — Forward `actor` through `ListServiceFilters` /
  `SearchServiceFilters` to `MemoryService.listMemories` /
  `searchMemories`. Tests cover the service passing the value to
  the store and the doctor check seeing the right distribution.
- [ ] **T3** — Add `actor` to `list_memories` and `search_memories`
  MCP tool schemas. Update the tool descriptions to mention the
  filter. New `tool-registration.test.ts` cases pin the field and
  the handler forwarding.
- [ ] **T4** — Add `--actor` flag to `agent-recall list` and
  `agent-recall search`. New CLI tests cover the flag being read,
  the filter being applied, and the output being labeled.
- [ ] **T5** — New `actor_ownership` doctor check (the 11th).
  Walks every `memory_entries` row, looks up the "created" audit
  event for each, and reports the per-actor distribution. Status
  is always `ok`; the check is informational. Update
  `test/doctor.test.ts` to expect 11 results.
- [ ] **T6** — Docs: `CHANGELOG.md` `[Unreleased] — Stage 4` entry;
  `docs/superpowers/plans/2026-07-20-stage-four-closure.md`
  closure report; `README.md` Tools-table note about the new
  filter, plus a CLI section update.
- [ ] **T7** — Final verification (`npm run typecheck && npm test &&
  git diff --check`), push branch + `--no-ff` merge to `main`,
  push `main` to origin.

## T1 — `actor` filter on the store (red → green)

### Test cases (extend `test/sqlite-store.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { SQLiteMemoryStore } from "../src/sqlite-store.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-store-actor-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  return { store, dataHome };
}

function makeEntry(id: string, actor: string, body: string) {
  return {
    id, scope: "global", type: "fact", memory_kind: "semantic",
    topic: "t", title: `t-${id}`, body, tags: [],
    source: { kind: "agent" },
    importance: 3, confidence: 3, status: "active",
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
    access_count: 0, supersedes: [],
    token_estimate: 1, char_count: body.length,
    metadata: { written_by_actor: actor }
  };
}

describe("listEntries actor filter", () => {
  it("returns all entries when actor is omitted", () => { ... });
  it("returns only entries whose created audit was by the given actor", () => { ... });
  it("returns empty when the actor has written nothing", () => { ... });
});

describe("searchEntries actor filter", () => {
  it("narrows FTS results by actor", () => { ... });
  it("combines with existing scope/status filters", () => { ... });
});
```

### Implementation sketch

`src/sqlite-store.ts`:

```ts
export type EntryFilters = {
  scope?: MemoryScope;
  project_id?: string;
  type?: MemoryType;
  topic?: string;
  status?: MemoryStatus;
  tags?: string[];
  limit?: number;
  offset?: number;
  actor?: string;  // NEW
};

function buildEntryWhere(filters: EntryFilters, alias: string): { where: string; params: SQLInputValue[] } {
  // ... existing ...
  if (filters.actor !== undefined) {
    clauses.push(`${column("id")} IN (SELECT memory_id FROM audit_events WHERE event = 'created' AND actor = ?)`);
    params.push(filters.actor);
  }
  // ...
}
```

`listEntries` and `searchEntries` are unchanged in shape — they
already pass `filters` through to `buildEntryWhere`.

### Commit

```bash
git add src/sqlite-store.ts test/sqlite-store.test.ts
git commit -m "feat(stage4): add actor filter to listEntries and searchEntries"
```

## T2 — Service-layer forwarding (red → green)

### Test cases (extend `test/memory-service.test.ts`)

```ts
it("listMemories forwards the actor filter to the store", () => { ... });
it("searchMemories forwards the actor filter to the store", () => { ... });
```

### Implementation

`src/memory-service.ts`:

```ts
type ListServiceFilters = EntryFilters & {
  project_path?: string;
  actor?: string;  // NEW (just allow the type to pass through)
};

type SearchServiceFilters = SearchFilters & {
  include_global?: boolean;
  project_path?: string;
  actor?: string;  // NEW
};
```

`listMemories` and `searchMemories` need to translate the
`project_path` → `project_id` lookup as they do today, but the
`actor` filter is just forwarded.

### Commit

```bash
git add src/memory-service.ts test/memory-service.test.ts
git commit -m "feat(stage4): forward actor filter through list and search"
```

## T3 — MCP tool schemas (red → green)

### Test cases (extend `test/tool-registration.test.ts`)

```ts
it("list_memories accepts an optional actor filter", () => {
  const parsed = memoryToolSchemas.list_memories.parse({
    scope: "global", actor: "agent:claude-code"
  });
  expect(parsed.actor).toBe("agent:claude-code");
});

it("search_memories accepts an optional actor filter", () => { ... });
```

### Implementation

`src/tools/schemas.ts`: add `actor: nonEmptyString.optional()` to
both `listMemoriesToolSchema` and `searchMemoriesToolSchema`.

`src/tools/descriptions.ts`: update `list_memories` and
`search_memories` INPUT segments to mention the new filter.

`src/tools/register-tools.ts`: handler already forwards via
`serviceInput<...>(input)`, no change needed.

### Commit

```bash
git add src/tools/schemas.ts src/tools/descriptions.ts test/tool-registration.test.ts
git commit -m "feat(stage4): add actor filter to list_memories and search_memories MCP tools"
```

## T4 — CLI flags (red → green)

### Test cases (extend `test/cli/list.test.ts` and `test/cli/search.test.ts`)

```ts
it("list --actor narrows the output to one writer", () => { ... });
it("search --actor narrows the FTS results to one writer", () => { ... });
```

### Implementation

`src/cli/commands/list.ts`:

```ts
const actor = flagString(ctx.args, "actor");
const filters: Record<string, unknown> = { scope, status, limit, offset };
if (projectId !== undefined) filters.project_id = projectId;
if (actor !== undefined) filters.actor = actor;
```

`src/cli/commands/search.ts`: same pattern.

### Commit

```bash
git add src/cli/commands/list.ts src/cli/commands/search.ts test/cli/list.test.ts test/cli/search.test.ts
git commit -m "feat(stage4): add --actor flag to agent-recall list and search"
```

## T5 — `actor_ownership` doctor check (red → green)

### Test cases (extend `test/doctor.test.ts`)

```ts
it("reports actor_ownership as 11th check", () => {
  const report = runDoctor(ctx);
  expect(report.results.length).toBe(11);
  const ownership = report.results.find((r) => r.name === "actor_ownership");
  expect(ownership?.status).toBe("ok");
});

it("actor_ownership shows per-actor distribution for memories with a created event", () => {
  store.insertEntry(makeEntry("mem_a", "agent:claude-code", "body a"));
  store.appendAudit({
    memory_id: "mem_a", scope: "global", event: "created",
    actor: "agent:claude-code", metadata: {}, created_at: "2026-07-20T00:00:00.000Z"
  });
  // ... similar for cursor and cli ...
  const report = runDoctor(ctx);
  const ownership = report.results.find((r) => r.name === "actor_ownership");
  expect(ownership?.message).toContain("agent:claude-code");
  expect(ownership?.message).toContain("agent:cursor");
});
```

### Implementation

`src/doctor/checks/actor-ownership.ts`:

```ts
import type { CheckContext, CheckResult } from "../types.js";

export function checkActorOwnership(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();
  const rows = handle.prepare(`
    SELECT a.actor AS actor, COUNT(DISTINCT a.memory_id) AS c
    FROM audit_events a
    WHERE a.event = 'created' AND a.actor IS NOT NULL AND a.actor != ''
    GROUP BY a.actor
    ORDER BY c DESC
  `).all() as Array<{ actor: string; c: number }>;

  if (rows.length === 0) {
    return { name: "actor_ownership", status: "ok", message: "no memories with a created event", details: { distribution: [] } };
  }
  const total = rows.reduce((acc, r) => acc + r.c, 0);
  return {
    name: "actor_ownership",
    status: "ok",
    message: `${total} entries across ${rows.length} actors`,
    details: { distribution: rows }
  };
}
```

`src/doctor/index.ts`: append to the `CHECKS` array.

### Commit

```bash
git add src/doctor/checks/actor-ownership.ts src/doctor/index.ts test/doctor.test.ts
git commit -m "feat(stage4): add actor_ownership doctor check (11th)"
```

## T6 — Closure docs

- `CHANGELOG.md`: add `[Unreleased] — Stage 4 Per-Agent Memory View`
  section above the existing Stage 3 entry; promote Stage 3 to
  `[0.3.0]`.
- `docs/superpowers/plans/2026-07-20-stage-four-closure.md` —
  plan-vs-actual, test inventory, architecture decisions, scope
  for Stage 5.
- `README.md`: Tools table — note that list_memories and
  search_memories now accept an `actor` filter. CLI section —
  mention `--actor` flag. Doctor section — "eleven health checks".

### Commit

```bash
git add CHANGELOG.md README.md docs/superpowers/plans/2026-07-20-stage-four-closure.md
git commit -m "docs(stage4): add CHANGELOG entry, closure report, README updates"
```

## T7 — Verification, push, merge

```bash
npm run typecheck
npm test
git diff --check
git push -u origin feat/stage4-per-agent-view
cd ../..
git checkout main
git merge --no-ff feat/stage4-per-agent-view -m "Merge branch 'feat/stage4-per-agent-view'"
git push origin main
```

## Expected outcome

- 239 → ~252 tests (+ ~13: ~5 sqlite-store, ~2 memory-service, ~2
  tool-registration, ~2 CLI, ~2 doctor)
- 1 new module (`src/doctor/checks/actor-ownership.ts`)
- 0 schema changes, 1 new field on `EntryFilters` (already-exposed
  via service)
- `doctor` now reports **11** checks (was 10)
- Stage 5 candidate: recall ranking weighted by actor trust,
  per-actor time windows, denormalized `created_by_actor` column if
  performance becomes a concern
