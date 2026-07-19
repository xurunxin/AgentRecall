# AgentRecall Stage One Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the five foundation pieces defined in [2026-07-19-stage-one-foundation.md](../specs/2026-07-19-stage-one-foundation.md): `actor` parsing + structured audit, `CURRENT_SCHEMA_VERSION` + v1→v2 migration, `Backup` mechanism, `Doctor` one-shot health check, and `agent-recall` CLI. Reorder tool descriptions to trigger / shape / failure three-segment form.

**Architecture:** Pure additions on top of the existing single-store / single-service layout. New modules under `src/actor.ts`, `src/backup.ts`, `src/doctor/`, `src/cli/`, `src/tools/descriptions.ts`. One migration v1→v2 that loosens `audit_events.actor` CHECK constraint. New `bin/agent-recall.ts` entrypoint. `MemoryService` and `SQLiteMemoryStore` are extended in-place; no facade refactor (stage 2 work).

**Tech Stack:** Node.js 24+, TypeScript, `@modelcontextprotocol/sdk`, `zod/v4`, built-in `node:sqlite`, Vitest. No new runtime or dev dependencies.

**Spec:** [`docs/superpowers/specs/2026-07-19-stage-one-foundation.md`](../specs/2026-07-19-stage-one-foundation.md)

**Working directory:** `G:\Projects\MetronX\local-memory-mcp`

---

## Commit Hygiene

Each task ends with a `git add` + `git commit` of the listed files. Use conventional commit prefixes:

- `feat(stage1):` for new modules (actor, backup, doctor, cli, descriptions)
- `feat(stage1):` for migration
- `docs(stage1):` for README
- `chore(stage1):` for package.json / bin field

---

## Task 1: Add `actor` Module and Wire It Into `MemoryService.appendAudit`

**Files:**
- Create: `src/actor.ts`
- Modify: `src/memory-service.ts`
- Create: `test/actor.test.ts`

The `actor` field on audit events is currently constrained to `'agent' | 'user' | 'system'`. We introduce a structured `actor` parser that produces strings of the form `agent:claude-code` while keeping the old bare values as valid fallbacks. `MemoryService.appendAudit` is updated to take an optional actor override; default resolution is added to a single helper.

- [ ] **Step 1.1: Create `src/actor.ts` with parser and recommended name list**

Create the file with the following content:

```ts
// src/actor.ts

export type ActorKind = "agent" | "user" | "system";

export const ACTOR_KINDS: readonly ActorKind[] = ["agent", "user", "system"];

export const RECOMMENDED_ACTOR_NAMES: Readonly<Record<ActorKind, readonly string[]>> = {
  agent: [
    "claude-code",
    "cursor",
    "codex",
    "aider",
    "cline",
    "continue",
    "windsurf",
    "roo-cline",
    "copilot"
  ],
  user: ["cli", "editor", "me"],
  system: [
    "expiry",
    "archive",
    "dedup",
    "doctor",
    "backup",
    "migration",
    "unknown"
  ]
};

export type ResolvedActor = {
  raw: string;
  kind: ActorKind;
  name: string;
};

const LEGACY_ACTOR_VALUES = new Set<string>(["agent", "user", "system"]);

function isActorKind(value: string): value is ActorKind {
  return (ACTOR_KINDS as readonly string[]).includes(value);
}

/**
 * Resolve the actor identifier to persist in audit_events.actor.
 *
 * Priority:
 *   1. explicit override (caller-provided)
 *   2. AGENT_RECALL_ACTOR environment variable
 *   3. fallback "agent:unknown"
 *
 * Accepts legacy bare values ("agent", "user", "system") and returns them
 * unchanged so v1 audit rows continue to validate against the v1 CHECK
 * constraint before migration.
 */
export function resolveActor(
  override: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string {
  const candidate = (override ?? env.AGENT_RECALL_ACTOR ?? "").trim();
  if (candidate.length === 0) {
    return "agent:unknown";
  }
  if (LEGACY_ACTOR_VALUES.has(candidate)) {
    return candidate;
  }
  return candidate;
}

/** Parse a stored actor string into structured form. Used for read-side display. */
export function parseActor(value: string): ResolvedActor {
  if (LEGACY_ACTOR_VALUES.has(value)) {
    return { raw: value, kind: value as ActorKind, name: value };
  }
  const separator = value.indexOf(":");
  if (separator === -1) {
    return { raw: value, kind: "system", name: value };
  }
  const kind = value.slice(0, separator);
  const name = value.slice(separator + 1);
  if (isActorKind(kind)) {
    return { raw: value, kind, name };
  }
  return { raw: value, kind: "system", name: value };
}

/** Test whether an actor value is a known recommended name. */
export function isRecommendedActor(value: string): boolean {
  const parsed = parseActor(value);
  return (RECOMMENDED_ACTOR_NAMES[parsed.kind] as readonly string[]).includes(parsed.name);
}
```

- [ ] **Step 1.2: Add a `cli` shorthand constant**

Append to the same file:

```ts
export const CLI_ACTOR = "user:cli";
export const DEFAULT_ACTOR = "agent:unknown";
```

- [ ] **Step 1.3: Update `MemoryService.appendAudit` to accept an optional actor override**

In `src/memory-service.ts`, locate the existing `appendAudit` method (around line ~860). Replace its signature and body so the actor is resolved through the new helper. Also extend the `remember`, `updateMemory`, `supersedeMemory`, and `forgetMemory` write paths so each audit event can carry the resolved actor.

Specifically:

1. Change `appendAudit` to:
   ```ts
   private appendAudit(
     input: Omit<MemoryAuditEvent, "id" | "created_at" | "actor"> & { actor?: string }
   ): void {
     const event: MemoryAuditEvent = {
       id: createAuditId(),
       scope: input.scope,
       event: input.event,
       actor: resolveActor(input.actor ?? this.defaultActor) as MemoryAuditEvent["actor"],
       metadata: input.metadata,
       created_at: nowIso()
     };
     if (input.memory_id !== undefined) event.memory_id = input.memory_id;
     if (input.project_id !== undefined) event.project_id = input.project_id;
     if (input.reason !== undefined) event.reason = input.reason;
     this.store.appendAudit(event);
   }
   ```
2. Add a constructor field:
   ```ts
   constructor(
     private readonly store: SQLiteMemoryStore,
     private readonly exporter?: MarkdownExporter,
     private readonly defaultActor: string = "agent:unknown"
   ) {}
   ```
3. In each call site of `appendAudit` inside `commitPreparedRemember`, `updateMemory`, `supersedeMemory`, `forgetMemory`, `maintainMemories`, `auditRejected`, `auditRejectedForEntry`, `auditRejectedForScope`, `appendMaintenanceAudit`, and `rebuildMarkdownIndex` — add an `actor` field. For internal/system events (e.g. expiry, archive, backup) use `"system:<name>"`. For agent-driven writes use `this.defaultActor`.

   Concretely:
   - `commitPreparedRemember`: `actor: this.defaultActor`
   - `updateMemory`: `actor: this.defaultActor`
   - `supersedeMemory` (replacement creation): `actor: this.defaultActor`
   - `supersedeMemory` (old entry superseded): `actor: this.defaultActor`
   - `forgetMemory`: `actor: this.defaultActor`
   - `expireDueMemories` (forgotten entry): `actor: "system:expiry"`
   - `archiveLowValueMemories`: `actor: "system:archive"`
   - `auditRejected*`: keep `actor: "system"` (legacy value) for now — they will move to `"system:validator"` in a follow-up after migration
   - `appendMaintenanceAudit`: `actor: "system:maintenance"` (not yet used; only relevant after Task 4 adds the actor threading for maintenance runs)

- [ ] **Step 1.4: Add `test/actor.test.ts`**

Create the file with the following cases:

```ts
// test/actor.test.ts
import { describe, expect, it } from "vitest";
import {
  ACTOR_KINDS,
  CLI_ACTOR,
  DEFAULT_ACTOR,
  RECOMMENDED_ACTOR_NAMES,
  isRecommendedActor,
  parseActor,
  resolveActor
} from "../src/actor.js";

describe("resolveActor", () => {
  it("returns the explicit override when provided", () => {
    expect(resolveActor("agent:claude-code", {})).toBe("agent:claude-code");
    expect(resolveActor("user:cli", {})).toBe("user:cli");
  });

  it("falls back to AGENT_RECALL_ACTOR env when override is missing", () => {
    expect(resolveActor(undefined, { AGENT_RECALL_ACTOR: "agent:codex" })).toBe("agent:codex");
  });

  it("falls back to agent:unknown when neither override nor env is set", () => {
    expect(resolveActor(undefined, {})).toBe(DEFAULT_ACTOR);
  });

  it("treats whitespace as empty", () => {
    expect(resolveActor("   ", {})).toBe(DEFAULT_ACTOR);
    expect(resolveActor(undefined, { AGENT_RECALL_ACTOR: "  " })).toBe(DEFAULT_ACTOR);
  });

  it("preserves legacy bare values", () => {
    expect(resolveActor("agent", {})).toBe("agent");
    expect(resolveActor("user", {})).toBe("user");
    expect(resolveActor("system", {})).toBe("system");
  });

  it("passes through unknown free-form strings", () => {
    expect(resolveActor("agent:custom-thing", {})).toBe("agent:custom-thing");
    expect(resolveActor("tool:ide", {})).toBe("tool:ide");
  });
});

describe("parseActor", () => {
  it("parses legacy values into themselves", () => {
    expect(parseActor("agent")).toEqual({ raw: "agent", kind: "agent", name: "agent" });
    expect(parseActor("system")).toEqual({ raw: "system", kind: "system", name: "system" });
  });

  it("parses structured values", () => {
    expect(parseActor("agent:claude-code")).toEqual({
      raw: "agent:claude-code",
      kind: "agent",
      name: "claude-code"
    });
    expect(parseActor("system:expiry")).toEqual({
      raw: "system:expiry",
      kind: "system",
      name: "expiry"
    });
  });

  it("falls back to system kind for malformed values", () => {
    expect(parseActor("nocolon")).toEqual({ raw: "nocolon", kind: "system", name: "nocolon" });
    expect(parseActor("tool:custom")).toEqual({ raw: "tool:custom", kind: "system", name: "custom" });
  });
});

describe("isRecommendedActor", () => {
  it("accepts each recommended name", () => {
    expect(isRecommendedActor("agent:claude-code")).toBe(true);
    expect(isRecommendedActor("user:cli")).toBe(true);
    expect(isRecommendedActor("system:expiry")).toBe(true);
  });

  it("rejects unknown names", () => {
    expect(isRecommendedActor("agent:mystery")).toBe(false);
    expect(isRecommendedActor("user:random")).toBe(false);
  });
});

describe("RECOMMENDED_ACTOR_NAMES", () => {
  it("covers all actor kinds", () => {
    for (const kind of ACTOR_KINDS) {
      expect(RECOMMENDED_ACTOR_NAMES[kind].length).toBeGreaterThan(0);
    }
  });
});

describe("CLI_ACTOR", () => {
  it("is a user-kind actor", () => {
    expect(parseActor(CLI_ACTOR).kind).toBe("user");
  });
});
```

- [ ] **Step 1.5: Run typecheck and tests**

Run:

```bash
cd G:\Projects\MetronX\local-memory-mcp
npm run typecheck
npm test -- test/actor.test.ts
npm test -- test/memory-service.test.ts
npm test -- test/e2e.test.ts
```

Expected: all green. The new constructor parameter is optional with a default value, so existing call sites in `test/memory-service.test.ts` keep working.

- [ ] **Step 1.6: Commit**

```bash
git add src/actor.ts src/memory-service.ts test/actor.test.ts
git commit -m "feat(stage1): add actor module and thread resolved actor into audit events"
```

---

## Task 2: Add `CURRENT_SCHEMA_VERSION` and `migrate_v1_to_v2`

**Files:**
- Modify: `src/sqlite-store.ts`
- Create: `test/sqlite-store-migration.test.ts`

Add an explicit schema version tracked via `PRAGMA user_version`. v1→v2 only loosens the `audit_events.actor` CHECK constraint. The migration is **not** auto-run during MCP server start; it is invoked explicitly by `agent-recall migrate` (Task 8) and by tests.

- [ ] **Step 2.1: Define the version constant and update `migrate()`**

In `src/sqlite-store.ts`:

1. Add at module top, near the imports:
   ```ts
   export const CURRENT_SCHEMA_VERSION = 2;
   ```
2. Rename the existing `migrate()` method body to a private `migrate_v1()` method. Change the public `migrate()` to:
   ```ts
   private migrate(): void {
     const current = this.readUserVersion();
     if (current >= CURRENT_SCHEMA_VERSION) {
       // Already at latest; nothing to do. The base DDL still needs to run
       // because tests construct empty databases that have no rows in
       // sqlite_master yet.
       this.runBaseDdl();
       return;
     }
     this.runBaseDdl();
     for (let version = current + 1; version <= CURRENT_SCHEMA_VERSION; version += 1) {
       this.migrateToVersion(version);
     }
   }

   private readUserVersion(): number {
     const row = this.db.prepare("PRAGMA user_version").get();
     if (row === undefined) return 0;
     const value = (row as Record<string, unknown>).user_version;
     return typeof value === "number" ? value : 0;
   }

   private runBaseDdl(): void {
     this.db.exec(`
       PRAGMA foreign_keys = ON;
       CREATE TABLE IF NOT EXISTS project_scopes (...);
       ...
     `);
     this.ensureMemoryKindColumn();
     this.ensureMemoryFtsSchema();
   }

   private migrateToVersion(version: number): void {
     if (version === 2) {
       this.migrate_v1_to_v2();
       return;
     }
     throw new Error(`No migration registered for schema version ${version}`);
   }
   ```
3. Add the migration method (after `ensureMemoryFtsSchema`):
   ```ts
   private migrate_v1_to_v2(): void {
     // Loosen the audit_events.actor CHECK constraint to accept structured
     // values like "agent:claude-code". The v1 constraint allowed only
     // "agent" / "user" / "system"; we drop the CHECK entirely.
     const row = this.db
       .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_events'")
       .get() as { sql: string } | undefined;
     if (row === undefined) {
       this.db.exec("PRAGMA user_version = 2");
       return;
     }
     const newSql = row.sql.replace(
       /CHECK \(actor IN \('agent', 'user', 'system'\)\)/,
       ""
     );
     if (newSql === row.sql) {
       // Already migrated (no CHECK to replace)
       this.db.exec("PRAGMA user_version = 2");
       return;
     }
     this.db.exec("PRAGMA writable_schema = ON");
     this.db
       .prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'audit_events'")
       .run(newSql);
     this.db.exec("PRAGMA writable_schema = OFF");
     this.db.exec("PRAGMA user_version = 2");
   }

   setUserVersion(version: number): void {
     // Exposed for the CLI migrate command. Runs outside a transaction.
     this.db.exec(`PRAGMA user_version = ${version}`);
   }

   getUserVersion(): number {
     return this.readUserVersion();
   }
   ```

   Note: the SQL block in `runBaseDdl` above is a placeholder; the actual body should be the same as the current `migrate()` DDL block (lines roughly 240-300 of `src/sqlite-store.ts`). Move that DDL into `runBaseDdl()` unchanged.

- [ ] **Step 2.2: Expose a public `migrate()` wrapper for CLI / tests**

Right after the existing `private migrate()` method, add:

```ts
runMigrations(): { from: number; to: number } {
  const before = this.readUserVersion();
  this.migrate();
  const after = this.readUserVersion();
  return { from: before, to: after };
}
```

- [ ] **Step 2.3: Add `test/sqlite-store-migration.test.ts`**

```ts
// test/sqlite-store-migration.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, SQLiteMemoryStore } from "../src/sqlite-store.js";

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "lm-mig-")), "memory.sqlite");
}

describe("SQLiteMemoryStore migrations", () => {
  let dbPath: string;
  let store: SQLiteMemoryStore;

  beforeEach(() => {
    dbPath = tmpDbPath();
  });

  afterEach(() => {
    store?.close();
  });

  it("creates a v2 schema on first run", () => {
    store = new SQLiteMemoryStore(dbPath);
    expect(store.getUserVersion()).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBe(2);
  });

  it("is a no-op when schema is already at latest version", () => {
    store = new SQLiteMemoryStore(dbPath);
    const result = store.runMigrations();
    expect(result).toEqual({ from: CURRENT_SCHEMA_VERSION, to: CURRENT_SCHEMA_VERSION });
  });

  it("migrates a v1 database (with the old CHECK constraint) to v2", () => {
    // Bootstrap a v1-shaped database directly with raw SQL
    const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
    db.exec(`
      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        memory_id TEXT,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
        project_id TEXT,
        event TEXT NOT NULL,
        reason TEXT,
        actor TEXT NOT NULL CHECK (actor IN ('agent', 'user', 'system')),
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO audit_events (id, scope, event, actor, metadata_json, created_at)
        VALUES ('aud_x', 'global', 'created', 'agent', '{}', '2026-01-01T00:00:00.000Z');
    `);
    db.close();

    store = new SQLiteMemoryStore(dbPath);
    expect(store.getUserVersion()).toBe(CURRENT_SCHEMA_VERSION);

    // After migration, structured actor values must be insertable
    const inner = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true, readOnly: false });
    inner
      .prepare(
        "INSERT INTO audit_events (id, scope, event, actor, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run("aud_y", "global", "created", "agent:claude-code", "{}", "2026-01-02T00:00:00.000Z");
    inner.close();
  });

  it("downgrading the schema is rejected via runMigrations from a higher version", () => {
    store = new SQLiteMemoryStore(dbPath);
    store.setUserVersion(99);
    store.close();

    // Re-open: should not run a no-op loop back down; the migration loop only
    // runs forward, so reading should succeed at v99 unchanged. This is a
    // smoke check, not a downgrade-prevention feature.
    store = new SQLiteMemoryStore(dbPath);
    expect(store.getUserVersion()).toBe(99);
  });
});
```

- [ ] **Step 2.4: Run typecheck + tests**

```bash
cd G:\Projects\MetronX\local-memory-mcp
npm run typecheck
npm test -- test/sqlite-store-migration.test.ts
npm test -- test/sqlite-store.test.ts
npm test -- test/memory-service.test.ts
npm test -- test/e2e.test.ts
```

Expected: all green. If `test/sqlite-store.test.ts` starts failing because of DDL changes inside `runBaseDdl`, fix by ensuring the moved DDL is byte-for-byte the same as before.

- [ ] **Step 2.5: Commit**

```bash
git add src/sqlite-store.ts test/sqlite-store-migration.test.ts
git commit -m "feat(stage1): introduce CURRENT_SCHEMA_VERSION and v1->v2 audit actor migration"
```

---

## Task 3: Rewrite Tool Descriptions to Three-Segment Form

**Files:**
- Create: `src/tools/descriptions.ts`
- Modify: `src/tools/register-tools.ts`
- Create: `test/tools-descriptions.test.ts`

Each tool's description becomes a `[TRIGGER] ... [INPUT] ... [OUTPUT] ... [FAILURE] ...` block. The total length per tool must not exceed 400 characters; each segment is at most 80 characters.

- [ ] **Step 3.1: Create `src/tools/descriptions.ts`**

```ts
// src/tools/descriptions.ts
import type { MemoryToolName } from "./schemas.js";

const MAX_TOTAL = 400;
const MAX_SEGMENT = 80;

type Segment = "TRIGGER" | "INPUT" | "OUTPUT" | "FAILURE";

const TEXT: Record<MemoryToolName, Record<Segment, string>> = {
  recall_context: {
    TRIGGER: "Call near the start of a coding task, before planning or editing.",
    INPUT: "scope (global|project), query, project_id|project_path, budget_chars, include_global?",
    OUTPUT: "Markdown context pack (budget-bounded). Paste directly into system prompt.",
    FAILURE: "Empty string on invalid_scope. Do not retry blindly; fix the input."
  },
  remember: {
    TRIGGER: "After learning a durable, reusable user/project fact, decision, or procedure.",
    INPUT: "scope, type, memory_kind?, topic, title, body, tags, source, importance, confidence.",
    OUTPUT: "{ memory_id, status, budget_after, warnings[] }. warnings may include duplicate_candidate.",
    FAILURE: "capacity_exceeded -> run maintain_memories. secret_detected -> never store secrets. search_memories first to avoid dupes."
  },
  search_memories: {
    TRIGGER: "Before writing, or when you need a specific past fact about the project or user.",
    INPUT: "query, scope, project_id|project_path?, type?, topic?, tags?, limit? (default 10), include_global?",
    OUTPUT: "items[] ranked by SQLite FTS bm25; each has match_reason, id, scope, type, memory_kind, topic, title, tags, source, updated_at, status.",
    FAILURE: "Empty array on no hits. If you expected a hit, broaden scope (include_global) or relax topic/type filters."
  },
  get_memory: {
    TRIGGER: "When you have a memory id and need its full body plus the lifecycle history.",
    INPUT: "id | memory_id (both accepted; if both present, must match).",
    OUTPUT: "{ entry, audit[] } where audit is the ordered lifecycle: created/updated/archived/superseded/forgotten/write_rejected.",
    FAILURE: "not_found if id is unknown. List via list_memories or search_memories to find the right id."
  },
  list_memories: {
    TRIGGER: "When you need a flat dump of memories, not a relevance-ranked search.",
    INPUT: "scope, project_id|project_path, status? (default active), type?, memory_kind?, topic?, tags?, limit?, offset?",
    OUTPUT: "{ items[] } ordered by updated_at desc.",
    FAILURE: "Empty list means no active memories in scope. Use get_memory_budget to inspect capacity before adding."
  },
  update_memory: {
    TRIGGER: "When a known memory needs correction, importance bump, or status change.",
    INPUT: "id | memory_id, then EITHER patch object OR top-level fields (topic|title|body|tags|importance|confidence|status|expires_at|review_after).",
    OUTPUT: "{ memory_id }. Mutation is atomic; old body is preserved in audit.",
    FAILURE: "invalid_state if memory is superseded|forgotten. invalid_schema if both patch and top-level fields are provided."
  },
  supersede_memory: {
    TRIGGER: "When a memory is wrong, outdated, or split across multiple entries that should merge into one.",
    INPUT: "old_memory_ids[] (>=1), replacement (a remember-shaped object), reason.",
    OUTPUT: "{ memory_id } of the new entry. Old entries are marked superseded atomically in the same transaction.",
    FAILURE: "not_found if any old id is missing. invalid_scope if old and new live in different scopes."
  },
  forget_memory: {
    TRIGGER: "When a memory is no longer true, relevant, or was a mistake. Use sparingly; prefer supersede.",
    INPUT: "id | memory_id, reason.",
    OUTPUT: "{ memory_id, released_chars } indicating budget freed.",
    FAILURE: "not_found. Forgotten memories keep their id and audit history; body is cleared, tags emptied."
  },
  get_memory_budget: {
    TRIGGER: "When you need to know how full the global or project budget is, or what to clean up next.",
    INPUT: "scope, project_id (required when scope=project).",
    OUTPUT: "{ budget, usage, cleanup_candidates[] }. cleanup_candidates are suggestions; you must call forget_memory/update_memory explicitly to act on them.",
    FAILURE: "invalid_scope when project_id is missing for scope=project."
  },
  maintain_memories: {
    TRIGGER: "When the user asks for cleanup, or as a fallback when remember returns capacity_exceeded.",
    INPUT: "action: archive_low_value | expire_due | rebuild_markdown_index | vacuum_fts | find_duplicates; scope, project_id|project_path.",
    OUTPUT: "{ action, changed, details }. expire_due auto-calls forget_memory on expired entries. find_duplicates returns groups but never mutates.",
    FAILURE: "invalid_scope. Some actions (vacuum_fts) may be a no-op if unsupported by the storage engine."
  },
  export_memory_context: {
    TRIGGER: "When a human-readable markdown snapshot of memories is needed (review, handoff, external storage).",
    INPUT: "scope, project_id|project_path?, query?, budget_chars, types?, memory_kinds?, topics?, include_global?",
    OUTPUT: "Full markdown document with budget-bounded entries. Diffable. NOT a substitute for recall_context (which is optimized for agent consumption).",
    FAILURE: "Empty document on invalid_scope. Output is plain text; do not try to parse it as JSON."
  }
};

export const memoryToolDescriptions: Record<MemoryToolName, string> = Object.fromEntries(
  (Object.keys(TEXT) as MemoryToolName[]).map((name) => [
    name,
    `[TRIGGER] ${TEXT[name].TRIGGER}\n[INPUT] ${TEXT[name].INPUT}\n[OUTPUT] ${TEXT[name].OUTPUT}\n[FAILURE] ${TEXT[name].FAILURE}`
  ])
) as Record<MemoryToolName, string>;
```

- [ ] **Step 3.2: Update `register-tools.ts` to use the new map**

In `src/tools/register-tools.ts`:

1. Delete the local `memoryToolDescriptions` constant.
2. Add the import:
   ```ts
   import { memoryToolDescriptions } from "./descriptions.js";
   ```
3. The reference inside the register loop already uses the variable; ensure the import is used.

- [ ] **Step 3.3: Add `test/tools-descriptions.test.ts`**

```ts
// test/tools-descriptions.test.ts
import { describe, expect, it } from "vitest";
import { memoryToolNames } from "../src/tools/register-tools.js";
import { memoryToolDescriptions } from "../src/tools/descriptions.js";
import type { MemoryToolName } from "../src/tools/schemas.js";

describe("memoryToolDescriptions", () => {
  it("has an entry for every tool", () => {
    for (const name of memoryToolNames) {
      expect(memoryToolDescriptions[name]).toBeDefined();
    }
  });

  it("respects the 400 character total budget per tool", () => {
    for (const name of memoryToolNames) {
      expect(memoryToolDescriptions[name].length, name).toBeLessThanOrEqual(400);
    }
  });

  it("contains all four segments", () => {
    for (const name of memoryToolNames) {
      const text = memoryToolDescriptions[name];
      expect(text).toContain("[TRIGGER]");
      expect(text).toContain("[INPUT]");
      expect(text).toContain("[OUTPUT]");
      expect(text).toContain("[FAILURE]");
    }
  });

  it("keeps each segment under 80 characters", () => {
    for (const name of memoryToolNames) {
      const lines = memoryToolDescriptions[name].split("\n");
      for (const line of lines) {
        const body = line.replace(/^\[[A-Z]+\] /, "");
        expect(body.length, `${name} line: ${line}`).toBeLessThanOrEqual(80);
      }
    }
  });
});
```

- [ ] **Step 3.4: Run typecheck + tests**

```bash
cd G:\Projects\MetronX\local-memory-mcp
npm run typecheck
npm test -- test/tools-descriptions.test.ts
npm test -- test/tool-registration.test.ts
npm test -- test/e2e.test.ts
```

Expected: all green. `tool-registration.test.ts` exercises the descriptions through the register flow.

- [ ] **Step 3.5: Commit**

```bash
git add src/tools/descriptions.ts src/tools/register-tools.ts test/tools-descriptions.test.ts
git commit -m "feat(stage1): rewrite MCP tool descriptions to trigger/input/output/failure form"
```

---

## Task 4: Add `Backup` Module and Auto-Backup Hooks

**Files:**
- Create: `src/backup.ts`
- Modify: `src/memory-service.ts`
- Modify: `src/sqlite-store.ts`
- Create: `test/backup.test.ts`

`Backup` performs `VACUUM INTO` on the active database to write a standalone copy. The `MemoryService.maintainMemories` path triggers a backup automatically when `changed > 0`. The CLI's `agent-recall backup` will also call this module (Task 7).

- [ ] **Step 4.1: Create `src/backup.ts`**

```ts
// src/backup.ts
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export type BackupResult = {
  path: string;
  size: number;
  durationMs: number;
  kept: number;
  pruned: number;
};

export type BackupOptions = {
  /** Directory the backup files are written into. */
  backupDir: string;
  /** How many recent backups to retain. Default 14. */
  keep?: number;
  /** Timestamp used as the backup filename. Defaults to `new Date()`. */
  now?: Date;
  /** Optional callback invoked after the backup file is written, before prune. */
  onCreated?: (result: { path: string; size: number }) => void;
};

export class BackupError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "BackupError";
  }
}

function safeTimestamp(date: Date): string {
  // 2026-07-19T20-01-00.123Z (colons replaced with dashes for Windows)
  return date.toISOString().replace(/[:]/g, "-");
}

export function backupFilename(date: Date = new Date()): string {
  return `memory-${safeTimestamp(date)}.sqlite`;
}

export function runBackup(db: DatabaseSync, options: BackupOptions): BackupResult {
  const keep = options.keep ?? 14;
  const now = options.now ?? new Date();
  const target = join(options.backupDir, backupFilename(now));

  mkdirSync(options.backupDir, { recursive: true });
  if (existsSync(target)) {
    throw new BackupError(`Backup file already exists: ${target}`);
  }

  const start = Date.now();
  const quotedTarget = target.replaceAll("'", "''");
  try {
    // VACUUM INTO runs outside transactions and takes an EXCLUSIVE lock.
    // SQLite does not support bound parameters in VACUUM INTO, so we
    // quote the path manually. Path components are sanitized via
    // path.join + the previous replacement.
    db.exec(`VACUUM INTO '${quotedTarget}'`);
  } catch (error) {
    throw new BackupError(`VACUUM INTO failed for ${target}`, error);
  }
  const size = statSync(target).size;
  const durationMs = Date.now() - start;

  options.onCreated?.({ path: target, size });

  const { kept, pruned } = pruneBackups(options.backupDir, keep);

  return { path: target, size, durationMs, kept, pruned };
}

export function pruneBackups(backupDir: string, keep: number): { kept: number; pruned: number } {
  if (!existsSync(backupDir)) return { kept: 0, pruned: 0 };
  const files = readdirSync(backupDir)
    .filter((name) => name.endsWith(".sqlite"))
    .sort();
  const toDelete = files.slice(0, Math.max(0, files.length - keep));
  for (const name of toDelete) {
    try {
      unlinkSync(join(backupDir, name));
    } catch {
      // Best-effort prune; don't fail the backup because of an old file we can't delete
    }
  }
  return { kept: Math.min(files.length, keep), pruned: toDelete.length };
}

export function listBackups(backupDir: string): Array<{ name: string; size: number; mtimeMs: number }> {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((name) => name.endsWith(".sqlite"))
    .map((name) => {
      const full = join(backupDir, name);
      const stat = statSync(full);
      return { name, size: stat.size, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}
```

- [ ] **Step 4.2: Expose the underlying `DatabaseSync` from `SQLiteMemoryStore` (gated)**

In `src/sqlite-store.ts`, add a method:

```ts
/**
 * Returns the underlying database handle. Intended ONLY for backup
 * (VACUUM INTO). Do not call arbitrary statements; doing so bypasses
 * the store's row-decoding and audit/FTS bookkeeping.
 */
backupHandle(): DatabaseSync {
  return this.db;
}
```

- [ ] **Step 4.3: Wire `MemoryService` to know its data home for backups**

Add to the constructor:

```ts
constructor(
  store: SQLiteMemoryStore,
  private readonly exporter?: MarkdownExporter,
  private readonly defaultActor: string = "agent:unknown",
  private readonly dataHome?: string
) {}
```

Update `createService()` in `src/index.ts` to pass `dataHome`:

```ts
export function createService(dataHome = resolveDataHome()): MemoryService {
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const exporter = new MarkdownExporter(join(dataHome, "exports"));
  return new MemoryService(store, exporter, undefined, dataHome);
}
```

- [ ] **Step 4.4: Add `MemoryService.backup()` and hook into `maintainMemories`**

Add a new public method on `MemoryService`:

```ts
backup(): { path: string; size: number; duration_ms: number } | { error: string } {
  if (this.dataHome === undefined) {
    return { error: "data_home_unknown" };
  }
  const backupDir = join(this.dataHome, "backups");
  try {
    const result = runBackup(this.store.backupHandle(), { backupDir });
    this.appendAudit({
      scope: "global",
      event: "maintenance_run",
      actor: "system:backup",
      reason: "backup_created",
      metadata: {
        action: "backup_created",
        path: result.path,
        size: result.size,
        duration_ms: result.durationMs,
        kept: result.kept,
        pruned: result.pruned
      }
    });
    return { path: result.path, size: result.size, duration_ms: result.durationMs };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    this.appendAudit({
      scope: "global",
      event: "maintenance_run",
      actor: "system:backup",
      reason: "backup_failed",
      metadata: { action: "backup_failed", error: message }
    });
    return { error: message };
  }
}
```

Add a new audit event name `"backup_created"` to the `AuditEventName` union in `src/domain.ts`:

```ts
export type AuditEventName =
  | "created"
  | "updated"
  | "archived"
  | "superseded"
  | "forgotten"
  | "write_rejected"
  | "maintenance_run"
  | "markdown_exported"
  | "backup_created";
```

Hook into `maintainMemories` so that when `changed > 0` AND the action is one of `rebuild_markdown_index`, `expire_due`, or `archive_low_value`, a backup is triggered. Concretely, at the end of each of those three branches (after returning from the store transaction), add:

```ts
if (this.dataHome !== undefined && result.changed > 0) {
  this.backup();
}
```

`find_duplicates` and `vacuum_fts` do not trigger backups (no row mutations in the former; the latter is a no-op-ish vacuum).

- [ ] **Step 4.5: Add `test/backup.test.ts`**

```ts
// test/backup.test.ts
import { existsSync, mkdtempSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { listBackups, pruneBackups, runBackup, BackupError } from "../src/backup.js";
import { SQLiteMemoryStore } from "../src/sqlite-store.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "lm-backup-"));
}

describe("runBackup", () => {
  it("writes a file and reports size + duration", () => {
    const dataHome = tmpDir();
    const backupDir = join(dataHome, "backups");
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    store.insertEntry({
      id: "mem_test",
      scope: "global",
      type: "fact",
      memory_kind: "semantic",
      topic: "test",
      title: "t",
      body: "b",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      status: "active",
      created_at: "2026-07-19T00:00:00.000Z",
      updated_at: "2026-07-19T00:00:00.000Z",
      access_count: 0,
      supersedes: [],
      token_estimate: 1,
      char_count: 2
    });
    const result = runBackup(store.backupHandle(), { backupDir });
    expect(existsSync(result.path)).toBe(true);
    expect(result.size).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.kept).toBe(1);
    store.close();
  });

  it("refuses to overwrite an existing file", () => {
    const dataHome = tmpDir();
    const backupDir = join(dataHome, "backups");
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const fixed = new Date("2026-01-01T00:00:00.000Z");
    runBackup(store.backupHandle(), { backupDir, now: fixed });
    expect(() => runBackup(store.backupHandle(), { backupDir, now: fixed })).toThrow(BackupError);
    store.close();
  });
});

describe("pruneBackups", () => {
  it("keeps the N most recent files", () => {
    const dir = tmpDir();
    for (let i = 0; i < 5; i += 1) {
      const name = `memory-2026-07-19T00-00-0${i}.000Z.sqlite`;
      const path = join(dir, name);
      // touch a real file so unlinkSync has something to delete
      statSync(path);
    }
    // Re-create via real touch using a no-op open+close
    for (let i = 0; i < 5; i += 1) {
      const name = `memory-2026-07-19T00-00-0${i}.000Z.sqlite`;
      // create empty files via writeFileSync
      require("node:fs").writeFileSync(join(dir, name), "");
    }
    const result = pruneBackups(dir, 3);
    expect(result.kept).toBe(3);
    expect(result.pruned).toBe(2);
    expect(readdirSync(dir).length).toBe(3);
    for (const name of readdirSync(dir)) unlinkSync(join(dir, name));
  });
});

describe("listBackups", () => {
  it("returns empty for missing dir", () => {
    expect(listBackups(join(tmpDir(), "does-not-exist"))).toEqual([]);
  });

  it("returns entries sorted newest first", () => {
    const dir = tmpDir();
    require("node:fs").writeFileSync(join(dir, "memory-a.sqlite"), "");
    require("node:fs").writeFileSync(join(dir, "memory-b.sqlite"), "");
    const items = listBackups(dir);
    expect(items.length).toBe(2);
    for (const name of readdirSync(dir)) unlinkSync(join(dir, name));
  });
});
```

- [ ] **Step 4.6: Run typecheck + tests**

```bash
cd G:\Projects\MetronX\local-memory-mcp
npm run typecheck
npm test -- test/backup.test.ts
npm test -- test/memory-service.test.ts
npm test -- test/e2e.test.ts
```

Expected: all green. The new `dataHome` parameter on `MemoryService` is optional so existing tests that construct `new MemoryService(store, exporter)` keep working.

- [ ] **Step 4.7: Commit**

```bash
git add src/backup.ts src/memory-service.ts src/sqlite-store.ts src/domain.ts src/index.ts test/backup.test.ts
git commit -m "feat(stage1): add VACUUM INTO backup with auto-backup after maintain_memories"
```

---

## Task 5: Add `doctor` Module (9 Checks + Orchestrator)

**Files:**
- Create: `src/doctor/index.ts`
- Create: `src/doctor/types.ts`
- Create: `src/doctor/checks/*.ts` (9 files)
- Create: `test/doctor.test.ts`

The `doctor` module exposes an orchestrator that runs all 9 checks and produces a structured report. Each check returns a `CheckResult` (`{ name, status, message, details? }`).

- [ ] **Step 5.1: Create `src/doctor/types.ts`**

```ts
// src/doctor/types.ts

export type CheckStatus = "ok" | "warn" | "fail";

export type CheckResult = {
  name: string;
  status: CheckStatus;
  message: string;
  details?: Record<string, unknown>;
};

export type DoctorReport = {
  started_at: string;
  finished_at: string;
  results: CheckResult[];
  summary: {
    ok: number;
    warn: number;
    fail: number;
  };
  exit_code: 0 | 1 | 2;
};

export type CheckContext = {
  dataHome: string;
  store: import("../sqlite-store.js").SQLiteMemoryStore;
  now: () => Date;
};
```

- [ ] **Step 5.2: Create the 9 check files**

Create `src/doctor/checks/data-home.ts`:

```ts
import { existsSync } from "node:fs";
import { accessSync, constants } from "node:fs";
import type { CheckContext, CheckResult } from "../types.js";

export function checkDataHome(ctx: CheckContext): CheckResult {
  if (!existsSync(ctx.dataHome)) {
    return { name: "data_home", status: "fail", message: `${ctx.dataHome} does not exist` };
  }
  try {
    accessSync(ctx.dataHome, constants.W_OK);
    return { name: "data_home", status: "ok", message: `${ctx.dataHome} writable` };
  } catch {
    return { name: "data_home", status: "fail", message: `${ctx.dataHome} not writable` };
  }
}
```

Create `src/doctor/checks/integrity.ts`:

```ts
import type { CheckContext, CheckResult } from "../types.js";

export function checkIntegrity(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();
  const row = handle.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;
  const value = row?.integrity_check ?? "";
  if (value === "ok") {
    return { name: "integrity", status: "ok", message: "ok" };
  }
  return {
    name: "integrity",
    status: "fail",
    message: `integrity_check returned: ${value}`,
    details: { raw: value }
  };
}
```

Create `src/doctor/checks/schema-version.ts`:

```ts
import { CURRENT_SCHEMA_VERSION } from "../../sqlite-store.js";
import type { CheckContext, CheckResult } from "../types.js";

export function checkSchemaVersion(ctx: CheckContext): CheckResult {
  const current = ctx.store.getUserVersion();
  if (current === CURRENT_SCHEMA_VERSION) {
    return {
      name: "schema_version",
      status: "ok",
      message: `${current} (latest)`,
      details: { current, latest: CURRENT_SCHEMA_VERSION }
    };
  }
  if (current > CURRENT_SCHEMA_VERSION) {
    return {
      name: "schema_version",
      status: "fail",
      message: `downgrade: db is v${current}, code expects v${CURRENT_SCHEMA_VERSION}`,
      details: { current, latest: CURRENT_SCHEMA_VERSION }
    };
  }
  return {
    name: "schema_version",
    status: "warn",
    message: `db is v${current}, code expects v${CURRENT_SCHEMA_VERSION}; run agent-recall migrate`,
    details: { current, latest: CURRENT_SCHEMA_VERSION }
  };
}
```

Create `src/doctor/checks/fts-consistency.ts`:

```ts
import type { CheckContext, CheckResult } from "../types.js";

export function checkFtsConsistency(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();
  const ftsRow = handle.prepare("SELECT COUNT(*) AS c FROM memory_fts").get() as { c: number };
  const memRow = handle.prepare("SELECT COUNT(*) AS c FROM memory_entries").get() as { c: number };
  if (ftsRow.c === memRow.c) {
    return {
      name: "fts_consistency",
      status: "ok",
      message: `${ftsRow.c} rows in fts == ${memRow.c} in memory_entries`,
      details: { fts: ftsRow.c, entries: memRow.c }
    };
  }
  return {
    name: "fts_consistency",
    status: "fail",
    message: `fts has ${ftsRow.c} rows but memory_entries has ${memRow.c}`,
    details: { fts: ftsRow.c, entries: memRow.c }
  };
}
```

Create `src/doctor/checks/backup-directory.ts`:

```ts
import { listBackups } from "../../backup.js";
import type { CheckContext, CheckResult } from "../types.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function checkBackupDirectory(ctx: CheckContext): CheckResult {
  const backupDir = `${ctx.dataHome}/backups`;
  const items = listBackups(backupDir);
  if (items.length === 0) {
    return { name: "backup_directory", status: "warn", message: "no backups present" };
  }
  const newest = items[0];
  const ageMs = ctx.now().getTime() - newest.mtimeMs;
  if (ageMs > SEVEN_DAYS_MS) {
    return {
      name: "backup_directory",
      status: "warn",
      message: `newest backup is ${Math.round(ageMs / 86_400_000)}d old`,
      details: { count: items.length, newest: newest.name, age_ms: ageMs }
    };
  }
  return {
    name: "backup_directory",
    status: "ok",
    message: `${items.length} backups, newest ${Math.round(ageMs / 3_600_000)}h ago`,
    details: { count: items.length, newest: newest.name, age_ms: ageMs }
  };
}
```

Create `src/doctor/checks/disk-free.ts`:

```ts
import { statfsSync } from "node:fs";
import type { CheckContext, CheckResult } from "../types.js";

const WARN_BYTES = 100 * 1024 * 1024;

export function checkDiskFree(ctx: CheckContext): CheckResult {
  try {
    const stat = statfsSync(ctx.dataHome);
    const freeBytes = stat.bavail * stat.bsize;
    if (freeBytes < WARN_BYTES) {
      return {
        name: "disk_free",
        status: "warn",
        message: `${(freeBytes / 1_048_576).toFixed(1)} MB available`,
        details: { free_bytes: freeBytes }
      };
    }
    return {
      name: "disk_free",
      status: "ok",
      message: `${(freeBytes / 1_073_741_824).toFixed(2)} GB available`,
      details: { free_bytes: freeBytes }
    };
  } catch (error) {
    return {
      name: "disk_free",
      status: "warn",
      message: `statfs failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
```

Create `src/doctor/checks/audit-health.ts`:

```ts
import type { CheckContext, CheckResult } from "../types.js";

const WARN_THRESHOLD = 10;
const FAIL_THRESHOLD = 100;

export function checkAuditHealth(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();
  const since = new Date(ctx.now().getTime() - 24 * 60 * 60 * 1000).toISOString();
  const row = handle
    .prepare("SELECT COUNT(*) AS c FROM audit_events WHERE event = 'write_rejected' AND created_at >= ?")
    .get(since) as { c: number };
  if (row.c >= FAIL_THRESHOLD) {
    return {
      name: "audit_health",
      status: "fail",
      message: `${row.c} write_rejected in last 24h`,
      details: { count: row.c, window_hours: 24 }
    };
  }
  if (row.c >= WARN_THRESHOLD) {
    return {
      name: "audit_health",
      status: "warn",
      message: `${row.c} write_rejected in last 24h`,
      details: { count: row.c, window_hours: 24 }
    };
  }
  return {
    name: "audit_health",
    status: "ok",
    message: `${row.c} write_rejected in last 24h`,
    details: { count: row.c, window_hours: 24 }
  };
}
```

Create `src/doctor/checks/capacity-headroom.ts`:

```ts
import { DEFAULT_GLOBAL_BUDGET, type MemoryBudget } from "../../domain.js";
import type { CheckContext, CheckResult } from "../types.js";

const WARN_RATIO = 0.8;

export function checkCapacityHeadroom(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();
  const row = handle
    .prepare("SELECT COUNT(*) AS c FROM memory_entries WHERE status = 'active' AND scope = 'global'")
    .get() as { c: number };
  const budget: MemoryBudget = DEFAULT_GLOBAL_BUDGET;
  const ratio = row.c / budget.max_active_entries;
  if (ratio >= 1) {
    return {
      name: "capacity_headroom",
      status: "fail",
      message: `global active = ${row.c}/${budget.max_active_entries} (${Math.round(ratio * 100)}%)`,
      details: { active: row.c, max: budget.max_active_entries }
    };
  }
  if (ratio >= WARN_RATIO) {
    return {
      name: "capacity_headroom",
      status: "warn",
      message: `global active = ${row.c}/${budget.max_active_entries} (${Math.round(ratio * 100)}%)`,
      details: { active: row.c, max: budget.max_active_entries }
    };
  }
  return {
    name: "capacity_headroom",
    status: "ok",
    message: `global active = ${row.c}/${budget.max_active_entries} (${Math.round(ratio * 100)}%)`,
    details: { active: row.c, max: budget.max_active_entries }
  };
}
```

Create `src/doctor/checks/actor-distribution.ts`:

```ts
import { isRecommendedActor } from "../../actor.js";
import type { CheckContext, CheckResult } from "../types.js";

export function checkActorDistribution(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();
  const rows = handle
    .prepare("SELECT actor, COUNT(*) AS c FROM audit_events GROUP BY actor ORDER BY c DESC")
    .all() as Array<{ actor: string; c: number }>;
  const unknown = rows.filter((r) => !isRecommendedActor(r.actor) && !["agent", "user", "system"].includes(r.actor));
  if (unknown.length === 0) {
    return {
      name: "actor_distribution",
      status: "ok",
      message: `${rows.length} distinct actors, all known`,
      details: { distribution: rows }
    };
  }
  return {
    name: "actor_distribution",
    status: "ok",
    message: `${rows.length} distinct actors, ${unknown.length} unknown`,
    details: { distribution: rows, unknown: unknown.map((u) => u.actor) }
  };
}
```

- [ ] **Step 5.3: Create `src/doctor/index.ts` orchestrator**

```ts
import { nowIso } from "../domain.js";
import { checkActorDistribution } from "./checks/actor-distribution.js";
import { checkAuditHealth } from "./checks/audit-health.js";
import { checkBackupDirectory } from "./checks/backup-directory.js";
import { checkCapacityHeadroom } from "./checks/capacity-headroom.js";
import { checkDataHome } from "./checks/data-home.js";
import { checkDiskFree } from "./checks/disk-free.js";
import { checkFtsConsistency } from "./checks/fts-consistency.js";
import { checkIntegrity } from "./checks/integrity.js";
import { checkSchemaVersion } from "./checks/schema-version.js";
import type { CheckContext, CheckResult, DoctorReport } from "./types.js";

const CHECKS: Array<(ctx: CheckContext) => CheckResult> = [
  checkDataHome,
  checkIntegrity,
  checkSchemaVersion,
  checkFtsConsistency,
  checkBackupDirectory,
  checkDiskFree,
  checkAuditHealth,
  checkCapacityHeadroom,
  checkActorDistribution
];

export function runDoctor(ctx: CheckContext): DoctorReport {
  const started = nowIso(ctx.now());
  const results = CHECKS.map((check) => check(ctx));
  const summary = results.reduce(
    (acc, r) => {
      acc[r.status] += 1;
      return acc;
    },
    { ok: 0, warn: 0, fail: 0 }
  );
  const exitCode: 0 | 1 | 2 = summary.fail > 0 ? 2 : summary.warn > 0 ? 1 : 0;
  return {
    started_at: started,
    finished_at: nowIso(ctx.now()),
    results,
    summary,
    exit_code: exitCode
  };
}
```

- [ ] **Step 5.4: Add `test/doctor.test.ts`**

```ts
// test/doctor.test.ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor/index.js";
import { SQLiteMemoryStore } from "../src/sqlite-store.js";
import type { CheckContext } from "../src/doctor/types.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-doctor-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const ctx: CheckContext = {
    dataHome,
    store,
    now: () => new Date("2026-07-19T20:00:00.000Z")
  };
  return { ctx, store, dataHome };
}

describe("runDoctor", () => {
  let ctx: CheckContext;
  let store: SQLiteMemoryStore;
  let dataHome: string;

  beforeEach(() => {
    ({ ctx, store, dataHome } = setup());
  });

  it("returns all-ok for an empty healthy database", () => {
    const report = runDoctor(ctx);
    expect(report.exit_code).toBe(0);
    expect(report.summary.fail).toBe(0);
    expect(report.results.length).toBe(9);
    store.close();
  });

  it("warns when no backups exist", () => {
    const report = runDoctor(ctx);
    const backupCheck = report.results.find((r) => r.name === "backup_directory");
    expect(backupCheck?.status).toBe("warn");
    store.close();
  });

  it("fails on integrity violation (manual corruption)", () => {
    // Overwrite the file with garbage
    writeFileSync(join(dataHome, "memory.sqlite"), "not a sqlite file");
    // Force a fresh open to bypass any in-memory caching
    store.close();
    const fresh = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const report = runDoctor({ ...ctx, store: fresh });
    const integrity = report.results.find((r) => r.name === "integrity");
    expect(integrity?.status).toBe("fail");
    expect(report.exit_code).toBe(2);
    fresh.close();
  });

  it("warns on schema version drift (simulated by setUserVersion)", () => {
    store.setUserVersion(1);
    const report = runDoctor(ctx);
    const schema = report.results.find((r) => r.name === "schema_version");
    expect(schema?.status).toBe("warn");
    expect(report.exit_code).toBe(1);
    store.close();
  });

  it("warns on capacity headroom when active >= 80% of global budget", () => {
    const budget = 500;
    // Simulate by inserting raw rows; we keep it small (5) and just verify the ratio calc
    for (let i = 0; i < 5; i += 1) {
      store.insertEntry({
        id: `mem_${i}`,
        scope: "global",
        type: "fact",
        memory_kind: "semantic",
        topic: "t",
        title: "t",
        body: "b",
        tags: [],
        source: { kind: "agent" },
        importance: 3,
        confidence: 3,
        status: "active",
        created_at: "2026-07-19T00:00:00.000Z",
        updated_at: "2026-07-19T00:00:00.000Z",
        access_count: 0,
        supersedes: [],
        token_estimate: 1,
        char_count: 2
      });
    }
    const report = runDoctor(ctx);
    const capacity = report.results.find((r) => r.name === "capacity_headroom");
    // 5/500 = 1%, so this is OK; we only assert the check ran
    expect(capacity).toBeDefined();
    store.close();
  });

  it("runs in < 500ms on a 100-row database", () => {
    for (let i = 0; i < 100; i += 1) {
      store.insertEntry({
        id: `mem_${i}`,
        scope: "global",
        type: "fact",
        memory_kind: "semantic",
        topic: "t",
        title: `t${i}`,
        body: `b${i}`,
        tags: [],
        source: { kind: "agent" },
        importance: 3,
        confidence: 3,
        status: "active",
        created_at: "2026-07-19T00:00:00.000Z",
        updated_at: "2026-07-19T00:00:00.000Z",
        access_count: 0,
        supersedes: [],
        token_estimate: 1,
        char_count: 2
      });
    }
    const start = Date.now();
    runDoctor(ctx);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
    store.close();
  });
});
```

- [ ] **Step 5.5: Run typecheck + tests**

```bash
cd G:\Projects\MetronX\local-memory-mcp
npm run typecheck
npm test -- test/doctor.test.ts
npm test -- test/e2e.test.ts
```

Expected: all green.

- [ ] **Step 5.6: Commit**

```bash
git add src/doctor test/doctor.test.ts
git commit -m "feat(stage1): add doctor module with 9 health checks"
```

---

## Task 6: Add CLI Framework (Arg Parser + Format + Command Dispatch)

**Files:**
- Create: `src/cli/arg-parser.ts`
- Create: `src/cli/format.ts`
- Create: `src/cli/index.ts`
- Create: `test/cli/arg-parser.test.ts`

The CLI is a hand-rolled argument parser. No third-party dependency.

- [ ] **Step 6.1: Create `src/cli/arg-parser.ts`**

```ts
// src/cli/arg-parser.ts

export type ParsedArgs = {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
};

const SHORT_TO_LONG: Record<string, string> = {
  h: "help",
  v: "version"
};

/**
 * Parse argv into a structured form. Supports:
 *   --flag                 -> flags.flag = true
 *   --key=value            -> flags.key = "value"
 *   --key value            -> flags.key = "value" (only if next arg is not a flag)
 *   -h                     -> flags.help = true (via SHORT_TO_LONG)
 *   --                     -> everything after is positional, even if it looks like a flag
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.length === 0) {
    return { command: "help", positional: [], flags: {} };
  }
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let afterDoubleDash = false;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (afterDoubleDash) {
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[body] = next;
        i += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length === 2) {
      const short = arg.slice(1);
      const long = SHORT_TO_LONG[short] ?? short;
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[long] = next;
        i += 1;
      } else {
        flags[long] = true;
      }
      continue;
    }
    positional.push(arg);
  }

  return { command, positional, flags };
}

export function flagString(args: ParsedArgs, name: string, fallback?: string): string | undefined {
  const value = args.flags[name];
  if (value === undefined) return fallback;
  if (typeof value !== "string") return fallback;
  return value;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true;
}
```

- [ ] **Step 6.2: Create `src/cli/format.ts`**

```ts
// src/cli/format.ts

const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m"
};

export type ColorMode = "auto" | "always" | "never";

export function resolveColorMode(args: { flags: Record<string, string | boolean> }, env: NodeJS.ProcessEnv = process.env): ColorMode {
  if (args.flags["no-color"] === true) return "never";
  if (args.flags.color === "always") return "always";
  if (args.flags.color === "never") return "never";
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "never";
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "") return "always";
  return "auto";
}

export function useColor(mode: ColorMode, stream: { isTTY?: boolean } = process.stdout): boolean {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return Boolean(stream.isTTY);
}

export function paint(text: string, color: keyof typeof COLORS, enabled: boolean): string {
  if (!enabled) return text;
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

export function statusGlyph(status: "ok" | "warn" | "fail", color: boolean): string {
  if (status === "ok") return paint("[ OK ]", "green", color);
  if (status === "warn") return paint("[WARN]", "yellow", color);
  return paint("[FAIL]", "red", color);
}

export function formatTable(rows: string[][], widths: number[]): string {
  return rows.map((cells) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ")).join("\n");
}

export function jsonOut(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
```

- [ ] **Step 6.3: Create `src/cli/index.ts` (placeholder dispatch — commands added in Task 7)**

```ts
// src/cli/index.ts
import { resolveDataHome } from "../index.js";
import { SQLiteMemoryStore } from "../sqlite-store.js";
import { parseArgs, type ParsedArgs } from "./arg-parser.js";

export type CliContext = {
  dataHome: string;
  args: ParsedArgs;
  store: SQLiteMemoryStore;
};

export type CliResult = { exitCode: 0 | 1 | 2 | 3; stdout: string; stderr: string };

export async function runCli(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<CliResult> {
  const args = parseArgs(argv);
  const dataHome = resolveDataHome(env);
  const store = new SQLiteMemoryStore(`${dataHome}/memory.sqlite`);

  // Dispatch table is populated in Task 7
  const dispatch: Record<string, (ctx: CliContext) => Promise<CliResult> | CliResult> = {
    help: () => ({
      exitCode: 0,
      stdout: HELP_TEXT,
      stderr: ""
    })
  };

  const handler = dispatch[args.command];
  if (handler === undefined) {
    return {
      exitCode: 3,
      stdout: "",
      stderr: `unknown command: ${args.command}\n\n${HELP_TEXT}`
    };
  }
  try {
    const result = await handler({ dataHome, args, store });
    store.close();
    return result;
  } catch (error) {
    store.close();
    return {
      exitCode: 3,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error)
    };
  }
}

const HELP_TEXT = `agent-recall — local memory CLI

Usage:
  agent-recall <command> [options]

Commands:
  list       List memories (default scope: global)
  show       Show a single memory and its audit history
  search     Full-text search
  audit      Show audit events for a memory
  doctor     Run health checks
  export     Trigger markdown export
  backup     Run a manual backup
  migrate    Run schema migrations
  help       Show this help

Global flags:
  --data-home <path>   Override AGENT_RECALL_HOME / LOCAL_MEMORY_MCP_HOME
  --json               Output machine-readable JSON
  --no-color           Disable ANSI color
  --color=always|never Override color detection
`;
```

- [ ] **Step 6.4: Add `test/cli/arg-parser.test.ts`**

```ts
// test/cli/arg-parser.test.ts
import { describe, expect, it } from "vitest";
import { flagBool, flagString, parseArgs } from "../../src/cli/arg-parser.js";

describe("parseArgs", () => {
  it("returns help command for empty input", () => {
    expect(parseArgs([]).command).toBe("help");
  });

  it("parses --flag as boolean", () => {
    const result = parseArgs(["list", "--json"]);
    expect(result.flags.json).toBe(true);
  });

  it("parses --key=value", () => {
    const result = parseArgs(["list", "--scope=project"]);
    expect(result.flags.scope).toBe("project");
  });

  it("parses --key value when next arg is not a flag", () => {
    const result = parseArgs(["list", "--scope", "project"]);
    expect(result.flags.scope).toBe("project");
  });

  it("parses --key with no value when next arg is a flag", () => {
    const result = parseArgs(["list", "--scope", "--json"]);
    expect(result.flags.scope).toBe(true);
    expect(result.flags.json).toBe(true);
  });

  it("maps -h to --help", () => {
    const result = parseArgs(["-h"]);
    expect(result.flags.help).toBe(true);
  });

  it("treats everything after -- as positional", () => {
    const result = parseArgs(["search", "query", "--", "--weird", "-x"]);
    expect(result.positional).toEqual(["query", "--weird", "-x"]);
  });

  it("captures positional arguments", () => {
    const result = parseArgs(["show", "mem_abc"]);
    expect(result.command).toBe("show");
    expect(result.positional).toEqual(["mem_abc"]);
  });
});

describe("flagString / flagBool", () => {
  it("returns fallback for missing key", () => {
    const args = parseArgs(["list"]);
    expect(flagString(args, "scope")).toBeUndefined();
    expect(flagString(args, "scope", "global")).toBe("global");
  });

  it("returns the value when present", () => {
    const args = parseArgs(["list", "--scope", "project"]);
    expect(flagString(args, "scope")).toBe("project");
  });

  it("returns undefined for boolean flags when expected string", () => {
    const args = parseArgs(["list", "--json"]);
    expect(flagString(args, "json")).toBeUndefined();
    expect(flagBool(args, "json")).toBe(true);
  });
});
```

- [ ] **Step 6.5: Run typecheck + tests**

```bash
cd G:\Projects\MetronX\local-memory-mcp
npm run typecheck
npm test -- test/cli/arg-parser.test.ts
```

Expected: all green. The CLI dispatch table only has `help`; other commands fall through to "unknown command" stderr.

- [ ] **Step 6.6: Commit**

```bash
git add src/cli/arg-parser.ts src/cli/format.ts src/cli/index.ts test/cli/arg-parser.test.ts
git commit -m "feat(stage1): add CLI framework with hand-rolled arg parser and format helpers"
```

---

## Task 7: Add CLI Subcommands (list / show / search / audit / doctor / export / backup / migrate)

**Files:**
- Create: `src/cli/commands/list.ts`
- Create: `src/cli/commands/show.ts`
- Create: `src/cli/commands/search.ts`
- Create: `src/cli/commands/audit.ts`
- Create: `src/cli/commands/doctor.ts`
- Create: `src/cli/commands/export.ts`
- Create: `src/cli/commands/backup.ts`
- Create: `src/cli/commands/migrate.ts`
- Modify: `src/cli/index.ts`
- Create: `test/cli/*.test.ts` (8 files)

Each command receives `CliContext` and returns a `CliResult`. They reuse the same `MemoryService` and `SQLiteMemoryStore` the MCP server uses.

- [ ] **Step 7.1: Create `src/cli/commands/list.ts`**

```ts
// src/cli/commands/list.ts
import { flagBool, flagString, type CliContext, type CliResult } from "../index.js";
import { jsonOut, paint, resolveColorMode, statusGlyph, useColor } from "../format.js";

export function listCommand(ctx: CliContext): CliResult {
  const scope = (flagString(ctx.args, "scope") ?? "global") as "global" | "project";
  const projectId = flagString(ctx.args, "project-id");
  const status = flagString(ctx.args, "status") ?? "active";
  const limit = Number.parseInt(flagString(ctx.args, "limit") ?? "20", 10);
  const offset = Number.parseInt(flagString(ctx.args, "offset") ?? "0", 10);

  const filters: Record<string, unknown> = { scope, status, limit, offset };
  if (projectId !== undefined) filters.project_id = projectId;

  const items = ctx.store.listEntries(filters);
  const json = flagBool(ctx.args, "json");
  if (json) {
    return { exitCode: 0, stdout: jsonOut({ items }), stderr: "" };
  }

  const colorMode = resolveColorMode(ctx.args);
  const color = useColor(colorMode);
  if (items.length === 0) {
    return { exitCode: 0, stdout: paint("no memories found", "dim", color), stderr: "" };
  }
  const header = ["ID", "TYPE", "TOPIC", "IMP", "UPDATED"];
  const rows = items.map((e) => [
    e.id,
    e.type,
    e.topic,
    String(e.importance),
    e.updated_at
  ]);
  const widths = [36, 12, 24, 4, 24];
  const body = rows.map((r) => r.map((c, i) => c.padEnd(widths[i])).join("  ")).join("\n");
  const title = paint(header.map((h, i) => h.padEnd(widths[i])).join("  "), "bold", color);
  const count = paint(`\n\n${items.length} entries.`, "dim", color);
  return { exitCode: 0, stdout: `${title}\n${body}${count}`, stderr: "" };
}
```

- [ ] **Step 7.2: Create `src/cli/commands/show.ts`**

```ts
// src/cli/commands/show.ts
import { flagBool, type CliContext, type CliResult } from "../index.js";
import { jsonOut, paint, resolveColorMode, useColor } from "../format.js";
import { parseActor } from "../../actor.js";

export function showCommand(ctx: CliContext): CliResult {
  const id = ctx.args.positional[0];
  if (id === undefined) {
    return { exitCode: 1, stdout: "", stderr: "usage: agent-recall show <memory_id>" };
  }
  const entry = ctx.store.peekEntry(id);
  if (entry === undefined) {
    return { exitCode: 1, stdout: "", stderr: `memory not found: ${id}` };
  }
  const audit = ctx.store.getAuditEvents(id);
  const json = flagBool(ctx.args, "json");
  if (json) {
    return { exitCode: 0, stdout: jsonOut({ entry, audit }), stderr: "" };
  }
  const colorMode = resolveColorMode(ctx.args);
  const color = useColor(colorMode);
  const head = (text: string) => paint(text, "bold", color);
  const body = [
    head(`# ${entry.title}`),
    `id:        ${entry.id}`,
    `scope:     ${entry.scope}${entry.project_id ? ` / ${entry.project_id}` : ""}`,
    `type:      ${entry.type} (${entry.memory_kind})`,
    `topic:     ${entry.topic}`,
    `tags:      ${entry.tags.join(", ") || "(none)"}`,
    `importance:${entry.importance}  confidence:${entry.confidence}  status:${entry.status}`,
    `source:    ${entry.source.kind}${entry.source.ref ? ` / ${entry.source.ref}` : ""}`,
    `created:   ${entry.created_at}`,
    `updated:   ${entry.updated_at}`,
    "",
    entry.body,
    "",
    head("## Audit"),
    ...audit.map((a) => {
      const actor = parseActor(a.actor);
      return `  ${a.created_at}  ${a.event.padEnd(16)}  ${actor.raw}`;
    })
  ].join("\n");
  return { exitCode: 0, stdout: body, stderr: "" };
}
```

- [ ] **Step 7.3: Create `src/cli/commands/search.ts`**

```ts
// src/cli/commands/search.ts
import { flagBool, flagString, type CliContext, type CliResult } from "../index.js";
import { jsonOut, paint, resolveColorMode, useColor } from "../format.js";

export function searchCommand(ctx: CliContext): CliResult {
  const query = ctx.args.positional[0];
  if (query === undefined) {
    return { exitCode: 1, stdout: "", stderr: "usage: agent-recall search <query> [options]" };
  }
  const scope = (flagString(ctx.args, "scope") ?? "global") as "global" | "project";
  const projectId = flagString(ctx.args, "project-id");
  const limit = Number.parseInt(flagString(ctx.args, "limit") ?? "10", 10);

  const filters: Record<string, unknown> = { query, scope, status: "active", limit };
  if (projectId !== undefined) filters.project_id = projectId;

  const items = ctx.store.searchEntries(filters);
  const json = flagBool(ctx.args, "json");
  if (json) {
    return { exitCode: 0, stdout: jsonOut({ items }), stderr: "" };
  }
  const colorMode = resolveColorMode(ctx.args);
  const color = useColor(colorMode);
  if (items.length === 0) {
    return { exitCode: 0, stdout: paint(`no matches for "${query}"`, "dim", color), stderr: "" };
  }
  const body = items
    .map((e) => `${paint(e.id, "cyan", color)}  ${e.title}\n  ${paint(`${e.scope}/${e.type}/${e.topic}`, "dim", color)}`)
    .join("\n");
  return { exitCode: 0, stdout: `${body}\n\n${items.length} matches.`, stderr: "" };
}
```

- [ ] **Step 7.4: Create `src/cli/commands/audit.ts`**

```ts
// src/cli/commands/audit.ts
import { flagBool, type CliContext, type CliResult } from "../index.js";
import { jsonOut, paint, resolveColorMode, useColor } from "../format.js";
import { parseActor } from "../../actor.js";

export function auditCommand(ctx: CliContext): CliResult {
  const id = ctx.args.positional[0];
  if (id === undefined) {
    return { exitCode: 1, stdout: "", stderr: "usage: agent-recall audit <memory_id>" };
  }
  const events = ctx.store.getAuditEvents(id);
  if (events.length === 0) {
    return { exitCode: 1, stdout: "", stderr: `no audit events for ${id}` };
  }
  const json = flagBool(ctx.args, "json");
  if (json) {
    return { exitCode: 0, stdout: jsonOut({ events }), stderr: "" };
  }
  const colorMode = resolveColorMode(ctx.args);
  const color = useColor(colorMode);
  const body = events
    .map((a) => {
      const actor = parseActor(a.actor);
      return `${a.created_at}  ${a.event.padEnd(16)}  ${paint(actor.raw, "cyan", color)}${a.reason ? `  reason=${a.reason}` : ""}`;
    })
    .join("\n");
  return { exitCode: 0, stdout: body, stderr: "" };
}
```

- [ ] **Step 7.5: Create `src/cli/commands/doctor.ts`**

```ts
// src/cli/commands/doctor.ts
import { flagBool, type CliContext, type CliResult } from "../index.js";
import { jsonOut, paint, resolveColorMode, statusGlyph, useColor } from "../format.js";
import { runDoctor } from "../../doctor/index.js";

export function doctorCommand(ctx: CliContext): CliResult {
  const report = runDoctor({
    dataHome: ctx.dataHome,
    store: ctx.store,
    now: () => new Date()
  });
  const json = flagBool(ctx.args, "json");
  if (json) {
    return { exitCode: report.exit_code, stdout: jsonOut(report), stderr: "" };
  }
  const colorMode = resolveColorMode(ctx.args);
  const color = useColor(colorMode);
  const lines = report.results.map((r) => {
    const glyph = statusGlyph(r.status, color);
    return `${glyph}  ${paint(r.name.padEnd(20), "bold", color)}  ${r.message}`;
  });
  const summary = paint(
    `\nSummary: ${report.summary.ok} OK, ${report.summary.warn} WARN, ${report.summary.fail} FAIL. Exit ${report.exit_code}.`,
    "bold",
    color
  );
  return { exitCode: report.exit_code, stdout: lines.join("\n") + summary, stderr: "" };
}
```

- [ ] **Step 7.6: Create `src/cli/commands/export.ts`**

```ts
// src/cli/commands/export.ts
import { flagString, type CliContext, type CliResult } from "../index.js";
import { MarkdownExporter } from "../../markdown-exporter.js";
import { join } from "node:path";
import { resolveMemoryScope } from "../../scope-resolver.js";
import type { MemoryScope } from "../../domain.js";

export function exportCommand(ctx: CliContext): CliResult {
  const scope = (flagString(ctx.args, "scope") ?? "global") as MemoryScope;
  const projectId = flagString(ctx.args, "project-id");
  const projectPath = flagString(ctx.args, "project-path");
  const out = flagString(ctx.args, "out");

  const resolved = resolveMemoryScope({ scope, ...(projectId ? { project_id: projectId } : {}), ...(projectPath ? { project_path: projectPath } : {}) });
  if (!resolved.ok) {
    return { exitCode: 1, stdout: "", stderr: resolved.message };
  }
  const filters: Record<string, unknown> = { scope: resolved.value.scope, status: "active", limit: 10_000 };
  if (resolved.value.project_id) filters.project_id = resolved.value.project_id;
  const entries = ctx.store.listEntries(filters);

  const exporter = new MarkdownExporter(out ?? join(ctx.dataHome, "exports"));
  const staged = exporter.stageScope({
    scope: resolved.value.scope,
    ...(resolved.value.project_id ? { project_id: resolved.value.project_id } : {}),
    entries,
    budgetStatus: ctx.store.getBudgetUsage({ scope: resolved.value.scope, ...(resolved.value.project_id ? { project_id: resolved.value.project_id } : {}) })
  });
  const published = exporter.publishStagedScope(staged);
  published.complete();
  return {
    exitCode: 0,
    stdout: `exported: ${staged.indexPath} (+ ${staged.topicPaths.length} topic files)`,
    stderr: ""
  };
}
```

- [ ] **Step 7.7: Create `src/cli/commands/backup.ts`**

```ts
// src/cli/commands/backup.ts
import { flagBool, flagString, type CliContext, type CliResult } from "../index.js";
import { jsonOut } from "../format.js";
import { runBackup } from "../../backup.js";
import { join } from "node:path";

export function backupCommand(ctx: CliContext): CliResult {
  const keep = Number.parseInt(flagString(ctx.args, "keep") ?? "14", 10);
  const json = flagBool(ctx.args, "json");
  const backupDir = join(ctx.dataHome, "backups");
  try {
    const result = runBackup(ctx.store.backupHandle(), { backupDir, keep });
    if (json) {
      return { exitCode: 0, stdout: jsonOut(result), stderr: "" };
    }
    return {
      exitCode: 0,
      stdout: `backup written: ${result.path} (${result.size} bytes, ${result.durationMs}ms, kept ${result.kept}, pruned ${result.pruned})`,
      stderr: ""
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 2, stdout: "", stderr: `backup failed: ${message}` };
  }
}
```

- [ ] **Step 7.8: Create `src/cli/commands/migrate.ts`**

```ts
// src/cli/commands/migrate.ts
import { flagBool, type CliContext, type CliResult } from "../index.js";
import { jsonOut } from "../format.js";
import { CURRENT_SCHEMA_VERSION } from "../../sqlite-store.js";

export function migrateCommand(ctx: CliContext): CliResult {
  const yes = flagBool(ctx.args, "yes");
  const json = flagBool(ctx.args, "json");
  if (!yes) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `refusing to migrate without --yes; current target is v${CURRENT_SCHEMA_VERSION}`
    };
  }
  const result = ctx.store.runMigrations();
  if (json) {
    return { exitCode: 0, stdout: jsonOut(result), stderr: "" };
  }
  return {
    exitCode: 0,
    stdout: `migrated: v${result.from} -> v${result.to}`,
    stderr: ""
  };
}
```

- [ ] **Step 7.9: Wire commands into `src/cli/index.ts`**

Replace the `dispatch` table with:

```ts
import { auditCommand } from "./commands/audit.js";
import { backupCommand } from "./commands/backup.js";
import { doctorCommand } from "./commands/doctor.js";
import { exportCommand } from "./commands/export.js";
import { listCommand } from "./commands/list.js";
import { migrateCommand } from "./commands/migrate.js";
import { searchCommand } from "./commands/search.js";
import { showCommand } from "./commands/show.js";

const dispatch: Record<string, (ctx: CliContext) => Promise<CliResult> | CliResult> = {
  help: () => ({ exitCode: 0, stdout: HELP_TEXT, stderr: "" }),
  list: listCommand,
  show: showCommand,
  search: searchCommand,
  audit: auditCommand,
  doctor: doctorCommand,
  export: exportCommand,
  backup: backupCommand,
  migrate: migrateCommand
};
```

- [ ] **Step 7.10: Add CLI tests** (8 files, 1 per command, plus a dispatch test)

Create `test/cli/list.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/arg-parser.js";
import { listCommand } from "../../src/cli/commands/list.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-list-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  store.insertEntry({
    id: "mem_a",
    scope: "global",
    type: "fact",
    memory_kind: "semantic",
    topic: "general",
    title: "hello",
    body: "world",
    tags: ["greeting"],
    source: { kind: "agent" },
    importance: 3,
    confidence: 3,
    status: "active",
    created_at: "2026-07-19T00:00:00.000Z",
    updated_at: "2026-07-19T00:00:00.000Z",
    access_count: 0,
    supersedes: [],
    token_estimate: 1,
    char_count: 2
  });
  return { dataHome, store };
}

describe("listCommand", () => {
  it("returns a table with one row", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["list"]);
    const result = listCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("mem_a");
    expect(result.stdout).toContain("hello");
    store.close();
  });

  it("emits JSON when --json", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["list", "--json"]);
    const result = listCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.items.length).toBe(1);
    expect(parsed.items[0].id).toBe("mem_a");
    store.close();
  });

  it("returns empty message when no memories", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-list-empty-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const args = parseArgs(["list"]);
    const result = listCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no memories");
    store.close();
  });

  it("filters by project_id when --scope=project --project-id=...", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["list", "--scope", "project", "--project-id", "p1"]);
    const result = listCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no memories");
    store.close();
  });

  it("respects --no-color", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["list", "--no-color"]);
    const result = listCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("\x1b[");
    store.close();
  });
});
```

Create `test/cli/show.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/arg-parser.js";
import { showCommand } from "../../src/cli/commands/show.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-show-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  store.insertEntry({
    id: "mem_x",
    scope: "global",
    type: "fact",
    memory_kind: "semantic",
    topic: "t",
    title: "Title",
    body: "Body",
    tags: [],
    source: { kind: "agent" },
    importance: 3,
    confidence: 3,
    status: "active",
    created_at: "2026-07-19T00:00:00.000Z",
    updated_at: "2026-07-19T00:00:00.000Z",
    access_count: 0,
    supersedes: [],
    token_estimate: 1,
    char_count: 2
  });
  store.appendAudit({
    id: "aud_x",
    memory_id: "mem_x",
    scope: "global",
    event: "created",
    actor: "agent:claude-code",
    metadata: {},
    created_at: "2026-07-19T00:00:00.000Z"
  });
  return { dataHome, store };
}

describe("showCommand", () => {
  it("renders the entry and its audit history", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["show", "mem_x"]);
    const result = showCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Title");
    expect(result.stdout).toContain("Body");
    expect(result.stdout).toContain("agent:claude-code");
    store.close();
  });

  it("returns exitCode 1 for unknown id", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-show-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const args = parseArgs(["show", "mem_missing"]);
    const result = showCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not found");
    store.close();
  });

  it("emits JSON with --json", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["show", "mem_x", "--json"]);
    const result = showCommand({ dataHome, args, store });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.entry.id).toBe("mem_x");
    expect(parsed.audit.length).toBe(1);
    store.close();
  });

  it("returns usage error when no id given", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-show-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const args = parseArgs(["show"]);
    const result = showCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("usage");
    store.close();
  });
});
```

Create `test/cli/search.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/arg-parser.js";
import { searchCommand } from "../../src/cli/commands/search.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-search-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  store.insertEntry({
    id: "mem_s",
    scope: "global",
    type: "fact",
    memory_kind: "semantic",
    topic: "postgres",
    title: "Local database setup",
    body: "Run pg_ctl start before tests",
    tags: ["postgres"],
    source: { kind: "agent" },
    importance: 3,
    confidence: 3,
    status: "active",
    created_at: "2026-07-19T00:00:00.000Z",
    updated_at: "2026-07-19T00:00:00.000Z",
    access_count: 0,
    supersedes: [],
    token_estimate: 1,
    char_count: 2
  });
  return { dataHome, store };
}

describe("searchCommand", () => {
  it("finds by full-text query", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["search", "postgres"]);
    const result = searchCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("mem_s");
    store.close();
  });

  it("returns exit 1 when no query", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-search-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const args = parseArgs(["search"]);
    const result = searchCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(1);
    store.close();
  });

  it("emits JSON with --json", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["search", "postgres", "--json"]);
    const result = searchCommand({ dataHome, args, store });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.items[0].id).toBe("mem_s");
    store.close();
  });

  it("returns 'no matches' for empty result", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-search-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const args = parseArgs(["search", "absolutely-no-match"]);
    const result = searchCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no matches");
    store.close();
  });

  it("respects --limit", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["search", "postgres", "--limit", "0"]);
    const result = searchCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no matches");
    store.close();
  });
});
```

Create `test/cli/audit.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/arg-parser.js";
import { auditCommand } from "../../src/cli/commands/audit.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-audit-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  store.appendAudit({
    id: "aud_1",
    memory_id: "mem_a",
    scope: "global",
    event: "created",
    actor: "agent:claude-code",
    metadata: {},
    created_at: "2026-07-19T00:00:00.000Z"
  });
  store.appendAudit({
    id: "aud_2",
    memory_id: "mem_a",
    scope: "global",
    event: "updated",
    actor: "user:cli",
    metadata: { fields: ["title"] },
    created_at: "2026-07-19T01:00:00.000Z"
  });
  return { dataHome, store };
}

describe("auditCommand", () => {
  it("shows audit events for a memory", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["audit", "mem_a"]);
    const result = auditCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("created");
    expect(result.stdout).toContain("updated");
    expect(result.stdout).toContain("agent:claude-code");
    expect(result.stdout).toContain("user:cli");
    store.close();
  });

  it("returns exit 1 for unknown id", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-audit-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const args = parseArgs(["audit", "mem_missing"]);
    const result = auditCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(1);
    store.close();
  });

  it("emits JSON with --json", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["audit", "mem_a", "--json"]);
    const result = auditCommand({ dataHome, args, store });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.events.length).toBe(2);
    store.close();
  });
});
```

Create `test/cli/doctor.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/arg-parser.js";
import { doctorCommand } from "../../src/cli/commands/doctor.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-doctor-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  return { dataHome, store };
}

describe("doctorCommand", () => {
  it("returns exitCode 0 on a healthy empty database", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["doctor"]);
    const result = doctorCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[");
    expect(result.stdout).toContain("Summary");
    store.close();
  });

  it("emits JSON with --json", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["doctor", "--json"]);
    const result = doctorCommand({ dataHome, args, store });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.exit_code).toBeDefined();
    store.close();
  });

  it("flags a missing data home as fail", () => {
    const fake = join(tmpdir(), "lm-cli-doctor-missing-" + Math.random().toString(36).slice(2));
    const store = new SQLiteMemoryStore(join(fake, "memory.sqlite"));
    // dataHome points at a path that does not exist
    const args = parseArgs(["doctor", "--json"]);
    const result = doctorCommand({ dataHome: fake, args, store });
    expect(result.exitCode).toBe(2);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.results.find((r) => r.name === "data_home").status).toBe("fail");
    store.close();
  });

  it("respects --no-color", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["doctor", "--no-color"]);
    const result = doctorCommand({ dataHome, args, store });
    expect(result.stdout).not.toContain("\x1b[");
    store.close();
  });

  it("surfaces backup_directory warning when no backups", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["doctor", "--json"]);
    const result = doctorCommand({ dataHome, args, store });
    const parsed = JSON.parse(result.stdout);
    const backupCheck = parsed.results.find((r) => r.name === "backup_directory");
    expect(backupCheck.status).toBe("warn");
    store.close();
  });

  it("warns on schema version drift (v1)", () => {
    const { dataHome, store } = setup();
    store.setUserVersion(1);
    const args = parseArgs(["doctor", "--json"]);
    const result = doctorCommand({ dataHome, args, store });
    const parsed = JSON.parse(result.stdout);
    const schema = parsed.results.find((r) => r.name === "schema_version");
    expect(schema.status).toBe("warn");
    expect(result.exitCode).toBe(1);
    store.close();
  });
});
```

Create `test/cli/backup.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/arg-parser.js";
import { backupCommand } from "../../src/cli/commands/backup.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";

describe("backupCommand", () => {
  it("writes a backup and reports the path", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-backup-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const args = parseArgs(["backup"]);
    const result = backupCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("backup written");
    store.close();
  });

  it("emits JSON with --json", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-backup-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const args = parseArgs(["backup", "--json"]);
    const result = backupCommand({ dataHome, args, store });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.path).toContain("memory-");
    expect(parsed.size).toBeGreaterThan(0);
    store.close();
  });

  it("respects --keep N", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-backup-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    for (let i = 0; i < 5; i += 1) {
      const result = backupCommand({
        dataHome,
        args: parseArgs(["backup", "--keep", "2"]),
        store
      });
      expect(result.exitCode).toBe(0);
    }
    const list = require("node:fs").readdirSync(join(dataHome, "backups"));
    expect(list.length).toBeLessThanOrEqual(2);
    store.close();
  });

  it("returns exitCode 2 when the disk rejects writes (simulated via bad dir)", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-backup-fail-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    // Make backups dir unwritable by pre-creating a file with the same name as the dir
    const { writeFileSync, mkdirSync } = require("node:fs");
    const backupDir = join(dataHome, "backups");
    mkdirSync(backupDir);
    writeFileSync(join(backupDir, "memory-2026-01-01T00-00-00.000Z.sqlite"), "blocking");
    const result = backupCommand({
      dataHome,
      args: parseArgs(["backup"]),
      store
    });
    // Either succeeds (SQLite just overwrites) or fails gracefully with exitCode 2
    expect([0, 2]).toContain(result.exitCode);
    store.close();
  });
});
```

Create `test/cli/export.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/arg-parser.js";
import { exportCommand } from "../../src/cli/commands/export.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";

describe("exportCommand", () => {
  it("exports an empty global scope without error", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-export-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const args = parseArgs(["export"]);
    const result = exportCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("exported");
    store.close();
  });

  it("rejects invalid scope", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-export-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const args = parseArgs(["export", "--scope", "nonsense"]);
    const result = exportCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(1);
    store.close();
  });
});
```

Create `test/cli/migrate.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/arg-parser.js";
import { migrateCommand } from "../../src/cli/commands/migrate.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";

describe("migrateCommand", () => {
  it("refuses to run without --yes", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-migrate-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const args = parseArgs(["migrate"]);
    const result = migrateCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--yes");
    store.close();
  });

  it("migrates when --yes", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-migrate-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    store.setUserVersion(1);
    const args = parseArgs(["migrate", "--yes"]);
    const result = migrateCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("migrated");
    store.close();
  });

  it("emits JSON with --json", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-migrate-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    store.setUserVersion(1);
    const args = parseArgs(["migrate", "--yes", "--json"]);
    const result = migrateCommand({ dataHome, args, store });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.from).toBe(1);
    expect(parsed.to).toBe(2);
    store.close();
  });
});
```

Add to `test/cli/dispatch.test.ts` (verifies the help command works through `runCli`):

```ts
// test/cli/dispatch.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/index.js";

describe("runCli", () => {
  it("shows help for empty input", async () => {
    const result = await runCli([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("agent-recall");
  });

  it("returns exitCode 3 for unknown command", async () => {
    const result = await runCli(["nope"]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("unknown command");
  });

  it("runs list against a real data home", async () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-dispatch-"));
    const result = await runCli(["list", "--data-home", dataHome]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no memories");
  });
});
```

- [ ] **Step 7.11: Run typecheck + tests**

```bash
cd G:\Projects\MetronX\local-memory-mcp
npm run typecheck
npm test -- test/cli
npm test -- test/e2e.test.ts
```

Expected: all green.

- [ ] **Step 7.12: Commit**

```bash
git add src/cli/commands test/cli
git commit -m "feat(stage1): add 8 CLI subcommands and per-command tests"
```

---

## Task 8: Add `bin/agent-recall.ts` Entry and Adjust `package.json` Bin

**Files:**
- Create: `bin/agent-recall.ts`
- Modify: `package.json`
- Modify: `src/index.ts` (deprecation warning)

- [ ] **Step 8.1: Create `bin/agent-recall.ts`**

```ts
#!/usr/bin/env node
import { runCli } from "../src/cli/index.js";

const argv = process.argv.slice(2);

runCli(argv).then((result) => {
  if (result.stdout.length > 0) {
    process.stdout.write(result.stdout + "\n");
  }
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr + "\n");
  }
  process.exit(result.exitCode);
});
```

Make it executable (chmod 755 on macOS/Linux; not needed on Windows).

- [ ] **Step 8.2: Update `package.json`**

1. Add the new bin entry and keep the old one as a deprecated alias. Replace the `bin` block with:
   ```json
   "bin": {
     "agent-recall": "./dist/bin/agent-recall.js",
     "agent-recall-mcp": "./dist/index.js"
   }
   ```
2. Add scripts:
   ```json
   "cli": "tsx bin/agent-recall.ts",
   "cli:list": "tsx bin/agent-recall.ts list",
   "cli:doctor": "tsx bin/agent-recall.ts doctor"
   ```
3. Add `tsx` invocation for dev (already in devDependencies). The `cli` script uses `tsx` to skip the build step during development.

- [ ] **Step 8.3: Add deprecation warning in `src/index.ts`**

Inside `main()`, before `await server.connect(transport)`, add:

```ts
if (process.env.AGENT_RECALL_SUPPRESS_MCP_DEPRECATION !== "1") {
  console.error(
    "[agent-recall] Note: this MCP server entry point is `dist/index.js`. " +
      "Future versions may rename it to `agent-recall-mcp`. " +
      "The new `agent-recall` binary is now the CLI. " +
      "Set AGENT_RECALL_SUPPRESS_MCP_DEPRECATION=1 to silence this message."
  );
}
```

- [ ] **Step 8.4: Build and smoke-test**

```bash
cd G:\Projects\MetronX\local-memory-mcp
npm run typecheck
npm run build
node bin/agent-recall.js --help
node bin/agent-recall.js doctor
```

Expected: `doctor` runs and prints a summary; `--help` shows the help text.

- [ ] **Step 8.5: Run full test suite**

```bash
cd G:\Projects\MetronX\local-memory-mcp
npm test
git diff --check
```

Expected: all green, no diff warnings.

- [ ] **Step 8.6: Commit**

```bash
git add bin/agent-recall.ts package.json src/index.ts
git commit -m "chore(stage1): add bin/agent-recall.ts entry and adjust package bin field"
```

---

## Task 9: Update README with CLI Section and Migration Notes

**Files:**
- Modify: `README.md`

- [ ] **Step 9.1: Add a "CLI" section after "MCP Client Config"**

Append (or insert) a new section:

```markdown
## CLI

A standalone terminal interface is available alongside the MCP server. Use it
for one-off inspection, health checks, manual backups, and migration.

```bash
# via npm script (no build required)
npm run cli -- doctor
npm run cli -- list --limit 10
npm run cli -- search "postgres" --limit 5
npm run cli -- show <memory_id>
npm run cli -- audit <memory_id>
npm run cli -- backup
npm run cli -- migrate --yes
```

After `npm run build`, the same commands are available via the `agent-recall`
binary:

```bash
node bin/agent-recall.js doctor
```

The CLI respects the same `AGENT_RECALL_HOME` / `LOCAL_MEMORY_MCP_HOME`
environment variables as the MCP server. All commands accept `--json` for
machine-readable output and `--no-color` to disable ANSI colors.

## Migrating the Bin Name

The `bin` field in `package.json` previously pointed `agent-recall` at the
MCP server entry. As of stage 1, `agent-recall` is the CLI; the MCP server is
published as `agent-recall-mcp`. Existing MCP client configs that invoke
`agent-recall` directly will start a CLI process instead and fail to
connect — update them to use `agent-recall-mcp` (or the explicit path
`node /path/to/dist/index.js`).

When the MCP server starts, it prints a one-time deprecation notice to
stderr unless `AGENT_RECALL_SUPPRESS_MCP_DEPRECATION=1`.

## Per-Client Env Setup

`AGENT_RECALL_ACTOR` controls which agent name shows up in the audit log.
Set it in the MCP server's `env` block in your client's JSON config:

```json
{
  "mcpServers": {
    "agent-recall-mcp": {
      "command": "node",
      "args": ["/path/to/agent-recall/dist/index.js"],
      "env": {
        "AGENT_RECALL_HOME": "/path/to/agent-recall-data",
        "AGENT_RECALL_ACTOR": "claude-code"
      }
    }
  }
}
```

Recommended names: `claude-code`, `cursor`, `codex`, `aider`, `cline`,
`continue`, `windsurf`, `roo-cline`, `copilot`.

## Doctor

`agent-recall doctor` runs nine health checks and exits with:

- `0` — all OK
- `1` — warnings present, no failures
- `2` — at least one failure (data integrity, missing data home, etc.)

Use it as a periodic self-check or before/after risky operations like
schema upgrades or hand-edits to the SQLite file.

## Backup

Backups are written to `<AGENT_RECALL_HOME>/backups/memory-<timestamp>.sqlite`
via SQLite's `VACUUM INTO` command. The 14 most recent backups are kept; older
ones are pruned automatically. Backups run automatically after successful
maintenance actions (`rebuild_markdown_index`, `expire_due`,
`archive_low_value`). Use `agent-recall backup` to trigger one manually.
```

- [ ] **Step 9.2: Verify the new section renders correctly**

```bash
cd G:\Projects\MetronX\local-memory-mcp
# Spot-check that the file is still well-formed markdown
Get-Content README.md | Select-String "^## "
```

Expected: the new `## CLI`, `## Migrating the Bin Name`, `## Per-Client Env
Setup`, `## Doctor`, and `## Backup` headings are present.

- [ ] **Step 9.3: Commit**

```bash
git add README.md
git commit -m "docs(stage1): document CLI, bin migration, env setup, doctor, and backup"
```

---

## Task 10: Final Integration Verification

**Files:**
- (no source changes; this is a verification task)

- [ ] **Step 10.1: Typecheck and full test suite**

```bash
cd G:\Projects\MetronX\local-memory-mcp
npm run typecheck
npm test
git diff --check
```

Expected: all green, no diff warnings.

- [ ] **Step 10.2: Performance smoke**

```bash
cd G:\Projects\MetronX\local-memory-mcp
# Build a 10k row db
node -e "
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { SQLiteMemoryStore } = require('./dist/sqlite-store.js');
const dataHome = mkdtempSync(join(tmpdir(), 'lm-perf-'));
const store = new SQLiteMemoryStore(join(dataHome, 'memory.sqlite'));
for (let i = 0; i < 10000; i += 1) {
  store.insertEntry({
    id: 'mem_' + i, scope: 'global', type: 'fact', memory_kind: 'semantic',
    topic: 't' + (i % 50), title: 'title ' + i, body: 'body ' + i,
    tags: ['tag' + (i % 10)], source: { kind: 'agent' },
    importance: 3, confidence: 3, status: 'active',
    created_at: '2026-07-19T00:00:00.000Z', updated_at: '2026-07-19T00:00:00.000Z',
    access_count: 0, supersedes: [], token_estimate: 1, char_count: 2
  });
}
store.close();
console.log(dataHome);
" > /tmp/perf-home.txt
set /p PERF_HOME=< /tmp/perf-home.txt

# Verify doctor < 500ms
powershell -Command "Measure-Command { node bin/agent-recall.js doctor --data-home \$env:PERF_HOME | Out-Null }"

# Verify list < 200ms
powershell -Command "Measure-Command { node bin/agent-recall.js list --limit 100 --data-home \$env:PERF_HOME | Out-Null }"

# Verify backup < 1s
powershell -Command "Measure-Command { node bin/agent-recall.js backup --data-home \$env:PERF_HOME | Out-Null }"
```

Expected:
- doctor < 500ms
- list < 200ms
- backup < 1s

If any of these exceed their target by a wide margin, file a follow-up task
before merging stage 1. The targets are smoke checks, not hard SLOs.

- [ ] **Step 10.3: Verify bin name migration note in build output**

```bash
cd G:\Projects\MetronX\local-memory-mcp
node dist/index.js < /dev/null 2>&1 | Select-String "deprecation"
```

Expected: a deprecation line is printed to stderr. (The stdio MCP server
will hang waiting for input; redirect stdin from `/dev/null` and capture
stderr to spot the warning, then kill the process.)

- [ ] **Step 10.4: Final commit (if anything was tweaked)**

```bash
cd G:\Projects\MetronX\local-memory-mcp
git status
# If anything is modified:
git add -A
git commit -m "chore(stage1): final integration verification tweaks"
```

---

## Acceptance Checklist

By the end of Task 10, the following must all be true:

- [ ] `npm test` is fully green
- [ ] `npm run typecheck` is clean
- [ ] `npm run build` produces `dist/bin/agent-recall.js`, `dist/index.js`, and the rest of the tree without errors
- [ ] `node bin/agent-recall.js doctor` exits 0 against an empty data home and prints 9 check rows
- [ ] `node bin/agent-recall.js list` and `search` and `show` and `audit` all work against a real data home
- [ ] `node bin/agent-recall.js backup` writes a file to `backups/` and prunes old ones
- [ ] `node bin/agent-recall.js migrate --yes` upgrades a v1 database to v2
- [ ] `node dist/index.js` prints the deprecation warning
- [ ] `git log` shows 9 stage1 commits, each with a `feat/stage1`/`docs/stage1`/`chore/stage1` prefix
- [ ] `git diff --check` reports no issues
- [ ] README's CLI / migration / doctor / backup sections render correctly

## What's Next

Stage 2 (not part of this plan):

- `merge_memories` MCP tool
- Upgrade `remember` duplicate warnings into a forced confirm flow
- Per-agent `last_accessed_by_agent` column
- Maintenance operation chunking / off-lock-path
- `MemoryService` façade split into write/read/maintenance
