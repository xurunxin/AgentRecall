# Bun single-file binary distribution

The Bun path is an **additive** distribution channel. The Node
npm package (`agent-recall`) is still primary. The Bun binary
exists for operators who need a single-file drop-in and can
accept the smaller surface coverage (smoke-tested, not
vitest-tested).

## Prerequisites

- **Build host:** Bun ≥ 1.3.0 on PATH (`bun --version`).
- **Consumer host:** nothing. The binary is self-contained.

## Build

```bash
npm run build:bun
```

The script writes `dist-bin/agent-recall-<plat>[.exe]` and
`dist-bin/agent-recall-mcp-<plat>[.exe]` for each canonical
platform (`linux-x64`, `darwin-x64`, `darwin-arm64`,
`win32-x64`), plus `dist-bin/MANIFEST.json` with per-binary
SHA-256 hashes.

The script asserts `bun --version >= 1.3.0` before any work
and exits non-zero with a clear message if the host Bun is
too old.

## Install

Pick the binary for the consumer platform from the GitHub
release for the desired version. Verify its SHA-256 against
the release's `MANIFEST.json`, then drop it onto `PATH`:

```bash
# linux-x64 example
curl -L -o agent-recall https://github.com/xurunxin/AgentRecall/releases/download/v1.1.3/agent-recall-linux-x64
curl -L -o MANIFEST.json https://github.com/xurunxin/AgentRecall/releases/download/v1.1.3/MANIFEST.json
sha256sum -c <(jq -r '.entries[] | select(.platform=="linux-x64" and .kind=="cli") | "agent-recall  " + .sha256' MANIFEST.json)
chmod +x agent-recall
sudo mv agent-recall /usr/local/bin/agent-recall
```

The MCP server binary follows the same recipe
(`agent-recall-mcp-<plat>`).

## Smoke test

```bash
npm run smoke:bun
```

Six-step smoke (`--version`, `help`, `doctor`, export+import
round-trip, `backup`, post-backup `doctor`) against the
host-platform binary. Exits 0 on all passing; emits
`[smoke_failed]` on any failure. Skips cleanly when the
binary is missing.

## Capabilities

| Capability | Node binary | Bun binary |
| --- | --- | --- |
| `--version` / `help` / `doctor` | yes | yes (smoke-tested) |
| `list` / `show` / `search` / `audit` | yes | yes (smoke-tested) |
| `export` / `import` | yes | yes (smoke-tested) |
| `backup` / `restore` | yes | yes (smoke-tested) |
| `migrate --yes` | yes | yes (covered by Node tests; Bun runtime not exercised) |
| `admin grant/status/revoke` | yes | yes (smoke-tested) |
| MCP stdio (10/20 tools) | yes | yes (same `dist/src/index.js` plus Bun runtime) |
| All 24 `doctor` checks | yes (vitest on Node) | smoke-tested on Bun (3 + 6) |
| `AGENT_RECALL_HOME` env var | yes | yes |
| `AGENT_RECALL_PROFILE` env var | yes | yes |

## Release channel

Bun binaries are GitHub release artifacts, **not npm
artifacts**. The npm package continues to ship the Node
path only. Rationale:

- Keeps the npm package size unchanged.
- Keeps `package.json` `bin` simple (no platform-matrix
  postinstall).
- Decouples Bun-binary publication from the npm publish
  cadence — Bun binaries can ship ahead of, alongside, or
  independently of an npm release.

The release-pipeline that consumes `dist-bin/MANIFEST.json`
is the subject of the follow-up ADR (`docs/adr/0007-bun-binary-release.md`),
out of scope for the design and this guide.
