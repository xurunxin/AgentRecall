# AgentRecall

![CI](https://github.com/xurx/agent-recall/actions/workflows/ci.yml/badge.svg)

AgentRecall is a local-first MCP server for coding-agent memory. It gives MCP-compatible clients a governed tool surface for storing, searching, maintaining, and exporting global or project-scoped memories.

SQLite is the source of truth. Markdown files are deterministic exports for review and handoff, not the live database. The server runs over stdio and does not require a hosted database, embedding service, or network model call.

## Requirements

- Node.js 24 or newer
- npm
- An MCP-compatible client that can launch a stdio server

## Architecture

`MemoryService` is a 253-line façade over three sub-services in
`src/services/`:

- `MemoryReadService` — `getMemory`, `listMemories`, `searchMemories`,
  `getMemoryBudget`, `exportMemoryContext`.
- `MemoryWriteService` — `remember`, `updateMemory`, `supersedeMemory`,
  `mergeMemories`, `forgetMemory`, `configureProjectBudget`.
- `MemoryMaintenanceService` — `maintainMemories` (and the per-action
  implementations: `findDuplicates`, `mergeDuplicates`,
  `rebuildMarkdownIndex`, `expireDueMemories`, `archiveLowValueMemories`,
  `vacuumFts`).

Shared helpers (audit append, budget evaluation, actor lookup, env-var
reads, comparison functions) live in
`src/services/memory-service-helpers.ts`. The façade holds the
`SQLiteMemoryStore`, the optional `MarkdownExporter`, the default
actor, and the data home, and wires them into each sub-service via
shared `ReadContext` / `WriteContext` / `MaintenanceContext` shapes.
`backup()` lives on the façade for historical reasons (Stage 1).

The public API (`new MemoryService(store, exporter?, defaultActor?, dataHome?)`
plus every public method) is byte-for-byte the same as before Stage 9.
The split was driven purely by maintainability — the class had
accumulated 1670 lines across Stages 1-8 — with zero user-visible
behavior change.

## Setup

Install dependencies, build the TypeScript output, then run the built stdio server:

```bash
npm install
npm run build
npm start
```

For local development:

```bash
npm run dev
```

The package binary also points at `dist/index.js` after build:

```bash
node dist/index.js
```

## Data Directory

By default, runtime data lives under:

```text
~/.agent-recall/
```

Set `AGENT_RECALL_HOME` to use a different directory:

```bash
AGENT_RECALL_HOME=/path/to/agent-recall npm start
```

The legacy `LOCAL_MEMORY_MCP_HOME` variable is also honored when `AGENT_RECALL_HOME` is not set. The server trims empty values and falls back to `~/.agent-recall`. Home-relative values beginning with `~/` or `~\` are expanded against the current user's home directory. Other values are resolved to an absolute path. In JSON client configs on Windows, escape backslashes, for example `C:\\path\\to\\agent-recall-data`.

## MCP Client Config

Most MCP clients support a JSON server entry. Use the built file after `npm run build`:

```json
{
  "mcpServers": {
    "agent-recall-mcp": {
      "command": "node",
      "args": ["/path/to/agent-recall/dist/src/index.js"],
      "env": {
        "AGENT_RECALL_HOME": "/path/to/agent-recall-data",
        "AGENT_RECALL_ACTOR": "claude-code"
      }
    }
  }
}
```

> **Note:** As of stage 1, the `bin` field in `package.json` publishes the CLI as `agent-recall`. MCP server entry is exposed as `agent-recall-mcp` (or via the explicit path `node /path/to/agent-recall/dist/src/index.js`). Existing configs that invoke the bare `agent-recall` command will start a CLI process instead and fail to connect — update them to use `agent-recall-mcp` or the explicit path. The MCP server prints a one-time deprecation notice to stderr unless `AGENT_RECALL_SUPPRESS_MCP_DEPRECATION=1` is set.
>
> **Note:** As of v1.1.2, the packaged MCP default is the **Core** profile (10 read / write / plan tools). Set `AGENT_RECALL_PROFILE=extended` in the `env` block to opt in to the additional memory-semantics + administrative tools. The `admin` profile is opt-in via `AGENT_RECALL_PROFILE=admin` AND a valid operator capability (run `agent-recall admin grant` first); see [Configuration](#configuration) and [ADR-0001](docs/adr/0001-local-admin-capability-boundary.md) for the full contract. The active profile is surfaced on `memory://health` as `active_profile`.

If your client supports `cwd`, you can launch through npm:

```json
{
  "mcpServers": {
    "agent-recall-mcp": {
      "command": "npm",
      "args": ["start"],
      "cwd": "/path/to/agent-recall",
      "env": {
        "AGENT_RECALL_HOME": "/path/to/agent-recall-data",
        "AGENT_RECALL_ACTOR": "claude-code"
      }
    }
  }
}
```

## CLI

A standalone terminal interface is available alongside the MCP server. Use it
for one-off inspection, health checks, manual backups, and schema migration.

```bash
# via npm script (no build required)
npm run cli -- doctor
npm run cli -- list --limit 10
npm run cli -- list --actor "agent:claude-code"   # only claude-code's writes
npm run cli -- list --since "2026-07-13"          # only memories created on/after
npm run cli -- list --updated-since "2026-07-13"  # only memories touched on/after
npm run cli -- list --actor "agent:claude-code" --since "2026-07-13"  # combine
npm run cli -- list --last-accessed-since "2026-07-13"  # only memories I've read recently
npm run cli -- search "postgres" --limit 5
npm run cli -- search "postgres" --actor "agent:claude-code"
npm run cli -- search "postgres" --since "2026-07-13"
npm run cli -- search "postgres" --updated-since "2026-07-13"
npm run cli -- show <memory_id>
npm run cli -- audit <memory_id>
npm run cli -- backup
npm run cli -- migrate --yes
npm run cli -- export --format json              # Stage 8: json / yaml / markdown
npm run cli -- export --format yaml
# Stage 18 v1.1.2 (issue #24, task 5): the import
# preflight is the authoritative gate. A bundle
# that contains `sensitivity: "restricted"` rows
# OR uses `restore_trust: true` + `full_history`
# requires an operator capability. The capability
# is installed via `agent-recall admin grant` (see
# ADR-0001); the programmatic import
# (`importMemoryExport(..., { capability })`)
# accepts the token, the CLI will accept a
# `--capability <token>` flag in a follow-up.
npm run cli -- import --from <export-root> --scope global --format json
npm run cli -- import --from <export-root> --scope project --project-id <id> --format json
```

After `npm run build`, the same commands are available via the `agent-recall`
binary:

```bash
node dist/bin/agent-recall.js doctor
```

The CLI respects the same `AGENT_RECALL_HOME` / `LOCAL_MEMORY_MCP_HOME`
environment variables as the MCP server. All commands accept `--json` for
machine-readable output and `--no-color` to disable ANSI colors.

## Per-Client Env Setup

`AGENT_RECALL_ACTOR` controls which agent name shows up in the audit log
and in the `last_accessed_by` map. Set it in the MCP server's `env` block
in your client's JSON config. Without it, audit rows are written as
`agent:unknown` (or the legacy `agent` value until the v1→v2 migration
is run), and per-agent access hints on `get_memory` calls are not
recorded.

Recommended names: `claude-code`, `cursor`, `codex`, `aider`, `cline`,
`continue`, `windsurf`, `roo-cline`, `copilot`.

The `last_accessed_by` column lands with the **v2 → v3 migration** in
Stage 2; existing v2 databases need `agent-recall migrate --yes` to
opt in. `remember` calls that hit a duplicate-candidate also need an
explicit `confirm_write: true` from the caller to proceed — the agent
should not silently overwrite.

## Doctor

`agent-recall doctor` runs **24** health checks and exits with:

- `0` — all OK
- `1` — warnings present, no failures
- `2` — at least one failure (data integrity, missing data home, etc.)

The checks come in three groups:

- **Operational (Stage 1-7)**: data_home, integrity, schema_version,
  fts_consistency, backup_directory, disk_free, audit_health,
  capacity_headroom, actor_distribution, last_accessed_by,
  actor_ownership, stale_memories.
- **v1.0 acceptance (Stage 14 / spec § 9.1)**: scope_safety,
  revision_integrity, journal_mode, sqlite_runtime, lock_health,
  backup_verification, project_alias_collision, ranking_health,
  export_collision, audit_revision_gap, secret_policy_version,
  idempotency_integrity.

Use it as a periodic self-check or before/after risky operations like
schema upgrades or hand-edits to the SQLite file. `--json` is supported for
scripting.

## Backup

Backups are written to `<AGENT_RECALL_HOME>/backups/memory-<timestamp>.sqlite`
via SQLite's `VACUUM INTO` command. The 14 most recent backups are kept; older
ones are pruned automatically. Backups run automatically after successful
maintenance actions (`rebuild_markdown_index`, `expire_due`,
`archive_low_value`). Use `agent-recall backup` to trigger one manually, or
`--keep N` to override the retention count.

## Tools

| Tool | Description |
| --- | --- |
| `recall_context` | Task-start memory recall entry point. Ranks the calling agent's own knowledge first; each entry is annotated with `[writer: <actor>]`. |
| `remember` | Store one validated local memory entry. |
| `search_memories` | Search memories by full-text query and optional metadata filters; `actor`, `since`, `last_accessed_since`, `updated_since` narrow the result. |
| `get_memory` | Read one memory entry and its audit history by memory id. |
| `list_memories` | List memories with optional scope and metadata filters; `actor`, `since`, `until`, `last_accessed_since`, `updated_since`, `updated_until` narrow the result. |
| `update_memory` | Update mutable fields on an active or archived memory. |
| `supersede_memory` | Create a replacement memory and mark older memories as superseded. |
| `forget_memory` | Forget a memory by clearing its body and marking it forgotten. |
| `get_memory_budget` | Report budget usage and cleanup candidates for a scope. |
| `maintain_memories` | Run local maintenance actions: `archive_low_value`, `expire_due`, `rebuild_markdown_index`, `vacuum_fts`, `find_duplicates`, `merge_duplicates`. Stage 7 adds `batch_size` (default 500, min 50, max 5000). Stage 8 adds `dry_run` (default false) for mutating actions and `strategy` (`keep_first` / `keep_newest`) for `merge_duplicates`. |
| `merge_memories` | Merge two or more active memories into a single replacement. Requires `confirm_write` semantics; relaxes budget to allow post-merge cap. |
| `export_memory_context` | Export selected memories as a bounded markdown context pack. |

## Tool And Schema Notes

- Project-scoped `remember`, `search_memories`, `list_memories`, `maintain_memories`, and `export_memory_context` calls require project identity through `project_id` or `project_path`.
- `get_memory_budget` requires `project_id` when `scope` is `project`; it does not accept `project_path` for project budget reads.
- `get_memory`, `update_memory`, and `forget_memory` accept either `id` or `memory_id`. If both aliases are provided, they must match.
- `update_memory` accepts either a `patch` object or top-level update fields, but not both.
- `remember` rejects unknown fields and only accepts supported memory types, source kinds, ratings, and writable statuses.
- Service errors are returned as structured JSON text. `export_memory_context` returns markdown text.

## Import Preflight + Capability Boundary

The `import` path (CLI `agent-recall import --from <export-root> --scope ...` and the programmatic `importMemoryExport(...)` API) runs an authoritative preflight that closes any of these gaps **before** any row is written:

- **Schema / enum / secret** — invalid enums and `secret_detected` (e.g. `sk-...` API keys in `body`) reject the bundle.
- **Project identity** — every project-scope entry is routed through `ProjectIdentityResolver.resolve(..., "strict_existing")`. A `project_id` that has not been registered surfaces `identity_conflict`; a `project_path` that aliases to a different id also surfaces `identity_conflict`. The v1.1.2 strict-by-default contract is enforced (no silent identity creation from a `project_id`-only input).
- **Sensitivity / trust authorization** — a `restore_trust: true` + `full_history` import OR a bundle that contains `sensitivity: "restricted"` rows requires an operator capability. The bare `restore_trust` / `allow_restricted` flag without a capability is rejected at preflight with `unauthorized`. The capability is installed via `agent-recall admin grant` (see [ADR-0001](docs/adr/0001-local-admin-capability-boundary.md)) and passed to the import via the `capability` option. The CLI does NOT silently `restore_trust`; the `restore_trust` + `full_history` import is the only way to re-claim a `user_confirmed` tier, and it must be paired with a valid `import_trust_restore` capability.
- **Aggregate budget** — the batch is checked against the configured `max_active_entries`, `max_total_chars`, `max_topic_chars`, and `max_index_chars` (the v1.1.1 PR-4 placeholder against `Number.MAX_SAFE_INTEGER` was useless; the v1.1.2 contract pins the check on the real configured limits). Replacements / merges release the existing entry's `char_count` and index size, so the budget is computed against the **net** impact (the preflight emits a deterministic `before` / `after` summary on the `PreflightPlan`).
- **Apply-time revalidation** — the `applyImport` step re-reads the live store INSIDE the transaction. A preflight / apply race (a concurrent write that bumped a row's revision, or a budget drift between preflight and apply) rolls the entire batch back atomically. The `import_batches` row is never written on a failed apply (Task 7 #26 will add the persistent lineage surface; the v1.1.2 contract ships the "no completed batch row on a failed apply" rule).

A failed preflight leaves the live store untouched and returns the preflight error in the structured envelope (`error.code` is one of `identity_conflict`, `secret_detected`, `aggregate_budget`, `sensitivity_denied`, `unauthorized`, `revision_drift`, `invalid_schema`, `bundle_garbled`).

### Full-history bundle format (`v3`)

The `history_mode: "full_history"` import path restores the source's complete history graph (entries + revisions + audit events + relations + provenance links) in one transaction. The wire format is the v3 bundle (`BUNDLE.json`):

```json
{
  "bundle_version": 3,
  "source": {
    "actor_id": "agent:source",
    "schema_version": 12,
    "data_home_fingerprint": "<sha256 of <data_home_path>@<schema_version>>"
  },
  "scope": { "kind": "global" },
  "generated_at": "2026-01-03T00:00:00.000Z",
  "entries": [ /* MemoryEntry post-images, sorted by id */ ],
  "revisions": [
    {
      "revision_id": "rev_<memory_id>_<revision>",
      "memory_id": "<source memory_id>",
      "revision": 1,
      "actor_id": "agent:source",
      "reason": "created",
      "request_id": "req_...",
      "session_id": null,
      "tool_call_id": null,
      "created_at": "2026-01-01T00:00:00.000Z",
      "snapshot": { /* post-image of the entry at this revision */ }
    }
  ],
  "audit_events": [
    {
      "event_id": "aud_...",
      "memory_id": "<source memory_id>",
      "scope": "global",
      "project_id": null,
      "event": "created",
      "reason": "imported",
      "actor_id": "agent:source",
      "request_id": null,
      "session_id": null,
      "tool_call_id": null,
      "metadata": { /* free-form metadata */ },
      "created_at": "2026-01-01T00:00:00.000Z"
    }
  ],
  "relations": [
    {
      "from_memory_id": "<source memory_id>",
      "to_memory_id": "<source memory_id>",
      "relation_type": "supersedes",
      "confidence": 0.9,
      "metadata": {},
      "created_at": "2026-01-02T00:00:00.000Z"
    }
  ],
  "provenance": [
    {
      "memory_id": "<source memory_id>",
      "source_kind": "issue",
      "source_ref": "https://example.com/issues/42",
      "recorded_by": "agent:source",
      "recorded_at": 1735776000000
    }
  ]
}
```

The `MANIFEST.json` for a v3 export carries `bundle_version: 3` and `bundle_hash` (SHA-256 over the canonical-JSON serialisation of the bundle, **excluding** the `source` identity block). The import preflight recomputes the hash and rejects a tampered bundle with `bundle_garbled`. The apply phase replays every section in one transaction; a single failure rolls back every entry / revision / audit / relation / provenance / FTS row.

**Source-side → target-side memory_id remap.** The v1.1.2 contract pins `target_id = source_id` for every section. A future "rename on collision" policy can plug in without touching the apply transaction.

**What is NOT restored.** `memory_accesses` (per-actor access counts / `last_accessed_by`) is a runtime write-time side effect, not a history row; the v3 bundle omits it. The `memory_feedback` table is also runtime state and is similarly omitted. New audit rows stamped during the apply carry `actor: "import:<batch_id>"` and `metadata.imported_from_actor: <source defaultActor>` so a reviewer can trace the row back to the exact source-side writer.

**Older bundles (v1 / v2 snapshot)** continue to work. The migration adapter recognises `bundle_version: 1` / `2` and falls through to the existing snapshot import path; the v3 work does NOT regress that surface.

## Configuration

The server reads these env vars at runtime (no restart needed; the next
call picks up the new value). All have safe defaults; setting an
invalid value falls back to the default with a one-line stderr warning.

| Env var | Default | Purpose |
| --- | --- | --- |
| `AGENT_RECALL_HOME` | `~/.agent-recall` | Where the SQLite file, backups, and exports live. The legacy `LOCAL_MEMORY_MCP_HOME` is honored if this is unset. |
| `AGENT_RECALL_ACTOR` | `agent` | Default actor name for audit rows. Set to `agent:claude-code`, `agent:cursor`, etc. in your MCP client config so per-agent view, trust_boost, and last_accessed_by work end-to-end. |
| `AGENT_RECALL_STALE_DAYS` | `90` | Threshold for the `stale_memories` doctor check. Must be a positive integer. |
| `AGENT_RECALL_TRUST_STRONG` | `0.3` | Recall `trust_boost` for memories the calling agent wrote. Must be in `[0, 1]`. |
| `AGENT_RECALL_TRUST_SOFT` | `0.1` | Recall `trust_boost` for memories the calling agent recently touched. Must be in `[0, 1]`. |
| `AGENT_RECALL_SUPPRESS_MCP_DEPRECATION` | unset | Set to `1` to silence the one-time MCP server deprecation notice. |
| `AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID` | unset (strict-by-default) | v1.1.2 (issue #21): default-off legacy escape hatch. When set to `1`, a `project_id`-only call without a registered identity is allowed in "unbound" mode (the resolver returns `ok` with `identity_status: "unbound"`). The default strict mode refuses unknown ids at the resolver before any project scope, alias, memory, audit, or budget row is created. The `memory://health` resource surfaces the current mode; the CLI `export` success message prints `[identity_status: unbound — strict isolation disabled]` when the escape hatch is on. |
| `AGENT_RECALL_PROFILE` | `core` (the packaged default) | v1.1.2 (issue #22 + issue #23): selects the active MCP tool profile. `core` registers the 10 read / write / plan essentials; `extended` adds the 10 memory-semantics + administrative tools (`record_memory_feedback`, `record_memory_provenance`, `explain_memory_provenance`, `confirm_memory_trust`, `maintain_memories`, `plan_maintenance`, `apply_maintenance`, `merge_memories`, `supersede_memory`, `export_memory_context`). `admin` registers the same 20-tool surface as `extended`; the difference is the startup-time capability gate — a server with `AGENT_RECALL_PROFILE=admin` refuses to bind to stdio without a valid operator capability at `${AGENT_RECALL_HOME}/admin.cap` (install one via `agent-recall admin grant`). Unknown values fail-closed at startup with a non-zero exit and an error message that names this env var. The `memory://health` resource surfaces the active profile as `active_profile` AND the admin boundary state as `capability_state` (`granted` / `missing`); the verbose stdio hint includes the profile. |

Example multi-agent MCP config:

```json
{
  "mcpServers": {
    "agent-recall-mcp": {
      "command": "node",
      "args": ["/path/to/agent-recall/dist/src/index.js"],
      "env": {
        "AGENT_RECALL_HOME": "/path/to/agent-recall-data",
        "AGENT_RECALL_ACTOR": "agent:claude-code",
        "AGENT_RECALL_STALE_DAYS": "60",
        "AGENT_RECALL_TRUST_STRONG": "0.4"
      }
    }
  }
}
```

## Memory Hygiene

- At task start, prefer `recall_context` with the current task query and, when available, the current project path. The output ranks the calling agent's own knowledge first (matching the `AGENT_RECALL_ACTOR` env var) and annotates each entry with `[writer: <actor>]` so authorship is visible at a glance.
- Keep each memory atomic: one preference, decision, constraint, lesson, or debugging fact per entry.
- Search before writing to avoid duplicate or near-duplicate memories.
- **Cross-agent dedup**: a `remember` that rephrases an existing memory
  by ≥ 0.7 token-set Jaccard returns the new memory **and** an
  advisory `near_duplicate` warning in `warnings[]`. The warning
  carries `actor` (who wrote the original) and `last_accessed_by`
  (when it was last touched) so the agent can decide whether to
  `merge_memories`, rewrite to be more distinct, or accept the
  duplicate. The exact-match `duplicate_candidate` path is still a
  hard block that requires `confirm_write: true`.
- Use project scope for repository-specific facts, paths, commands, and debugging lessons.
- Use global scope only for cross-project preferences and stable operating constraints.
- Prefer high-confidence, durable facts. Archive or supersede stale entries instead of accumulating contradictions.
- Never store secrets, private keys, bearer tokens, raw `.env` files, credentials, or customer-sensitive data.
- Secret-looking writes and updates are rejected before storage, and rejection audit metadata does not include the raw secret text.
- When a write returns `capacity_exceeded`, search or run maintenance before retrying.

## Local Storage

The authoritative SQLite database is stored at:

```text
<AGENT_RECALL_HOME>/memory.sqlite
```

Generated markdown exports are stored at:

```text
<AGENT_RECALL_HOME>/exports/
```

Markdown exports are for inspection and handoff. Manual edits under `exports/` may be overwritten by `maintain_memories` with `action: "rebuild_markdown_index"`.

## Changelog

Stage-level changes are tracked in [`CHANGELOG.md`](./CHANGELOG.md).
Stage 14 delivered the v1.0 acceptance bar (per spec § 9.1):
`migrate --yes` now takes a verified pre-migration backup before
advancing the schema (PR-A); every mutating tool accepts a
`RequestContext` so two clients sharing one MCP process are
distinguishable, and nine v1.0 error codes are wired in
(`scope_mismatch`, `project_identity_conflict`, `unsafe_content`,
`duplicate_candidate`, `db_busy`, `idempotency_key_reuse`,
`maintenance_plan_stale`, `migration_required`, `backup_failed`,
`cancelled`) — see PR-B1; idempotency replay / mismatch CAS,
`memory_revisions` post-image snapshots, atomic per-actor access
tracking, and the 8-process concurrency stress test — see PR-B2;
and the 12 v1.0 acceptance health checks the doctor runs
(see "Doctor" above) — see PR-C.
Stage 8 delivered three user-facing maintenance-path
improvements: the new `merge_duplicates` action on
`maintain_memories` (auto-supersedes all but the keep
target for each duplicate group), the `dry_run` flag
on `maintain_memories` (preview what would change
without writing), and the export format switch
(`--format markdown|json|yaml` on `agent-recall export`)
with a new `FormatRouter` that picks the right
exporter; see the
[Stage 8 spec](./docs/superpowers/specs/2026-07-20-stage-eight-maintenance-rich.md).
Stage 7 delivered `updated_since` / `updated_until` filters,
`AGENT_RECALL_STALE_DAYS` / `AGENT_RECALL_TRUST_STRONG` /
`AGENT_RECALL_TRUST_SOFT` env vars, a token-bucketed
inverted index for `find_duplicates` (5-10x pair count
reduction), and chunked maintenance via the new
`batch_size` parameter on `maintain_memories`; see the
[Stage 7 spec](./docs/superpowers/specs/2026-07-20-stage-seven-polish.md).
Stage 6 delivered time-window filters on `list_memories` and
`search_memories` (MCP + CLI: `since`, `until`,
`last_accessed_since`) and the twelfth doctor check
`stale_memories`; see the
[Stage 6 closure report](./docs/superpowers/plans/2026-07-20-stage-six-time-window-closure.md).
Stage 5 delivered the actor trust boost in `recall_context`
ranking (+0.3 for the calling agent's own writes, +0.1 for
recently-touched foreign writes) and a `[writer: X]`
annotation on each recall entry; see the
[Stage 5 closure report](./docs/superpowers/plans/2026-07-20-stage-five-recall-trust-closure.md).
Stage 4 delivered the `actor` filter on `list_memories` and
`search_memories` (MCP + CLI), and the eleventh doctor check
`actor_ownership`; see the
[Stage 4 closure report](./docs/superpowers/plans/2026-07-20-stage-four-closure.md).
Stage 3 delivered token-set Jaccard similarity, the `near_duplicate`
advisory on `remember`, and the `similar_title_and_body` group on
`maintain_memories find_duplicates`; see the
[Stage 3 closure report](./docs/superpowers/plans/2026-07-20-stage-three-closure.md).
Stage 2 delivered `merge_memories`, `confirm_write`, the
`last_accessed_by` column (with v2 → v3 migration), and a tenth doctor
check; see the [Stage 2 closure report](./docs/superpowers/plans/2026-07-19-stage-two-closure.md).
Stage 1 delivered CLI, doctor, backup, structured `actor`, schema
migration, and rewritten tool descriptions; see the
[Stage 1 closure report](./docs/superpowers/plans/2026-07-19-stage-one-closure.md).

## Verification

```bash
npm test -- test/e2e.test.ts
npm test
npm run typecheck
npm run build
git diff --check
```
