# Sensitivity matrix — operator-facing reference

Date: 2026-07-28
Lane: v1.1.3 GATE-03 (issue #33)
Companion: `docs/adr/0006-one-sensitivity-policy.md`

This guide documents the 3-profile × 3-sensitivity
matrix the v1.1.3 GATE-03 lane pins. Every row / column
maps to a real assertion in
`test/release-gate/v113-sensitivity-policy.test.ts`.

## Profiles

- **Core** — the packaged default. Fail-closed.
- **Extended** — adds maintenance / semantic tools;
  same fail-closed visibility contract as Core.
- **Admin** — adds the privileged surface; lifts
  visibility to `"restricted"` ONLY when the process
  loaded a valid capability at startup.

The active profile is set via the
`AGENT_RECALL_PROFILE` env var (`core` / `extended` /
`admin`); the CLI and MCP entry resolve it through
`resolveActiveProfile(...)`.

## Sensitivity tiers

Every `memory_entries` row carries one of three
sensitivity values:

- `"normal"` — visible to every profile.
- `"private"` — visible only to Admin + capability.
- `"restricted"` — visible only to Admin +
  capability.

## Matrix

The table reads as: "Does the {profile} profile see
{operation}-class rows of {sensitivity} tier?"

### Read surface

| Profile × Sensitivity | Read (getMemory) | Search / List / Recall | Budget | Markdown Export |
|-----------------------|------------------|------------------------|--------|-----------------|
| Core × normal         | yes              | yes                    | yes    | yes             |
| Core × private        | **denied** (not_found) | **denied** (filtered at SQL) | **denied** | **denied** |
| Core × restricted     | **denied** (forbidden_visibility) | **denied** | **denied** | **denied** |
| Extended × normal     | yes              | yes                    | yes    | yes             |
| Extended × private    | **denied** (not_found) | **denied** | **denied** | **denied** |
| Extended × restricted | **denied** (forbidden_visibility) | **denied** | **denied** | **denied** |
| Admin × normal        | yes              | yes                    | yes    | yes             |
| Admin × private       | yes              | yes                    | yes    | yes             |
| Admin × restricted    | yes              | yes                    | yes    | yes             |

The deny paths on `getMemory` surface two distinct
error codes:

- `"not_found"` — for rows that don't exist OR for
  rows the caller can't see but the resource layer
  refuses to acknowledge exist.
- `"forbidden_visibility"` — for single-row reads
  (`getMemoryWithVisibility`) where the row exists at
  a higher sensitivity than the caller's ceiling.

The deny path NEVER surfaces the row's `sensitivity`
literal, title, body, tags, source, or any other
row-derived secret.

### Maintenance surface (12 actions)

The maintenance service consults the
`MaintenanceActionPolicy` table to gate destructive
actions. The current `MaintenanceAction` enum maps to
six of the spec's twelve actions; the planner
(`planMaintenance`) covers the planning actions.

| Action | Core / Extended | Admin (no capability) | Admin + capability |
|--------|-----------------|-----------------------|---------------------|
| `archive_low_value` (apply) | yes (normal-only) | yes (normal-only) | yes (normal-only) |
| `expire_due` (apply) | yes (normal-only) | yes (normal-only) | yes (normal-only) |
| `rebuild_markdown_index` | yes (visible scope) | yes (visible scope) | yes (visible scope) |
| `vacuum_fts` | yes (schema op) | yes (schema op) | yes (schema op) |
| `find_duplicates` | yes (normal-only) | yes (normal-only) | yes (all sensitivity) |
| `merge_duplicates` | **denied** (`unauthorized`) | **denied** (`unauthorized`) | yes |

The planner (`planMaintenance`) yields zero destructive
items on Core / Extended (the duplicate scan excludes
restricted rows); a Core caller running `applyMaintenance`
sees a no-op plan.

### Import / Export / Backup / Markdown

| Surface | Core / Extended | Admin + capability |
|---------|-----------------|---------------------|
| `CanonicalExporter.exportScope` | normal + private rows | restricted rows included |
| Envelope `max_sensitivity` field | `"normal"` or `"private"` | `"restricted"` |
| `importMemoryExport` (per-row) | restricted rows refused at apply | restricted rows accepted |
| `allow_restricted: true` (bundle-level) | deprecated-but-accepted | deprecated-but-accepted |
| `listBackups` | full list (no per-backup sensitivity tags) | full list |
| `MarkdownExporter.exportScope` | restricted rows refused with `forbidden_visibility` exit 1 | restricted rows included |

The bundle-level `allow_restricted: true` flag is
deprecated-but-preserved for one release. The canonical
per-row enforcement is on the importer's apply step.

### Provenance / Doctor / MCP resources

| Surface | Core / Extended | Admin + capability |
|---------|-----------------|---------------------|
| `explainProvenance` (restricted row) | `not_found` (no row existence leak) | full explanation |
| `memory://health` | surfaces `active_profile` + `capability_state` | surfaces `active_profile: "admin"` + `capability_state: "granted"` |
| `memory://project/{id}/memory/{mid}` | restricted row → `forbidden_visibility` | full row |
| Doctor checks | walk visible scope only | walk every scope |

## CLI mapping

The CLI's `AGENT_RECALL_PROFILE` env var controls the
per-invocation authorization:

```sh
AGENT_RECALL_PROFILE=core       agent-recall list
AGENT_RECALL_PROFILE=extended   agent-recall list
AGENT_RECALL_PROFILE=admin      agent-recall list
```

The CLI commands (`list` / `show` / `search` / `export`
/ `diagnostics`) thread the same decision the MCP
server threads; the deny path exits 1 with the same
stable error codes.

## Audit log

Every read / write / maintenance / export / import
operation that consults the decision emits an audit
row with:

- `metadata.active_profile` — the caller's profile.
- `metadata.capability_state` — `granted` / `missing`
  / `drift`.
- `metadata.max_sensitivity` — the decision's value.

The audit row NEVER includes the capability token
bytes. The reasoning string mentions the capability
type only by its stable code (e.g.
`sensitivity_restricted`), never the token.

## Acceptance matrix

The matrix above is pinned in the following test files
(commit 7):

- `test/release-gate/v113-sensitivity-policy.test.ts`
  — 31 tests (the central matrix).
- `test/release-gate/p3-sql-boundary-sensitivity.test.ts`
  — 12 new matrix assertions.
- `test/blackbox/mcp-all-tools-e2e-core.test.ts` — 6
  Core-profile matrix assertions.
- `test/blackbox/mcp-all-tools-e2e-extended.test.ts` —
  6 Extended-profile matrix assertions.
- `test/release-gate/admin-default/mcp-admin-default.test.ts`
  — 6 Admin-profile matrix assertions.