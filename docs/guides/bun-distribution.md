# Bun single-file binary distribution

The Bun path is an **additive** distribution channel. The Node
npm package (`agent-recall`) is still primary. The Bun binary
exists for operators who need a single-file drop-in and can
accept the smaller surface coverage (smoke-tested, not
vitest-tested). **Current implementation: v1.1.5.**

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
curl -L -o agent-recall https://github.com/xurunxin/AgentRecall/releases/download/v1.1.5/agent-recall-linux-x64
curl -L -o MANIFEST.json https://github.com/xurunxin/AgentRecall/releases/download/v1.1.5/MANIFEST.json
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

Seven-step smoke (`--version`, `help`, `doctor`, export+import
round-trip, `backup`, post-backup `doctor`, HTTP daemon
end-to-end probe) against the host-platform binary. Exits 0
on all passing; emits `[smoke_failed]` on any failure. Skips
cleanly when the binary is missing. The HTTP probe is
covered in the next section.

## Shared HTTP daemon

v1.1.5 adds an `agent-recall --http` mode: a local HTTP
daemon that multiple HTTP-capable agents (Bun-friendly
sub-agents included) share via a single process, a single
`MemoryService`, and a single SQLite connection, with
per-MCP-session actor isolation. The mode is the answer to
"dozens of idle stdio child processes on a busy host": one
daemon, many clients. The stdio path is unchanged (the
v1.1.4 `server-lifecycle` contract still applies), and a
new stdio idle-exit covers the long-tail cleanup case (see
`AGENT_RECALL_STDIO_IDLE_MS` below).

> **Important:** `agent-recall-mcp --http` does **not** enter
> HTTP mode. The compatibility name `agent-recall-mcp` is
> always stdio (the v1.1.4 dispatch contract is preserved;
> both `--http` and `AGENT_RECALL_MCP_TRANSPORT` are ignored).
> HTTP mode is reachable only from `agent-recall`.

### Launch

```bash
agent-recall --http
```

A soft env-var switch is also available (when `agent-recall`
sees `AGENT_RECALL_MCP_TRANSPORT=http` it behaves the same
as `--http`; other values like `HTTP` / `stdio` are no-ops):

```bash
AGENT_RECALL_MCP_TRANSPORT=http agent-recall list
```

`agent-recall` with neither `--http` nor
`AGENT_RECALL_MCP_TRANSPORT=http` falls back to the v1.1.5
default (no arguments → stdio, `<subcommand>` → CLI).

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_RECALL_HTTP_HOST` | `127.0.0.1` | Bind interface. Keep it on loopback; there is no auth fallback for a public interface. |
| `AGENT_RECALL_HTTP_PORT` | `7777` | Listen port. Setting `0` to ask the OS for a free port is **not supported** (see "Known limitations" below). |
| `AGENT_RECALL_HTTP_ALLOWED_ORIGINS` | (empty) | Comma-separated browser origin allow-list (e.g. `http://localhost:5173`). Empty accepts only non-browser clients with no `Origin` header. |
| `AGENT_RECALL_HTTP_VERBOSE` | (off) | Set to `1` to emit `[mcp-http] …` diagnostic lines on stderr (start / shutdown / handler errors). Leave off in production. |
| `AGENT_RECALL_MCP_TRANSPORT` | (unset) | `agent-recall` switches to HTTP when the value is the literal `http`; other values are no-ops. |
| `AGENT_RECALL_PROFILE` | `core` | Decides which MCP tool set is registered. `admin` also requires a local `admin.cap` capability; missing it causes the daemon to fail to start with a non-zero exit. |
| `AGENT_RECALL_HOME` | platform default | Data home; the lockfile and SQLite live under it. |
| `AGENT_RECALL_STDIO_IDLE_MS` | `600000` (10 min) | **stdio-only** idle-exit threshold (no MCP message and no in-flight request for N ms → exit), reusing the `server-lifecycle` 1.5 s ceiling + second-signal escape. `0` disables. HTTP mode does not read this variable. |

### Lockfile and bearer token

The launcher calls `acquireOrJoin` at startup:

- Lockfile path: `${AGENT_RECALL_HOME}/.mcp-${AGENT_RECALL_PROFILE}.lock`.
- First start: `fs.open('wx')` atomic create, then write the JSON payload:
  ```json
  {
    "pid": 12345,
    "endpoint": "http://127.0.0.1:7777/mcp",
    "transport": "tcp",
    "token": "<64 hex chars; 32 raw bytes>",
    "started_at": "2026-08-08T...",
    "version": "1.1.5",
    "data_home": "...",
    "profile": "core"
  }
  ```
- Existing lock: check whether the recorded `pid` is alive + TCP probe the port; either failure unlinks the old lock and the launcher takes over.
- Token length is 64 hex chars (32 random bytes; same entropy budget as `admin.cap`). On POSIX the file mode is tightened to `0o600`.
- **Same `pid` calling twice joins** (returns the existing endpoint + token) instead of overwriting.

Clients **must** present the token as a Bearer:

```
Authorization: Bearer <64 hex chars>
```

### Client connection contract

Every MCP client must satisfy:

1. `Authorization: Bearer <token>` is required. Missing → 401 + `WWW-Authenticate: Bearer`.
2. `Accept: application/json, text/event-stream` is required. Missing → the SDK 406s in pre-flight with `Not Acceptable: Client must accept both application/json and text/event-stream`.
3. `Content-Type: application/json`.
4. The first `initialize` request's `params` **must** include `actor` (missing → 400 `missing_actor`; malformed → 400 `invalid_actor`):
   ```json
   {
     "jsonrpc": "2.0",
     "id": 1,
     "method": "initialize",
     "params": {
       "protocolVersion": "2025-03-26",
       "capabilities": {},
       "clientInfo": { "name": "my-agent", "version": "0.1.0" },
       "actor": { "kind": "agent", "id": "my-agent-001" }
     }
   }
   ```
   `actor.kind` must be one of `"agent"` / `"user"` / `"service"`; `actor.id` is a non-empty string. Once the session registers its `actor`, the value is locked for the session's lifetime (spec § actor 锁定).
5. The `initialize` response carries an `mcp-session-id` header. Subsequent POSTs echo it; DELETE with `mcp-session-id` closes the session.

Minimal Node / Bun `fetch` example after the token is read from the lockfile:

```ts
const res = await fetch(endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "demo", version: "0" },
      actor: { kind: "agent", id: "demo" },
    },
  }),
});
const sessionId = res.headers.get("mcp-session-id");
// Subsequent tools/list / tools/call must echo mcp-session-id
```

`scripts/smoke-bun-binary.mjs` step 7 is the end-to-end
reference: spawn `agent-recall --http`, wait for the
lockfile, read `endpoint` + `token`, send `initialize` (with
`actor`), capture `mcp-session-id`, send `tools/list` to
verify the per-session `McpServer` (the Task 11 fix), send
SIGTERM, and clean up the temp `AGENT_RECALL_HOME`.

### Known limitations (v1.1.5 deferrals)

- **Lockfile is not unlinked on clean shutdown.** The daemon
  finishes its shutdown sequence with `process.exit(0)`,
  which skips the launcher's `try/finally release()` wrapper
  around `runHttpServer`. The next launcher's `acquireOrJoin`
  reclaims the stale lock via the pid-alive + port probes;
  the new daemon takes over and the token rotates.
- **OS-assigned port (`port=0`) is not supported.** The
  lockfile's `endpoint` is the *requested*
  `AGENT_RECALL_HTTP_PORT`, not the actually-bound port;
  clients following the recorded endpoint will not connect.
  Pin a fixed port in production.
- **Network-share data home.** A soft `fs.lstat` check on
  the lockfile's parent directory is planned (per spec § 错误处理)
  to print a stderr warning on NFS / SMB without refusing startup.
  It is not yet implemented in v1.1.5. Putting
  `AGENT_RECALL_HOME` on a local filesystem is the safe choice
  either way (today's behaviour just doesn't warn, so mitigate
  upstream).

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
| MCP stdio idle exit (`AGENT_RECALL_STDIO_IDLE_MS`, default 10 min, `0` disables; v1.1.5) | yes | yes |
| Shared HTTP daemon (`agent-recall --http`, Bearer + per-session actor; v1.1.5) | yes | yes (smoke step 7) |
| All 24 `doctor` checks | yes (vitest on Node) | smoke-tested on Bun (3 + 6) |
| `AGENT_RECALL_HOME` env var | yes | yes |
| `AGENT_RECALL_PROFILE` env var | yes | yes |
| `AGENT_RECALL_HTTP_HOST` / `AGENT_RECALL_HTTP_PORT` env vars (v1.1.5) | yes | yes |
| `AGENT_RECALL_HTTP_ALLOWED_ORIGINS` env var (v1.1.5) | yes | yes |
| `AGENT_RECALL_HTTP_VERBOSE` env var (v1.1.5; HTTP diagnostic stderr) | yes | yes |
| `AGENT_RECALL_MCP_TRANSPORT` env var (v1.1.5; `http` soft switch) | yes | yes |
| `AGENT_RECALL_VERBOSE_STDIO` env var (v1.1.4) | yes | yes |

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
