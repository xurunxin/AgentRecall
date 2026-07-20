# Stage 8 — Maintenance Rich — Implementation Plan

Date: 2026-07-20
Branch: `feat/stage8-maintenance-rich`
Worktree: `G:\Projects\MetronX\local-memory-mcp\.worktrees\stage8-maintenance-rich`
Baseline: 301/301 tests green, `main` at `2494fc9`

See [spec](../specs/2026-07-20-stage-eight-maintenance-rich.md) for
design rationale and scope.

## Task list

- [x] **T0** — Spec + plan (this document)
- [ ] **T1** — `merge_duplicates` action on
  `maintain_memories`. Walks the duplicate groups
  from `find_duplicates` and supersedes all but the
  keep target. ~4 tests in
  `test/maintain-merge-duplicates.test.ts`.
- [ ] **T2** — Export format switch (markdown | json
  | yaml). New `src/format-exporters.ts` with
  `FormatRouter` + `JsonExporter` + `YamlExporter`.
  `MarkdownExporter` stays as-is. ~6 tests in
  `test/format-exporters.test.ts`.
- [ ] **T3** — `dry_run` flag on
  `MaintainMemoriesInput`. For `archive_low_value`,
  `expire_due`, `merge_duplicates`: report what
  would happen without mutating. ~4 tests in
  `test/maintenance-dry-run.test.ts`.
- [ ] **T4** — Docs: CHANGELOG `[Unreleased] — Stage
  8`, closure report, README updates (Maintenance
  section, Tools table).
- [ ] **T5** — Verify (`npm run typecheck && npm test
  && git diff --check`), push branch, `--no-ff`
  merge to `main`, push `main` to origin.

## T1 — `merge_duplicates` action (red → green)

### Test cases (`test/maintain-merge-duplicates.test.ts`)

```ts
describe("maintainMemories merge_duplicates (stage 8)", () => {
  it("supersedes all-but-keep_first for same_title_and_body groups", ...);
  it("supersedes all-but-keep_newest (oldest two out of three)", ...);
  it("skips size-1 groups", ...);
  it("skips groups whose keep target is already superseded", ...);
  it("writes one superseded audit event per merge", ...);
});
```

### Implementation sketch

`src/memory-service.ts`:

```ts
case "merge_duplicates": {
  const strategy = input.strategy ?? "keep_first";
  const entries = this.activeEntriesForScope(resolved.value);
  const groups = this.findDuplicateGroups(entries);
  // Only consider groups that imply multiple active entries.
  // Stage 7 already has findDuplicateGroups; we reuse it.
  const dryRun = input.dry_run === true;
  return this.mergeDuplicateGroups(resolved.value, groups, strategy, dryRun, input.onProgress);
}

private mergeDuplicateGroups(
  scope: ResolvedReadScope,
  groups: DuplicateGroup[],
  strategy: "keep_first" | "keep_newest",
  dryRun: boolean,
  onProgress?: (processed: number, total: number) => void
): MaintainMemoriesResult {
  // ... group-by-group, pick keep target, mark others superseded
  // ... use store.transaction() per group for the write lock
  // ... write audit events
  // ... return { action, changed, details: { superseded_by_group } }
}
```

`src/tools/schemas.ts`:

```ts
const maintenanceActions = [
  ...,
  "merge_duplicates"  // Stage 8
] as const;
```

`MaintainMemoriesInput` (in `src/memory-service.ts`) gains
`strategy?: "keep_first" | "keep_newest"`.

### Commit

```bash
git add src/memory-service.ts src/tools/schemas.ts \
        test/maintain-merge-duplicates.test.ts \
        test/tool-registration.test.ts
git commit -m "feat(stage8): add merge_duplicates action to maintain_memories"
```

## T2 — Export format switch (red → green)

### Test cases (`test/format-exporters.test.ts`)

```ts
describe("FormatRouter (stage 8)", () => {
  it("routes format=markdown to MarkdownExporter (default behavior)", ...);
  it("routes format=json to JsonExporter", ...);
  it("routes format=yaml to YamlExporter", ...);
  it("omitted format defaults to markdown", ...);
});

describe("JsonExporter (stage 8)", () => {
  it("writes MEMORY.json with sorted keys", ...);
  it("writes one JSON file per topic", ...);
  it("includes budget, topics, high-importance, review-due sections", ...);
  it("handles entries with supersedes and superseded_by", ...);
});

describe("YamlExporter (stage 8)", () => {
  it("writes MEMORY.yaml with structural validity", ...);
  it("writes one YAML file per topic", ...);
  it("quotes strings that look like booleans / numbers / null", ...);
  it("multi-line strings are block-quoted", ...);
});
```

### Implementation sketch

`src/format-exporters.ts` (new):

```ts
export type ExportFormat = "markdown" | "json" | "yaml";

export interface Exporter {
  exportScope(input: ExportScopeInput, root: string): ExportScopeResult;
}

class JsonExporter implements Exporter { ... }
class YamlExporter implements Exporter { ... }   // hand-rolled

export class FormatRouter {
  constructor(
    private readonly exportRoot: string,
    private readonly markdown = new MarkdownExporter(exportRoot)
  ) {}
  export(input: ExportScopeInput): ExportScopeResult {
    const format = input.format ?? "markdown";
    if (format === "markdown") return this.markdown.exportScope(input);
    if (format === "json") return new JsonExporter(this.exportRoot).exportScope(input);
    if (format === "yaml") return new YamlExporter(this.exportRoot).exportScope(input);
    throw new Error(`unknown export format: ${format}`);
  }
}
```

The `MarkdownExporter.exportScope` is the public
shape we keep; the new exporter classes follow the
same pattern. The `MemoryService.rebuildMarkdownIndex`
becomes:

```ts
private rebuildMarkdownIndex(scope: ResolvedReadScope): MaintainMemoriesResult {
  // Use FormatRouter with format = "markdown" (default) for
  // backward compat. The CLI can pass format = "json" or "yaml"
  // via a new public method.
  ...
}
```

CLI `src/cli/commands/export.ts` gains
`--format markdown|json|yaml`.

### Commit

```bash
git add src/format-exporters.ts src/markdown-exporter.ts \
        src/memory-service.ts src/tools/schemas.ts \
        src/cli/commands/export.ts \
        test/format-exporters.test.ts \
        test/tool-registration.test.ts
git commit -m "feat(stage8): add json and yaml export formats via FormatRouter"
```

## T3 — `dry_run` flag (red → green)

### Test cases (`test/maintenance-dry-run.test.ts`)

```ts
describe("maintainMemories dry_run (stage 8)", () => {
  it("archive_low_value with dry_run returns would_archive_count + sample; no state change", ...);
  it("expire_due with dry_run returns would_expire_count + sample; no body clears", ...);
  it("merge_duplicates with dry_run returns per-group would_supersede; no audit events", ...);
  it("dry_run: false (default) actually mutates; state matches dry-run report", ...);
});
```

### Implementation sketch

`src/memory-service.ts`:

```ts
export type MaintainMemoriesInput = {
  ...
  dry_run?: boolean;
};

// In each maintainMemories case:
case "archive_low_value": {
  return this.archiveLowValueMemories(resolved.value, input.dry_run === true);
}
case "expire_due": {
  return this.expireDueMemories(resolved.value, input.dry_run === true);
}
case "merge_duplicates": {
  return this.mergeDuplicateGroups(resolved.value, ..., input.dry_run === true, ...);
}
```

Each method gains a `dryRun: boolean` param. When
true, it builds the candidate list, formats the
report, and returns without writing.

`src/tools/schemas.ts`:

```ts
export const maintainMemoriesToolSchema = z
  .object({
    ...
    dry_run: z.boolean().default(false)
  })
```

### Commit

```bash
git add src/memory-service.ts src/tools/schemas.ts \
        test/maintenance-dry-run.test.ts \
        test/tool-registration.test.ts
git commit -m "feat(stage8): add dry_run flag to maintain_memories"
```

## T4 — Closure docs

Same pattern as Stage 7 closure.

### Commit

```bash
git add CHANGELOG.md README.md \
        docs/superpowers/plans/2026-07-20-stage-eight-maintenance-rich-closure.md
git commit -m "docs(stage8): add CHANGELOG entry, closure report, README updates"
```

## T5 — Verify, push, merge

```bash
npm run typecheck
npm test -- --pool=forks --poolOptions.forks.singleFork=true
git diff --check
git push -u origin feat/stage8-maintenance-rich
cd ../..
git checkout main
git merge --no-ff feat/stage8-maintenance-rich -m "Merge branch 'feat/stage8-maintenance-rich'"
git push origin main
```

After the merge: ask the user whether to clean the
stage 8 worktree, and surface the Stage 9 candidates
(facade split, import CLI, secret-detector PII,
semantic dedup dep decision).

## Expected outcome

- 301 → ~315 tests (+ ~14: 4 merge-duplicates, 6
  format-exporters, 4 maintenance-dry-run)
- 0 schema changes
- 1 new module: `src/format-exporters.ts`
- 1 new `MaintainMemoriesInput` field: `dry_run`
- 1 new `MaintainMemoriesInput` field: `strategy`
- 1 new `ExportScopeInput` field: `format`
- 1 new `maintain_memories` action: `merge_duplicates`
- 2 new export formats: `json`, `yaml`
- 1 new CLI flag: `--format markdown|json|yaml` on `export`
- All 301 prior tests still pass
- 12 doctor checks unchanged
- 12 MCP tools unchanged in count; `maintain_memories`
  gains a new action and a `dry_run` field;
  `export_memory_context` is unchanged (read-side)
