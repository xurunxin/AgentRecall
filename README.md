# AgentRecall

AgentRecall is a local-first MCP server for coding-agent memory. It gives MCP-compatible clients a governed tool surface for storing, searching, maintaining, and exporting global or project-scoped memories.

SQLite is the source of truth. Markdown files are deterministic exports for review and handoff, not the live database. The server runs over stdio and does not require a hosted database, embedding service, or network model call.

## Requirements

- Node.js 24 or newer
- npm
- An MCP-compatible client that can launch a stdio server

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

`agent-recall doctor` runs twelve health checks and exits with:

- `0` — all OK
- `1` — warnings present, no failures
- `2` — at least one failure (data integrity, missing data home, etc.)

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
| `maintain_memories` | Run local maintenance actions such as export rebuilds, expiry, cleanup, FTS vacuum, or duplicate detection. Stage 7 accepts `batch_size` (default 500, min 50, max 5000) to chunk scan-the-table operations. |
| `merge_memories` | Merge two or more active memories into a single replacement. Requires `confirm_write` semantics; relaxes budget to allow post-merge cap. |
| `export_memory_context` | Export selected memories as a bounded markdown context pack. |

## Tool And Schema Notes

- Project-scoped `remember`, `search_memories`, `list_memories`, `maintain_memories`, and `export_memory_context` calls require project identity through `project_id` or `project_path`.
- `get_memory_budget` requires `project_id` when `scope` is `project`; it does not accept `project_path` for project budget reads.
- `get_memory`, `update_memory`, and `forget_memory` accept either `id` or `memory_id`. If both aliases are provided, they must match.
- `update_memory` accepts either a `patch` object or top-level update fields, but not both.
- `remember` rejects unknown fields and only accepts supported memory types, source kinds, ratings, and writable statuses.
- Service errors are returned as structured JSON text. `export_memory_context` returns markdown text.

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
