# v1.1.3 release notes

This file is the v1.1.3 release notes for AgentRecall. It documents the
release commit, the platform artifacts, the migration / compatibility
contract, and the known non-blocking limits. The operator pastes this
into the GitHub Release body after the manual `git push origin v1.1.3`.

## Release

| Field | Value |
|-------|-------|
| `release_commit` | `366bc98a04183d3ab1657c91dd873c34745c6ea1` |
| `tag` | `v1.1.3` |
| `date` | 2026-07-30 (lane close; manual GH Release subject to the operator's push) |
| predecessor (`main`) | `366bc98` |

## Platform artifacts

| Platform | Archive | size_bytes | sha256 |
|----------|---------|-----------:|--------|
| linux-x64 | `agent-recall-1.1.3-linux-x64.tar.gz` | 328419 | `1dbc1004d8a692616c0aa6a264d689771c47d996baf5a9a104a2c8aab37b9bdb` |
| darwin-x64 | `agent-recall-1.1.3-darwin-x64.tar.gz` | 657996 | `90676e883cea93c179dbc033ee60b4425eb475f7ca3ab1755304e2bb580d7110` |
| win32-x64 | `agent-recall-1.1.3-win32-x64.zip` | 1357629 | `68b47b4e0418ce251fe59e97ed5378a39835b7ef27050ed0d1e4462cc85322b6` |

All three archives were produced from the same `dist/` tree at the same
commit (`366bc98`); `release-artifact-hashes.json` is the canonical
SHA-256 manifest.

## SHA-256 checksums

For convenience:

```text
1dbc1004d8a692616c0aa6a264d689771c47d996baf5a9a104a2c8aab37b9bdb  agent-recall-1.1.3-linux-x64.tar.gz
90676e883cea93c179dbc033ee60b4425eb475f7ca3ab1755304e2bb580d7110  agent-recall-1.1.3-darwin-x64.tar.gz
68b47b4e0418ce251fe59e97ed5378a39835b7ef27050ed0d1e4462cc85322b6  agent-recall-1.1.3-win32-x64.zip
```

## Migration / compatibility notes

- **Schema-preserving migration**: v1.1.2 → v1.1.3 is schema-preserving.
  The v13 `user_version` is unchanged (the v1.1.3 lane is purely additive
  on top of v1.1.2). The `import_batches.audit_metadata_json` column is
  the only database surface change; `addColumnIfMissing` covers pre-v13
  databases transparently.
- **Identity resolution modes (issue #31)**: `ProjectIdentityResolver.resolve(..., mode)`
  now honours the `mode` argument. `lookup` and `strict_existing` produce
  zero database writes on success and failure; `register` is the only mode
  allowed to insert into `project_identities` / `project_aliases_new`.
  The apply transaction revalidates the identity binding alongside
  revisions + aggregate-budget checks; identity drift between preflight and
  apply rolls back via `identity_drift`.
- **Profile-scoped admin capability (issue #32)**: only an Admin-profile
  process with a valid capability gains `"restricted"` visibility on the
  read surface. A load-time `permission_drift` / `acl_drift` / `symlink`
  / `unsupported_owner` surfaces on `status()` without leaking token bytes.
  The per-request capability path is preserved as the canonical Core /
  Extended authorization surface for capability types without
  `profile_required`.
- **One sensitivity policy (issue #33)**: the `sensitivity` SQL-boundary
  filter resolves to one canonical decision per (profile, capability,
  row-sensitivity) tuple; the per-row visibility envelope is identical
  for `core` and `extended` callers.

## Known non-blocking limits

- `p3-extracted-artifact-lifecycle.test.ts` has one pre-existing regex
  mismatch unrelated to v1.1.3: the suite asserts `release-artifact-hashes-`
  (with a trailing dash) in `release-candidate.yml`, but the workflow uses
  `release-artifact-hashes.json` (no trailing dash before `.json`). The
  regex was tightened in Phase A and the workflow was never patched. The
  failure is documented as a follow-up regression signal; the test is
  excluded from the v1.1.3 release lane on the project's documented
  exclusion list.
- The Windows-only `multi-process-stress` orphan-dir flake (the cleanup
  `rmSync` races the next test's `mkdtempSync`) is documented as a
  pre-existing known non-blocking limit and remains on the exclusion list.
- Windows PowerShell `Expand-Archive` dependency (the matrix leg shells
  `powershell -NoProfile -Command Expand-Archive` for the `.zip` archive
  on Windows runners). The Windows runner image ships PowerShell; a
  future minimised runner image without PowerShell would need a
  Node-native fallback (`node:zlib` + a tar parser).

## npm publish

**`npm publish` is OUT OF SCOPE for v1.1.3.** The package is marked
`"private": true`; the GitHub release artefacts (the three platform
archives + the SHA-256 manifest) are the canonical distribution surface.
Do not attempt `npm publish` against this repository.

## Verification

The local-operator rehearsal evidence is documented in
`docs/superpowers/evidence/2026-07-29-v1.1.3-gate-08.md` (the GATE-08
evidence file). The CI matrix + the GH Actions runs at the canonical
release-commit SHA are the published source of truth; the operator runs
the canonical `scripts/prepare-release.mjs` (DRY_RUN=0) + `scripts/verify-release-evidence.mjs --stable`
invocation just before tagging to capture the final evidence.

Workflow links (placeholders until the operator runs the canonical push):

- Release Candidate Gate: `https://github.com/xurunxin/AgentRecall/actions/runs/<release-candidate-run-id>`
- Release: `https://github.com/xurunxin/AgentRecall/actions/runs/<release-run-id>`

The operator fills in the real URLs after the manual push (the lane
captures the local-rehearsal evidence under
`docs/superpowers/evidence/2026-07-29-v1.1.3-gate-08.md`).
