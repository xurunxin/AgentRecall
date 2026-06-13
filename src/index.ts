import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MarkdownExporter } from "./markdown-exporter.js";
import { MemoryService } from "./memory-service.js";
import { SQLiteMemoryStore } from "./sqlite-store.js";
import { registerMemoryTools } from "./tools/register-tools.js";

export function serverName(): string {
  return "local-memory-mcp";
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
  const configured = env.LOCAL_MEMORY_MCP_HOME?.trim();
  return resolve(expandHome(configured === undefined || configured.length === 0 ? "~/.local-memory-mcp" : configured));
}

export function createService(dataHome = resolveDataHome()): MemoryService {
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const exporter = new MarkdownExporter(join(dataHome, "exports"));
  return new MemoryService(store, exporter);
}

export async function main(): Promise<void> {
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
