// src/cli/commands/admin.ts
//
// Stage 18 v1.1.2 (issue #23, ADR-0001): the
// `agent-recall admin grant / revoke / status`
// CLI commands. The admin subcommand is the
// ONLY supported mutation surface for the
// operator capability file under
// `${AGENT_RECALL_HOME}/admin.cap`. MCP tool
// calls cannot create or rotate a capability;
// the file is operator-only.
//
// Usage:
//   agent-recall admin grant [--label <text>]
//   agent-recall admin status
//   agent-recall admin revoke
//
// The grant output is the single redacted
// display of the new capability token. The
// operator is expected to copy the value
// into the privileged MCP / CLI / script
// call. The token is never logged by the
// server and never appears in audit output;
// the on-disk file is the only persistent
// copy.
//
// Output formatting: the `--json` flag
// produces a machine-readable payload so
// automation can pipe the grant output
// into a secret store. The default (human)
// output is a `**** <last 4 hex>` redacted
// tail plus the on-disk path.

import { join } from "node:path";
import { flagBool, flagString } from "../arg-parser.js";
import type { CliContext, CliResult } from "../index.js";
import { jsonOut, paint, resolveColorMode, useColor } from "../format.js";
import {
  CapabilityStore,
  type AuthorizationDenialReason,
  type CapabilityStatus
} from "../../admin/capability.js";

type AdminSubcommand = "grant" | "revoke" | "status" | "help";

export function adminCommand(ctx: CliContext): CliResult {
  const sub = (ctx.args.positional[0] ?? "help") as AdminSubcommand;
  switch (sub) {
    case "grant":
      return adminGrant(ctx);
    case "revoke":
      return adminRevoke(ctx);
    case "status":
      return adminStatus(ctx);
    case "help":
    default:
      return adminHelp(ctx);
  }
}

function resolveStore(ctx: CliContext): CapabilityStore {
  return new CapabilityStore(ctx.dataHome, { persistent: true });
}

function adminGrant(ctx: CliContext): CliResult {
  const label = flagString(ctx.args, "label");
  const store = resolveStore(ctx);
  let status: CapabilityStatus;
  try {
    status = store.grant(label !== undefined ? { label } : {});
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `admin grant failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (status.kind !== "granted") {
    // Should not happen — grant always
    // returns a granted record on success.
    return {
      exitCode: 1,
      stdout: "",
      stderr: "admin grant: status is missing immediately after grant (this is a bug)"
    };
  }
  const json = flagBool(ctx.args, "json") === true;
  if (json) {
    return {
      exitCode: 0,
      stdout: jsonOut({
        ok: true,
        path: status.path,
        created_at: status.created_at,
        ...(status.label !== undefined ? { label: status.label } : {}),
        token_tail: status.token_tail,
        fingerprint: status.fingerprint
      }),
      stderr: ""
    };
  }
  const colorMode = resolveColorMode(ctx.args);
  const color = useColor(colorMode);
  const head = (text: string) => paint(text, "bold", color);
  const accent = (text: string) => paint(text, "red", color);
  const lines: string[] = [
    head("# admin grant"),
    "",
    `  path:        ${status.path}`,
    `  state:       granted`,
    `  created_at:  ${status.created_at}`,
    ...(status.label !== undefined ? [`  label:       ${status.label}`] : []),
    `  token_tail:  ${status.token_tail}`,
    `  fingerprint: ${status.fingerprint}`,
    "",
    accent(
      "  The full token is NOT shown. Re-grant to rotate; revoke to delete."
    ),
    ""
  ];
  return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
}

function adminRevoke(ctx: CliContext): CliResult {
  const store = resolveStore(ctx);
  store.revoke();
  const json = flagBool(ctx.args, "json") === true;
  if (json) {
    return { exitCode: 0, stdout: jsonOut({ ok: true, revoked: true }), stderr: "" };
  }
  return {
    exitCode: 0,
    stdout: "admin revoke: capability removed (if it existed).\n",
    stderr: ""
  };
}

function adminStatus(ctx: CliContext): CliResult {
  const store = resolveStore(ctx);
  const status = store.status();
  const json = flagBool(ctx.args, "json") === true;
  if (json) {
    return { exitCode: 0, stdout: jsonOut(status), stderr: "" };
  }
  const colorMode = resolveColorMode(ctx.args);
  const color = useColor(colorMode);
  const head = (text: string) => paint(text, "bold", color);
  if (status.kind === "missing") {
    return {
      exitCode: 0,
      stdout: [
        head("# admin status"),
        "",
        `  path:   ${status.path}`,
        "  state:  missing",
        "",
        "  no capability installed. run `agent-recall admin grant` to install one."
      ].join("\n") + "\n",
      stderr: ""
    };
  }
  return {
    exitCode: 0,
    stdout: [
      head("# admin status"),
      "",
      `  path:        ${status.path}`,
      `  state:       granted`,
      `  created_at:  ${status.created_at}`,
      ...(status.label !== undefined ? [`  label:       ${status.label}`] : []),
      `  token_tail:  ${status.token_tail}`,
      `  fingerprint: ${status.fingerprint}`
    ].join("\n") + "\n",
    stderr: ""
  };
}

function adminHelp(ctx: CliContext): CliResult {
  return {
    exitCode: 0,
    stdout: [
      "agent-recall admin — manage the operator capability",
      "",
      "Usage:",
      "  agent-recall admin grant [--label <text>]    install a new capability",
      "  agent-recall admin status                      show the on-disk state",
      "  agent-recall admin revoke                      remove the capability",
      "",
      "The capability is the single source of truth for",
      "trust / sensitivity / admin-profile operations.",
      "It is stored at <AGENT_RECALL_HOME>/admin.cap with",
      "owner-only permissions (POSIX 0o600 / Windows",
      "owner-only ACL). Run `admin grant` to install a new",
      "token; copy the printed value into privileged MCP",
      "calls (the `capability` field on the `remember`,",
      "`update_memory`, and `confirm_memory_trust` tools)."
    ].join("\n") + "\n",
    stderr: ""
  };
}

/**
 * Stage 18 v1.1.2 (issue #23, ADR-0001): the
 * CLI helper that surfaces a stable
 * authorization-denial message. The function
 * is exported so a downstream CLI command
 * can re-use the same human-readable
 * message without re-implementing the
 * switch.
 */
export function describeDenialReason(reason: AuthorizationDenialReason): string {
  switch (reason) {
    case "capability_missing":
      return "operator capability is not installed; run `agent-recall admin grant` and supply the token";
    case "capability_malformed":
      return "the supplied capability token is malformed (expected 64 hex chars)";
    case "permission_drift":
      return "the on-disk capability file no longer satisfies the owner-only permission contract; re-run `agent-recall admin grant`";
    case "token_mismatch":
      return "the supplied capability token does not match the on-disk token";
    case "store_unavailable":
      return "the capability store is unavailable; check the data home and file permissions";
    case "unsupported_capability_type":
      return "the requested capability type is not recognised";
  }
}
