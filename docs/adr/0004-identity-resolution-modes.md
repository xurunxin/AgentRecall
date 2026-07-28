# ADR-0004 — Identity resolution modes

- Status: Accepted (replaces the v1.1.2 carve-out documented in the
  v1.1.2 / #24 "Known non-blocking limits" CHANGELOG entry)
- Date: 2026-07-28
- Issue: #31 (v1.1.3 GATE-01, sub-issue of #30)
- Authors: agent-recall maintainers
- Supersedes: the v1.1.2 IDENTITY-CARVE-OUT documented at
  `src/portability/importer.ts` lines 962–1052 (the apply-time
  revalidation preamble) and in `CHANGELOG.md` under the v1.1.2
  release.

## Context

`ProjectIdentityResolver.resolve()` accepts a `mode` argument
(`"lookup" | "register" | "strict_existing"`) and forwards it to the
helper `resolveMemoryScopeWithStore` (in `src/scope-resolver.ts`).
Pre-#31 the helper did NOT consult the mode argument — every
path-supplied call funnelled through the same code that calls
`upsertProjectIdentity(...)` and `registerAlias(...)`. The concrete
consequences were:

1. A `lookup` call (a read-only operation) could leave a fresh row
   in `project_identities` and `project_aliases_new` if the caller
   supplied a path that had not been registered before. Reads
   mutated state.
2. `strict_existing` had the same behaviour: a strict-mode read of
   a new path silently created an identity + alias, then returned
   `ok`. The whole point of `strict_existing` is to *refuse*
   unknown bindings; the implementation could not enforce that.
3. The import preflight inherited this: it called `resolve(...,
   "strict_existing")` and got an implicit identity registration as
   a side effect. The `ProjectIdentityResolver` doc-comment
   (`src/scope-resolver.ts` lines 282–340) said "lookup and
   strict_existing never create one"; the implementation
   disagreed.
4. The import apply revalidated revisions + aggregate budget inside
   the apply transaction but did NOT revalidate the identity
   binding. A preflight / apply race that registered a new
   identity (because of the bug above) then bumped a different
   `canonical_path` between preflight and apply would silently
   mutate the identity row under the apply transaction.

Issue #21 (v1.1.2) closed the default-unbound `project_id`
fallback but explicitly carved out apply-time identity
revalidation because the side-effect-on-strict path was not a
regression for the cases #21 covered. Issue #31 closes that
carve-out.

## Decision

We pin the three modes as **genuinely distinct operations** with
zero overlap on the mutating path:

| Mode | Path-supplied unknown | Path-supplied known, id mismatch | Path-supplied known, id matches | project_id-only unknown | project_id-only known |
|------|-----------------------|---------------------------------|--------------------------------|------------------------|----------------------|
| `lookup` | returns `ok` with `identity_status: "absent"`; **0 writes** | returns `project_identity_conflict`; **0 writes** | returns `ok` with `identity_status: "bound"`; **0 writes** | returns `ok` with `identity_status: "absent"`; **0 writes** | returns `ok` with `identity_status: "bound"`; **0 writes** |
| `strict_existing` | returns `project_identity_conflict`; **0 writes** | returns `project_identity_conflict`; **0 writes** | returns `ok` with `identity_status: "bound"`; **0 writes** | returns `invalid_scope` (unless escape hatch) | returns `ok` with `identity_status: "bound"`; **0 writes** |
| `register` | inserts `project_identities` + `project_aliases_new`; returns `ok` | returns `project_identity_conflict`; **0 writes** | inserts only if missing (alias row idempotent); returns `ok` | inserts `project_identities` (with derived id); returns `ok` | inserts alias if missing; returns `ok` |

### Implementation

`resolveMemoryScopeWithStore(input, store, recordedBy)` gains a
required `mode: IdentityResolutionMode = "register"` parameter. The
default preserves the legacy `"register"` behaviour for callers
that have not been updated yet (so the type-level change is
backwards-compatible at the call sites).

The store-aware path splits into three private helpers:

- `lookupIdentity(...)` — pure read. Look up alias → identity;
  never upsert; never register. If unknown, returns
  `identity_status: "absent"` so the caller knows the binding is
  not registered.
- `strictExistingIdentity(...)` — pure read. If unknown, returns
  `project_identity_conflict`. Never upsert; never register.
- `registerIdentity(...)` — the only mutator. Existing upsert +
  alias + worktree logic, idempotent on `(project_id,
  canonical_path)` and on `alias_key`.

The shared pre-checks (global short-circuit, project_id /
project_path normalisation, the caller-supplied `project_id`
alias-conflict check) stay in the dispatcher. Each helper is
small (~25-40 lines) and independently inspectable; the public
function is a thin dispatcher (~70 lines).

### Canonical registration path

The single production path that may invoke `register` mode is
`MemoryWriteService.configureProjectBudget(input)`. Every other
public method (`remember`, `updateMemory`, `searchMemory`,
`getMemoryBudget`, `exportMemoryContext`, …) calls either `lookup`
or `strict_existing`.

CLI:

```text
agent-recall project register <path>
```

is the operator-facing alias for `configureProjectBudget`. The
CLI calls the same write-service path; there is no separate
register CLI surface.

MCP has no public tool that registers a project. The
`memory://health` resource surfaces `strict_isolation: true` so a
client can verify the resolver is in strict mode at runtime.

### Apply-time identity revalidation

`applyImport` now carries a third revalidation step (after the
existing revisions + aggregate budget re-checks) that re-resolves
every `(project_id, project_path)` triple in `plan.scopes` via
`ProjectIdentityResolver.resolve(..., "strict_existing")`. A
drifted or missing binding throws `identity_drift` (a new
`ResolveError` member) and rolls back the entire batch.

The revalidation runs INSIDE the apply transaction so the throw
rolls back every entry / revision / audit / relation / provenance
row + the `running` / `completed` batch transitions atomically.
The post-transaction catch block writes `apply_failed` to the
batch row with the identity-drift envelope attached to
`audit_metadata.identity_revalidation` (see `ADR-0004` /
`commit 6`).

The order is deliberately after the budget re-check: a missing
identity at revalidation time is a stronger signal than a drifted
budget. The preflight already populates `plan.scopes` from every
project-scoped entry's identity check, so the apply transaction
has the deduped `(project_id, project_path)` pairs to re-validate.

### Audit trail

`ImportBatchRow.audit_metadata.identity_revalidation` records
`{ outcome: "ok" | "drift", conflicts: [...] }` on every applied
batch. The column is the additive
`audit_metadata_json TEXT NOT NULL DEFAULT '{}'` column on
`import_batches`; the `user_version` stays at 13 (the column is
purely additive and `addColumnIfMissing` covers pre-existing v13
databases).

## Consequences

### Positive

- `lookup` and `strict_existing` callers can no longer mutate
  identity / alias tables. The pre-#31 implicit side effect is
  gone; the `ProjectIdentityResolver` doc-comment now matches the
  implementation.
- The apply transaction now re-validates the identity binding
  alongside revisions + aggregate budget, all in one transaction.
  A preflight / apply race that bumps a different canonical path
  is detected and the batch rolls back atomically.
- The three modes are genuinely distinct and the contract is
  pinned by `test/release-gate/v113-identity-side-effect-free.test.ts`
  (9 tests covering lookup zero-writes, strict_existing
  zero-writes, register-only mutation, and cross-platform
  determinism).

### Negative / risks

- The mode parameter is now required on
  `resolveMemoryScopeWithStore`. The default `"register"`
  preserves the legacy behaviour for callers that have not been
  updated yet, but a future release should remove the default and
  require every caller to pass an explicit mode (so the
  type-level audit is complete).
- The `addColumnIfMissing("import_batches", "audit_metadata_json", ...)`
  call inside `migrate_v12_to_v13` is an additive schema change.
  It does NOT bump `user_version` (the v1.1.3 contract pins v13
  as sufficient) but a future v14 release should make it a
  first-class migration step.

### Maintenance

- If a future release changes the `strict_existing` contract
  (e.g. removes the "absent → conflict" mapping or adds a
  "soft-warm" alias for an unknown path), the apply-time
  identity revalidation block in `src/portability/importer.ts`
  MUST be revisited. The check assumes that a successful
  preflight `strict_existing` call implies the identity is
  `bound` AND that the apply-time `strict_existing` call returns
  the same envelope; any change to either assumption can let
  drift slip through the revalidation.
- If a future release adds an in-band identity delete / rename
  path (e.g. an `import` of an identity bundle, or a `forget`
  that targets a `project_id`), the apply path's preflight
  fail-fast contract (the identity is `bound` before any row is
  written) changes. The revalidation is already in place to
  catch the drift; the only follow-up is to update the
  IDENTITY-CARVE-OUT comment block that this ADR
  supersedes.

## Alternatives considered

- **Drop the mode parameter entirely.** Rejected because the
  three-way distinction is genuinely useful at the call site
  (a write service wants `register`; a read service wants
  `strict_existing`; an exploratory read wants `lookup`). Forcing
  every caller to implement the mode branching inline would
  scatter the contract.
- **Mode enforcement via a separate `Mode` enum / class.**
  Rejected because the existing `IdentityResolutionMode` string
  union is already the public type and the v1.1.1 PR-2 contract
  pins the string literal. A new class would be a breaking change
  for no observable benefit.
- **Apply-time revalidation via a hash on the `project_identities`
  row.** Rejected because the race surface we care about is
  identity-table edits (canonical path changes), not row-level
  version bumps. A separate `ProjectIdentityResolver.resolve(...,
  "strict_existing")` call is the natural re-check and matches
  the preflight contract.
- **Bump the `user_version` to 14 for the audit_metadata column.**
  Rejected because the column is purely additive (defaults to
  `{}`, no NOT NULL without default, no CHECK constraints that
  touch existing rows). The `addColumnIfMissing` helper is the
  established pattern for additive changes; bumping the schema
  version would force a migration test that doesn't actually
  test anything new.

## Implementation references

- `src/scope-resolver.ts` — `resolveMemoryScopeWithStore` now
  dispatches to `lookupIdentity` / `strictExistingIdentity` /
  `registerIdentity`. The `mode` parameter is required.
- `src/portability/importer.ts` — `preflightImport` populates
  `plan.scopes` from every project-scoped entry's identity check.
  `applyImport` re-validates the scopes inside the apply
  transaction and throws `identity_drift` on any drift.
- `src/portability/import-batch-store.ts` — `complete(...)` and
  `fail(...)` accept an optional `auditMetadata` argument; the
  apply writer threads the identity-revalidation envelope onto
  the `completed` or `failed` row.
- `src/sqlite-store.ts` — additive `audit_metadata_json` column
  on `import_batches` (no `user_version` bump; covered by
  `addColumnIfMissing` for existing v13 databases).
- `test/release-gate/v113-identity-side-effect-free.test.ts` —
  9 tests pinning the three-mode contract.
- `test/release-gate/p1-atomic-import.test.ts` — new
  `identity_drift` test (commit 4) pinning the apply-time
  revalidation rollback contract.
- `test/release-gate/p3-import-batch-lineage.test.ts` — new
  audit-metadata assertions on the existing
  successful-snapshot test and a new forced-drift test (commit 6)
  pinning the failure-row metadata contract.

## See also

- ADR-0001 — Local admin capability boundary (the v1.1.2 admin
  boundary that the import capability contract references).
- `docs/superpowers/specs/2026-07-28-v1.1.3-gate-01-identity-design.md`
  — the design spec for #31.
- `docs/superpowers/plans/2026-07-28-v1.1.3-gate-01-identity-plan.md`
  — the implementation plan for #31.
- `docs/guides/identity-resolution.md` — operator-facing guide.