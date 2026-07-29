// src/cli/index.ts
//
// CLI entry: parses argv, dispatches to a command handler, and returns a
// structured result. The actual command implementations live in
// ./commands/*.ts and are wired into the dispatch table in T7.

import { resolveDataHome } from "../index.js";
import { SQLiteMemoryStore } from "../sqlite-store.js";
import { ProjectIdentityResolver } from "../scope-resolver.js";
import { adminCommand } from "./commands/admin.js";
import { auditCommand } from "./commands/audit.js";
import { backupCommand, restoreCommand } from "./commands/backup.js";
import { doctorCommand } from "./commands/doctor.js";
import { exportCommand } from "./commands/export.js";
import { importCommand } from "./commands/import.js";
import { listCommand } from "./commands/list.js";
import { migrateCommand } from "./commands/migrate.js";
import { searchCommand } from "./commands/search.js";
import { showCommand } from "./commands/show.js";
import { parseArgs, type ParsedArgs } from "./arg-parser.js";
import { buildRequestContext, type RequestContext } from "../request-context.js";
import { randomUUID } from "node:crypto";
import {
  resolveAuthorization,
  type AuthorizationDecision,
  type SensitivityLevel
} from "../services/auth-context.js";
import { resolveActiveProfile, type ToolProfile } from "../tools/profile.js";
import { CapabilityStore } from "../admin/capability.js";

export type CliContext = {
  dataHome: string;
  args: ParsedArgs;
  store: SQLiteMemoryStore;
  /**
   * v1.1.2 (issue #21): the per-CLI project identity
   * resolver. Constructed once in `runCli` and shared
   * with the project-scope commands (`export` in
   * particular). A `project_id`-only call without a
   * registered identity is rejected at the resolver
   * before any store query runs. The legacy escape
   * hatch (`AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID=1`)
   * is read by the resolver constructor.
   */
  identityResolver: ProjectIdentityResolver;
  /**
   * Stage 14 PR-B1 (spec § 5.2 AR-P0-002): a per-invocation
   * RequestContext. The actor defaults to the
   * `AGENT_RECALL_ACTOR` env / `user:cli` fallback; the
   * session_id is the CLI PID so audit events from the
   * same shell session can be grouped; the request_id is a
   * fresh UUID per CLI invocation so a retried command
   * (e.g. wrapped in a shell loop) gets a distinct audit
   * trail.
   */
  ctx: RequestContext;
  /**
   * v1.1.3 GATE-03 (issue #33): the canonical
   * authorization decision. The CLI derives this
   * from `AGENT_RECALL_PROFILE` and the loaded
   * capability once per invocation; every
   * command consults it before reading or
   * exporting entries. Defaults to the
   * fail-closed decision (`max_sensitivity:
   * "normal"`) so legacy callers stay
   * compatible.
   */
  authorization: AuthorizationDecision;
  /**
   * v1.1.3 GATE-03 (issue #33): the derived
   * `max_sensitivity` string, kept for
   * backward compatibility with CLI commands
   * that pre-date the v1.1.3 split.
   */
  actorMaxSensitivity: SensitivityLevel;
};

export type CliResult = { exitCode: 0 | 1 | 2 | 3; stdout: string; stderr: string };

export const HELP_TEXT = `agent-recall — local memory CLI

Usage:
  agent-recall <command> [options]

Commands:
  list       List memories (default scope: global)
  show       Show a single memory and its audit history
  search     Full-text search
  audit      Show audit events for a memory
  doctor     Run health checks
  export     Trigger export (markdown / json / yaml)
  import     Replay an export into the live store
  backup     Run a manual backup
  restore    Restore from a verified backup
  migrate    Run schema migrations
  admin      Manage the operator capability (grant / status / revoke)
  help       Show this help

Global flags:
  --data-home <path>   Override AGENT_RECALL_HOME / LOCAL_MEMORY_MCP_HOME
  --json               Output machine-readable JSON
  --no-color           Disable ANSI color
  --color=always|never Override color detection
`;

type CommandHandler = (ctx: CliContext) => CliResult | Promise<CliResult>;

const dispatch: Record<string, CommandHandler> = {
  help: () => ({ exitCode: 0, stdout: HELP_TEXT, stderr: "" }),
  list: listCommand,
  show: showCommand,
  search: searchCommand,
  audit: auditCommand,
  doctor: doctorCommand,
  export: exportCommand,
  import: importCommand,
  backup: backupCommand,
  restore: restoreCommand,
  migrate: migrateCommand,
  admin: adminCommand
};

export async function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<CliResult> {
  const args = parseArgs(argv);
  const dataHomeOverride = typeof args.flags["data-home"] === "string" ? args.flags["data-home"] : undefined;
  const dataHome = dataHomeOverride ?? resolveDataHome(env);
  // v1.1.3 GATE-03 (issue #33): the CLI derives
  // the canonical authorization decision once per
  // invocation. The active profile comes from
  // `AGENT_RECALL_PROFILE` (resolved through
  // `resolveActiveProfile` so unknown values fail
  // closed); the capability comes from the
  // `admin.cap` file when one is installed.
  // The decision is the single source of truth
  // for every command; the legacy
  // `actorMaxSensitivity` string is kept as a
  // derived helper for callers that pre-date
  // the v1.1.3 split.
  const activeProfile: ToolProfile = resolveActiveProfile(env);
  const capabilityStore = new CapabilityStore(dataHome, { persistent: true });
  const hasCapability = capabilityStore.hasCapability();
  const authorization: AuthorizationDecision = resolveAuthorization(
    { activeProfile, hasCapability },
    { kind: "read", restrictedAllowed: false }
  );
  // Stage 18 v1.1.2 third follow-up (Critical #2):
  // wrap the SQLiteMemoryStore construction in
  // try/catch so a corrupted DB, missing schema,
  // or similar bootstrap-time failure surfaces
  // a stable `[internal_error]` code on stderr
  // (exit 3) instead of the previous unhandled
  // async-rejection that crashed the CLI
  // process. The doctor command catches the same
  // exception inside its handler and re-emits a
  // `[doctor_failed]` code on stderr (exit 2).
  // The `runCli` level covers the dispatch table
  // (`backup`, `migrate`, `admin grant`, ...)
  // which all open through this code path.
  let store: SQLiteMemoryStore;
  try {
    store = new SQLiteMemoryStore(`${dataHome}/memory.sqlite`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 3,
      stdout: "",
      stderr: `[internal_error] failed to open store at ${dataHome}/memory.sqlite: ${message}`
    };
  }
  // v1.1.2 (issue #21): construct one identity resolver
  // per CLI invocation. The recordedBy is `user:cli` so
  // any auto-registered identity row carries the
  // canonical CLI actor. The allowUnbound flag is read
  // from the `AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID`
  // env var at construction time; the resolver reads
  // from the supplied env so a programmatic CLI test
  // (e.g. `runCli(argv, env)`) can flip the flag
  // without mutating `process.env`.
  const identityResolver = new ProjectIdentityResolver(
    store,
    "user:cli",
    env["AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID"] === "1"
  );
  const ctx: RequestContext = buildRequestContext({
    actor_override: "user:cli",
    client_name: "agent-recall-cli",
    client_version: process.env.npm_package_version ?? "0.0.0",
    session_id: `cli-pid-${process.pid}`,
    request_id: randomUUID()
  });

  const handler = dispatch[args.command];
  if (handler === undefined) {
    store.close();
    return {
      exitCode: 3,
      stdout: "",
      // Stage 18 v1.1.2 third follow-up (Critical #2):
      // the unknown-command path surfaces a stable
      // `usage_error` code in `[code]` form on
      // stderr so a script can pin the failure mode
      // without parsing the help text. The help text
      // is appended below the code so operator-
      // readable output is unchanged.
      stderr: `[usage_error] unknown command: ${args.command}\n\n${HELP_TEXT}`
    };
  }
  try {
    const result = await handler({
      dataHome,
      args,
      store,
      identityResolver,
      ctx,
      authorization,
      actorMaxSensitivity: authorization.max_sensitivity
    });
    store.close();
    return result;
  } catch (error) {
    store.close();
    return {
      exitCode: 3,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error)
    };
  }
}

export function registerCommand(name: string, handler: CommandHandler): void {
  dispatch[name] = handler;
}
