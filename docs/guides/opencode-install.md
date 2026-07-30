# OpenCode installation

This guide is the **canonical recipe** for registering AgentRecall
(`local-memory-mcp`) with [OpenCode](https://opencode.ai). It covers both
required steps: the MCP server (`mcp:` section) and the prompt-injection
plugin (`plugin:` section), plus the optional environment variables and
troubleshooting knobs.

The bundled paths below assume the project lives at
`G:\Projects\MetronX\local-memory-mcp` and that you have already run
`npm install` and `npm run build` (or installed a published artefact;
see the top-level README "Installation" section).

## 1. Register the MCP server

Add the server block to `~/.config/opencode/opencode.json` under `mcp`:

```json
{
  "mcp": {
    "agent-recall": {
      "command": [
        "node",
        "G:\\Projects\\MetronX\\local-memory-mcp\\dist\\src\\index.js"
      ],
      "enabled": true,
      "environment": {
        "AGENT_RECALL_HOME": "G:\\Memory\\AgentRecall",
        "AGENT_RECALL_ACTOR": "claude-code"
      },
      "type": "local"
    }
  }
}
```

This exposes all 11 tools (`recall_context`, `remember`, `search_memories`,
`get_memory`, `list_memories`, `update_memory`, `forget_memory`,
`get_memory_budget`, `explain_recall`, `list_backups`, `supersede_memory`)
to every OpenCode session in every project. The `mcp:` block is the
**only** registration needed for MCP tool availability — the plugin
documented in step 2 is independent.

## 2. Register the prompt-injection plugin (optional)

The plugin lives inside the project at
`G:\Projects\MetronX\local-memory-mcp\opencode-plugin\`. It is an **optional
companion**: with it, every LLM turn automatically receives an
`[AGENT_RECALL]` block of project+global memories in the system prompt.
Without it, you must call `recall_context` manually to surface memories.

Add the path to `~/.config/opencode/opencode.json` under `plugin`:

```json
{
  "plugin": [
    "G:\\Projects\\MetronX\\local-memory-mcp\\opencode-plugin"
  ]
}
```

Options go in a tuple-form second element:

```json
{
  "plugin": [
    [
      "G:\\Projects\\MetronX\\local-memory-mcp\\opencode-plugin",
      { "max_chars": 6000, "cache_ttl_ms": 90000, "debug": false }
    ]
  ]
}
```

| Option           | Default     | Notes                                                            |
|------------------|-------------|------------------------------------------------------------------|
| `max_chars`      | `8000`      | Hard cap on the injected block size.                             |
| `cache_ttl_ms`   | `60000`     | How long to reuse the formatted block. `0` disables cache.       |
| `db_path`        | (default)   | Override DB location. See environment variables below.           |
| `max_entries`    | `40`        | Hard cap on number of memories included.                         |
| `include_global` | `true`      | If `false`, only project-scope memories are injected.            |
| `header`         | (default)   | First line of the injected block. Set empty string to omit.      |
| `debug`          | `false`     | Log to `stderr` on each inject.                                  |

The plugin reads the same SQLite store the MCP server uses
(`$AGENT_RECALL_HOME/memory.sqlite`) via `node:sqlite`. It never writes
and never overrides existing system prompt content — it only appends to
`output.system`. Every IO / parse / schema error is caught and logged;
a failure is a no-op so LLM calls still proceed.

## 3. Environment variables

The MCP server reads these from its own process environment (set in the
`mcp.agent-recall.environment` block or shell):

| Variable                               | Default                      | Purpose                                                 |
|----------------------------------------|------------------------------|---------------------------------------------------------|
| `AGENT_RECALL_HOME` (or `LOCAL_MEMORY_MCP_HOME`) | `~/.agent-recall/` on Windows / `~/.agent-recall` on POSIX | Data home; the SQLite store lives at `${HOME}/memory.sqlite`. |
| `AGENT_RECALL_ACTOR`                   | `user:cli`                   | Used for audit attribution when a tool call arrives from outside an MCP client (e.g. ad-hoc CLI use). |
| `AGENT_RECALL_PROFILE`                 | `core`                       | One of `core` / `extended` / `full` / `admin`. Affects tool surface. |
| `AGENT_RECALL_SUPPRESS_MCP_DEPRECATION`| unset                        | Set to `1` to silence the one-time migration note.      |
| `AGENT_RECALL_VERBOSE_STDIO`           | unset                        | Set to `1` for verbose stdio logs while debugging.      |

The plugin honours `AGENT_RECALL_HOME` (or `LOCAL_MEMORY_MCP_HOME`)
through the same resolution chain; pass `db_path` in options to override.

## 4. Verify

After saving `opencode.json`, start a fresh OpenCode session in any
project:

1. Confirm the MCP tools appear (e.g. `agent-recall_recall_context`,
   `agent-recall_remember`). They are listed in the session system prompt.
2. If the plugin is registered, confirm the `[AGENT_RECALL]` block is
   appended to the system prompt on every turn. Set `debug: true` to
   see log lines on `stderr`.
3. Sanity-check the SQLite path: the plugin's debug log will print
   `loaded N project scope(s) from <path>; include_global=<bool>`.

Smoke test the MCP server in isolation (no plugin involved):

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' \
  | node G:\\Projects\\MetronX\\local-memory-mcp\\dist\\src\\index.js
```

Expected: a `serverInfo.name: "agent-recall"` response followed by a
`tools/list` response listing the 11 tools.

## 5. Smoke test the plugin in isolation

The plugin ships its own `node --test` suite:

```bash
npm --prefix G:\\Projects\\MetronX\\local-memory-mcp\\opencode-plugin test
```

Expected: `pass 5 fail 0`. The suite opens the live SQLite at
`G:\Memory\AgentRecall\memory.sqlite` by default; override per-test with
`db_path` in plugin options.

## 6. Uninstall

To remove AgentRecall from OpenCode:

1. Remove the `mcp.agent-recall` block from `~/.config/opencode/opencode.json`.
2. Remove the `G:\\Projects\\MetronX\\local-memory-mcp\\opencode-plugin`
   entry from `opencode.json`'s `plugin` array (if present).
3. The SQLite store at `$AGENT_RECALL_HOME/memory.sqlite` is **not**
   removed automatically — back it up or delete it manually if desired.

## Related

- MCP server source: `src/` in this repo.
- Plugin source: `opencode-plugin/index.js` in this repo.
- Plugin options / failure modes: `opencode-plugin/README.md`.
- Architectural decision to colocate the plugin: see `CHANGELOG.md`.
