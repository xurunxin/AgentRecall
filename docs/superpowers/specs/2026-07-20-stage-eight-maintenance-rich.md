# Stage 8 — Maintenance Rich

Date: 2026-07-20
Branch: `feat/stage8-maintenance-rich`
Predecessor: Stage 7 (commit `2494fc9` on `main`)

## Why

Stages 1-7 shipped the user-facing surface that came out
of the multi-stage review, and T5 in Stage 7 added
chunked maintenance. Three maintenance-path improvements
remain that are clearly useful to the user but were
deferred:

1. **Auto-supersede duplicates**: today, after
   `find_duplicates` reports a group, the user must call
   `merge_memories` for each group one at a time. For a
   store with 50 near-duplicate groups, that's 50 manual
   calls. A `merge_duplicates` action (new for
   `maintain_memories`) walks the groups and
   auto-supersedes all but the chosen keep target.
2. **Markdown export format switch**: today, the
   markdown export is the only format. A user who wants
   to consume the export programmatically (CI, a custom
   tool, a different language) has to parse markdown.
   Adding JSON and YAML outputs is straightforward; the
   existing `MarkdownExporter.exportScope` shape is a
   good template.
3. **Per-scope maintenance dry-run**: today, calling
   `maintain_memories` with `archive_low_value` or
   `expire_due` mutates state. The user has no way to
   see what would happen before committing. A `dry_run`
   flag returns the same shape but skips the actual
   mutations and reports what would have changed.

All three are user-facing improvements on the
maintenance path. None are pure refactor; all are
testable in isolation.

## What this stage ships

### T1 — `merge_duplicates` action

A new `maintain_memories` action: `merge_duplicates`.
Walks the duplicate groups from `find_duplicates` and
for each group, picks one memory as the keep target
(strategy: `keep_first` — first id alphabetically —
or `keep_newest` — most recent `created_at`) and
marks the others as `superseded` with
`superseded_by = keep_id`. Writes an audit event for
each superseded memory. The keep target is not
modified.

The `merge_memories` MCP tool (Stage 2) already does
this for one group at a time; this action is the
batch version. It accepts the same `strategy` and
`replacement` is implicit (the keep target stays).

User flow: agent runs `find_duplicates`, sees a list
of groups, then calls `merge_duplicates` to bulk-act.
The `details` of the result includes per-group
`superseded_ids` and the new `superseded_by` for each.

Edge case: a group with size 1 has nothing to merge
and is skipped. A group whose keep target is
already `superseded` is skipped (cannot supersede
into an already-superseded memory).

### T2 — Export format switch

`ExportScopeInput` gains `format: "markdown" | "json"
| "yaml"` (default `"markdown"`, backward compat).
The `MarkdownExporter` becomes one of three
exporters. A new `FormatRouter` (in
`src/format-exporters.ts`) picks the right exporter
based on the format field.

- **markdown**: the existing path (unchanged).
- **json**: writes `<scope>/MEMORY.json` and
  `<scope>/topics/<topic>.json` with a deterministic
  shape (id, scope, type, topic, title, body, tags,
  source, importance, confidence, status, timestamps,
  supersedes, superseded_by). One file per topic plus
  the index. Sorted keys for stable diffs.
- **yaml**: same shape, but YAML. We hand-roll a
  minimal YAML emitter (no new deps); for the
  personal-tool scale the data is small enough that
  hand-rolling is fine.

The CLI `export` command gains `--format
markdown|json|yaml`. The MCP `export_memory_context`
tool (which is read-side, not the maintenance path)
is unchanged; this is a `maintain_memories` /
`rebuild_markdown_index` thing.

User flow: `agent-recall export --format json` to
get a machine-readable snapshot for CI or external
tooling.

### T3 — `dry_run` flag

`MaintainMemoriesInput` gains `dry_run: boolean`
(default `false`, backward compat). When `true`:
- `archive_low_value`: returns the candidate list
  with `would_archive_count` and `would_archive_sample`
  in `details`. No state mutation.
- `expire_due`: same shape with
  `would_expire_count` / `would_expire_sample`. No
  state mutation.
- `merge_duplicates`: returns the per-group
  `superseded_ids` that would be applied. No state
  mutation.
- `find_duplicates`, `rebuild_markdown_index`,
  `vacuum_fts`: `dry_run` is ignored (they're
  read-only or filesystem-only).

The user can call `dry_run: true` first to see what
would happen, then call again with `dry_run: false`
(or omitted) to actually do it.

## Data model changes

None. All three sub-tasks work on existing tables
and existing JSON file outputs.

## API changes

### `MaintainMemoriesInput` (T1 + T3)

```ts
{
  action: "find_duplicates" | "merge_duplicates" |   // T1: new action
           "archive_low_value" | "expire_due" |
           "rebuild_markdown_index" | "vacuum_fts",
  scope: "global" | "project",
  project_id?: string,
  project_path?: string,
  batch_size?: number,         // Stage 7
  dry_run?: boolean,            // T3
  onProgress?: (processed, total) => void,  // Stage 7
  // T1-specific (only when action === "merge_duplicates"):
  strategy?: "keep_first" | "keep_newest"   // default "keep_first"
}
```

### `ExportScopeInput` (T2)

```ts
{
  scope: "global" | "project",
  project_id?: string,
  entries: MemoryEntry[],
  budgetStatus: string | BudgetUsage,
  format?: "markdown" | "json" | "yaml"   // default "markdown"
}
```

### CLI

```bash
agent-recall export --format json       # T2
agent-recall export --format yaml
agent-recall maintain archive_low_value --dry-run   # T3
agent-recall maintain merge_duplicates --strategy keep_newest  # T1
```

## Tests added

T1: `test/maintain-merge-duplicates.test.ts` (~4 tests):
- 3 same-title-and-body duplicates, default
  `keep_first`: 2 superseded, 1 untouched
- 3 duplicates, `keep_newest`: 2 superseded (oldest
  two), 1 untouched
- groups of size 1 are skipped
- the keep target's `superseded_by` stays undefined;
  the others get `superseded_by = keep_id`
- audit events recorded for each supersede

T2: `test/format-exporters.test.ts` (~6 tests):
- `format: "json"` writes a `MEMORY.json` and
  per-topic JSON files
- `format: "yaml"` writes a `MEMORY.yaml` and
  per-topic YAML files
- JSON keys are sorted; YAML is hand-rolled and
  round-trippable through `js-yaml` parse if
  available, or a structural check otherwise
- `format: "markdown"` still works (backward compat)
- omitted `format` defaults to `"markdown"`
- the budget status, topics list, and high-importance
  section all appear in JSON / YAML outputs

T3: `test/maintenance-dry-run.test.ts` (~4 tests):
- `archive_low_value` with `dry_run: true` returns
  `would_archive_count` and a sample; no entry
  status changes
- `expire_due` with `dry_run: true` returns
  `would_expire_count`; no `body` clears
- `merge_duplicates` with `dry_run: true` returns
  the per-group `would_supersede` map; no audit
  events written
- `dry_run: false` (default) actually mutates; the
  state changes match the dry-run report

Expected test count: 301 → ~315 (+14).

## Documentation updates

- `CHANGELOG.md` — `[Unreleased] — Stage 8` entry;
  Stage 7 promoted to `[0.7.0]`.
- `docs/superpowers/plans/2026-07-20-stage-eight-maintenance-rich.md`
  — 5-task implementation plan.
- `docs/superpowers/plans/2026-07-20-stage-eight-maintenance-rich-closure.md`
  — closure report.
- `README.md` — Maintenance section: brief note
  about `merge_duplicates`, `dry_run`, and the
  `--format` switch on `export`. Tools table:
  mention the new action and the new flag.

## Acceptance criteria

1. `maintain_memories` with `action: "merge_duplicates"`
   and 3 same-title-and-body duplicates marks 2
   memories as `superseded` with `superseded_by` set
   to the keep target. Audit events written.
2. `maintain_memories` with `action: "merge_duplicates"`
   and `dry_run: true` returns the same shape but
   writes no audit events and does not change
   entry status.
3. `export` with `--format json` writes
   `MEMORY.json` and per-topic JSON files; the JSON
   keys are sorted and the shape is stable.
4. `export` with `--format yaml` writes
   `MEMORY.yaml` and per-topic YAML files; the YAML
   is structurally valid (round-trip via the
   hand-rolled emitter is the test).
5. `maintain_memories` with `action: "archive_low_value"`
   and `dry_run: true` returns
   `details.would_archive_count` and a sample; no
   entry is actually archived.
6. Existing 301 tests still pass; typecheck clean.

## Out of scope (deferred to Stage 9+)

- **T2/T4 facade split** (deferred from Stage 7). Pure
  refactor; still the first candidate for the next
  stage if a stage opens with no user-impact work.
- **True semantic dedup via embeddings** (deferred
  from Stage 7). Would require a new dep; user has
  not asked to revisit the no-new-deps policy.
- **Secret-detector PII redaction** (deferred from
  Stage 2+).
- **Import / restore CLI** (read a JSON dump into a
  fresh store). Stage 8 ships JSON export; the import
  half is the natural Stage 9 task.
- **Per-agent workspace isolation**.

## Risks

- **T1 merge_duplicates performance**: at 1000
  duplicate groups, the action runs 1000 supersede
  audits. The chunked maintenance from Stage 7 means
  the write lock isn't held for the full duration,
  but each supersede is its own transaction. At 1k
  groups this is a few seconds; acceptable for the
  personal-tool scale.
- **T2 hand-rolled YAML**: the YAML emitter has to
  handle strings with special characters (`:`, `#`,
  leading hyphens, multi-line). Strings that look
  like booleans / numbers / null need explicit
  quoting. The hand-rolled emitter is well-tested
  with the round-trip test, but a malicious or
  pathological string could expose a bug. The
  mitigation is to be conservative (always quote
  strings when in doubt).
- **T3 dry_run shape parity**: each of
  `archive_low_value`, `expire_due`, `merge_duplicates`
  returns a different `details` shape today. Stage 8
  pins the dry-run shape per action and the spec
  documents them. The risk is that future maintenance
  actions forget to implement dry-run; the Zod schema
  enforces `dry_run` is a valid optional boolean but
  doesn't enforce the per-action behavior. Stage 9
  could add a unit test that asserts every action
  with a "would"-affordance honors `dry_run`.
