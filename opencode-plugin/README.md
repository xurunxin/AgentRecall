# agent-recall-opencode-plugin

Bundled inside [`local-memory-mcp`](../) at `opencode-plugin/`.
Previously published as the standalone `opencode-agent-recall-plugin`
package; behaviour, options, and failure modes are unchanged.

OpenCode plugin that auto-injects [AGENT_RECALL] memory entries into the system prompt on every LLM turn.

This is the **passive injection layer** for the `agent-recall` MCP server. The MCP server exposes tools (`remember`, `search_memories`, ...) for active writes/reads; this plugin reads the same SQLite store and surfaces relevant entries as part of the system prompt, so the model sees them without having to call a tool.

## What it does

1. Opens the AgentRecall SQLite at `$AGENT_RECALL_HOME/memory.sqlite` (or `~/.agent-recall/memory.sqlite`).
2. On every `experimental.chat.system.transform` call, looks up the current session's `directory`, finds the matching `project_id` in `project_scopes`, and fetches:
   - All active project-scope memories for that project_id (sorted by `importance DESC, updated_at DESC`)
   - All active global-scope memories (sorted by `importance DESC, updated_at DESC`)
3. Formats them as a compact `[AGENT_RECALL]` markdown block and appends to `output.system`.
4. Caches the formatted block for `cache_ttl_ms` (default 60s) to avoid per-token DB reads.

## What it does NOT do

- It does **not** write to the store. Writes go through the `agent-recall` MCP tools.
- It does **not** remove or override any existing system prompt content — it only appends.
- It does **not** run FTS per turn. v1 just dumps the most-important active entries; relevance filtering can be added later without a config change.

## Install / Register

In `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "opencode-agent-recall-plugin"
  ]
}
```

If loading from a local path, use a relative or absolute path:

```json
{
  "plugin": [
    "G:\\Projects\\MetronX\\local-memory-mcp\\opencode-plugin"
  ]
}
```

(See `docs/guides/opencode-install.md` in the parent project for the canonical
end-to-end install recipe including MCP server registration.)

## Options

Pass as the second element of the plugin tuple:

```json
{
  "plugin": [
    ["G:\\Projects\\MetronX\\local-memory-mcp\\opencode-plugin", { "max_chars": 6000, "cache_ttl_ms": 90000 }]
  ]
}
```

| Option | Default | Notes |
|---|---|---|
| `max_chars` | `8000` | Hard cap on the injected block size. Larger entries (or all titles) always fit. |
| `cache_ttl_ms` | `60000` | How long to reuse the same formatted block. 0 disables cache. |
| `db_path` | `$AGENT_RECALL_HOME/memory.sqlite` or `~/.agent-recall/memory.sqlite` | Override DB location. |
| `max_entries` | `40` | Hard cap on number of memories included. |
| `include_global` | `true` | If false, only project-scope memories are injected. |
| `header` | `"[AGENT_RECALL] Local memory context. Use the agent-recall MCP tools (search_memories, remember, ...) to add/refresh; this is auto-injected from the local store."` | First line of the block. Set empty to omit. |
| `debug` | `false` | Log to stderr on each inject. |

## Failure mode

The plugin **must not** break LLM calls. Every SQLite / IO / parse error is caught, logged to stderr, and the hook is a no-op. The model gets its baseline system prompt unchanged.

## Companion

- Bundled inside the AgentRecall project at `opencode-plugin/` (this directory was previously the standalone `opencode-agent-recall-plugin` repo; it is now colocated with the MCP server source in `local-memory-mcp`).
- Server source: `G:\Projects\MetronX\local-memory-mcp` (also published as `agent-recall`).
- Server config: `mcp.agent-recall` in `opencode.json`.
- Canonical install recipe: `docs/guides/opencode-install.md` in the parent project.
