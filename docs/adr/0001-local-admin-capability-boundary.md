# ADR-0001 — Local admin capability boundary

- Status: Accepted
- Date: 2026-07-27
- Issue: #23 (Stage 18 v1.1.2)
- Authors: agent-recall maintainers

## Context

AgentRecall v1.1.1 introduced four memory-semantics
tools (`record_memory_feedback`,
`record_memory_provenance`, `explain_memory_provenance`,
`confirm_memory_trust`) plus the `sensitivity` /
`trust_level` controlled fields on `remember` /
`update_memory`. The Stage 16 v1.1.1 PR-7 release
gated the `user_confirmed` trust tier on a
client-supplied `user_confirmed: true` boolean,
treating the boolean as authorization evidence. The
v1.1.2 follow-up roadmap left issue **#23**
("Trusted local admin boundary for sensitive
memory operations") on the list; this ADR is the
design decision for that issue.

The v1.1.1 boolean gate is an **unauthenticated
assertion**. Any MCP client (or any process that can
speak the JSON-RPC wire) can flip the boolean and
promote a memory to `user_confirmed` (or write a
`restricted` row). The v1.1.1 contract does not
distinguish between "a coding agent talking to the
user" and "a coding agent lying to the user". The
v1.1.2 contract has to close that gap without
introducing a new dependency on an external auth
service — the v1.1.x series is explicitly a
local-first, single-process, single-operator tool.

## Decision

We introduce a **local operator capability** as the
single source of truth for the v1.1.2 admin
boundary. The capability is:

- A 32-byte random secret (64 hex chars) generated
  by the operator-facing `agent-recall admin grant`
  CLI command.
- Stored at `${AGENT_RECALL_HOME}/admin.cap` with
  POSIX `0o600` (owner-only) permissions. On
  Windows, the equivalent is an owner-only ACL set
  via `icacls /inheritance:r /grant:r <user>:(R,W)`.
- Consulted by the write path on every `trust_level:
  "user_confirmed"` promotion and every
  `sensitivity: "restricted"` write. The
  comparison is constant-time
  (`crypto.timingSafeEqual`); the on-disk token is
  held in memory for the lifetime of the MCP
  process; the in-memory token is the runtime
  source of truth.
- Consulted by the import preflight on every
  `restore_trust: true + history_mode: "full_history"`
  import and every `sensitivity: "restricted"`
  import. The preflight fails closed when the
  capability is missing or invalid.
- Consulted by the read service on the
  `sensitivity_visibility` capability type. The
  default read sensitivity is `actor_max_sensitivity
  = "normal"` (fail-closed); a loaded capability
  raises the value to `"restricted"` so the
  reader can see `private` and `restricted` rows.

The `user_confirmed: true` boolean remains a
documented field on the input payload (for
backward compatibility) but is **no longer
authorization evidence**. The validator accepts the
field without gating on it; the service performs the
`CapabilityStore.authorize(...)` check.

A new `admin` profile is added to the MCP tool
selector (`AGENT_RECALL_PROFILE=admin`). The admin
profile refuses to bind to stdio without a valid
capability; `core` and `extended` are unchanged
(they start in fail-closed mode — a privileged
write is rejected at the service layer).

The CLI `agent-recall admin` is the only supported
mutation surface for the capability. MCP tool calls
cannot create or rotate a capability. The CLI
prints a `**** <last 4 hex>` redacted tail and
never logs the full token; the on-disk file is the
only persistent copy.

## Why not crypto / signing?

The v1.1.x series is local-first. The capability is
a single shared secret between the operator and the
caller — there is exactly one operator per
`AGENT_RECALL_HOME` directory. A cryptographic
multi-user boundary would require a new dependency
(ed25519 signing, an external secret store, a
remote auth service) and is explicitly out of scope
for the v1.1.x series. The v1.1.2 contract documents
this in the brief: "this is local operator
separation rather than cryptographic multi-user
security".

A reader with read access to
`~/.agent-recall/admin.cap` can self-promote; the
v1.1.2 contract relies on POSIX file permissions /
Windows ACLs to limit that read access to the
operator account. The `chmod 0o600` (POSIX) and
`icacls` (Windows) calls are enforced at the
`grant()` boundary; the `status()` read path
verifies the permissions and surfaces
`permission_drift` when the on-disk state has been
tampered with.

## Why a single token (not per-operation tokens)?

The v1.1.2 surface has five privileged operations
(`trust_promotion`, `sensitivity_restricted`,
`import_trust_restore`, `import_restricted`,
`sensitivity_visibility`). A per-operation token
model would force the operator to manage five
separate capabilities. The single-token model is
simpler: the operator runs `agent-recall admin grant`
once, the MCP server loads the token at startup, and
every privileged call authorises against the same
on-disk state. Per-operation audit metadata is
recorded in the audit log (`capability_type` +
`reason` + `request_id`) so a reviewer can answer
"who promoted which memory, and when?" without
needing a separate token for each operation.

The `CapabilityType` union is the per-operation
discriminator; the same token authorises every type.
A future v1.2 release could split the union into
per-operation tokens if a real threat model
demands it (e.g. an operator who wants to grant a
caller `trust_promotion` rights without granting
`import_restricted`). The v1.1.2 contract is the
simplest viable model; the audit metadata is the
diagnostic fallback.

## What about the v1.1.1 `user_confirmed: true` boolean?

Preserved as a HINT, not authorization evidence.
The validator still extracts the value (so existing
clients keep parsing their payloads); the service
no longer gates on it. The audit log records
`trusted_user_confirmation: true` on a successful
trust promotion (the value the caller supplied) so
a reviewer can correlate the transition to the
original `confirm_memory_trust` tool call.

The `user_confirmed: true` field is no longer
required by the `remember` / `update_memory` /
`confirm_memory_trust` schemas. The MCP `confirm_memory_trust`
tool still sets the value to `true` internally
(the tool is the canonical trusted path) so the
audit attribution is consistent; the value is
**not** a substitute for the capability.

## Permission model (POSIX)

The capability file is written with `0o600` (owner
read/write only). The `grant()` call:

1. Generates a 32-byte random token (64 hex chars).
2. Writes the file to a temp path
   (`admin.cap.tmp.<pid>.<ts>`) with `0o600`.
3. Calls `fs.chmodSync(tmp, 0o600)` to pin the
   permission BEFORE the rename (a peek at the temp
   file between write and rename cannot read the
   token).
4. `renameSync(tmp, admin.cap)` (atomic on POSIX).
5. `fs.chmodSync(admin.cap, 0o600)` (re-verify
   after rename; the rename is atomic on POSIX
   but the re-verify is the documented fail-closed
   guard).

A `permission_drift` error (the on-disk file has a
mode other than `0o600`) is surfaced by the
`status()` read path; the v1.1.2 contract treats the
file as missing in that case (the fail-closed
default).

## Permission model (Windows)

`fs.chmod` on Windows only sets the read-only flag.
The `grant()` call shells out to `icacls`:

```cmd
icacls <path> /inheritance:r /grant:r <user>:(R,W) /remove Everyone /remove Users
```

`/inheritance:r` strips inherited ACEs (the
directory default ACL); `/grant:r` grants the
named SID the listed rights; `/remove` strips
`Everyone` / `Users` ACEs that would otherwise leak
the file. The verify path reads the ACL back via
`icacls <path>` and asserts at least one ACE
granting the current user and zero ACEs
mentioning `Everyone` or `BUILTIN\Users`.

A failure of `icacls` (e.g. missing on PATH) raises
a `PermissionDriftError`; the grant helper catches
it and removes the partial file so the store does
not end up in a half-installed state.

## Sensitivity visibility (the SQL/store boundary filter)

The v1.1.2 contract enforces the sensitivity
isolation at the SQL boundary (NOT at the response
layer). The `EntryFilters` shape gains a new
`actor_max_sensitivity` field; the store's
`buildEntryWhere` helper encodes a
`CASE WHEN sensitivity ... THEN <order>` so a row
whose `sensitivity` exceeds the value is excluded
from every public read path (`getMemory`,
`listMemories`, `searchMemories`,
`exportMemoryContext`, maintenance diagnostics,
the MCP resources, the CLI `show` / `audit` paths).
A caller without the capability cannot probe
whether a `private` or `restricted` row exists —
the response is an empty list, identical to the
behaviour for a non-existent row.

The denial surfaces a stable
`forbidden_visibility` machine-readable error
through the per-tool / per-resource layer; the
SQL filter is the source of truth, the response
filter is a documentation hint.

## Default values (the fail-closed contract)

| Profile | `actor_max_sensitivity` | Capability required for... |
| --- | --- | --- |
| `core` (default) | `"normal"` | `trust_promotion`, `sensitivity_restricted` |
| `extended` | `"normal"` | `trust_promotion`, `sensitivity_restricted` |
| `admin` | `"restricted"` (when capability is loaded) | startup (the server refuses to bind) |

A missing `CapabilityStore` (e.g. a direct
service call from a unit test, the legacy
`MemoryService` constructor with no
`capabilityStore` arg) is fail-closed: every
privileged write is rejected with `unauthorized`,
every privileged read returns the `actor_max_sensitivity: "normal"`
filter. The default `MemoryService` constructor
is the backwards-compatible path (no capability,
fail-closed privilege); the MCP server explicitly
constructs the `CapabilityStore` at startup.

## CLI surface

```
agent-recall admin grant [--label <text>]
agent-recall admin status [--json]
agent-recall admin revoke
agent-recall admin help
```

The grant output is `**** <last 4 hex>` plus the
file path. The `--json` flag emits
`{ ok: true, path, created_at, label?, token_tail, fingerprint }`.
The full token is never printed; the operator
copies the value from a side channel (or the
`admin grant` JSON output piped to a secret store).

## Alternatives considered

- **HMAC of the operator's password**: rejected
  because the v1.1.x series is local-first and
  password-based auth is out of scope.
- **A separate `AGENT_RECALL_ADMIN_TOKEN` env var**:
  rejected because env vars are visible to every
  process in the user's session. The capability
  file is owner-only at the file-system level,
  which is a stronger isolation guarantee.
- **MCP-level authentication (OAuth / API keys)**:
  rejected for the same reason. The v1.1.x series
  is local-first; a future v1.2 could add MCP-level
  auth on top of the v1.1.2 capability.
- **Per-operation tokens**: rejected because the
  operator surface is small (5 operations) and a
  single token is simpler. Per-operation audit
  metadata is the diagnostic fallback.

## Risks

- **A reader with `~/.agent-recall/admin.cap` read
  access can self-promote.** The v1.1.2 contract
  relies on POSIX `0o600` / Windows owner-only ACL
  to limit that read access. An operator who
  loosens the permission (e.g. for a multi-user
  workstation) is opting out of the v1.1.2
  security model.
- **The in-memory token is the runtime source of
  truth.** A process crash after a `grant()` and
  before the next `authorize(...)` call would
  leave the in-memory state out-of-sync with the
  on-disk state. The constructor reads the on-disk
  file at startup; the in-memory state is the
  per-process state. A long-running MCP server
  is expected to be restarted for a token
  rotation; an `admin revoke` + `admin grant`
  cycle is the documented rotation path.
- **The Windows ACL path shells out to `icacls`.**
  A Windows host without `icacls` (e.g. a
  containerised Windows server) cannot install
  a capability. The failure surfaces a
  `PermissionDriftError`; the grant is rolled
  back. A future release could add a Node-native
  ACL helper, but the v1.1.2 contract pins
  `icacls` as the documented Windows path.
- **The `actor_max_sensitivity` filter is a SQL
  predicate, not a row-level security policy.**
  A misconfigured filter (e.g. a future schema
  change that adds a new sensitivity tier) would
  bypass the isolation. The v1.1.2 contract
  documents the tier ordering
  (`normal < private < restricted`) and pins the
  `CASE WHEN ... THEN <order>` SQL expression as
  the single source of truth.

## Status

Accepted; tracked in the v1.1.2 release notes
(`#23` section).

## Implementation references

- `src/portability/importer.ts` — the
  `applyImport` doc comment carries the
  v1.1.2 / #24 identity-carve-out
  documented in the
  `Known non-blocking limits` sub-section
  of the v1.1.2 / #24 CHANGELOG entry.
  The carve-out records the closure
  decision that the apply transaction
  re-validates revisions + aggregate
  budget but does not re-call
  `ProjectIdentityResolver.resolve(...,
  "strict_existing")`, because identity
  is a long-lived entity pinned at the
  preflight fail-fast path. See the
  review verdict by `ora-2` recorded in
  `.superpowers/sdd/task-5-review.md`
  for the closure rationale and the
  maintenance note for the future
  identity delete / rename path.
