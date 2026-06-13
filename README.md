# local-memory-mcp

`local-memory-mcp` is a local-first MCP server for coding-agent memory. It gives MCP-compatible clients a governed tool surface for storing, searching, maintaining, and exporting global or project-scoped memories.

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
~/.local-memory-mcp/
```

Set `LOCAL_MEMORY_MCP_HOME` to use a different directory:

```bash
LOCAL_MEMORY_MCP_HOME=/path/to/local-memory npm start
```

The server trims empty values and falls back to `~/.local-memory-mcp`. Home-relative values beginning with `~/` or `~\` are expanded against the current user's home directory. Other values are resolved to an absolute path. In JSON client configs on Windows, escape backslashes, for example `G:\\Memory\\local-memory-mcp`.

## MCP Client Config

Most MCP clients support a JSON server entry. Use the built file after `npm run build`:

```json
{
  "mcpServers": {
    "local-memory": {
      "command": "node",
      "args": ["G:\\Projects\\MetronX\\local-memory-mcp\\dist\\index.js"],
      "env": {
        "LOCAL_MEMORY_MCP_HOME": "G:\\Memory\\local-memory-mcp"
      }
    }
  }
}
```

If your client supports `cwd`, you can launch through npm:

```json
{
  "mcpServers": {
    "local-memory": {
      "command": "npm",
      "args": ["start"],
      "cwd": "G:\\Projects\\MetronX\\local-memory-mcp",
      "env": {
        "LOCAL_MEMORY_MCP_HOME": "G:\\Memory\\local-memory-mcp"
      }
    }
  }
}
```

## Tools

| Tool | Description |
| --- | --- |
| `remember` | Store one validated local memory entry. |
| `search_memories` | Search memories by full-text query and optional metadata filters. |
| `get_memory` | Read one memory entry and its audit history by memory id. |
| `list_memories` | List memories with optional scope and metadata filters. |
| `update_memory` | Update mutable fields on an active or archived memory. |
| `supersede_memory` | Create a replacement memory and mark older memories as superseded. |
| `forget_memory` | Forget a memory by clearing its body and marking it forgotten. |
| `get_memory_budget` | Report budget usage and cleanup candidates for a scope. |
| `maintain_memories` | Run local maintenance actions such as export rebuilds, expiry, cleanup, FTS vacuum, or duplicate detection. |
| `export_memory_context` | Export selected memories as a bounded markdown context pack. |

## Tool And Schema Notes

- Project-scoped `remember`, `search_memories`, `list_memories`, `maintain_memories`, and `export_memory_context` calls require project identity through `project_id` or `project_path`.
- `get_memory_budget` requires `project_id` when `scope` is `project`; it does not accept `project_path` for project budget reads.
- `get_memory`, `update_memory`, and `forget_memory` accept either `id` or `memory_id`. If both aliases are provided, they must match.
- `update_memory` accepts either a `patch` object or top-level update fields, but not both.
- `remember` rejects unknown fields and only accepts supported memory types, source kinds, ratings, and writable statuses.
- Service errors are returned as structured JSON text. `export_memory_context` returns markdown text.

## Memory Hygiene

- Keep each memory atomic: one preference, decision, constraint, lesson, or debugging fact per entry.
- Search before writing to avoid duplicate or near-duplicate memories.
- Use project scope for repository-specific facts, paths, commands, and debugging lessons.
- Use global scope only for cross-project preferences and stable operating constraints.
- Prefer high-confidence, durable facts. Archive or supersede stale entries instead of accumulating contradictions.
- Never store secrets, private keys, bearer tokens, raw `.env` files, credentials, or customer-sensitive data.
- Secret-looking writes and updates are rejected before storage, and rejection audit metadata does not include the raw secret text.
- When a write returns `capacity_exceeded`, search or run maintenance before retrying.

## Local Storage

The authoritative SQLite database is stored at:

```text
<LOCAL_MEMORY_MCP_HOME>/memory.sqlite
```

Generated markdown exports are stored at:

```text
<LOCAL_MEMORY_MCP_HOME>/exports/
```

Markdown exports are for inspection and handoff. Manual edits under `exports/` may be overwritten by `maintain_memories` with `action: "rebuild_markdown_index"`.

## Verification

In this repository's local environment, shell commands are normally run through `rtk`:

```bash
rtk npm test -- test/e2e.test.ts
rtk npm test
rtk npm run typecheck
rtk npm run build
rtk git diff --check
```

Without the local wrapper, run the same npm and git commands without the `rtk` prefix.
