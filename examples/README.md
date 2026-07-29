# Examples

This directory is intentionally empty in v1.1.3.

The v1.1.2-era `examples/` directory (which carried
hand-written CLI invocation examples) was removed as
part of v1.1.3 GATE-07 (issue #37). The CLI is now
exercised through:

1. The `docs/guides/release-publication.md` operator
   recipe (the canonical installation + lifecycle
   commands on `linux-x64` / `darwin-x64` / `win32-x64`).
2. The `test/blackbox/packaged-install.test.ts`
   lifecycle E2E (11 documented scenarios against the
   packaged `dist/`).
3. The v1.1.3 GATE-07 documentation contract — every
   command that the README surfaces must run end-to-end
   in CI (or fail the doc tests).

If a future release wants to ship user-facing examples
(`npm-script snippets`, `MCP client JSON configs` for
Claude Code / Cursor / Codex / etc.), they MUST import
from the v1.1.3 entry points (`dist/src/index.js` for
the MCP server, `dist/bin/agent-recall.js` for the
CLI) and MUST NOT reference the v1.1.2-era
`dist/index.js` (no `src/` prefix) or the
`xurx/agent-recall` repo URL.