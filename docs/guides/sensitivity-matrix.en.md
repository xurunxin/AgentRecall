# Sensitivity matrix — operator guide

> **🌏 Language**: English. 中文: [`sensitivity-matrix.md`](./sensitivity-matrix.md).  
> **Implementation version**: v1.1.3.

This guide documents the v1.1.3 GATE-03 (issue #33)
sensitivity policy. It is the operator-facing companion
to `docs/adr/0006-one-sensitivity-policy.md` (the
ADR that documents the canonical `AuthorizationDecision`
+ the maintenance classification + the per-row vs
per-bundle semantics).

## TL;DR

- **Core and Extended profiles never inherit
  `"restricted"` visibility.** A Core / Extended
  process with a valid `admin.cap` in its data
  home still sees only `"normal"` rows at the SQL
  boundary. The capability file is operator-only
  metadata; it does NOT auto-authorize restricted
  reads on a non-Admin profile.
- **Only the Admin profile + a loaded capability
  gains `"restricted"` visibility.** The
  per-process in-memory token (loaded at startup)
  is the gate; the per-request capability token
  is the per-call exception for non-`profile_required`
  capability types only.
- **The SQL boundary is the source of truth.** Every
  content-bearing path consults the canonical
  `AuthorizationDecision` and applies the filter at
  the SQL layer. No path filters at response
  rendering time.
- **`forbidden_visibility` is the stable error code**
  for unauthorized restricted access from every
  surface. The error envelope NEVER includes the
  row's `sensitivity` literal or any row-derived
  secret (title / body / tags / source).

## Central visibility matrix

| Profile × Sensitivity | Read | Search / List / Recall | Export | Maintenance apply | Import restricted bundle | Admin capability |
|-----------------------|------|------------------------|--------|-------------------|---------------------------|------------------|
| Core × normal         | yes  | yes                    | yes    | yes (apply_archive / apply_merge on normal-only) | n/a (must opt in via `allow_restricted: true` + capability token) | denied |
| Core × private        | denied | denied                | denied | denied          | denied                   | denied |
| Core × restricted     | denied | denied                | denied | denied          | denied                   | denied |
| Extended × normal     | yes  | yes                    | yes    | yes             | n/a                       | denied |
| Extended × private    | denied | denied                | denied | denied          | denied                   | denied |
| Extended × restricted | denied | denied                | denied | denied          | denied                   | denied |
| Admin × normal        | yes  | yes                    | yes    | yes             | yes (with capability)     | yes (per-request) |
| Admin × private       | yes  | yes                    | yes    | yes (with capability) | yes (with capability) | yes (per-request) |
| Admin × restricted    | yes  | yes                    | yes    | yes (with capability) | yes (with capability) | yes (per-request) |

## Maintenance action classification

| Action | Safe in Extended | Restricted to Admin | Capability-required |
|--------|------------------|----------------------|---------------------|
| `view_cleanup_candidates` | yes (normal-only listing) | — | — |
| `plan_archive_low_value` | yes (dry-run) | — | — |
| `plan_merge_duplicates` | yes (dry-run) | — | — |
| `plan_apply_maintenance` | yes (dry-run, normal-only) | — | — |
| `apply_archive_low_value` | yes (normal-only) | — | — |
| `apply_merge_duplicates` | — | yes (Admin profile, normal + private only) | per-request capability token for restricted merges |
| `apply_supersede` | — | yes (Admin profile) | — |
| `apply_forget` | — | yes (Admin profile) | per-request capability token for `sensitivity_restricted` forgets |
| `apply_maintenance` | — | yes | — |
| `preview_budget_bypass` | — | — | yes (`trust_promotion`) |
| `apply_force_forget` | — | — | yes (`sensitivity_restricted`) |
| `rebuild_markdown_index` | yes (limited to visible scope) | — | — |

## Common operator questions

### Q: I have a valid `admin.cap` in my data home but my Core process still shows `"normal"` visibility. Why?

A: That's the v1.1.3 GATE-03 contract. A Core or
Extended process NEVER inherits `"restricted"`
visibility merely because `admin.cap` exists in
its data home. The capability file is
operator-only metadata; the visibility ceiling
is profile-scoped.

To gain `"restricted"` visibility, restart the
process with `AGENT_RECALL_PROFILE=admin` (the
MCP server entry fail-closes at startup if the
Admin profile is active without a valid capability).

### Q: My Admin process fails to start. What do I do?

A: The Admin-profile MCP server entry refuses to
start without a valid capability. Run
`agent-recall admin grant` to install a valid
capability (writes the canonical `admin.cap` with
`0o600` / Windows owner-only ACL), then restart.

### Q: I get `forbidden_visibility` when I try to read a `restricted` row. What does that mean?

A: The SQL-boundary filter is hiding the row. The
`forbidden_visibility` error envelope NEVER
includes the row's `sensitivity` literal or any
row-derived secret (title / body / tags /
source) — only the operational metadata
(`memory_id`). To see the row, restart with the
Admin profile + a loaded capability.

### Q: My `apply_merge_duplicates` call returns zero merges on Core. What do I do?

A: The v1.1.3 GATE-03 spec restricts
`apply_merge_duplicates` to the Admin profile
(the destructive path requires Admin). On
Core / Extended, the maintenance service
refuses the action with `unauthorized`.

To merge on Core, run `find_duplicates` (the
read-only path is safe on Core) and then
manually supersede the duplicate rows via
`update_memory` with the canonical `revision`
+ `user_confirmed` flag (which itself requires
the `trust_promotion` capability on the
per-request path).

### Q: Can I use a per-request capability token to lift Core's visibility ceiling?

A: No. The v1.1.3 GATE-03 spec is clear: a
per-request capability token on Core / Extended
authorizes the **operation** (e.g.
`import_trust_restore` on a restricted bundle)
but does NOT lift the **visibility** ceiling.
Visibility is profile-scoped; the per-request
token is the per-call exception for non-`profile_required`
capability types only.

For restricted visibility, the Admin profile
+ a loaded capability is the only path.

## See also

- `docs/adr/0006-one-sensitivity-policy.md` — the
  ADR that documents the canonical
  `AuthorizationDecision` + the maintenance
  classification + the per-row vs per-bundle
  semantics.
- `src/services/auth-context.ts` — the canonical
  authorization decision + the
  `MAINTENANCE_ACTION_POLICY` table.
- `src/services/memory-read-service.ts` — every
  read method threads the decision.
- `docs/superpowers/specs/2026-07-28-v1.1.3-gate-03-sensitivity-design.md`
  — the design spec for #33.