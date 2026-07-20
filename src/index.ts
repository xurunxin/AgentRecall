#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MarkdownExporter } from "./markdown-exporter.js";
import { MemoryService } from "./memory-service.js";
import { SQLiteMemoryStore } from "./sqlite-store.js";
import { registerMemoryTools } from "./tools/register-tools.js";
import { resolveActor } from "./actor.js";

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
  const service = createService();
  const server = new McpServer({
    name: serverName(),
    version: "0.1.0"
  });
  registerMemoryTools(server, service);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${serverName()} connected on stdio`);
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
