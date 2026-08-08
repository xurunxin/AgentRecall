// src/launcher.ts
//
// v1.1.5 unified CLI and MCP executable.
//
// A small dispatcher that routes
// `process.argv` to one of three runtimes:
// the CLI implementation
// (`src/cli/index.ts` — `runCli`), the MCP
// stdio server (`src/index.ts` — `main`),
// or the MCP shared-HTTP daemon (a
// placeholder `runHttpServer` stub in
// this task; the real implementation in
// Task 9 / Stage 4 will reuse the
// `daemon-lock` and `auth` modules). The
// launcher owns the routing decision
// only; the CLI, MCP, and HTTP service
// modules remain the canonical source of
// behaviour.
//
// Dispatch contract (see
// `docs/superpowers/specs/2026-08-04-unified-cli-mcp-executable-design.md`
// and Stage 3 Task 7 brief):
//
//   - args[0] === "--http"          → HTTP.
//     (Explicit opt-in; wins over every
//     other rule, including the compat
//     name, so wrappers and supervisors
//     can force HTTP without renaming the
//     binary.)
//   - argv[0] basename matches `agent-recall-mcp`
//     → MCP, regardless of arguments or
//     env.
//   - argv[0] basename matches `agent-recall`:
//       - env.AGENT_RECALL_MCP_TRANSPORT
//         === "http"               → HTTP.
//         (Exact-match on the literal
//         string "http"; "HTTP" or
//         "stdio" do not opt in.)
//       - no args                   → MCP.
//       - args[0] === "mcp"         → MCP (explicit alias).
//       - else                      → CLI (forward args).
//   - anything else                 → CLI (forward args).
//
// The launcher identifies the binary by
// the basename of `process.argv[0]`, with
// a trailing `.exe` (Windows suffix)
// stripped. The decision is pure and
// does not depend on the current working
// directory or any absolute path
// component.

export type DispatchMode = "cli" | "mcp" | "http";

export interface DispatchRequest {
  /** The invoked executable path, i.e.
   * `process.argv[0]` of the launching
   * shell or npm binary. */
  argv0: string;
  /** Arguments to forward to the CLI
   * implementation. Ignored in MCP mode
   * (the compatibility name always
   * starts MCP regardless of arguments). */
  args: readonly string[];
}

/**
 * Strip a Windows `.exe` suffix from a
 * basename so the same launch source can
 * drive both `agent-recall` and
 * `agent-recall.exe`. The strip is case-
 * insensitive; case-insensitive match is
 * not needed for the basename comparison
 * because both file systems are case-
 * preserving for the file in question
 * (we only call this on a basename, not a
 * full path).
 */
function stripExe(name: string): string {
  return name.replace(/\.exe$/i, "");
}

function basenameOf(value: string): string {
  if (value.length === 0) return "";
  // Cross-platform basename: `node:path.basename`
  // is platform-specific and rejects backslashes
  // on POSIX, which makes path-form
  // `agent-recall` from a Windows-launched
  // launcher ambiguous on POSIX CI. Use a manual
  // split on both `/` and `\` so a path from
  // either OS normalises to the same last
  // component.
  const idx = Math.max(
    value.lastIndexOf("/"),
    value.lastIndexOf("\\")
  );
  const name = idx === -1 ? value : value.slice(idx + 1);
  return stripExe(name);
}

/**
 * Pure routing decision. Returns the
 * dispatch mode and a normalised args
 * slice ready for the CLI implementation.
 * The CLI implementation already drops a
 * single `mcp` token if it ever lands in
 * argv; here we strip it from the
 * forwarded CLI args to avoid surprising
 * the CLI parser with an unknown subcommand.
 */
export interface DispatchDecision {
  mode: DispatchMode;
  /** Arguments to forward to the CLI. The
   * launcher strips a single leading `mcp`
   * token in MCP mode. The CLI always
   * receives the full args slice unchanged
   * when mode is "cli". */
  forwardedArgs: string[];
}

export function decideMode(
  argv0: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): DispatchMode {
  // Explicit `--http` flag wins over
  // everything: the compat name, the env
  // override, and the canonical-name
  // dispatch. Wrappers and supervisors
  // can therefore force HTTP without
  // renaming the binary or polluting the
  // environment. Stage 3 / Task 7; the
  // HTTP path itself is a stub until
  // Stage 4 wires in the real
  // `runHttpServer` (Task 9).
  if (args[0] === "--http") return "http";
  const base = basenameOf(argv0);
  // The compatibility name always wins.
  if (base === "agent-recall-mcp") return "mcp";
  // The canonical name dispatches on
  // argument presence. A single leading
  // `mcp` token is the explicit alias.
  // The env override is checked first so
  // a wrapper script can set the env
  // once and have every invocation route
  // to HTTP without re-flagging.
  if (base === "agent-recall") {
    if (env.AGENT_RECALL_MCP_TRANSPORT === "http") return "http";
    if (args.length === 0) return "mcp";
    if (args[0] === "mcp") return "mcp";
    return "cli";
  }
  // Any other binary name is a downstream
  // launcher / wrapper; default to the CLI
  // because that is the historical contract
  // (CLI is the documented surface; MCP
  // users are expected to invoke the
  // `agent-recall-mcp` binary explicitly).
  return "cli";
}

/**
 * Compatibility shim used by the test
 * suite. Production code calls
 * `decideMode` + `dispatch`; the test
 * suite only exercises the routing table.
 */
export function decide(
  argv0: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): DispatchDecision {
  const mode = decideMode(argv0, args, env);
  if (mode === "mcp" || mode === "http") {
    return { mode, forwardedArgs: [] };
  }
  return { mode, forwardedArgs: args.slice() };
}

// The production entry. Lazily import the
// CLI and MCP modules so `decideMode` (the
// pure routing helper) can be unit-tested
// without booting either runtime. The
// imports are wrapped behind async
// functions so any import error surfaces
// as a `dispatch` rejection rather than
// crashing the launcher process at import
// time.
async function loadRunCli(): Promise<(args: readonly string[]) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>> {
  const mod = (await import("./cli/index.js")) as {
    runCli: (args: readonly string[]) => Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>;
  };
  return mod.runCli;
}

async function loadMcpMain(): Promise<() => Promise<void>> {
  const mod = (await import("./index.js")) as {
    main: () => Promise<void>;
  };
  return mod.main;
}

// Placeholder for the shared-HTTP daemon
// runtime. Stage 3 / Task 7 wires the
// launcher to detect HTTP mode; the real
// implementation — which will reuse
// `src/mcp/daemon-lock.ts` (acquireOrJoin)
// and `src/mcp/auth.ts` (validateRequest)
// — lands in Stage 4 / Task 9. Throwing a
// clearly labelled TODO keeps the wiring
// honest: any code that accidentally
// reaches HTTP mode in this task fails
// fast with an actionable message rather
// than silently starting the stdio path.
async function runHttpServer(): Promise<void> {
  throw new Error("TODO: implement runHttpServer (stage 4)");
}

/**
 * Production dispatch. Runs the chosen
 * runtime to completion and returns the
 * dispatch mode. The CLI implementation
 * owns its own exit code; the launcher's
 * `process.exit` is driven by the CLI
 * implementation's `runCli` return value
 * (the existing `bin/agent-recall.ts`
 * pattern). MCP mode never reaches a CLI
 * `runCli` call and is owned by
 * `src/index.ts main()`.
 */
export async function dispatch(req: DispatchRequest): Promise<DispatchMode> {
  const decision = decide(req.argv0, req.args);
  if (decision.mode === "http") {
    // HTTP mode: the stub in this task
    // throws a TODO. Task 9 replaces the
    // stub with the real
    // `acquireOrJoin` + `validateRequest`
    // + Node http.createServer path. The
    // rejection propagates to the
    // `main().catch(...)` handler at the
    // bottom of this file, which surfaces
    // it on stderr with a non-zero exit
    // code — the existing launch-failure
    // contract.
    await runHttpServer();
    return "http";
  }
  if (decision.mode === "mcp") {
    const mcpMain = await loadMcpMain();
    await mcpMain();
    return "mcp";
  }
  const runCli = await loadRunCli();
  const result = await runCli(decision.forwardedArgs);
  if (result.stdout.length > 0) {
    process.stdout.write(result.stdout);
    if (!result.stdout.endsWith("\n")) {
      process.stdout.write("\n");
    }
  }
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr);
    if (!result.stderr.endsWith("\n")) {
      process.stderr.write("\n");
    }
  }
  // Preserve the existing CLI exit-code
  // contract. CLI callers expect a
  // non-zero status to bubble up.
  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
  return "cli";
}

// The production entry point. Read
// `process.argv` once and dispatch.
async function main(): Promise<void> {
  const argv0 = process.argv[0] ?? "";
  const args = process.argv.slice(2);
  await dispatch({ argv0, args });
}

main().catch((error: unknown) => {
  // The CLI prints structured errors; the
  // MCP server never reaches this branch
  // because `main()` owns its own
  // diagnostics + exit path. Anything that
  // lands here is an unhandled launch
  // failure (import error, runtime crash,
  // etc.). Surface on stderr with a
  // non-zero exit code so callers (npm
  // postinstall, MCP supervisors) can
  // detect the failure.
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`agent-recall: launcher failed: ${message}\n`);
  process.exit(1);
});
