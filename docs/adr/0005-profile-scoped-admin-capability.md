# ADR-0005 — Profile-scoped admin capability + load-time permission validation

- Status: Accepted
- Date: 2026-07-28
- Issue: #32 (v1.1.3 GATE-02, sub-issue of #30)
- Authors: agent-recall maintainers
- Supersedes: the v1.1.2 IDENTITY-CARVE-OUT in
  `src/portability/importer.ts` lines 962–1052
  (see ADR-0004 for the v1.1.3 IDENTITY-CARVE-OUT
  closure on the identity lane)

## Context

The Stage 18 v1.1.2 (issue #23, ADR-0001)
`CapabilityStore` accepts a `mode` argument on
`resolve` and persists an in-memory token via
the `grant()` / `revoke()` CLI commands. The
store is the gate for `trust_promotion` and
`sensitivity_restricted` capability types, and
the MCP server entry fails closed when
`AGENT_RECALL_PROFILE=admin` is set without a
valid capability.

The v1.1.2 contract leaves two gaps:

1. **Core-with-cap visibility leak.** A Core
   or Extended process with a valid `admin.cap`
   in its data home inherits `"restricted"`
   visibility — the SQL-boundary sensitivity
   filter is gated only on
   `capabilityStore.hasCapability()`, not on
   the active profile. The MCP server's
   `actorMaxSensitivity` derivation conflates
   "is there a file on disk" with "is the
   active profile Admin".

2. **Permission validation is JSON-only.**
   `CapabilityStore` parses the file content
   but does NOT validate the filesystem
   permission boundary at load time. A `0644`
   / group-readable `admin.cap` is loaded as
   if it were `0600`. On Windows, no ACL check
   runs at all. Symlinks and reparse points
   are not refused.

This lane (#32) closes both gaps.

## Decision

We pin three orthogonal contracts:

### 1. Profile-scoped visibility

`actorMaxSensitivity` is derived as:

```ts
const visibilityLifted =
  activeProfile === "admin" && capabilityStore.hasCapability() === true;
actorMaxSensitivity = visibilityLifted ? "restricted" : "normal";
```

Only an Admin-profile process with a valid
capability gains `"restricted"` visibility. A
Core / Extended process with a valid
`admin.cap` stays at `"normal"` regardless of
the on-disk capability. The contract pins
the rule on the resource layer too
(`memory://project/{id}/memory/{mid}`).

### 2. Load-time permission validation

`validatePermissionBoundary(path)` runs
BEFORE the JSON parse so a drift never
reveals token bytes. The contract:

| Platform | Rule |
|----------|------|
| POSIX | `lstat` rejects symlinks; `stat` checks `mode & 0o077 === 0`; `stat.uid === process.getuid()` |
| Windows | `lstat` rejects symlinks / reparse points; `stat` rejects non-regular files; an `icacls` probe refuses any non-system non-owner principal (BUILTIN\\Users, BUILTIN\\Remote Desktop Users, Everyone, Authenticated Users) |

System principals (BUILTIN\\Administrators,
NT AUTHORITY\\SYSTEM/LOCAL SERVICE/NETWORK
SERVICE, APPLICATION PACKAGE AUTHORITY\\) are
accepted as inherited; only user-added grants
trigger `acl_drift`.

`CapabilityStatus` gains `kind: "drift"` +
`drift_reason: PermissionDriftReason`; the
underlying `fs` error stays in the log; the
status envelope NEVER includes token bytes.

### 3. Per-request authorization

The per-request capability token path is
preserved as the canonical way for a Core /
Extended process to authorize a privileged
operation. The path is gated by a new
`profile_required?: "admin"` per-type field:

| Type | profile_required |
|------|------------------|
| `trust_promotion` | `"admin"` |
| `sensitivity_restricted` | `"admin"` |
| `import_trust_restore` | (none) |
| `import_restricted` | (none) |
| `sensitivity_visibility` | `"admin"` |

Types with `profile_required: "admin"` refuse
per-request authorization on Core / Extended
with `reason: "profile_mismatch"`. The
Admin-profile process authorizes every type
via the in-memory capability token (no
per-request path needed). Types without
`profile_required` work on every profile via
the per-request token.

## Consequences

### Positive

- The Core-with-cap visibility leak is
  closed. Operators can no longer accidentally
  grant `"restricted"` visibility to a Core
  process by leaving `admin.cap` on disk.
- The Admin profile remains the single
  source of truth for restricted visibility
  AND for `profile_required: "admin"`
  capability types (trust, sensitivity,
  visibility).
- The per-request capability path stays the
  explicit choice for agentic flows that must
  work in Core / Extended without sacrificing
  security (the import capability contract
  pins `profile_required: undefined` for
  `import_trust_restore` + `import_restricted`).
- The load-time permission validation
  enforces the v1.1.2 "POSIX 0o600 / Windows
  owner-only ACL" contract via the OS's
  filesystem APIs; a drift surfaces
  immediately to the operator via
  `memory://health` + `admin status` without
  leaking token bytes.

### Negative / risks

- A test fixture that constructs a
  `MemoryService` without `activeProfile`
  defaults to `"core"`. Tests that exercise
  `trust_promotion` or `sensitivity_restricted`
  via per-request tokens must opt into the
  Admin profile (this is a deliberate
  break — the v1.1.2 test fixtures inherited
  the buggy Core-with-cap visibility).
- The Windows ACL probe shells out to
  `icacls` and parses the output. The
  parser is permissive (accepts all known
  system principals) but a future Windows
  release that introduces a new system
  principal may surface `acl_drift` for a
  file that should be accepted. The
  maintenance note covers this case.

### Maintenance

- A future lane that changes the
  `profile_required` table must update both
  `CAPABILITY_TYPE_REGISTRY` (this file's
  source) and `docs/guides/operator-capability.md`.
- A future Windows release that adds new
  system principals (e.g. a new UWP package
  authority SID) must update
  `validateWindowsAcl`'s accept-list.
- The legacy escape hatch
  `AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID=1`
  is preserved unchanged on the identity
  lane (issue #31); this lane does NOT
  introduce a parallel escape hatch for the
  capability contract (by design — the
  Admin profile + per-request token are the
  only authorization paths).

## Alternatives considered

- **Bump the Admin-profile gate to also
  require a per-request token.** Rejected
  because the per-process in-memory token IS
  the source of truth (the v1.1.2 contract);
  a per-request token would break the
  per-process authorization model and
  complicate the operator workflow.
- **Drop the `admin.cap` file entirely and
  use a keyring.** Rejected because the
  v1.1.x series is explicitly local-first;
  the operator-separation contract relies on
  the filesystem permission boundary. A
  keyring migration is a future-major-version
  concern.
- **Reject all ACL drift on Windows
  regardless of the principal list.** Rejected
  because Windows always inherits system
  principals; the strict-permission-bit
  approach doesn't translate. The
  icacls-output parser is the documented
  Windows contract.
- **Bump the `user_version` schema to v14
  for the new audit metadata.** Out of scope
  (no schema migration is part of this lane;
  v13 is sufficient).

## Implementation references

- `src/admin/capability.ts` — `validatePermissionBoundary`,
  `PermissionDriftReason`, `CapabilityStatus` drift branch,
  `CAPABILITY_TYPE_REGISTRY`, `getCapabilityTypeDescriptor`,
  `authorize(input, profile?)` two-arg signature.
- `src/memory-service.ts` — `activeProfile` constructor
  parameter at position 6, threaded into ReadContext +
  WriteContext.
- `src/services/memory-read-service.ts` — `activeProfile`
  field on `ReadContext`.
- `src/services/memory-write-service.ts` — `activeProfile`
  field on `WriteContext`; `authorizeCapability` threads
  the profile through.
- `src/index.ts` — `createService` accepts `activeProfile`;
  `registerMemoryResources` derives `actorMaxSensitivity`
  with the (admin + capability) gate.
- `src/cli/commands/admin.ts` — `admin status` surfaces
  the `drift` branch with the stable `drift_reason` code.
- `test/release-gate/v113-capability-profile.test.ts` (NEW)
  — 16 tests pinning the three contracts.
- `test/admin/capability.test.ts` (extended) — 6 new
  permission-boundary tests.
- `test/release-gate/p3-memory-semantics-mcp.test.ts`
  (extended) — Core-with-cap visibility assertion.
- `test/blackbox/mcp-all-tools-e2e-core.test.ts`
  (extended) — Core-packaged-refuses-privileged-write
  assertion.

## See also

- ADR-0001 — Local admin capability boundary
  (the v1.1.2 admin boundary that #32
  tightens).
- ADR-0004 — Identity resolution modes (the
  v1.1.3 GATE-01 sibling ADR that closes
  the identity-side carve-out).
- `docs/guides/operator-capability.md` —
  operator-facing guide for the
  grant / status / revoke / forensic flow.
- `docs/superpowers/specs/2026-07-28-v1.1.3-gate-02-capability-design.md`
  — the design spec for #32.
- `docs/superpowers/plans/2026-07-28-v1.1.3-gate-02-capability-plan.md`
  — the implementation plan for #32.