# Identity resolution — operator guide

> **🌏 Language**: English. 中文（摘要）: [`identity-resolution.md`](./identity-resolution.md).  
> **Implementation version**: v1.1.2.

This guide documents how to register a project in AgentRecall's
strict-by-default identity model (introduced in v1.1.2 / issue #21
and hardened in v1.1.3 GATE-01 / issue #31). It is the
operator-facing companion to
`docs/adr/0004-identity-resolution-modes.md` (the ADR that
documents the three modes + the canonical registration path).

## TL;DR

- **Project-scoped reads and writes are strict by default.** A
  `project_id` that is not bound to a registered identity, or a
  `project_path` that aliases to a different `project_id`, is
  refused at the service boundary before any row is written.
- **The single production path that may register a project is**
  `MemoryWriteService.configureProjectBudget(project_id, budget,
  canonical_path, display_name)` (called by the CLI `agent-recall
  project register <path>`). MCP has no public tool that
  registers a project.
- **The escape hatch** `AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID=1`
  is preserved for one-off operator triage. It is NOT appropriate
  for production agent flows; it lets a `project_id`-only call
  without a registered identity proceed in "unbound" mode (the
  resolver returns `ok` with `identity_status: "unbound"`).

## How to register a project

There is exactly one supported way to register a project:

1. Run the CLI command:

   ```text
   agent-recall project register <canonical_path> \
     --project-id <id> \
     --display-name <name> \
     [--budget <max_active_entries>,<max_total_chars>,<max_topic_chars>,<max_index_chars>]
   ```

2. The CLI calls `MemoryWriteService.configureProjectBudget(...)`,
   which creates both the `project_identities` row (the canonical
   binding `(project_id, canonical_path)`) AND the `project_scopes`
   row (the budget envelope). The `register` mode is the only
   mode that may insert into `project_identities` /
   `project_aliases_new`; the CLI is the operator-facing alias for
   this path.

3. After registration, `project_id`-only calls succeed in strict
   mode (the strict resolver finds the identity row and returns
   `ok` with `identity_status: "bound"`). `project_path`-only
   calls also resolve via the alias table (Windows
   case-insensitive; POSIX case-sensitive).

A registered project is required for:

- `MemoryService.remember({scope: "project", project_id, ...})`
- `MemoryService.updateMemory(...)` against a project-scoped row
- `MemoryService.searchMemory(...)` filtered to a `project_id`
- `MemoryService.getMemoryBudget({project_id})`
- Any CLI command that targets a project (`agent-recall list
  --project <id>`, `agent-recall export --project <id>`, ...)

## The three modes — what they mean for the operator

The mode argument on `ProjectIdentityResolver.resolve(input,
mode)` controls whether the call may mutate identity / alias
tables. The three modes are genuinely distinct (post-#31):

| Mode | Behaviour | Mutates identity / alias? |
|------|-----------|---------------------------|
| `lookup` | Pure read. Returns `ok` with `identity_status: "absent"` if the binding is not registered. NEVER upserts. | No |
| `strict_existing` | Pure read. Returns `project_identity_conflict` if the binding is not registered. NEVER upserts. The default for public reads / writes. | No |
| `register` | The only mutator. Inserts `project_identities` if missing (idempotent on `(project_id)`). Inserts `project_aliases_new` if missing (idempotent on `alias_key`). | Yes |

The production rule is:

- A **write** service (`MemoryWriteService`) only calls `register`
  mode in one place: `configureProjectBudget`. Every other
  write-site call uses `strict_existing`.
- A **read** service (`MemoryReadService`) uses `strict_existing`
  by default. An opt-in `lookup` mode is available for
  best-effort paths (e.g. `getMemoryBudget` when the caller
  explicitly accepts an absent binding).

The MCP layer surfaces the strict-isolation state via the
`memory://health` resource: `strict_isolation: true` means the
resolver is in strict mode at runtime.

## The legacy escape hatch

```text
AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID=1
```

allows a `project_id`-only call without a registered identity to
proceed in "unbound" mode. The resolver returns `ok` with
`identity_status: "unbound"`. This is the v1.0.0 → v1.1.1
behaviour preserved as an opt-in escape hatch.

**When to use it:** ONLY for one-off operator triage. For
example:

- Bootstrapping a new install where the project registration
  step was forgotten.
- Recovering from a corrupted `project_identities` table that
  needs to be rebuilt before the strict path can be re-enabled.
- A migration script that needs to backfill identities without
  the strict resolver refusing every call.

**When NOT to use it:**

- In production agent flows. The escape hatch disables strict
  isolation; a missing identity silently proceeds, which defeats
  the v1.1.2 / #21 contract.
- In test fixtures where the project registration step is
  intentional. The test should call `configureProjectBudget`
  (or its programmatic equivalent) instead of bypassing the
  strict resolver.

The flag is read at process startup via
`isUnboundProjectIdAllowed(env)` in `src/scope-resolver.ts`. The
`ProjectIdentityResolver.isAllowUnbound()` accessor surfaces the
constructor's flag so the CLI / resource health payload can
declare "strict isolation is disabled" without re-reading the
env var.

## Apply-time identity revalidation

The import path (`agent-recall import`, `importMemoryExport`,
`applyImport`) carries an in-transaction identity revalidation
step that closes the v1.1.2 IDENTITY-CARVE-OUT. Every
`(project_id, project_path)` triple the bundle touches is
re-resolved via `ProjectIdentityResolver.resolve(...,
"strict_existing")` inside the apply transaction. A drifted or
missing binding throws `identity_drift` and rolls back the
entire batch (entries + revisions + audit + relations +
provenance + the `running` / `completed` batch row transitions).

The drift envelope is recorded on the failed batch row:

```text
audit_metadata.identity_revalidation = {
  outcome: "drift",
  conflicts: [
    { project_id: "<id>", expected_path: "<path>", observed_path: "<drifted-path>" },
    ...
  ]
}
```

A reviewer can grep the `import_batches` table for
`audit_metadata_json LIKE '%identity_revalidation%drift%'` to
surface forced-drift attempts without parsing the free-form
error message. See `ADR-0004` / `commit 6` for the contract.

## Common operator questions

### Q: I called `remember({scope: "project", project_id: "my-proj", ...})` and got `invalid_scope`. Why?

The `project_id` is not registered. Run `agent-recall project
register <path> --project-id my-proj --display-name "My Project"`
(or call `configureProjectBudget` programmatically), then retry.

### Q: I called `remember({scope: "project", project_path: "/tmp/my-repo", ...})` and got `project_identity_conflict`. Why?

The path is already aliased to a different `project_id` (e.g.
someone registered `/tmp/my-repo` as `other-proj`). Either:

- Use the existing `other-proj` identity, OR
- Call `configureProjectBudget` with a fresh `project_id` for
  `/tmp/my-repo` (the alias is bound to the FIRST registered id;
  re-registration with a different id refuses).

### Q: I want to use the v1.0.0 "unbound" mode for one CLI command. How?

Set the env var on the command line:

```text
AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID=1 agent-recall remember --project my-proj --body "..."
```

The CLI process picks up the env var at startup. The
`memory://health` resource will surface
`strict_isolation: false` for the duration of the process.

### Q: My forced-drift apply produced an `identity_drift` failure. How do I trace it?

The `import_batches` row is in `failed` status with
`failure_code = "apply_failed"`. Inspect the
`audit_metadata_json` column:

```sql
SELECT import_batch_id, failure_code, audit_metadata_json
  FROM import_batches
 WHERE status = 'failed'
   AND audit_metadata_json LIKE '%identity_revalidation%drift%'
 ORDER BY started_at DESC;
```

The JSON shape is documented in `ImportBatchAuditMetadata` in
`src/portability/import-batch-store.ts`. The `conflicts` array
lists every drifted scope with its expected and observed
`canonical_path`.

## See also

- `docs/adr/0004-identity-resolution-modes.md` — the ADR that
  documents the three modes + the canonical registration path
  + the apply-time revalidation contract.
- `src/scope-resolver.ts` — the resolver implementation.
- `src/services/memory-write-service.ts` — the write service
  that owns `configureProjectBudget`.
- `src/portability/importer.ts` — the import path with the
  apply-time identity revalidation.
- `src/portability/import-batch-store.ts` — the
  `ImportBatchAuditMetadata` type + the
  `complete` / `fail` writers that surface the revalidation
  envelope.