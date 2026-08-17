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
import { startIdleTimer } from "./mcp/idle-timer.js";
import { resolveActiveProfile, type ToolProfile } from "./tools/profile.js";
import { resolveActor } from "./actor.js";
import { ProjectIdentityResolver } from "./scope-resolver.js";
import { serverVersion } from "./server-version.js";
import { CapabilityStore } from "./admin/capability.js";
import { resolveAuthorization } from "./services/auth-context.js";

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
  // v1.1.5 (Stage 1, task 3): shared in-flight
  // request counter. Mutated by the per-tool
  // tracker hooks the registration helpers wrap
  // around their callbacks, and read by
  // `isMessageInFlight` when the stdio idle-exit
  // timer (below) fires so the deadline is held
  // while a tool handler is mid-flight. Wrapped
  // in an object so both call sites (the
  // registration hooks + the timer predicate)
  // share the same value via closure capture;
  // a plain `number` `let` would also work, but
  // the object keeps the read-site (`inFlightCount.value`)
  // and the write-sites (`inFlightCount.value++/--`)
  // visually symmetric.
  const inFlightCount = { value: 0 };
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
    registerCoreTools(server, service, {
      onStart: () => inFlightCount.value++,
      onEnd: () => inFlightCount.value--
    });
  } else {
    registerExtendedTools(server, service, {
      onStart: () => inFlightCount.value++,
      onEnd: () => inFlightCount.value--
    });
  }
  registerMemoryResources(server, {
    store: service.store,
    dataHome,
    defaultActor,
    identityResolver,
    activeProfile,
    capabilityStore,
    // v1.1.3 GATE-03 (issue #33): the
    // canonical authorization decision
    // replaces the v1.1.2 derived string.
    // `resolveAuthorization(...)` is the
    // single source of truth; the resource
    // layer consults it for every templated
    // resource. The legacy
    // `actorMaxSensitivity` string is kept
    // as a derived helper so pre-GATE-03
    // callers stay compatible.
    authorization: resolveAuthorization(
      {
        activeProfile,
        hasCapability: capabilityStore.hasCapability() === true
      },
      { kind: "read", restrictedAllowed: false }
    ),
    actorMaxSensitivity:
      activeProfile === "admin" && capabilityStore.hasCapability() === true
        ? "restricted"
        : "normal"
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // v1.1.4 (graceful shutdown fix): wire stdin
  // EOF + SIGINT/SIGTERM to a clean shutdown
  // sequence. Pre-fix the server stayed alive
  // forever (the SDK's StdioServerTransport
  // never observes `stdin` `end` / `close`),
  // and SIGTERM killed the child without
  // closing the SQLite handle. Idle residency
  // is preserved: the server only exits when
  // the stdio pipe is gone or a signal arrives,
  // not on mere inactivity. The shutdown hook
  // closes the SQLite store LAST so any final
  // audit event the server emits during its own
  // close() can land before the file handle is
  // released. The hook is silent on the hot
  // path; stdout stays protocol-clean.
  //
  // The lifecycle module additionally enforces:
  //   - `process.exit(0)` on a clean shutdown
  //     (otherwise the Node process would stay
  //     alive parked on the SQLite / stdio
  //     handles).
  //   - a 1500 ms ceiling on the shutdown
  //     sequence (hung handler → hard-exit with
  //     code 1 so the host can reap the
  //     process).
  //   - second-signal escape (SIGINT/SIGTERM
  //     while the sequence is in flight →
  //     hard-exit with code 1).
  //   - a verbose reason log gated behind
  //     AGENT_RECALL_VERBOSE_STDIO=1 (one
  //     stderr line at shutdown trigger time).
  const { installServerLifecycle } = await import(
    "./mcp/server-lifecycle.js"
  );
  // v1.1.5 (Stage 1, task 3): capture the
  // handle so the idle-timer trigger (below) can
  // call `shutdown("stdio_idle_timeout")` and
  // reuse the same verbose-reason log + 1.5s
  // ceiling as the stdin/signal paths.
  const lifecycleHandle = installServerLifecycle({
    server,
    transport,
    onShutdown: () => service.store.close(),
    onShutdownError: (error: unknown) => {
      // Diagnostics go to stderr, never stdout.
      // The MCP JSON-RPC stream is `process.stdout`;
      // a leak here would corrupt the next frame.
      console.error(
        `${serverName()} shutdown error:`,
        error instanceof Error ? error.message : String(error)
      );
    },
    onShutdownStart: (reason) => {
      // Mirror the AGENT_RECALL_VERBOSE_STDIO
      // gate from the connected-on-stdio hint
      // (PR-8, issue #16) so the hot path stays
      // silent unless the operator opts in. The
      // reason string is one of "stdio_end",
      // "stdio_close", "SIGINT", "SIGTERM",
      // "stdio_idle_timeout".
      if (process.env.AGENT_RECALL_VERBOSE_STDIO === "1") {
        const label =
          reason === "stdio_end" ? "stdin EOF" :
          reason === "stdio_close" ? "stdin closed" :
          reason;
        console.error(
          `${serverName()} shutting down (${label})`
        );
      }
    },
    // v1.1.6 follow-up D1: emit the
    // `[lifecycle] idle-sentinel` line on stderr
    // immediately before the clean `exitFn(0)` so
    // the blackbox test (mcp-stdio-idle.test.ts)
    // can wait for the sentinel on `child.stderr`
    // instead of racing a 2.5 s cap. The line is
    // ONLY emitted on the `stdio_idle_timeout`
    // reason — every other shutdown reason
    // (stdio_end, stdio_close, SIGINT, SIGTERM)
    // keeps the "no stderr leak" invariant that
    // mcp-shutdown.test.ts + mcp-all-tools-e2e
    // .test.ts assert. The lifecycle module itself
    // never touches stderr; this callback is the
    // boundary where stderr emission is allowed.
    onShutdownComplete: (reason) => {
      if (reason === "stdio_idle_timeout") {
        process.stderr.write("[lifecycle] idle-sentinel\n");
      }
    }
  });
  // v1.1.5 (Stage 1, task 3): wire the
  // call-site idle timer from
  // `src/mcp/idle-timer.ts` so an idle stdio
  // session eventually exits without operator
  // action. Default 600_000 ms (10 min) when
  // `AGENT_RECALL_STDIO_IDLE_MS` is unset; set
  // to `0` to disable (matches the lifecycle's
  // idle-residency contract — the v1.1.4 fix
  // promised "no exit on mere inactivity", so
  // operators must opt in to the timer
  // explicitly). The `trigger` reuses the
  // lifecycle's `shutdown()` so the verbose
  // reason log (`AGENT_RECALL_VERBOSE_STDIO=1`)
  // and 1.5s ceiling apply unchanged. We do
  // NOT pass the `idleTimeoutMs` / `isMessageInFlight`
  // options on `installServerLifecycle` itself:
  // that wiring path is reserved for a future
  // HTTP transport (Stage 2+); the stdio path
  // owns its timer end-to-end.
  const idleMs = Number.parseInt(
    process.env.AGENT_RECALL_STDIO_IDLE_MS ?? "600000",
    10
  );
  if (Number.isFinite(idleMs) && idleMs > 0) {
    startIdleTimer({
      stdin: process.stdin,
      idleMs,
      isMessageInFlight: () => inFlightCount.value > 0,
      trigger: (reason) => {
        lifecycleHandle.shutdown(reason);
      }
    });
  }
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
