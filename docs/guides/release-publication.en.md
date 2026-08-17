# Release publication

> **🌏 Language**: English. 中文（默认）: [`release-publication.md`](./release-publication.md).  
> **Implementation version**: v1.1.4.

## Produce candidate evidence

1. Run the release-candidate workflow for the exact candidate SHA.
2. Each matrix leg records its canonical platform token, actual Vitest JSON totals, job metadata, and artifact hash.
3. The record-evidence job merges exactly three fragments with `scripts/release-evidence.mjs`.
4. Run `node scripts/verify-release-evidence.mjs --stable --evidence release-evidence.json`.

Evidence and all referenced artifact files must remain together while verifying checksums.

## Prepare a release

Place the three archives, hash manifest, staging documents, and verified `release-evidence.json` in `ARTIFACT_DIR`. Set `GITHUB_SHA` to the checked-out candidate and run:

```sh
DRY_RUN=1 ARTIFACT_DIR=/path/to/artifacts GITHUB_SHA=<40-hex-sha> node scripts/prepare-release.mjs
```

Review generated notes before using `DRY_RUN=0`. Preparation fails before tag creation when evidence is absent, the stable verifier rejects it, either recorded SHA differs, or the recorded tag-only workflow is not successful.

## Publish the tag

The Release workflow runs only for tags. It downloads evidence from the successful candidate workflow, runs the stable verifier again, and requires both `release_commit` and `candidate_sha` to equal the tag's `head_sha`. Any mismatch blocks packaging.

## Development diagnostics

`--dev` permits `local://` URLs and `totals_from: "constant"` for local fixture work. It still requires canonical platforms, complete artifact coverage, a valid schema, and matching bytes. Development evidence must never be used by preparation or publication.

Verifier failures are JSON on stderr. Use the `code` field for automation; the `detail` field is explanatory and may evolve.
