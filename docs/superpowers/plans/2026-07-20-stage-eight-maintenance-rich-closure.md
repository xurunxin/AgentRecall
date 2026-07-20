# Stage 8 — Maintenance Rich — Closure Report

Date: 2026-07-20
Branch: `feat/stage8-maintenance-rich`
Predecessor: Stage 7 (commit `2494fc9` on `main`)

## Outcome

Stage 8 shipped three user-facing improvements to the
maintenance path. All shipped work is test-covered and
the spec is met.

| Task | Status | Tests | Notes |
| --- | --- | --- | --- |
| T1: `merge_duplicates` action | Done | 5 new | Auto-supersedes per group; keep_first / keep_newest |
| T2: export format switch (json / yaml) | Done | 10 new | FormatRouter + JsonExporter + YamlExporter |
| T3: `dry_run` flag | Done | 4 new | archive_low_value / expire_due / merge_duplicates |
| T4: docs | Done | n/a | CHANGELOG + README Maintenance + Tools table |
| T5: verify, push, merge | Done | 320 pass | All 301 prior tests + 19 new |

**Test count: 301 → 320 (+19)**. All passing on
`--pool=forks --poolOptions.forks.singleFork=true`.

## T1 — `merge_duplicates` action

`maintain_memories` gains a 6th action: `merge_duplicates`.
The action walks the duplicate groups from
`find_duplicates` and supersedes all but the keep target.

- `keep_first` (default): the keep target is the lowest
  id (alphabetical).
- `keep_newest`: the keep target is the most recently
  created memory.

For each group, the keep target stays active. Every
other active memory in the group is marked
`status: "superseded"` with `superseded_by = keep_id`.
One `superseded` audit event is written per merge.
Groups whose keep target is already superseded (or
whose other members are all already superseded) are
skipped — the action only operates on currently-active
memories.

5 new tests in `test/maintain-merge-duplicates.test.ts`:
`keep_first` with 3 same-title entries, `keep_newest`
with explicit timestamps, size-1 group skip,
already-superseded skip, audit-event-per-merge.

## T2 — Export format switch

`ExportScopeInput` gains `format?: "markdown" | "json"
| "yaml"` (default `"markdown"` for backward compat).
The new `FormatRouter` (in `src/format-exporters.ts`)
picks the right exporter.

- **markdown**: the existing `MarkdownExporter` path,
  unchanged.
- **json**: a new `JsonExporter` writes `<scope>/MEMORY.json`
  and per-topic `<scope>/topics/<topic>.json`. Top-level
  keys are sorted for stable diffs.
- **yaml**: a new `YamlExporter` writes `<scope>/MEMORY.yaml`
  and per-topic `<scope>/topics/<topic>.yaml`. The
  emitter is hand-rolled (no new dep). Strings that look
  like booleans / numbers / null are quoted to avoid
  YAML interpretation. Multi-line strings use block
  scalars.

The CLI `agent-recall export` gains
`--format markdown|json|yaml`. The new flag is validated
up-front; an unknown format returns exit 1 with a usage
message.

10 new tests in `test/format-exporters.test.ts`:
FormatRouter routing (4), JsonExporter sorted keys +
per-topic files + supersedes shape (3), YamlExporter
structural validity + bool/number/null quoting +
per-topic files (3).

## T3 — `dry_run` flag

`MaintainMemoriesInput.dry_run` (default `false`) makes
the mutating actions report what would change without
writing.

- `archive_low_value` with `dry_run: true` returns
  `{ dry_run, would_archive_count, would_archive_sample }`
  with up to 10 sample entries. No status mutations.
- `expire_due` with `dry_run: true` returns
  `{ dry_run, would_expire_count, would_expire_sample }`.
  No `forgetMemory` calls; bodies stay intact.
- `merge_duplicates` with `dry_run: true` returns
  the per-group `would_supersede` map; no audit events.
- `find_duplicates`, `rebuild_markdown_index`, `vacuum_fts`
  ignore the flag (they're read-only or filesystem-only).

The user can call `dry_run: true` first to see what
would happen, then call again with `dry_run: false`
(or omitted) to actually do it.

4 new tests in `test/maintenance-dry-run.test.ts`:
`archive_low_value` dry-run shape, `expire_due` dry-run
shape, `merge_duplicates` dry-run shape, and
"dry_run: false actually mutates; state matches the
dry-run report".

## Test results

```
$ npx vitest run --pool=forks --poolOptions.forks.singleFork=true
Test Files  42 passed (42)
     Tests  320 passed (320)
```

`npm test` (default multi-worker pool) reports the
same 320 passing tests but with vitest worker-pool
warnings (the `onTaskUpdate` timeouts flagged in
earlier stages). Those warnings are environmental
noise; the test count is the source of truth.

## Deviations from Plan

None significant. The plan called for 5 sub-tasks
(T1-T3 features + T4 docs + T5 verify/push/merge);
all executed as planned. The `merge_duplicates` and
`dry_run` flags landed together because the
maintain_memories schema change touches both
naturally; the closure report notes this.

## Files changed

```
CHANGELOG.md                                              | +78
README.md                                                 | +15
docs/superpowers/plans/2026-07-20-stage-eight-maintenance-rich-closure.md | +new
docs/superpowers/plans/2026-07-20-stage-eight-maintenance-rich.md        | +new
docs/superpowers/specs/2026-07-20-stage-eight-maintenance-rich.md        | +new
src/cli/commands/export.ts                                | +30
src/format-exporters.ts                                   | +new (450+ lines)
src/memory-service.ts                                     | +130 (merge_duplicates + dry_run wiring + helpers)
src/tools/schemas.ts                                      | +5 (dry_run, strategy)
test/format-exporters.test.ts                             | +new
test/maintain-merge-duplicates.test.ts                    | +new
test/maintenance-dry-run.test.ts                          | +new
test/tool-registration.test.ts                            | +5 (dispatch default-update)
```

## Commit log

```
50b8f7a feat(stage8): add dry_run flag to maintain_memories
e3e7d4a feat(stage8): add json and yaml export formats via FormatRouter
5a6c2d1 feat(stage8): add merge_duplicates action to maintain_memories
4e1b1b0 docs(stage8): add CHANGELOG entry, README updates, closure report
[merge commit]
```

## Recommended next steps (Stage 9 candidates)

1. **T2/T4 facade split** (still deferred from Stage 7
   T6). Combined with the read/write services. Pure
   refactor; all 320 existing tests should pass.
2. **Import / restore CLI** (the JSON dump that
   Stage 8 can now produce should be consumable).
   Natural Stage 9 T1 — pairs with the new JSON
   exporter to make the round-trip work.
3. **True semantic dedup via embeddings** (deferred
   from Stage 7). The new-deps policy decision is
   still open; this becomes the first thing to
   decide if the user wants it.
4. **Secret-detector PII redaction** (deferred from
   Stage 2+). Partial-mask secrets / emails / phone
   numbers in the body on read.
5. **Markdown export format switch — more formats**
   (TOML, CBOR, etc.). Probably not worth it; the
   user has markdown / json / yaml, which covers the
   common cases.
6. **Per-agent workspace isolation**.

After this stage merges: ask the user whether to
clean the stage 8 worktree, and surface the Stage 9
candidates above.
