# AgentRecall

[![CI](https://github.com/xurunxin/AgentRecall/actions/workflows/ci.yml/badge.svg)](https://github.com/xurunxin/AgentRecall/actions/workflows/ci.yml)

AgentRecall is a local-first MCP server for coding-agent memory. It gives MCP-compatible clients a governed tool surface for storing, searching, maintaining, and exporting global or project-scoped memories.

SQLite is the source of truth. Markdown files are deterministic exports for review and handoff, not the live database. The server runs over stdio and does not require a hosted database, embedding service, or network model call.

## Requirements

- Node.js 24 or newer
- npm
- An MCP-compatible client that can launch a stdio server

## Architecture

`MemoryService` is a façade over three sub-services in `src/services/`:

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
actor, the data home, the active tool profile, and the loaded
capability, and wires them into each sub-service via shared
`ReadContext` / `WriteContext` / `MaintenanceContext` shapes. `backup()`
lives on the façade for historical reasons (Stage 1).

The public API of `MemoryService` plus every public method is the
v1.1.3 contract: side-effect-free identity resolution (#31), a
profile-scoped admin capability with load-time permission validation
(#32), and a single canonical `AuthorizationDecision` for every
content-bearing path (#33). The split into three sub-services is a
maintainability change with zero user-visible behaviour change.

## Setup (source build)

Clone, install, build, and run the stdio server:

```bash
git clone https://github.com/xurunxin/AgentRecall.git
cd AgentRecall
npm install
npm run build
npm start
```

For local development (no build step):

```bash
npm run dev
```

The package binary also points at `dist/src/index.js` after build.
See [Installation](#installation) for the canonical-platform artefact
recipe.

## MCP vs CLI

AgentRecall ships two binaries:

| Binary | Backing file | Purpose |
| --- | --- | --- |
| `agent-recall-mcp` | `dist/src/index.js` | MCP stdio server (10 read / write / plan tools by default; opt-in to the 20-tool surface via `AGENT_RECALL_PROFILE=extended`) |
| `agent-recall` | `dist/bin/agent-recall.js` | Standalone CLI for one-off inspection, health checks, manual backups, and schema migration |

Run the CLI via:

```bash
node dist/bin/agent-recall.js doctor
# or, after `npm install`:
npx agent-recall doctor
```

`agent-recall --version` / `agent-recall -v` print the server version
and exit (the same value the MCP handshake and every
`meta.server_version` field surface — the canonical source is
`src/server-version.ts`).

## Data Directory

By default, runtime data lives under:

```text
~/.agent-recall/
```

Set `AGENT_RECALL_HOME` to use a different directory:

```bash
AGENT_RECALL_HOME=/path/to/agent-recall npm start
```

Home-relative values beginning with `~/` or `~\` are expanded against
the current user's home directory. Other values are resolved to an
absolute path. In JSON client configs on Windows, escape backslashes,
for example `C:\\path\\to\\agent-recall-data`. The legacy
`LOCAL_MEMORY_MCP_HOME` variable is no longer documented; the v1.1.3
contract is `AGENT_RECALL_HOME` only.

## MCP Client Config

Most MCP clients support a JSON server entry. Use the built file after
`npm run build`:

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

The packaged MCP default is the **Core** profile (10 read / write /
plan tools). Set `AGENT_RECALL_PROFILE=extended` in the `env` block to
opt in to the 20-tool `Extended` profile (memory-semantics +
administrative tools). The `admin` profile is opt-in via
`AGENT_RECALL_PROFILE=admin` AND a valid operator capability; install
one via `agent-recall admin grant`. See [Capabilities](#capabilities)
and `docs/adr/0005-profile-scoped-admin-capability.md` for the full
contract.

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

## Tools (per-profile tool lists)

The three profiles register different tool sets. The Core profile is
the packaged default; Extended adds memory-semantics + administrative
tools; Admin inherits the 20-tool Extended surface and gates
profile-required capabilities behind a valid operator capability.

| Profile | `AGENT_RECALL_PROFILE` | Tool count | Tools |
| --- | --- | --- | --- |
| Core | (unset) | 10 | `recall_context`, `remember`, `search_memories`, `get_memory`, `list_memories`, `update_memory`, `supersede_memory`, `forget_memory`, `get_memory_budget`, `maintain_memories` |
| Extended | `extended` | 20 | the Core 10 + `merge_memories`, `record_memory_feedback`, `record_memory_provenance`, `explain_memory_provenance`, `confirm_memory_trust`, `plan_maintenance`, `apply_maintenance`, `export_memory_context`, `import_memory_context` (1 placeholder), `audit_memory` (1 placeholder) |
| Admin | `admin` (requires capability) | 20 | identical surface to `extended`; the difference is the load-time capability gate — a server with `AGENT_RECALL_PROFILE=admin` refuses to bind to stdio without a valid operator capability at `${AGENT_RECALL_HOME}/admin.cap` |

`memory://health` surfaces the active profile as `active_profile` AND
the admin boundary state as `capability_state` (`granted` / `missing`).

## Project Identity

AgentRecall distinguishes three project-identity resolution modes,
shipped by v1.1.3 GATE-01 (issue #31):

- `lookup` — pure read; an unknown `project_path` returns
  `identity_conflict` with **zero** writes to `project_identities` /
  `project_aliases_new`.
- `strict_existing` — refuses an unbound `project_id` /
  `project_path`; the canonical preflight + apply-time revalidation
  surface.
- `register` — the only mode allowed to insert into
  `project_identities` / `project_aliases_new`. This is the canonical
  registration path: `MemoryWriteService.configureProjectBudget(...)`
  or the CLI `agent-recall project register <path>`.

The escape hatch `AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID=1` is preserved
for one-off operator triage. It is NOT appropriate for production
agent flows; it lets a `project_id`-only call without a registered
identity proceed in "unbound" mode. See
`docs/adr/0004-identity-resolution-modes.md` for the full design and
`docs/guides/identity-resolution.md` for the operator-facing guide.

## Capabilities

v1.1.3 GATE-02 (issue #32) closes the v1.1.2 admin-boundary gaps. The
contract is:

- **Profile-scoped visibility.** Only the Admin-profile process with a
  valid capability gains `"restricted"` visibility. A Core / Extended
  process with `admin.cap` in its data home stays at `"normal"` (the
  v1.1.2 visibility leak is closed).
- **Load-time permission validation.** Before the JSON parse, the
  capability file's POSIX mode + owner + symlink status are checked;
  on Windows, an `icacls` ACL probe refuses any non-system non-owner
  principal. A drift sets the in-memory token to empty; `status()`
  surfaces `{kind: "drift", drift_reason, path}` without leaking
  token bytes.
- **Per-request capability.** A Core / Extended caller may supply a
  per-request capability token to authorize a privileged operation
  (the per-request path does NOT depend on the active profile);
  capability types with `profile_required: "admin"` are refused on
  Core / Extended with `reason: "profile_mismatch"`.

Grant / status / revoke flow:

```bash
agent-recall admin grant
agent-recall admin status
agent-recall admin revoke
```

See `docs/adr/0005-profile-scoped-admin-capability.md` for the design
and `docs/guides/operator-capability.md` for the operator-facing
flow.

## Sensitivity

v1.1.3 GATE-03 (issue #33) collapses every read / export / resource /
maintenance / CLI / MCP path onto a single canonical
`AuthorizationDecision` (`max_sensitivity`, `capability_token_present`,
`reasoning`). The decision is the single source of truth for every
content-bearing path; the SQL-boundary filter remains the ONLY place
sensitivity is decided.

The 3×3 visibility matrix (3 profiles × 3 sensitivity levels):

| Profile | normal | private | restricted |
| --- | --- | --- | --- |
| Core | yes | yes | no |
| Extended | yes | yes | no |
| Admin (with capability) | yes | yes | yes |

A restricted export on a Core / Extended process surfaces
`FORBIDDEN_VISIBILITY`; the CLI exits 1 with the stable
`forbidden_visibility` code. See
`docs/adr/0006-one-sensitivity-policy.md` for the design and
`docs/guides/sensitivity-matrix.md` for the operator-facing matrix.

## Installation

The canonical installation recipe is **download a platform-specific
archive, verify its SHA-256, extract, install runtime deps, and run**.
The archive name embeds the canonical platform token; the platform
vocabulary is `linux-x64`, `darwin-x64`, `win32-x64`.

```bash
# 1. Pick the canonical-platform artefact
VERSION="1.1.3"
PLATFORM="linux-x64"   # or `darwin-x64` or `win32-x64`
ARCHIVE="agent-recall-${VERSION}-${PLATFORM}.tar.gz"
# Windows: `agent-recall-${VERSION}-${PLATFORM}.zip`

# 2. Download the archive + its SHA-256 manifest from the GitHub
#    release for `v${VERSION}` (the release body lists every
#    archive alongside its SHA-256).

# 3. Verify integrity
sha256sum -c "agent-recall-${VERSION}-${PLATFORM}.sha256"

# 4. Extract
tar -xzf "$ARCHIVE"              # POSIX (linux-x64 / darwin-x64)
# Windows (PowerShell):
#   Expand-Archive -Path "${ARCHIVE}.zip" -DestinationPath .

# 5. Install runtime deps (the archive ships `dist` + `README.md` +
#    `LICENSE` + `CHANGELOG.md`; it does NOT ship `node_modules`).
(cd agent-recall-${VERSION} && npm install --omit=dev)

# 6. Run
node agent-recall-${VERSION}/dist/src/index.js      # MCP stdio server
node agent-recall-${VERSION}/dist/bin/agent-recall.js doctor   # CLI smoke
```

The `files` array in `package.json` ships `dist`, `README.md`,
`LICENSE`, and `CHANGELOG.md` — NOT `node_modules`. The consumer-side
`npm install --omit=dev` is the canonical install path. The
publication lifecycle (extract → install → lifecycle E2E) is pinned in
`docs/adr/0003-extracted-artifact-lifecycle.md` and
`docs/guides/release-publication.md`.

## OpenCode integration

To use AgentRecall from [OpenCode](https://opencode.ai) register the MCP
server (for active tool calls) and optionally the bundled
prompt-injection plugin (for passive `[AGENT_RECALL]` context on every
LLM turn). The canonical recipe — including `mcp:` and `plugin:`
configuration, environment variables, options table, smoke tests, and
uninstall steps — lives in
[`docs/guides/opencode-install.md`](docs/guides/opencode-install.md).
The plugin source is bundled inside this repository at
`opencode-plugin/`.

The MCP server runs **independently** of the plugin: it is a pure
JSON-RPC-over-stdio process that responds to `initialize` and
`tools/list` without touching the system prompt. The plugin only
appends a context block to `output.system` via
`experimental.chat.system.transform`. Removing the plugin entry from
`opencode.json` does not affect MCP tool availability.

## Upgrade / Rollback

### Upgrade v1.1.2 → v1.1.3

The v1.1.3 migration is **schema-preserving**: the v1.1.2 schema v13
is sufficient. The v1.1.3 lane adds the additive `import_batches`
lineage table (`schema v13`, the row is minted only on a successful
apply) and the additive `audit_metadata_json` column on
`import_batches` (covered by `addColumnIfMissing` for pre-existing
v13 databases). `user_version` stays at `13`.

Upgrade recipe (per host):

1. Stop the running MCP server / CLI process.
2. Replace `dist/` with the v1.1.3 build (`tar -xzf` / `Expand-Archive`).
3. Re-run `npm install --omit=dev` if the new `package.json` carries
   a dependency change (v1.1.3 does not).
4. Run `node dist/bin/agent-recall.js migrate --yes` (no-op for
   v13 → v13; idempotent for any pre-existing v0..v12 store that
   needs the staged migrations).
5. Restart the MCP server with the same `AGENT_RECALL_HOME` and
   `AGENT_RECALL_ACTOR`.

### Rollback v1.1.3 → v1.1.2

The v1.1.2 surface is preserved by the v1.1.3 release (no breaking
changes). To roll back:

1. Stop the running MCP server / CLI process.
2. Restore the v1.1.2 `dist/` from a known-good backup (the
   `agent-recall backup` command writes
   `<AGENT_RECALL_HOME>/backups/memory-<timestamp>.sqlite`).
3. If the v1.1.3 `import_batches` lineage rows are unwanted, run
   `node dist/bin/agent-recall.js doctor` to confirm no v1.1.3-only
   data is in the live store.
4. Restart the MCP server with the v1.1.2 binary.

The schema-preserving contract means a roll-forward (v1.1.2 → v1.1.3)
or roll-backward (v1.1.3 → v1.1.2) does NOT require a data migration.

## Configuration

The server reads these env vars at runtime (no restart needed; the
next call picks up the new value). All have safe defaults; setting an
invalid value falls back to the default with a one-line stderr
warning.

| Env var | Default | Purpose |
| --- | --- | --- |
| `AGENT_RECALL_HOME` | `~/.agent-recall` | Where the SQLite file, backups, and exports live. |
| `AGENT_RECALL_ACTOR` | `agent` | Default actor name for audit rows. Set to `agent:claude-code`, `agent:cursor`, etc. in your MCP client config so per-agent view, trust_boost, and last_accessed_by work end-to-end. |
| `AGENT_RECALL_STALE_DAYS` | `90` | Threshold for the `stale_memories` doctor check. Must be a positive integer. |
| `AGENT_RECALL_TRUST_STRONG` | `0.3` | Recall `trust_boost` for memories the calling agent wrote. Must be in `[0, 1]`. |
| `AGENT_RECALL_TRUST_SOFT` | `0.1` | Recall `trust_boost` for memories the calling agent recently touched. Must be in `[0, 1]`. |
| `AGENT_RECALL_SUPPRESS_MCP_DEPRECATION` | unset | Set to `1` to silence the one-time MCP server deprecation notice. |
| `AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID` | unset (strict-by-default) | v1.1.2 (issue #21) → v1.1.3 (#31): default-off legacy escape hatch. When set to `1`, a `project_id`-only call without a registered identity is allowed in "unbound" mode. The default strict mode refuses unknown ids at the resolver before any project scope, alias, memory, audit, or budget row is created. |
| `AGENT_RECALL_PROFILE` | `core` (the packaged default) | v1.1.2 (issue #22 + #23) → v1.1.3 (#32): selects the active MCP tool profile. `core` registers the 10 read / write / plan essentials; `extended` adds 10 memory-semantics + administrative tools; `admin` registers the same 20-tool surface as `extended` but gates `profile_required: "admin"` capabilities behind the load-time capability check. Unknown values fail-closed at startup. |

## Memory Hygiene

- At task start, prefer `recall_context` with the current task query
  and, when available, the current project path. The output ranks the
  calling agent's own knowledge first and annotates each entry with
  `[writer: <actor>]` so authorship is visible at a glance.
- Keep each memory atomic: one preference, decision, constraint,
  lesson, or debugging fact per entry.
- Search before writing to avoid duplicate or near-duplicate
  memories.
- **Cross-agent dedup**: a `remember` that rephrases an existing
  memory by ≥ 0.7 token-set Jaccard returns the new memory **and** an
  advisory `near_duplicate` warning in `warnings[]`. The exact-match
  `duplicate_candidate` path is still a hard block that requires
  `confirm_write: true`.
- Use project scope for repository-specific facts, paths, commands,
  and debugging lessons.
- Use global scope only for cross-project preferences and stable
  operating constraints.
- Prefer high-confidence, durable facts. Archive or supersede stale
  entries instead of accumulating contradictions.
- Never store secrets, private keys, bearer tokens, raw `.env` files,
  credentials, or customer-sensitive data.
- Secret-looking writes and updates are rejected before storage, and
  rejection audit metadata does not include the raw secret text.
- When a write returns `capacity_exceeded`, search or run maintenance
  before retrying.

## Local Storage

The authoritative SQLite database is stored at:

```text
<AGENT_RECALL_HOME>/memory.sqlite
```

Generated markdown exports are stored at:

```text
<AGENT_RECALL_HOME>/exports/
```

Markdown exports are for inspection and handoff. Manual edits under
`exports/` may be overwritten by `maintain_memories` with
`action: "rebuild_markdown_index"`.

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
schema upgrades or hand-edits to the SQLite file. `--json` is
supported for scripting. The full operator-facing guide is in
[`docs/guides/release-publication.md`](docs/guides/release-publication.md).

## Release Publication

The release process is governed by:

- [`docs/adr/0003-extracted-artifact-lifecycle.md`](docs/adr/0003-extracted-artifact-lifecycle.md) — the
  cross-platform `Pack → Extract → Install → Lifecycle E2E` gate.
- [`docs/adr/0004-immutable-tag-and-evidence.md`](docs/adr/0004-immutable-tag-and-evidence.md) — the
  immutable-tag + evidence-comment contract.
- [`docs/adr/0007-release-evidence-contract.md`](docs/adr/0007-release-evidence-contract.md) — the
  v1.1.3 evidence schema (canonical platforms, fail-closed verifier,
  stable invariants).
- [`docs/adr/0008-deterministic-orchestration.md`](docs/adr/0008-deterministic-orchestration.md) — the
  5-job CI topology (per-suite + matrix leg + release-aggregate).
- [`docs/guides/release-publication.md`](docs/guides/release-publication.md) — the
  operator-facing `prepare-release.mjs` flow + the publication gate.
- [`docs/guides/release-test-topology.md`](docs/guides/release-test-topology.md) — the
  per-suite CI map (which job runs which suite; expected duration
  ranges; where to look when a job fails).

## Release Candidate Gate

Operators publish only from a commit with exact, retained release
evidence:

1. Freeze the intended commit and push it to an `rc-*` branch, for
   example: `git push origin HEAD:rc-1.1.3-candidate`. This triggers
   `.github/workflows/release-candidate.yml` on Ubuntu, macOS, and
   Windows with Node 24. Do not add release-blocking changes after
   the run; a new commit requires a new candidate run and invalidates
   the earlier evidence.
2. Wait for the `Release Candidate Gate` workflow to finish
   successfully. The run checks the exact candidate SHA, release
   stress profile, migrations, backup / restore, strict snapshot
   import, cleanup, MCP profiles, and artifact globs. It uploads
   `release-evidence.json` and `release-candidate.json`.
3. Before tagging, copy the candidate commit SHA and the workflow URL
   into [issue #19](https://github.com/xurunxin/AgentRecall/issues/19).
   In a review or issue comment, cite both values explicitly, for
   example:
   `candidate SHA: <40-char SHA>; workflow: https://github.com/xurunxin/AgentRecall/actions/runs/<run-id>`.
4. Push the release tag only after the evidence is green:
   `git tag v1.1.3 <candidate-sha> && git push origin v1.1.3`.
   `release.yml` finds a successful candidate workflow for that exact
   SHA, verifies the evidence artifact and `release_commit`, and fails
   closed if the tag points anywhere else. A tag cannot rely on
   legacy commit-status contexts alone.

The evidence artifact is the operator's audit link: it contains the
candidate SHA, workflow URL and job URLs with conclusions and
durations, OS / Node details, test and migration counts, artifact
names, and known non-blocking limits.

## Extracted-artifact lifecycle E2E

A separate CI gate (`.github/workflows/release-candidate.yml`
`matrix` job + `.github/workflows/release.yml`
`verify-extracted-artifacts` job) exercises the **packaged** release
archive end-to-end on Linux, macOS, and Windows. The gate is
independent of the source / build smoke (`mcp-blackbox-extracted`),
which still downloads the built `dist/` and runs the existing
blackbox suites.

The lifecycle gates:

1. **Pack candidate release artifact** — mirror the production
   `release.yml` `Strip dev-only artefacts` + `Pack` steps
   (`.tar.gz` on Linux / macOS, `.zip` on Windows).
2. **Extract candidate release artifact** — call
   `node scripts/extract-release-artifact.mjs` with the archive path +
   `$RUNNER_TEMP/agent-recall-extracted` + the platform tag
   (`linux` / `darwin` / `win32`). The script spawns `tar -xzf` on
   POSIX, PowerShell `Expand-Archive` on Windows, or `unzip -q -o`
   for Linux / macOS `.zip` archives, then asserts the extracted
   tree contains the canonical entry points (`dist/src/index.js` +
   `dist/bin/agent-recall.js` + `package.json`).
3. **Install runtime deps in extracted artifact** — `npm install
   --omit=dev` inside the extracted tree. The archive's
   `package.json` `files` list ships `dist` + `README.md` +
   `LICENSE` + `CHANGELOG.md` and does NOT ship `node_modules`; the
   install step matches the consumer surface.
4. **Compute candidate release artifact hashes** — call
   `node scripts/compute-artifact-hashes.mjs` on the archive. The
   script writes `release-artifact-hashes.json` (`{ schema_version,
   candidate_sha, generated_at, artifacts: [{ platform,
   artifact_path, sha256, size_bytes, mtime }] }`). The matrix
   uploads the JSON as part of the evidence fragment.
5. **Extracted-artifact lifecycle E2E** — run
   `npx vitest run test/blackbox/packaged-install.test.ts` with
   `AGENT_RECALL_EXTRACTED_ARTIFACT` pointing at the extracted
   directory. The suite spawns the **packaged** MCP server and runs
   the 11 documented lifecycle scenarios end-to-end.
6. `record-evidence` aggregates every matrix leg's
   `release-artifact-hashes.json` into a single `sha256_checksums`
   map keyed on `artifact_path`, and
   `scripts/release-evidence.mjs` forwards it into
   `release-evidence.json`.

The `release.yml` `verify-extracted-artifacts` matrix re-downloads
each platform artefact, re-extracts it, re-computes SHA-256, and
re-runs the lifecycle E2E. A failure on ANY platform blocks the tag.

### Run the lifecycle locally

```bash
npm run build
STAGE="stage-agent-recall"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R dist "$STAGE/dist"
cp package.json "$STAGE/package.json"
cp README.md "$STAGE/README.md"
cp LICENSE "$STAGE/LICENSE"
VERSION=$(node -e 'console.log(require("./package.json").version)')
tar -czf "agent-recall-${VERSION}-linux-x64.tar.gz" -C "$STAGE" .

AGENT_RECALL_PACKAGED_ARTIFACT="agent-recall-${VERSION}-linux-x64.tar.gz" \
AGENT_RECALL_EXTRACT_DIR="$PWD/extracted" \
AGENT_RECALL_PLATFORM="linux" \
  node scripts/extract-release-artifact.mjs

(cd extracted && npm install --omit=dev)

GITHUB_SHA="$(git rev-parse HEAD)" \
MATRIX_OS="linux" \
  node scripts/compute-artifact-hashes.mjs "agent-recall-${VERSION}-linux-x64.tar.gz"

AGENT_RECALL_EXTRACTED_ARTIFACT="$PWD/extracted" \
AGENT_RECALL_SUPPRESS_MCP_DEPRECATION="1" \
  npx vitest run test/blackbox/packaged-install.test.ts
```

The gate is documented in
[`docs/adr/0003-extracted-artifact-lifecycle.md`](docs/adr/0003-extracted-artifact-lifecycle.md).

## Immutability + Evidence

The publication step is governed by the immutable-tag + evidence-comment
contract documented in
[`docs/adr/0004-immutable-tag-and-evidence.md`](docs/adr/0004-immutable-tag-and-evidence.md).
The operator-facing surface is `scripts/prepare-release.mjs`:

- The existing tags `v1.0.0` / `v1.1.0` / `v1.1.1` / `v1.1.2` are
  **never** moved. `prepare-release.mjs` refuses to override any tag
  that already exists; the script source does not contain
  `git tag -f` / `git push --force` / `git push --tags`, and a CI
  failure is the regression signal.
- `GITHUB_SHA` MUST equal `git rev-parse HEAD` at publication time. A
  mismatch exits 1 with a structured `stderr` line; the script will
  not mint a tag from a commit that is not checked out.
- `ARTIFACT_DIR` MUST contain all three platform release archives
  (`linux-x64` / `darwin-x64` / `win32-x64`) AND the canonical
  `release-artifact-hashes.json` produced by
  `scripts/compute-artifact-hashes.mjs`. A missing platform or a
  stale hash manifest exits 1.
- `DRY_RUN=1` is the default: the script validates every input and
  writes `release-notes.md` + `issue-19-evidence-comment.md` under
  `ARTIFACT_DIR`, but it does **not** create the annotated tag.
  Re-run with `DRY_RUN=0` after reviewing the artefacts to mint
  the tag.
- The author identity is carried by the `--author` flag on
  `git tag -a`; the script never calls `git config` and does not
  touch the developer's `~/.gitconfig`.

```bash
GITHUB_SHA="$(git rev-parse HEAD)" \
ARTIFACT_DIR="$PWD/dist-stage" \
RELEASE_TAG="v1.1.3" \
DRY_RUN="1" \
  node scripts/prepare-release.mjs
```

The script is dependency-free (Node 18+ stdlib only) and is verified
by `test/release-gate/p3-release-immutability.test.ts`. See
[`docs/guides/release-publication.md`](docs/guides/release-publication.md)
for the full operator-facing flow.

## Development

The project ships a deterministic per-suite orchestrator
(`scripts/run-test-suites.mjs`) that replaces the v1.1.2 monolithic
`npm test`. Every heavyweight suite (MCP black-box, migration /
backup / import, multi-process 10,000-op stress, extracted-artifact
lifecycle) is segregated into an independent script and CI job.

Run the per-suite tests:

```bash
# unit / integration layer (default; the v1.1.3 contract)
npm test

# heavyweight suites (each has its own vitest config)
npm run test:blackbox
npm run test:migrations
npm run test:stress
npm run test:packaged-artifact

# the deterministic orchestrator (runs every suite as a child process
# in the canonical order)
npm run test:all-suites
```

Build, typecheck, and the release-glob verifier:

```bash
npm run build
npm run typecheck
npm run verify:artifacts
```

## Changelog

Stage-level changes are tracked in
[`CHANGELOG.md`](./CHANGELOG.md). The v1.1.3 section is the
unreleased head; the v1.1.2 section is the previous release.

## Verification

```bash
npm test -- test/e2e.test.ts
npm test
npm run typecheck
npm run build
git diff --check
```