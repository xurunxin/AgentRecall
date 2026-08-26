// src/cli/index.ts
//
// CLI entry: parses argv, dispatches to a command handler, and returns a
// structured result. The actual command implementations live in
// ./commands/*.ts and are wired into the dispatch table in T7.

import { resolveDataHome } from "../index.js";
import { SQLiteMemoryStore } from "../sqlite-store.js";
import { ProjectIdentityResolver } from "../scope-resolver.js";
import { adminCommand } from "./commands/admin.js";
import { assetsCommand } from "./commands/assets.js";
import { auditCommand } from "./commands/audit.js";
import { backupCommand, restoreCommand } from "./commands/backup.js";
import { bootstrapCommand } from "./commands/bootstrap.js";
import { doctorCommand } from "./commands/doctor.js";
import { exportCommand } from "./commands/export.js";
import { externalRefsCommand } from "./commands/external-refs.js";
import { importCommand } from "./commands/import.js";
import { jobsCommand } from "./commands/jobs.js";
import { loadoutsCommand } from "./commands/loadouts.js";
import { listCommand } from "./commands/list.js";
import { migrateCommand } from "./commands/migrate.js";
import { searchCommand } from "./commands/search.js";
import { sessionsCommand } from "./commands/sessions.js";
import { showCommand } from "./commands/show.js";
import { skillsCommand } from "./commands/skills.js";
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
import { serverVersion } from "../server-version.js";

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
  agent-recall --version      # print server version and exit

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
  jobs       Inspect, cancel, or run derivation jobs
  candidates List, show, accept, reject, or apply distillation candidates (issue #50)
  sessions   Inspect / ingest / list / show / forget / distill captured session traces
  assets     Manage the typed asset registry (memory_ref / skill / context_pack / external_reference)
  bootstrap  Cold-start bootstrap pipeline (configure / scan / plan)
  external-refs  Manage typed external_reference assets (list / create / verify)
  version    Print the server version (also: --version / -v)
  help       Show this help

Global flags:
  --data-home <path>   Override AGENT_RECALL_HOME / LOCAL_MEMORY_MCP_HOME
  --version / -v       Print server version and exit
  --json               Output machine-readable JSON
  --no-color           Disable ANSI color
  --color=always|never Override color detection
`;

type CommandHandler = (ctx: CliContext) => CliResult | Promise<CliResult>;

const dispatch: Record<string, CommandHandler> = {
  help: () => ({ exitCode: 0, stdout: HELP_TEXT, stderr: "" }),
  // v1.1.3 GATE-07 (issue #37): the canonical
  // `version` subcommand. The single source of truth
  // is `src/server-version.ts` (the same value the
  // MCP handshake + every `meta.server_version`
  // field surface). `agent-recall --version` /
  // `agent-recall -v` resolve here too (see the
  // early-return in `runCli` below).
  version: () => ({ exitCode: 0, stdout: serverVersion(), stderr: "" }),
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
  admin: adminCommand,
  // v1.2.0-alpha.0 (issue #48): the derivation job
  // subcommand. Provides the durable inspect / cancel /
  // run surface for the v1.2 derivation job substrate.
  jobs: jobsCommand,
  // v1.2.0-alpha.1 (issue #49): the session trace
  // subcommand. Provides the inspect / ingest / list /
  // show / forget surface for the v1.2 session
  // evidence substrate.
  sessions: sessionsCommand,
  // v1.2.0-alpha.1 (issue #51): the typed asset
  // registry subcommand. Provides list / show /
  // history / lifecycle / create-memory-ref for
  // the additive asset envelope. Skill /
  // context_pack / external_reference creation
  // land with their owning Phase 2 issues
  // (#53 / #54).
  assets: assetsCommand,
  // v1.2.0-alpha.2 (issue #54): the cold-start
  // bootstrap pipeline. Provides configure / scan /
  // plan show / plan apply / plan cancel for the
  // v20 surface.
  bootstrap: bootstrapCommand,
  // v1.2.0-alpha.2 (issue #54): the typed
  // external_reference asset subcommand. Provides
  // list / create / verify for the
  // `external_references` table.
  "external-refs": externalRefsCommand
};

export async function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<CliResult> {
  const args = parseArgs(argv);
  // v1.1.3 GATE-07 (issue #37): handle the bare
  // `--version` / `-v` flag before any store /
  // capability / data-home work. The arg-parser
  // maps `-v` to `flags.version`; without this
  // early-return the flag would fall through to the
  // default `help` command and never print the
  // version. We return BEFORE constructing the
  // SQLiteMemoryStore so `--version` works on a
  // machine without an existing data home.
  if (args.flags["version"] === true) {
    return { exitCode: 0, stdout: serverVersion(), stderr: "" };
  }
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

/**
 * v1.2.0-alpha.2 (issue #50): build a minimal
 * `WriteContext` for the CLI's `MemoryWriteService`.
 * The CLI does not own a `MemoryService` instance
 * directly (the MCP server does); the write
 * services are only constructed when a CLI verb
 * needs to mutate memory rows. The write context
 * uses the CLI's `identityResolver` for project
 * scope checks and the `ctx.defaultActor` for the
 * `actor` field. A `configureProjectBudget` stub
 * is supplied so the `remember` path can lazily
 * bootstrap a project on a `project_path`-only
 * input — the candidate apply path passes an
 * explicit `project_id`, so the stub is only
 * consulted for `project_path` flows.
 */
export function buildCliWriteContext(
  cliCtx: CliContext
): import("../services/memory-write-service.js").WriteContext {
  return {
    store: cliCtx.store,
    defaultActor: cliCtx.ctx.actor_id,
    identityResolver: cliCtx.identityResolver,
    configureProjectBudget: (
      _project_id: string,
      _budget: import("../domain.js").MemoryBudget,
      _canonical_path: string,
      _display_name: string
    ) => {
      throw new Error(
        "[internal_error] configureProjectBudget is not wired into the CLI; " +
          "candidate apply must pass an explicit project_id"
      );
    }
  };
}
