# Unified CLI and MCP Executable Design

**Date:** 2026-08-04  
**Status:** Approved design; implementation not started

## Goal

Unify the Node/npm and Bun CLI/MCP executable implementations behind one launcher while preserving the existing `agent-recall-mcp` compatibility entry point and updating the project-internal CLI SKILL documentation.

## Scope

In scope:

- Add one runtime launcher that dispatches to the existing CLI and MCP implementations.
- Make `agent-recall` with no arguments start the MCP stdio server.
- Make `agent-recall` with CLI arguments start the CLI.
- Make `agent-recall-mcp` force MCP mode regardless of arguments, preserving existing MCP client configurations.
- Point both Node/npm `bin` entries at the same launcher.
- Build both Bun artifact names from the same launcher logic while retaining both names in the manifest.
- Update `skills/agent-recall-cli/SKILL.md` and `skills/README.md` to describe the unified behavior.
- Add regression and smoke coverage for launcher routing, Node/npm entry points, Bun CLI/MCP behavior, and graceful shutdown.

Out of scope:

- Removing either published artifact name.
- Rewriting the CLI implementation or MCP server implementation.
- Changing MCP tool contracts, CLI subcommand contracts, data schemas, authorization behavior, or shutdown semantics.
- Updating documentation outside the implementation files, release metadata, and the two files under `skills/` required by the user.

## Current Architecture

The repository currently has separate runtime entry points:

- `bin/agent-recall.ts`: CLI entry point.
- `src/index.ts`: MCP stdio entry point.
- `package.json`: exposes `agent-recall` and `agent-recall-mcp` as separate Node/npm binaries.
- `scripts/build-bun-binary.mjs`: compiles separate Bun CLI and MCP sources into separate platform artifacts.
- `scripts/smoke-bun-binary.mjs`: exercises the Bun CLI artifact.

The implementation will preserve these two internal entry modules. The new launcher is an orchestration boundary, not a merge of the CLI and MCP service internals.

## Runtime Dispatch Contract

The launcher must implement the following deterministic rules:

| Invocation | Mode | Behavior |
| --- | --- | --- |
| `agent-recall` | no arguments | Start MCP stdio server. |
| `agent-recall <cli-subcommand> [options]` | CLI | Forward all arguments unchanged to the existing CLI entry. |
| `agent-recall-mcp` | any arguments | Start MCP stdio server and ignore launcher-level CLI routing. Existing MCP configurations remain valid. |
| `agent-recall mcp` | MCP alias | Optional explicit MCP alias; it must not pass `mcp` to the CLI. |

The launcher must identify the compatibility name robustly under Node and Bun. The implementation should use the invoked executable name (`argv[0]` / equivalent) only to detect the explicit `agent-recall-mcp` compatibility entry. It must not depend on the current working directory or absolute executable path.

The default `agent-recall` no-argument behavior is MCP, not CLI help. This is required for concise MCP client configuration and is the selected user experience.

The launcher must not write ordinary diagnostics to stdout while in MCP mode. MCP stdout remains reserved for JSON-RPC frames. CLI output behavior remains owned by the existing CLI implementation.

## Node/npm Packaging

`package.json` will expose both names through the same compiled launcher path:

```json
{
  "bin": {
    "agent-recall": "./dist/src/launcher.js",
    "agent-recall-mcp": "./dist/src/launcher.js"
  }
}
```

The existing source build must produce the launcher and retain the existing CLI/MCP modules. `npm start` may continue to be the explicit MCP development command, but the packaged `agent-recall` binary is the canonical unified entry.

The launcher must preserve direct development workflows. Keep `npm run cli -- <args>` as a CLI-focused development shortcut, and add `npm run launcher -- [args]` for exercising the unified routing contract from source. Both scripts must invoke the same launcher behavior; `npm run cli` may supply an explicit CLI compatibility mode only if needed to avoid stdin ambiguity during local CLI development.

## Bun Packaging

The Bun build process will compile the unified launcher rather than compiling separate source roots. The output artifact names remain:

- `dist-bin/agent-recall-<platform>[.exe]`
- `dist-bin/agent-recall-mcp-<platform>[.exe]`

Both artifacts are compatibility names for the same unified launcher behavior. The build script must continue recording both entries in `MANIFEST.json`, with explicit kind values that distinguish the canonical unified executable from the compatibility MCP name without changing the existing manifest field shape required by release tooling.

The source hash must continue to include `package.json`, all tracked TypeScript files under `src/` and `bin/`, and the launcher source through the existing source-file enumeration.

The build remains tolerant of per-platform Bun compilation failures: failures are logged, represented in the manifest, and cause a non-zero exit after all platform attempts.

## CLI SKILL Documentation

Update only:

- `skills/agent-recall-cli/SKILL.md`
- `skills/README.md`

The CLI SKILL must state:

- `agent-recall` is the unified executable.
- `agent-recall` with no arguments starts MCP and should not be used for CLI inspection.
- CLI operations require a subcommand, for example `agent-recall doctor`.
- `agent-recall-mcp` is a compatibility MCP entry point, not a separate implementation.
- Node/npm, source-development, and Bun artifact invocation examples use the unified routing contract.
- CLI remains read/lifecycle-oriented as currently documented; no new write commands are implied.

## Error Handling

- Unknown CLI arguments and CLI subcommand errors remain handled by the existing CLI parser and exit-code contract.
- The launcher only consumes the optional explicit `mcp` alias; it must not swallow or reorder ordinary CLI arguments.
- If the launcher cannot resolve or invoke an entry module, it must fail non-zero and write diagnostics to stderr.
- MCP mode must preserve all existing stdio lifecycle behavior: stdin EOF/close and `SIGINT`/`SIGTERM` trigger graceful shutdown, stdout remains protocol-clean, and `AGENT_RECALL_VERBOSE_STDIO=1` controls the one-shot shutdown reason line on stderr.
- The compatibility name must ignore CLI-style arguments rather than accidentally entering CLI mode, because existing MCP clients may supply transport-related arguments in future configurations.

## Verification Plan

### Launcher routing tests

- `agent-recall` with no arguments selects MCP mode.
- `agent-recall doctor` selects CLI mode and forwards `doctor` unchanged.
- `agent-recall admin status --json` forwards all arguments unchanged.
- `agent-recall mcp` selects MCP mode and removes only the launcher alias.
- `agent-recall-mcp` selects MCP mode even when extra arguments are present.
- A CLI parser error still returns the CLI's existing non-zero status.

### Node/npm tests

- Build succeeds and emits the launcher.
- Both package `bin` entries resolve to the launcher.
- CLI smoke covers `--version`, `doctor --json`, and one lifecycle command.
- MCP black-box covers `initialize`, `tools/list`, and stdin EOF graceful exit.

### Bun tests

- Build creates the canonical and compatibility artifact names for the host platform.
- CLI smoke runs through `agent-recall-<platform>`.
- MCP smoke runs through both the canonical artifact and `agent-recall-mcp-<platform>` compatibility artifact.
- Both artifacts respond to `initialize` and `tools/list` with protocol-clean stdout.
- Both artifacts exit cleanly after stdin EOF.
- `MANIFEST.json` contains both entries and valid checksums.

### Documentation and release checks

- `skills/agent-recall-cli/SKILL.md` contains no claim that MCP is a separate binary implementation.
- `skills/README.md` matches the unified command behavior.
- Existing artifact glob verification passes.
- Existing default test suite and relevant black-box/Bun suites pass.
- `git diff --check` passes.

## Compatibility Guarantees

- Existing `agent-recall-mcp` Node/npm configurations continue to launch MCP.
- Existing `agent-recall-mcp-<platform>` Bun artifact names remain available.
- Existing CLI subcommands and arguments remain unchanged.
- MCP JSON-RPC framing, tool lists, resources, environment variables, authorization, and shutdown behavior remain unchanged.
- The only intentional behavior change is that the canonical `agent-recall` executable with no arguments now starts MCP; CLI users must provide a CLI subcommand for CLI behavior.
