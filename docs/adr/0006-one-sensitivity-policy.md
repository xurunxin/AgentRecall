# ADR 0006 — One sensitivity policy across every read / export / resource / maintenance path

Date: 2026-07-28
Status: Accepted (v1.1.3 GATE-03, issue #33)
Parent gate: [#30](https://github.com/xurunxin/AgentRecall/issues/30)
Sub-issue: [#33](https://github.com/xurunxin/AgentRecall/issues/33)

## Context

The pre-v1.1.3 sensitivity filter lived in scattered
places. v1.1.2 (issue #23 + review by `ora-8`) added a
SQL-boundary filter to the read surface via
`actorMaxSensitivity` threaded into `peekEntry` /
`listEntries` / `searchEntries`. v1.1.3 GATE-02 made the
active profile an explicit input (`activeProfile`), so
`MemoryService` now derives `actorMaxSensitivity` from
`(activeProfile === "admin" && hasCapability()) ?
"restricted" : "normal"`.

That gave us a single input (`activeProfile`) and a
single derived visibility ceiling
(`actorMaxSensitivity`). The pre-#33 contract was:
filter at the SQL boundary for the three core read
paths, plus per-request capability overrides where the
request supplied a token.

What #33 closes: **the same visibility ceiling is NOT
yet threaded through every content-bearing path.**
Maintenance helpers (`find_duplicates`, plan/apply
diagnostics, the budget cleanup candidates), MCP
templated resources, the Markdown index/context export,
CLI show / list / search / export / diagnostics, the
`explainProvenance` surface, the backup inspection
surface, and several `peekEntry` overloads within write
+ maintenance paths can still leak hidden rows or
restricted titles / ids / counts.

#33 makes the authorization decision ONE canonical,
typed result that every content-bearing path consults,
with the SQL-boundary filter as the ONLY place
sensitivity is decided.

## Decision

### The canonical `AuthorizationDecision`

```ts
export type AuthorizationDecision = {
  max_sensitivity: "normal" | "private" | "restricted";
  capability_token_present: boolean;
  reasoning: string;
};
```

- `max_sensitivity` is the highest tier the caller is
  authorized to read or write. The SQL-boundary filter
  is the ONLY place this value is enforced.
- `capability_token_present` is a boolean (NOT the
  token bytes) for audit metadata.
- `reasoning` is a stable, loggable string for
  forensic review. The string NEVER includes the
  token bytes; only the operation kind, the active
  profile, and the capability type (stable code).

`resolveAuthorization(ctx, operation)` is the
single source of truth. The resolver is a PURE
function over `AuthContextShape`:

```ts
export type AuthContextShape = {
  activeProfile: "core" | "extended" | "admin";
  hasCapability: boolean;
  requestCapability?: string;        // bytes never logged
  capabilityType?: string;            // stable code, e.g. "sensitivity_restricted"
};
```

Algorithm:
1. Default `max_sensitivity = "normal"` (fail-closed).
2. If `requestCapability !== undefined`, lift to
   `"restricted"` and set
   `capability_token_present = true`.
3. Else if `activeProfile === "admin" &&
   hasCapability === true`, lift to `"restricted"`.
4. Else return the fail-closed decision.

The resolver does NOT touch the filesystem, the
database, or the `CapabilityStore`. The caller performs
the per-request authorization (when one is supplied)
and threads the result via `requestCapability`. The
module is dependency-free and trivially testable.

### The 12-action maintenance classification

`MaintenanceActionPolicy` is the canonical table for
"which profile / capability is authorized to run this
action":

| Action | Safe in Extended | Restricted to Admin | Capability-required |
|--------|------------------|----------------------|---------------------|
| `archive_low_value` | yes (normal-only) | — | — |
| `expire_due` | yes (normal-only) | — | — |
| `rebuild_markdown_index` | yes (limited to visible scope) | — | — |
| `vacuum_fts` | yes (schema op, no row scan) | — | — |
| `find_duplicates` | yes (normal-only) | — | — |
| `merge_duplicates` | — | yes (Admin profile) | — |

(Future lanes may extend the registry; the table is
the single source of truth, not inlined policy at
each dispatch site.)

The mapping from the spec's 12-action table to the
current 6-action `MaintenanceAction` enum is:

- `view_cleanup_candidates` → `getMemoryBudget`'s
  `cleanup_candidates` (covered by the read surface)
- `plan_archive_low_value` / `plan_merge_duplicates` /
  `plan_apply_maintenance` → `planMaintenance` (the
  planner helper; produces zero rows for restricted
  scope)
- `apply_archive_low_value` → `archive_low_value`
- `apply_merge_duplicates` → `merge_duplicates`
- `apply_supersede` → `supersedeMemory` (write path)
- `apply_forget` → `forgetMemory` (write path)
- `apply_maintenance` → `applyMaintenance` (plan-driven)
- `apply_force_forget` → reserved for future lane;
  pre-#33 the per-request `sensitivity_restricted`
  capability type is the canonical gate

### Per-row vs per-bundle semantics

`allow_restricted: true` (the bundle-level import flag)
is now redundant. The capability token (when supplied
per-request) authorizes restricted rows individually;
the bundle-level flag is deprecated-but-preserved for
backward compat (one release).

### Backward compatibility

- `actorMaxSensitivity` (the v1.1.2 derived string) is
  kept as a derived helper for callers that pre-date
  the v1.1.3 split. New code MUST consult
  `authorization` directly.
- `peekEntry(id)` (no-options overload) remains the
  write / maintenance path gate. The new
  `peekEntryUnrestricted(id)` accessor on
  `MemoryReadService` is a typed wrapper that callers
  may invoke ONLY when their own authorization
  decision lifts to `"restricted"`.
- `MemoryServerContext.actorMaxSensitivity` and
  `ReadContext.actorMaxSensitivity` are kept as
  derived helpers; the canonical field is
  `authorization`.

## Consequences

Positive:
- One decision, one source of truth. The SQL-boundary
  filter is the ONLY place the sensitivity ceiling is
  decided; every other surface consults the same
  decision.
- The matrix (3 profiles × 3 sensitivity × 6
  content-bearing paths) is pinned in the
  `test/release-gate/v113-sensitivity-policy.test.ts`
  suite. Future lanes extend the table; they do NOT
  inline policy at each dispatch site.
- `reasoning` gives the operator a stable,
  non-sensitive surface to correlate denials with the
  active profile. Audit rows never carry token bytes.

Negative / acknowledged:
- The legacy `actorMaxSensitivity` string is kept as a
  derived helper; the contract surface widens by one
  field. The CLI commands and MCP resources receive
  both the typed decision AND the string. Callers that
  pre-date the v1.1.3 split keep working without
  changes.
- The maintenance service grows by ~110 lines (the
  `MaintenanceActionPolicy` table). The growth is
  acceptable: future lanes extend the table; they do
  NOT inline policy at each dispatch site.

Out of scope:
- New schema. The `sensitivity` column on
  `memory_entries` is sufficient.
- Identity (#31) and capability (#32) layers. Both
  are already on `main`. This lane consumes them.
- New dependencies.
- Bypassing the existing per-request capability token
  escape hatch. A per-request capability still
  authorizes the operation; #33 makes the boundary
  ordering consistent, not new-authoritative.

## Alternatives considered

1. **Inline `actorMaxSensitivity` at every consumer**
   (status quo before #33). Rejected: the visibility
   ceiling drifted across the codebase, and the
   `findDuplicates` + `budgetUsage` leaks are
   pre-#33-era bugs.

2. **Two distinct decisions (read vs write).**
   Rejected: the visibility ceiling is the same for
   every content-bearing path. Two decisions would
   double the surface area without any contract
   benefit.

3. **Encode the decision in the store as a row
   attribute.** Rejected: the store is already
   per-call parameterized via
   `actor_max_sensitivity`. Encoding the decision in
   the store would couple the policy to the
   persistence layer.

## References

- Design spec: `docs/superpowers/specs/2026-07-28-v1.1.3-gate-03-sensitivity-design.md`
- Implementation plan: `docs/superpowers/plans/2026-07-28-v1.1.3-gate-03-sensitivity-plan.md`
- ADR-0001 (the v1.1.2 SQL-boundary filter)
- ADR-0005 (the v1.1.3 GATE-02 profile-scoped capability)
- Operator-facing matrix: `docs/guides/sensitivity-matrix.md`