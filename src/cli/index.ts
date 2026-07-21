// src/cli/index.ts
//
// CLI entry: parses argv, dispatches to a command handler, and returns a
// structured result. The actual command implementations live in
// ./commands/*.ts and are wired into the dispatch table in T7.

import { resolveDataHome } from "../index.js";
import { SQLiteMemoryStore } from "../sqlite-store.js";
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

export type CliContext = {
  dataHome: string;
  args: ParsedArgs;
  store: SQLiteMemoryStore;
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
  migrate: migrateCommand
};

export async function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<CliResult> {
  const args = parseArgs(argv);
  const dataHomeOverride = typeof args.flags["data-home"] === "string" ? args.flags["data-home"] : undefined;
  const dataHome = dataHomeOverride ?? resolveDataHome(env);
  const store = new SQLiteMemoryStore(`${dataHome}/memory.sqlite`);

  const handler = dispatch[args.command];
  if (handler === undefined) {
    store.close();
    return {
      exitCode: 3,
      stdout: "",
      stderr: `unknown command: ${args.command}\n\n${HELP_TEXT}`
    };
  }
  try {
    const result = await handler({ dataHome, args, store });
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
