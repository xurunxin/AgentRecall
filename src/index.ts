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
import { CapabilityStore } from "./admin/capability.js";

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

export function createService(
  dataHome = resolveDataHome(),
  options: { capabilityStore?: CapabilityStore } = {},
  /**
   * v1.1.3 GATE-02 (issue #32): the active
   * tool profile. Defaults to `"core"` so
   * legacy call sites (test fixtures that
   * exercise the MCP service without an
   * `AGENT_RECALL_PROFILE` env var) compile
   * unchanged. The MCP server entry resolves
   * the profile via `resolveActiveProfile()`
   * and threads it through; the CLI keeps
   * the existing fail-closed behaviour.
   */
  activeProfile: ToolProfile = "core"
): MemoryService {
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const exporter = new MarkdownExporter(join(dataHome, "exports"));
  // Resolve AGENT_RECALL_ACTOR -> structured actor (e.g. agent:claude-code).
  // Falls back to "agent:unknown" inside resolveActor when the env var is unset.
  return new MemoryService(
    store,
    exporter,
    resolveActor(undefined),
    dataHome,
    options.capabilityStore,
    activeProfile
  );
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
  // Stage 18 v1.1.2 (issue #23, ADR-0001): load the
  // operator capability at startup. The store
  // fails closed when the file is missing /
  // malformed / permission-drifted; the in-memory
  // token is empty in that case. The
  // `admin` profile refuses to start without a
  // valid capability; `core` / `extended`
  // start in fail-closed mode (a privileged
  // write is rejected at the service layer).
  const capabilityStore = new CapabilityStore(dataHome, { persistent: true });
  if (activeProfile === "admin" && !capabilityStore.hasCapability()) {
    console.error(
      `${serverName()} failed to start: AGENT_RECALL_PROFILE=admin requires a valid operator capability. ` +
        `Run \`agent-recall admin grant\` (in the CLI) to install one, then start the server. ` +
        `The capability file is ${CapabilityStore.capabilityPath(dataHome)}.`
    );
    process.exitCode = 1;
    return;
  }
  const service = createService(dataHome, { capabilityStore }, activeProfile);
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
  // v1.1.2 (issue #22) + Stage 18 v1.1.2
  // (issue #23): the per-profile tool registration.
  // `core` is the packaged default (the safe,
  // low-surface option for an unconfigured
  // server). `extended` adds the four
  // memory-semantics tools plus the administrative
  // tools (plan/apply maintenance, merge,
  // supersede, export, maintain). `admin`
  // registers the same surface as `extended`; the
  // difference is the startup-time capability
  // gate (above) and the in-memory capability
  // token that the service consults on
  // privileged writes. The shared
  // `createMemoryToolHandlers` factory is
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
    activeProfile,
    capabilityStore,
    // v1.1.3 GATE-02 (issue #32): the
    // SQL-boundary sensitivity filter is now
    // gated on BOTH the active profile AND
    // the loaded capability. Only the
    // Admin-profile process with a valid
    // capability lifts to `"restricted"`; a
    // Core / Extended process with a valid
    // `admin.cap` on disk still sees
    // `"normal"` (fail-closed by profile).
    // The contract pins the rule on the
    // resource layer too so a per-project
    // single-memory resource cannot leak a
    // restricted row to a Core client.
    actorMaxSensitivity:
      activeProfile === "admin" && capabilityStore.hasCapability() === true
        ? "restricted"
        : "normal"
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stage 16 v1.1.1 PR-8 (issue #16, spec § 11.2):
  // the connected-on-stdio status hint is gated
  // behind `AGENT_RECALL_VERBOSE_STDIO` so the
  // black-box test can assert "no stderr leak
  // over the lifecycle" without false positives.
  // Operators who want the old behaviour opt
  // in via the env var. Stage 18 v1.1.2 (issue
  // #23, ADR-0001) adds the active profile to
  // the hint so an operator can verify the
  // admin-boundary state at a glance.
  if (process.env.AGENT_RECALL_VERBOSE_STDIO === "1") {
    const capabilityHint = activeProfile === "admin" ? " capability=loaded" : "";
    console.error(
      `${serverName()} connected on stdio (profile=${activeProfile}${capabilityHint})`
    );
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
