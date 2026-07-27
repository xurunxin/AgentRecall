# ADR-0004 — Immutable release tag + evidence comment contract

- Status: Accepted
- Date: 2026-07-28
- Issue: #29 (AgentRecall V1 Final Release Task 10)
- Scope: Release publication only (no runtime path)
- Supersedes: none
- Related: ADR-0002 (release candidate gate, issue #27), ADR-0003
  (extracted-artifact lifecycle, issue #28)

## Context

The V1 final release plan freezes the package at version `1.1.2` over the
`feat/v1-final-release` branch. Tasks 0–9 closed the candidate-gate + lifecycle
E2E paths; the final publication step still has to:

1. Mint an annotated `v1.1.2` tag from the **exact** verified candidate commit.
2. Refuse to **ever** move the three protected legacy tags (`v1.0.0`,
   `v1.1.0`, `v1.1.1`). The tag guard in `release.yml` (ADR-0002) enforces
   the upstream side of this contract; the operator-side is enforced by the
   `scripts/prepare-release.mjs` script this ADR introduces.
3. Emit the 9-field evidence contract the `release-candidate.yml` workflow
   ingests into issue #19, so a reviewer can correlate the release with the
   cross-platform evidence without re-running the candidate gate.
4. Decide explicitly that `npm publish` is **not** part of the v1.1.2
   contract — the package is `private: true`, the GitHub release artefacts
   are the canonical distribution surface, and silently publishing a
   private package would invalidate the immutability promise.

## Decision

### Tag immutability

The release-publication script
(`scripts/prepare-release.mjs`) refuses to issue any
`git tag` command that would move an existing tag:

- `git tag -f` / `--force` — refused at the textual level (the script source
  does not contain the pattern; a CI failure is the regression signal).
- `git push --force` / `git push -f` / `git push --tags` — refused at the
  textual level. The script never invokes `git push` of any kind; pushing is
  the operator's explicit call after reviewing the `release-notes.md` and
  `issue-19-evidence-comment.md` artefacts.
- An attempt to publish a `RELEASE_TAG` that matches a protected tag
  (`v1.0.0`, `v1.1.0`, `v1.1.1`, or a previously-published `v1.1.2`) exits
  with status 1 and a structured `stderr` line.

The `release.yml` tag guard (ADR-0002) refuses to package a tag whose commit
SHA differs from the `release_commit` recorded in `release-evidence.json`.
This ADR extends the contract: the **operator-side** `prepare-release.mjs`
script enforces the same SHA-equals-HEAD invariant and refuses to mint a
tag from a different commit, so the publication step and the CI gate stay
in lockstep.

### Annotated tag content

When `DRY_RUN=0`, the script issues:

```text
git tag -a v1.1.2 -F <staging>/tag-message.txt --author "AgentRecall Release <noreply@agent-recall.local>"
```

The author identity is carried by the `--author` flag (no `git config`
invocation); the staging file holds the annotation message:

```text
v1.1.2 release of AgentRecall

release_commit: <40-char SHA>
release_workflow: <workflow URL or local:// placeholder>
date: <ISO 8601 timestamp>
```

The staging directory is created under `$RUNNER_TEMP` when available
(so the GitHub Actions runner cleans it up on job shutdown) or under
`os.tmpdir()` otherwise; `prepare-release.mjs` removes it explicitly
on script exit regardless of outcome.

### Evidence comment contract

The script writes two artefacts inside `ARTIFACT_DIR`:

- `release-notes.md` — Markdown body for the GitHub Release description.
- `issue-19-evidence-comment.md` — Markdown body for the issue #19
  evidence comment.

Both files carry exactly the 9 fields the master plan brief names:

```text
release_commit:
tag:
ci_runs:
release_workflow:
artifacts:
sha256_checksums:
test_summary:
migration_summary:
known_non_blocking_limits:
```

The fields are written as `field: value` lines so the markdown body
survives copy-paste into the GitHub UI without rendering issues. The
`release_commit` value equals `GITHUB_SHA`; the script refuses to run
when `GITHUB_SHA` does not match `git rev-parse HEAD` of the working
tree.

### `DRY_RUN` default

`DRY_RUN=1` is the default. In dry-run mode the script validates every
input and writes the two artefacts; it does **not** issue `git tag`. The
operator reviews the artefacts, then re-runs with `DRY_RUN=0` to mint
the annotated tag. This split keeps the script idempotent under repeat
runs in CI / local experimentation, and avoids the surprise of an
unintended tag landing on the wrong commit.

### `npm publish out of scope`

The `package.json` `private: true` flag stays on. `prepare-release.mjs`
does **not** call `npm publish`. The release-notes + evidence-comment
files both carry an explicit "**npm publish out of scope for v1.1.2**"
line so a future maintainer (or a casual reviewer) cannot accidentally
attempt to publish the private package. Resolving the private flag is a
deliberate decision for a future release, gated by its own ADR.

## Relationship to existing artefacts

- **ADR-0002** — release candidate gate. This ADR extends the
  upstream-side SHA / evidence contract to the operator-side
  publication step. The two contracts share the same
  `release_commit == GITHUB_SHA == HEAD` invariant.
- **ADR-0003** — extracted-artifact lifecycle. The three platform
  archives (`linux-x64` / `darwin-x64` / `win32-x64`) and the
  `release-artifact-hashes.json` manifest are inputs to this ADR's
  `ARTIFACT_DIR` validation; the SHA-256 entries on the evidence
  comment are the same hashes Task 9 computed.
- **`scripts/verify-release-evidence.mjs`** — extended in Task 10
  to enforce the `version` field equal to `1.1.2` AND the
  three-platform `artifacts[]` coverage. The existing field
  validation is preserved verbatim; the new checks are additive.

## Consequences

- A future v1.1.3 patch would mint a new annotated tag, not rewrite
  the existing `v1.1.2` tag. The release-gate test
  (`test/release-gate/p3-release-immutability.test.ts`) asserts the
  script refuses to override any tag — a regression that re-introduces
  `git tag -f` is caught at the textual level.
- The release-notes + evidence-comment artefacts are **not** committed
  to the repository; they live in `ARTIFACT_DIR` only. Operators paste
  them into the GitHub Release body and issue #19 by hand, after
  reviewing the generated SHA-256 entries.
- `package.json` `private: true` stays. The release remains a
  GitHub-artefact-only publication; npm is intentionally out of scope.

## Known limits

- **Operator still has to push the tag.** The script mints the tag
  locally; the `git push origin v1.1.2` step is the operator's
  explicit call, performed after the release-notes / evidence-comment
  review. This is by design: pushing without operator review would
  invert the immutability promise (a CI failure that auto-recovered
  the tag would be invisible to the reviewer).
- **One annotated tag per release.** Re-publishing `v1.1.2` from a
  new commit is impossible by design; the canonical recovery path is
  a new patch version (`v1.1.3`).
- **No per-platform sub-tags.** The three platform archives share
  the single `v1.1.2` tag. A future release that needs per-platform
  attestation would add an ADR + a new `prepare-release-platform.mjs`
  companion script; this ADR does not preclude that.