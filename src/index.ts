#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MarkdownExporter } from "./markdown-exporter.js";
import { MemoryService } from "./memory-service.js";
import { SQLiteMemoryStore } from "./sqlite-store.js";
import {
  registerCoreTools,
  registerExtendedTools
} from "./tools/register-tools.js";
import { registerMemoryResources } from "./mcp/resources.js";
import { resolveActiveProfile, type ToolProfile } from "./tools/profile.js";
import { resolveActor } from "./actor.js";
import { ProjectIdentityResolver } from "./scope-resolver.js";
import { serverVersion } from "./server-version.js";

export function serverName(): string {
  return "agent-recall";
}

function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export function resolveDataHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AGENT_RECALL_HOME?.trim() || env.LOCAL_MEMORY_MCP_HOME?.trim();
  return resolve(expandHome(configured === undefined || configured.length === 0 ? "~/.agent-recall" : configured));
}

export function createService(dataHome = resolveDataHome()): MemoryService {
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const exporter = new MarkdownExporter(join(dataHome, "exports"));
  // Resolve AGENT_RECALL_ACTOR -> structured actor (e.g. agent:claude-code).
  // Falls back to "agent:unknown" inside resolveActor when the env var is unset.
  return new MemoryService(store, exporter, resolveActor(undefined), dataHome);
}

export async function main(): Promise<void> {
  if (process.env.AGENT_RECALL_SUPPRESS_MCP_DEPRECATION !== "1") {
    console.error(
      "[agent-recall] Note: the `agent-recall` binary is now the CLI. " +
        "MCP server entry is `dist/src/index.js` (also published as `agent-recall-mcp`). " +
        "Set AGENT_RECALL_SUPPRESS_MCP_DEPRECATION=1 to silence this message."
    );
  }
  // v1.1.2 (issue #22): resolve the active tool
  // profile BEFORE constructing the server. The
  // selector fail-closes on an unknown value
  // (throws); the catch below surfaces the error
  // on stderr with the env-var name and exits
  // with a non-zero code, so the operator sees a
  // stable startup error rather than a server
  // that silently half-starts.
  const activeProfile: ToolProfile = resolveActiveProfile();
  const dataHome = resolveDataHome();
  const service = createService(dataHome);
  const defaultActor = resolveActor(undefined);
  // v1.1.2 (issue #21): construct one identity
  // resolver per MCP process and share it with the
  // resource layer so the per-project templates and
  // the health resource surface the strict isolation
  // contract. The resolver reads the
  // `AGENT_RECALL_ALLOW_UNBOUND_PROJECT_ID` env var
  // at construction time; the recordedBy is the
  // server's default actor.
  const identityResolver = new ProjectIdentityResolver(service.store, defaultActor);
  const server = new McpServer({
    name: serverName(),
    version: serverVersion()
  });
  // v1.1.2 (issue #22): the per-profile tool
  // registration. `core` is the packaged default
  // (the safe, low-surface option for an
  // unconfigured server). `extended` adds the
  // four memory-semantics tools plus the
  // administrative tools (plan/apply maintenance,
  // merge, supersede, export, maintain). The
  // shared `createMemoryToolHandlers` factory is
  // unchanged; the per-profile gate is the
  // `registerCoreTools` / `registerExtendedTools`
  // boundary.
  if (activeProfile === "core") {
    registerCoreTools(server, service);
  } else {
    registerExtendedTools(server, service);
  }
  registerMemoryResources(server, {
    store: service.store,
    dataHome,
    defaultActor,
    identityResolver,
    activeProfile
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stage 16 v1.1.1 PR-8 (issue #16, spec § 11.2):
  // the connected-on-stdio status hint is gated
  // behind `AGENT_RECALL_VERBOSE_STDIO` so the
  // black-box test can assert "no stderr leak
  // over the lifecycle" without false positives.
  // Operators who want the old behaviour opt
  // in via the env var.
  if (process.env.AGENT_RECALL_VERBOSE_STDIO === "1") {
    console.error(`${serverName()} connected on stdio (profile=${activeProfile})`);
  }
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}

if (isDirectExecution()) {
  main().catch((error: unknown) => {
    console.error(`${serverName()} failed to start:`, error);
    process.exitCode = 1;
  });
}
