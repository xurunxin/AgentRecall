# ADR-0007: Release evidence contract

## Status

Accepted for v1.1.3.

## Context

Release evidence previously mixed platform names, accepted local placeholders, and could report hard-coded test totals. Checksums and artifact sets were not consistently validated against downloaded bytes.

## Decision

Stable publication uses schema version `1.1.3` and the platform vocabulary `linux-x64`, `darwin-x64`, and `win32-x64`. Three and only three artifacts are required. `sha256_checksums` is an object keyed by artifact name and every digest and size is checked against the file beside the evidence document.

`scripts/verify-release-evidence.mjs --stable` is authoritative. It rejects local URLs, non-GitHub job URLs, zero-duration jobs, constant test totals, candidate/release SHA differences, malformed schemas, and incomplete or duplicate artifact sets with machine-readable reason codes. `--dev` relaxes only local URLs and constant totals.

`prepare-release.mjs` must verify evidence and SHA/workflow success before creating a tag. The tag workflow repeats verification against its checked-out SHA.

## Consequences

Ad-hoc and v1.1.2 evidence fails closed until canonicalised. Operators gain deterministic diagnostics and cannot publish from placeholder evidence. Existing SQLite data and runtime APIs are unaffected.

## Rejected alternatives

Permissive warnings and platform aliases in the verifier were rejected because stable publication must not reinterpret evidence. Hard-coded fallback totals were rejected because they are not evidence of the candidate run.
