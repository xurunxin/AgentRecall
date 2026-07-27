# ADR-0003 — Extracted-artifact MCP lifecycle E2E

- Status: Accepted
- Date: 2026-07-27
- Issue: #28 (AgentRecall V1 Final Release Task 9)
- Scope: CI and release publication only

## Context

Task 8 / #27 introduced the `mcp-blackbox-extracted`
matrix job: it downloads the candidate workflow's
built `dist/` artefact and re-runs the existing MCP
blackbox suites against it. The gate proves that the
build artefact survives a download + reload, but it
does NOT prove that a fully packaged archive (the
`.tar.gz` a Linux consumer downloads, the `.tar.gz`
a macOS consumer downloads, the `.zip` a Windows
consumer downloads) is a complete, self-contained MCP
server. The existing matrix leg produces `dist/`
directly; the cross-platform release workflow packages
`dist/` + `package.json` + `README.md` + `LICENSE`
into a platform-specific archive. The gap is the
packaging step + the consumer-side extraction step:
none of them is currently exercised on every commit.

A second gap is that the existing blackbox suites
(`mcp-client-e2e.test.ts` /
`mcp-all-tools-e2e-{core,extended}.test.ts` /
`admin-default/mcp-admin-default.test.ts`) cover the
mutation + retrieval + project identity + admin
boundary contracts, but they do NOT assert the
documented **full** lifecycle against a single client
session:

1. `initialize` + capability negotiation
2. exact tools / resources discovery (Core /
   Extended / Admin canonical lists)
3. `remember` + idempotent replay + key-reuse
   rejection
4. CAS update + stale revision rejection
5. project identity registration / lookup /
   conflict
6. `search` + `recall`
7. sensitivity / trust authorised AND
   unauthorised (`forbidden_visibility` on
   restricted reads without a capability)
8. maintenance plan / apply on the permitted
   profile
9. snapshot export / import round-trip through
   the **packaged CLI** (`dist/bin/agent-recall.js`,
   not `bin/agent-recall.ts`)
10. backup / doctor / CLI entry points (using the
    packaged CLI)
11. clean shutdown — empty stderr (modulo the
    documented allowed diagnostics), no leaked
    process, no leaked temp directory

## Decision

The candidate workflow grows three new matrix steps:

- `Pack candidate release artifact` — mirrors
  `.github/workflows/release.yml`'s
  `Strip dev-only artefacts` + `Pack` steps. The
  matrix leg produces a platform-correct archive
  (`agent-recall-<version>-linux-x64.tar.gz`,
  `-darwin-x64.tar.gz`, or `-windows-x64.zip`) under
  the workspace.
- `Extract candidate release artifact` — calls
  `node scripts/extract-release-artifact.mjs` with
  the archive + a clean
  `$RUNNER_TEMP/agent-recall-extracted` target. The
  script is dependency-free (Node 18+ stdlib only)
  and uses `tar -xzf` on POSIX + PowerShell
  `Expand-Archive` on Windows. The script also
  asserts the extracted tree contains the canonical
  entry points (`dist/src/index.js`,
  `dist/bin/agent-recall.js`, `package.json`); a
  partial extraction is a non-zero exit and halts
  the matrix leg.
- `Install runtime deps in extracted artifact` —
  `npm install --omit=dev` inside the extracted
  tree. The archive's `package.json` `files` list
  ships `dist`, `README.md`, `LICENSE`,
  `CHANGELOG.md` — it does NOT ship `node_modules`.
  The install step matches the consumer surface.
- `Compute candidate release artifact hashes` —
  calls `node scripts/compute-artifact-hashes.mjs`
  on the archive. The script is dependency-free and
  writes a `release-artifact-hashes.json` with one
  row per artefact (`platform`, `artifact_path`,
  `sha256`, `size_bytes`, `mtime`). The matrix
  uploads it as part of the evidence fragment.
- `Extracted-artifact lifecycle E2E` — runs the new
  `test/blackbox/packaged-install.test.ts` suite
  with `AGENT_RECALL_EXTRACTED_ARTIFACT` pointing at
  the extracted directory. The suite spawns the
  **packaged** MCP server (`<extracted>/dist/src/index.js`)
  and exercises all 11 lifecycle scenarios above.

The `record-evidence` job ingests the
`release-artifact-hashes.json` fragments from every
matrix leg and feeds the aggregated
`sha256_checksums` map into
`scripts/release-evidence.mjs` via
`RELEASE_EVIDENCE_SHA256_JSON`. The verifier
(`scripts/verify-release-evidence.mjs`) already
asserts `sha256_checksums` is a JSON object; the
record-evidence step populates it with the canonical
per-platform hashes.

The `release.yml` workflow grows a
`verify-extracted-artifacts` matrix job that runs
**after** the `package` matrix and **before** the
`smoke` matrix. The new job downloads each platform
archive, extracts it via
`scripts/extract-release-artifact.mjs`,
re-computes SHA-256 via
`scripts/compute-artifact-hashes.mjs`, installs
runtime deps, and re-runs
`test/blackbox/packaged-install.test.ts` against
each platform artefact. A failure on ANY platform
blocks the tag (the `smoke` matrix `needs` the new
gate).

## Cross-platform extraction

The extraction script handles three archive shapes:

- `.tar.gz` (Linux + macOS): Node spawns `tar -xzf`.
  The matrix runner images all ship BSD tar.
- `.zip` on Windows: Node spawns PowerShell
  `Expand-Archive`. The script does NOT depend on
  `unzip` because the Windows runner image does
  NOT ship `unzip` on PATH (the same surprise Stage
  16 PR-8 surfaced for `release.yml`'s upload-glob;
  PR-8 added `agent-recall-*.zip` to the glob to
  fix the silent drop).
- `.zip` on Linux / macOS: Node spawns `unzip -q
  -o`. The matrix runners ship it pre-installed.

The hash script is platform-agnostic (`node:crypto`
+ `node:fs`).

## Fail-closed semantics

- The matrix leg runs every new step under
  `set -euo pipefail`. A non-zero exit from any of
  `extract-release-artifact.mjs`,
  `compute-artifact-hashes.mjs`, or
  `vitest ... packaged-install.test.ts` halts the
  matrix leg.
- The `record-evidence` job fails closed when the
  `release-artifact-hashes.json` fragments are
  missing — the `set -e` chain surfaces a
  `::error::` annotation before the verify step.
- The release workflow's
  `verify-extracted-artifacts` matrix has no
  `continue-on-error`; a single platform failure
  blocks the tag.
- No `|| true` suppressor is introduced. The
  `mcp-blackbox-extracted` job's existing `|| true`
  removal (Stage 16 PR-8) is preserved end-to-end.

## Known limits

- **Windows PowerShell `Expand-Archive` dependency**
  — the Windows extraction path requires
  PowerShell on PATH. The matrix runner image ships
  it, but a future minimised runner image without
  PowerShell would need a fallback. The fallback
  candidate is Node-native (`node:zlib` + a tar
  parser), deferred to a follow-up release; the
  v1.1.2 contract documents PowerShell as the
  primary Windows path.
- **Matrix leg does not patch the candidate
  workflow's package output** — the matrix job
  produces its OWN archive (via the new
  `Pack candidate release artifact` step), separate
  from `release.yml`'s `package` matrix. Both
  archives carry the SAME `dist/` (built once in
  each leg), but the hash paths differ. The
  `sha256_checksums` field is keyed on
  `artifact_path`, so the two archives' hashes
  coexist on the evidence document without
  collision.
- **`npm install --omit=dev` cost** — the
  matrix leg pays the install cost once per
  matrix entry (3 OSes × 1 Node = 3 installs).
  The cache hit rate is high because the lockfile
  is unchanged; the per-matrix cost is ~10s on the
  reference runner. The release workflow's
  `verify-extracted-artifacts` matrix pays the
  same cost on top of the existing `smoke`
  matrix's install.
- **No application code or dependency is
  introduced by this ADR.** The scripts are pure
  stdlib (`node:child_process`, `node:crypto`,
  `node:fs`). The test file is dependency-free at
  the npm level — it uses `@modelcontextprotocol/sdk`
  (already a runtime dep) + Node's
  `node:child_process.spawn` for the CLI surface.

## Relationship to existing CI

The existing `release-candidate.yml` matrix job
keeps the existing release-critical tests (full
`npm test`, release stress profile, migrations,
backup / restore, strict snapshot import, cleanup,
MCP source / build smoke). The new steps are
**additive** at the end of the matrix leg; the
existing tests are not weakened.

The `mcp-blackbox-extracted` job (Task 8) keeps
downloading the `candidate-dist` artefact and
running the existing blackbox suites against it.
The new `extracted-lifecycle-e2e` step is a
stricter consumer-surface gate: it operates on the
**packaged** archive, after `npm install
--omit=dev`, against a fresh data home.

The `release.yml` workflow keeps the existing
`verify-release-evidence` tag guard, the existing
`package` matrix, and the existing `smoke` matrix.
The new `verify-extracted-artifacts` matrix sits
between `package` and `smoke`; the existing `smoke`
job's `needs` list grows to include it.

No application code or dependency is introduced
by this ADR. Task 10 will populate the immutable
`v1.1.2` tag guard; that work is orthogonal to the
extracted-artifact lifecycle E2E this ADR pins.