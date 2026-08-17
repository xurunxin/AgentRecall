# Operator guide — admin capability

> **🌏 Language**: English. 中文: [`operator-capability.md`](./operator-capability.md).  
> **Implementation version**: v1.1.3.

This guide documents how to manage the
operator capability (`admin.cap`) under
the v1.1.3 GATE-02 profile-scoped contract
(issue #32). It is the operator-facing
companion to
`docs/adr/0005-profile-scoped-admin-capability.md`
(the ADR that documents the per-profile
contract + the load-time permission
validation rules).

## TL;DR

- The capability file is the single
  persistence surface for the operator
  capability token (32 bytes from
  `crypto.randomBytes`, 64 hex chars).
- The file lives under
  `${AGENT_RECALL_HOME}/admin.cap` with
  POSIX `0o600` / Windows owner-only ACL.
- Only the Admin-profile process with a
  loaded capability gains `"restricted"`
  visibility. Core / Extended processes
  stay at `"normal"` regardless of the
  on-disk capability.
- The per-request capability token path
  is the canonical way for a Core /
  Extended process to authorize a
  privileged operation. Capability types
  with `profile_required: "admin"` refuse
  the per-request path on Core / Extended.

## Grant / revoke / status

```text
agent-recall admin grant [--label <text>]
agent-recall admin status
agent-recall admin revoke
```

### `grant`

Writes a fresh 64-hex-char token to
`${AGENT_RECALL_HOME}/admin.cap` with the
canonical permission boundary (POSIX
`0o600` / Windows owner-only ACL via
`icacls`). The new token is printed in
redacted form (`**** <last 4 hex>`). The
operator is expected to copy the full token
into a secret store; the printed value is
NOT the full token.

A pre-existing token is rotated on every
`grant()` call (the in-memory token is the
new one; the on-disk file is overwritten).

### `status`

Reports the on-disk state without leaking
the token bytes. Possible states:

| State | Meaning |
|-------|---------|
| `granted` | The file is present, parses, and passes the permission validation. The `token_tail` (last 4 hex) + `fingerprint` (first 16 hex) are surfaced; the full token is NEVER returned. |
| `missing` | The file is absent. The store refuses every privileged operation. |
| `drift` | The file is present but fails the permission validation. The `drift_reason` is one of `permission_drift` / `acl_drift` / `symlink` / `unsupported_owner`. The token bytes are NEVER returned on the drift branch. |

When `status` reports `drift`, the
recommended remediation is to re-run
`agent-recall admin grant` (which re-creates
the file with the correct permissions). The
underlying `fs` error is logged but not
surfaced via `status` (drift reasons are
stable codes, not OS-specific messages).

### `revoke`

Removes the capability file. The CLI is
silent on success (idempotent: revoke of
a missing file is a no-op).

Restart is required for any change to take
effect on a running process (the in-memory
token is set at startup; `revoke()` removes
the file but the running process still has
the token until restart).

## Permission requirements

The file MUST be:

- **POSIX**: `0o600` (owner read/write only).
  Any group / other bit is a drift. The file
  owner MUST equal the current `process.getuid()`.
- **Windows**: owner-only ACL via `icacls`.
  The CLI grants `${user}:(F)` and removes
  `Everyone`, `Users`, and inherited ACEs.

The file MUST NOT be:

- A symlink (the canonical path-of-record
  must be a regular file).
- A directory, device, or other non-regular
  file.
- Owned by a different uid (POSIX).

The drift detection runs at `load()` time
(constructor of `CapabilityStore`). A drift
sets the in-memory token to empty; subsequent
`authorize(...)` calls return
`capability_missing`.

## Per-profile authorization

The contract pins which profile can
authorize each capability type:

| Capability type | Admin-profile | Per-request (Core / Extended) | Per-request (Admin) |
|-----------------|---------------|------------------------------|---------------------|
| `trust_promotion` | yes | no (`profile_mismatch`) | no (`profile_mismatch` — Admin uses the in-memory token, no per-request needed) |
| `sensitivity_restricted` | yes | no (`profile_mismatch`) | no |
| `sensitivity_visibility` | yes | no (`profile_mismatch`) | no |
| `import_trust_restore` | yes | yes | yes |
| `import_restricted` | yes | yes | yes |

The Admin-profile process authorizes
every type via the in-memory capability
token (set at startup from the on-disk
file). The per-request capability token
path is for agentic flows that must work
in Core / Extended.

### Per-request authorization recipe

For an agentic flow that needs to write a
`restricted` row from a Core / Extended
process:

1. The operator runs
   `agent-recall admin grant` to install a
   valid capability (this also requires
   switching to the Admin profile for the
   operator process).
2. The agent reads the printed token (the
   full 64-hex-char value, which the
   operator copies into a secret store; the
   CLI only prints the redacted tail).
3. The agent invokes the privileged MCP
   tool with the `capability: <token>` field.
4. The `authorize(...)` call verifies the
   token against the in-memory capability
   loaded at startup.

For `import_trust_restore` and
`import_restricted`, the per-request path
works on every profile. The
`trust_promotion` and
`sensitivity_restricted` paths require the
Admin profile (or the per-process in-memory
token, which is set at startup when the
Admin profile is active).

## Forensic recipe

When a privileged write is rejected:

```text
reason: "profile_mismatch"
  -> The capability type has profile_required: "admin"
     and the active profile is Core / Extended.
     Switch to Admin profile (or use the per-process
     in-memory token, which requires Admin at startup).

reason: "capability_missing"
  -> The in-memory token is empty. Run
     `agent-recall admin status` to see why:
     - `missing`: run `agent-recall admin grant`
     - `drift`: run `agent-recall admin grant`
       to re-create the file with the correct
       permissions (the drift branch surfaces
       the stable reason code; the underlying
       `fs` error is logged but never returned)

reason: "token_mismatch"
  -> The supplied capability token does not match
     the in-memory token. Verify the token was
     copied correctly (no whitespace, exactly 64
     hex chars).

reason: "permission_drift"
  -> (This reason is now surfaced via the
     `status()` envelope's `drift` branch; the
     per-call `authorize(...)` no longer returns
     it. Re-run `agent-recall admin status` to
     see the stable drift reason.)

reason: "capability_malformed"
  -> The supplied token is not 64 hex chars
     (or has whitespace / non-hex characters).
     Strip the whitespace; verify the token
     length.
```

## Common operator questions

### Q: I see `drift` on `admin status`. What does it mean?

A drift means the on-disk `admin.cap`
exists but fails the load-time
permission validation. The `drift_reason`
is the stable code:

- `permission_drift`: POSIX file mode
  has group/other bits set (`0o644`,
  `0o664`, etc.) or the file is owned by a
  different uid.
- `acl_drift`: Windows ACL grants access to
  a non-owner principal (e.g. `Users`,
  `Authenticated Users`).
- `symlink`: The file is a symlink. Re-run
  `agent-recall admin grant` to write a
  regular file.
- `unsupported_owner`: (POSIX) The file is
  owned by a different uid. Re-run from the
  operator account.

The fix is always the same: re-run
`agent-recall admin grant` (which writes a
fresh file with the canonical permissions).

### Q: My Core process is showing `"restricted"` reads. Why?

It shouldn't — the v1.1.3 contract pins
that a Core / Extended process stays at
`"normal"` visibility regardless of the
on-disk capability. If you see
`"restricted"` reads, check:

1. The active profile via `memory://health.active_profile`.
2. The capability state via
   `memory://health.capability_state`.

If `active_profile: "admin"` is reported
on a Core process, the process was started
with `AGENT_RECALL_PROFILE=admin` (the
canonical Admin gate at the MCP server
entry). To fix: restart without the env
var.

### Q: My Admin process shows `missing` capability. Why?

The Admin-profile MCP server entry fails
closed at startup when the capability file
is missing / malformed / drifted. The
process exits with `process.exitCode = 1`
and a stable message:
`agent-recall failed to start: AGENT_RECALL_PROFILE=admin requires a valid operator capability.`

The fix: run `agent-recall admin grant` to
install a valid capability, then restart.

### Q: The per-request capability token path returns `profile_mismatch`. Why?

The capability type has
`profile_required: "admin"`. The
per-request path is only available for types
WITHOUT `profile_required` (the import
capability surface). For `trust_promotion`
and `sensitivity_restricted`, the
authorization path is the Admin-profile
process's in-memory token; the per-request
path is not consulted.

## See also

- `docs/adr/0005-profile-scoped-admin-capability.md`
  — the ADR that documents the three contracts.
- `src/admin/capability.ts` — the implementation.
- `src/cli/commands/admin.ts` — the CLI
  surface (`grant` / `status` / `revoke`).
- `docs/superpowers/specs/2026-07-28-v1.1.3-gate-02-capability-design.md`
  — the design spec for #32.