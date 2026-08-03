---
name: agent-recall-cli
description: Operate the AgentRecall unified `agent-recall` binary. Use when the user wants to inspect, search, export, import, back up, restore, or migrate the local AgentRecall memory store, run a health check (`doctor`), manage the operator capability (`admin grant/status/revoke`), or troubleshoot SQLite / backup / schema issues without booting the MCP server. Triggers include "agent-recall", "agent recall", "本地记忆", "记忆数据库", "memory store", "memory CLI", "记忆查询", "记忆导出", "记忆备份", "记忆恢复", "doctor check", "memory health", "schema migration", "admin capability", "记忆审核", "审计事件", "memory audit", "operator capability". Also use when the user invokes the `agent-recall` binary directly, asks about `~/.agent-recall/`, or mentions the `AGENT_RECALL_HOME` / `AGENT_RECALL_PROFILE` environment variables.
---

# agent-recall CLI (unified executable)

Starting with v1.1.4 the `agent-recall` binary is a single
launcher that dispatches to either the CLI surface described in
this document or the MCP stdio server based on the invocation.
The MCP server surface (10 read/write/plan tools per profile)
still lives in its own server configuration; the CLI does
**not** register MCP tools.

| Binary | Purpose |
| --- | --- |
| `agent-recall` | Unified executable. With no arguments it starts the MCP stdio server. With any subcommand (e.g. `doctor`, `admin status`) it runs the CLI. |
| `agent-recall-mcp` | Compatibility MCP entry point. Always starts the MCP stdio server. Internally the same launcher source as `agent-recall`. |

The packaged entry point after `npm install` is
`node_modules/.bin/agent-recall`. From a source checkout run
`npm run launcher -- <args>` to exercise the unified dispatcher
directly, or `npm run cli -- <args>` to bypass the dispatch and
invoke the CLI module straight from `bin/agent-recall.ts`.

### Unified executable routing (v1.1.4)

| Invocation | Mode | Reason |
| --- | --- | --- |
| `agent-recall` (no arguments) | MCP | The MCP default; matches the historical `agent-recall-mcp` shape. |
| `agent-recall <subcommand> [opts]` | CLI | Any subcommand (including the explicit `mcp` alias) is forwarded to the CLI parser. |
| `agent-recall-mcp [anything]` | MCP | Compatibility entry point; the launcher recognises the basename and always starts MCP. |

The launcher identifies the binary by the basename of
`process.argv[0]`, stripping a trailing `.exe` on Windows. CLI
users must supply a subcommand; the CLI does NOT print help when
the binary is invoked with no arguments.

## Decision table

Match the user's intent to a single section below. When multiple
sections apply (e.g. "back up before migrating"), run them in
order: each section's "Pair with" column lists dependencies.

| User intent | Section | Pair with |
| --- | --- | --- |
| "is the store healthy?" / "memory health" / "doctor failed" | [Health check](#health-check-doctor) | — |
| "find a memory about X" / "list recent memories" | [Inspect memories](#inspect-memories-listsearchshowaudit) | — |
| "show memory <id>" / "why was this memory edited" | [Inspect memories](#inspect-memories-listsearchshowaudit) | — |
| "export memories to markdown/json/yaml" | [Export](#export) | — |
| "re-import an export bundle" / "import inspect <batch_id>" | [Import](#import) | [Export](#export) (read first) |
| "back up the database" / "restore from backup" | [Backup & restore](#backup--restore) | — |
| "upgrade the schema" / "migrate" | [Migration](#migration) | [Backup & restore](#backup--restore) (always pre-backup) |
| "grant admin" / "revoke admin" / "admin status" | [Admin capability](#admin-capability) | [Sensitivity matrix](#sensitivity-matrix-quick-reference) |

## Global flags (apply to every command)

| Flag | Effect |
| --- | --- |
| `--data-home <path>` | Override `AGENT_RECALL_HOME` / `LOCAL_MEMORY_MCP_HOME` for one call. |
| `--json` | Emit a machine-readable JSON envelope on stdout. Stable for scripts. |
| `--no-color` / `--color=never` | Strip ANSI. |
| `--color=always` | Force ANSI even when stdout is not a TTY (good for logs). |
| `--version` / `-v` | Print `server_version` (the same value as the MCP handshake) and exit. |
| `--help` / `-h` | Print the help text and exit. |

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_RECALL_HOME` | `~/.agent-recall` | Data directory (SQLite DB, `backups/`, `admin.cap`). Home-relative `~/` is expanded; other values are resolved to absolute paths. |
| `AGENT_RECALL_PROFILE` | (unset → Core) | `core` / `extended` / `admin`. CLI is unaffected except through the authorization decision (Core = `normal` only). |
| `AGENT_RECALL_ACTOR` | `user:cli` | Recorded as the `actor` on every audit event the CLI writes. |
| `AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID` | unset | Escape hatch for one-off triage: lets `project_id`-only calls proceed without a registered identity. **Do not** enable in normal agent flows. |

`LOCAL_MEMORY_MCP_HOME` is no longer documented; `AGENT_RECALL_HOME`
is the v1.1.3 contract.

## Health check (`doctor`)

```bash
agent-recall doctor                  # human-readable summary
agent-recall doctor --json           # machine-readable report (use for scripts)
```

`doctor` runs 24 independent checks (data home, integrity, schema
version, FTS, backup directory, disk free, audit, capacity, actor
distribution, scope safety, revision integrity, journal mode,
SQLite runtime, lock health, backup verification, project alias
collision, ranking health, export collision, audit revision gap,
secret policy version, idempotency integrity, …).

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | All checks `ok`. |
| `1` | Only `warn` results. |
| `2` | At least one `fail` result. Stable `[doctor_failed]` prefix on stderr. |

When the report fails, **read the `[doctor_failed]` line first** —
it carries the failure count without forcing the script to parse
the human summary.

## Inspect memories (`list` / `search` / `show` / `audit`)

The CLI is fail-closed: without an admin capability, it can only
read `normal` (and `private`) sensitivity rows. Anything else
surfaces `forbidden_visibility` and exits 1 — the row's
`sensitivity` literal is **never** echoed on the deny path.

```bash
# List recent global memories (default scope, status=active, limit=20)
agent-recall list
agent-recall list --scope project --project-id <id> --limit 50
agent-recall list --actor user:claude --since 2026-07-01T00:00:00Z

# Full-text search (FTS5) — bounded by actor_max_sensitivity automatically
agent-recall search "agent-recall doctor failed"
agent-recall search "schema migration" --scope project --project-id <id>

# Single memory + audit history
agent-recall show <memory_id>
agent-recall show <memory_id> --json

# Just the audit events for a memory
agent-recall audit <memory_id>
agent-recall audit <memory_id> --json
```

Common filters (all commands): `--scope` (`global` | `project`),
`--project-id`, `--status` (default `active`), `--actor`,
`--since`, `--until`, `--last-accessed-since`, `--updated-since`,
`--updated-until`, `--limit`, `--offset`. `list` shows them all;
`search` accepts the query as its first positional.

## Export

```bash
agent-recall export --scope global --format markdown --out ./export-global
agent-recall export --scope project --project-id <id> --format json --out ./export-proj
agent-recall export --scope global --history-mode full_history --out ./export-history
agent-recall export --scope project --project-path /abs/path/to/repo --out ./export
```

Rules:

- `--format` must be `markdown` | `json` | `yaml`. Anything else
  exits 1 with `[invalid_format]`.
- `--history-mode` must be `snapshot` (default) | `full_history`.
  Invalid value exits 1 with `[invalid_history_mode]`.
- `--scope project` requires either `--project-id` (must be a
  registered identity) or `--project-path` (registers it on the
  fly in `register` mode).
- Restricted-sensitivity entries require an Admin-profile process
  with a valid capability; without it the export exits 1 with
  `[forbidden_visibility]`.
- Output is a directory containing a `manifest.json` plus
  per-topic files (or a single JSON/YAML document for those
  formats).

## Import

```bash
# Replay a snapshot bundle into the live store (default: keep = preserve existing)
agent-recall import --from ./export-global --scope global

# Replace conflicting ids instead of keeping them
agent-recall import --from ./export-global --scope global --conflict replace

# Plan only — do not write
agent-recall import --from ./export-global --scope global --dry-run

# Inspect a previously-applied batch (durable lineage, no bodies)
agent-recall import inspect <batch_id> --json
```

Conflict policies: `keep` (default), `replace`, `merge`, `fail`.
`--dry-run` prints the plan to stdout (JSON when `--json` is
passed). `import inspect` surfaces the `import_batches` row:
bundle hash, version, actor, counts, redacted on the deny path —
no memory bodies, no secret values, no capability tokens.

## Backup & restore

```bash
# Manual backup (default keep=14; rotates oldest)
agent-recall backup
agent-recall backup --keep 30 --json

# Restore from a verified backup
agent-recall restore --from ~/.agent-recall/backups/<file>.sqlite --confirm
```

Stable error codes on failure: `[backup_failed]`. Restore takes a
pre-restore backup of the live DB before swapping files; the
resulting file is `memory.sqlite.pre-restore.<ts>` next to the DB.

Always run `agent-recall doctor` **after** a restore to confirm
the new DB passes all 24 checks before treating the restore as
successful.

## Migration

```bash
agent-recall migrate --yes           # human-readable
agent-recall migrate --yes --json    # machine-readable
agent-recall migrate                 # refuses without --yes (exits 1)
```

The migration command:

1. Takes a verified pre-migration backup of the live DB.
2. Acquires the migration lock.
3. Advances `user_version` inside a SQLite transaction.
4. Prints the rollback command:
   `agent-recall restore --from <backup.path> --confirm`.

The v1.1.3 lane is **schema-preserving** (v13 stays valid; the
additive `import_batches` table and `audit_metadata_json` column
are minted only when the corresponding feature is used), so most
upgrades are no-ops that print `no migration needed`.

## Admin capability

```bash
agent-recall admin grant [--label "operator:alice"]
agent-recall admin status
agent-recall admin revoke
```

The admin capability file lives at
`${AGENT_RECALL_HOME}/admin.cap`. The grant output is the **only**
redacted display of the new token (`**** <last 4 hex>` plus the
on-disk path); use `--json` to pipe the token into a secret store.
The token is never logged by the server and never appears in
audit output.

The file is verified at load time (POSIX mode + owner + symlink
status on POSIX; `icacls` ACL probe on Windows). A drift sets the
in-memory token to empty; `admin status` surfaces
`{kind: "drift", drift_reason, path}` without leaking token bytes.

## Sensitivity matrix (quick reference)

| Profile | `normal` | `private` | `restricted` |
| --- | --- | --- | --- |
| Core (CLI default) | visible | visible | **forbidden_visibility** |
| Extended | visible | visible | **forbidden_visibility** |
| Admin (with valid `admin.cap`) | visible | visible | visible |

A CLI caller without an admin capability **cannot** read
restricted entries — even if it would otherwise be allowed by
identity scope. Install a capability (`admin grant`) and re-run
with `AGENT_RECALL_PROFILE=admin` to lift the visibility ceiling.

## Common error codes (stable `[code]` prefixes on stderr)

| Code | Source command(s) | What it means |
| --- | --- | --- |
| `[usage_error]` | dispatch, `import` | Unknown command or missing positional arg. |
| `[internal_error]` | dispatch | The SQLite store could not be opened (corrupted DB, missing schema). |
| `[doctor_failed]` | `doctor` | One or more doctor checks failed. |
| `[backup_failed]` | `backup`, `restore`, `migrate` | Backup, verify, or restore step failed. |
| `[invalid_format]` | `export`, `import` | `--format` not in `markdown` \| `json` \| `yaml`. |
| `[invalid_history_mode]` | `export`, `import` | `--history-mode` not `snapshot` \| `full_history`. |
| `[invalid_conflict_policy]` | `import` | `--conflict` not `keep` \| `replace` \| `merge` \| `fail`. |
| `[invalid_scope]` | `export`, `import` | `--scope` not `global` \| `project`. |
| `[missing_project_id]` | `import` | Project-scope import without `--project-id` / `--project-path`. |
| `[not_found]` | `show`, `audit`, `import inspect` | Memory id or batch id does not exist. |
| `forbidden_visibility` | `show`, `export` | Row is above the caller's max sensitivity. **Never** echoed with the row's `sensitivity` literal. |

Scripts should pin on the `[code]` prefix; the rest of stderr is
free-form prose that may evolve.

## What this skill does not cover

- The MCP server tool surface (`recall_context`, `remember`,
  `search_memories`, etc.) — those are MCP client tools, not CLI
  commands. Use the MCP config instead.
- Internal maintenance (vacuum, FTS rebuild, duplicate merge).
  Those run through the MCP `maintain_memories` tool; the CLI
  exposes a thin slice (`doctor`, `backup`) but not the per-action
  knobs.
- Memory writes from the CLI. The CLI is **read + lifecycle only**
  (`backup`, `restore`, `migrate`, `admin`, `export`, `import`).
  To create or update memories, use the MCP server.

## Pairing with the rest of the toolchain

- Run `agent-recall doctor` before any destructive operation
  (`migrate`, `restore`, `import --conflict replace`). A green
  doctor is the cheapest precondition check.
- Pipe `--json` outputs through `jq` (or your script of choice) —
  the JSON envelope is the contract this skill pins against.
- For Windows / PowerShell users, escape backslashes in
  `--data-home` (`C:\\path\\to\\data`) and use forward slashes
  everywhere else; the CLI normalises both.
- **Bun single-file binary.** If the consumer host has no
  Node runtime, the Bun binary at
  `dist-bin/agent-recall-<plat>` is the supported drop-in.
  Stable CLI contract is identical; only the launcher
  differs. See `docs/guides/bun-distribution.md` for
  install + verification.