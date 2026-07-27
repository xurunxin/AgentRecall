# ADR-0002 — Exact-SHA release candidate gate

- Status: Accepted
- Date: 2026-07-27
- Issue: #27 (AgentRecall V1 Final Release Task 8)
- Scope: CI and release publication only

## Context

A green status context is not sufficient evidence for publishing a release. A
candidate can move after CI has completed, or a tag can point at a different
commit from the one that was tested. Release evidence must therefore identify
one immutable commit and retain links to the actual GitHub Actions workflow and
job executions that tested it.

## Decision

The operator freezes a candidate by pushing the exact source commit to an
`rc-*` branch. The resulting candidate SHA is the immutable release input:
`release-candidate.yml` checks out `github.sha` explicitly and
fails if the checkout does not resolve to that SHA. It runs the release-critical
checks on Ubuntu, macOS, and Windows with Node 24. A later release-blocking
change creates a new commit and invalidates the previous evidence; the old
candidate is never reused for a new tag.

The candidate workflow uploads an evidence artifact containing both
`release-evidence.json` and `release-candidate.json`. The evidence contract
contains:

- `release_commit` and `candidate_sha`;
- `ci_runs`, including OS, Node, workflow URL, job URL, conclusion, and
  duration;
- `release_workflow`, including the workflow run URL and conclusion;
- `test_summary` with passed, failed, skipped, and total counts;
- `migration_summary` with an explicit result for every schema version v0
  through v13;
- artifact names and the `sha256_checksums` placeholder for the later artifact
  hashing task; and
- a non-empty `known_non_blocking_limits` list sourced from `CHANGELOG.md`.

The evidence verifier fails on a missing field, an SHA mismatch, a failed or
skipped release-critical test, a missing schema version, or an empty known
limits list. It requires workflow URLs and conclusions; legacy commit-status
contexts are not accepted as a substitute.

## Tag guard

`release.yml` is tag-only. Before packaging, its `verify-release-evidence` job
uses the GitHub Actions API to locate a successful `release-candidate.yml` run
whose `head_sha` equals the tag SHA. It downloads that run's evidence artifact,
checks `tag_commit_sha == release_commit == GITHUB_SHA`, and runs the evidence
verifier. A mismatch, missing artifact, non-success conclusion, or malformed
evidence exits with status 1. Package and smoke jobs depend on this guard.

This is an exact-SHA guard rather than a time-based or status-context guard. A
new tag must wait for a new successful candidate run if its commit changes.

## Relationship to existing CI

The existing `ci.yml` remains the ordinary main/PR cross-platform matrix and
also runs for `rc-*` branches. It keeps the heartbeat filter for the known
Vitest transport notification while worker failures, timeouts, child-process
leaks, and test failures remain fatal. The candidate workflow is the stronger
release gate: it adds the release stress profile, migration/import/backup/
restore/cleanup checks, extracted-artifact MCP profile checks, and strict
artifact-glob verification.

No application code or dependency is introduced by this ADR. Task 9 will
replace the candidate's extracted-dist fixture with the final extracted package
fixture, and Task 10 will populate real release artifact hashes; neither is
part of this gate's design.
