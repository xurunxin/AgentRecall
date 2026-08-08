// test/unit/launcher.http-flag.test.ts
//
// v1.1.5 launcher HTTP mode tests. The
// launcher dispatches to a new "http" mode
// (in addition to the v1.1.4 "cli" / "mcp"
// modes) when either:
//
//   1. `args[0] === "--http"`, OR
//   2. `env.AGENT_RECALL_MCP_TRANSPORT === "http"`
//      and the basename is the canonical
//      `agent-recall` (the v1.1.4 compat
//      name `agent-recall-mcp` keeps its
//      stdio-MCP contract; the env override
//      does not apply to it).
//
// The HTTP path is wired through a stub
// `runHttpServer` in `src/launcher.ts` that
// throws a TODO; Task 9 (Stage 4) replaces
// the stub with the real implementation
// built on `daemon-lock` + `auth`. The
// routing decision itself is pure and
// fully covered here against `decideMode`.
//
// The `decideMode` signature gains a third
// optional `env: NodeJS.ProcessEnv` param
// so the unit tests can pin the env
// without touching the host process.

import { describe, expect, it } from "vitest";
import { decideMode } from "../../src/launcher.js";

describe("decideMode with --http (v1.1.5)", () => {
  it("explicit --http selects http even with cli basename", () => {
    expect(decideMode("agent-recall", ["--http"])).toBe("http");
  });

  it("AGENT_RECALL_MCP_TRANSPORT=http selects http without flag", () => {
    // The helper reads env via the new third
    // parameter; passing it explicitly keeps
    // the test pure and host-env-independent.
    expect(
      decideMode("agent-recall", [], { AGENT_RECALL_MCP_TRANSPORT: "http" })
    ).toBe("http");
  });

  it("env override wins over the explicit `mcp` alias", () => {
    expect(
      decideMode("agent-recall", ["mcp"], { AGENT_RECALL_MCP_TRANSPORT: "http" })
    ).toBe("http");
  });

  it("env override applies to a path-form canonical basename", () => {
    expect(
      decideMode(
        "/usr/local/bin/agent-recall",
        [],
        { AGENT_RECALL_MCP_TRANSPORT: "http" }
      )
    ).toBe("http");
  });

  it("compat name `agent-recall-mcp` ignores the env override", () => {
    // v1.1.4 contract: the compat name
    // always routes to MCP, regardless of
    // arguments or environment. The new
    // env override only applies to the
    // canonical `agent-recall` basename.
    expect(
      decideMode(
        "agent-recall-mcp",
        [],
        { AGENT_RECALL_MCP_TRANSPORT: "http" }
      )
    ).toBe("mcp");
  });

  it("compat-name wins over explicit --http flag", () => {
    // v1.1.4 compat-name contract: the
    // basename `agent-recall-mcp` always
    // routes to MCP stdio. The `--http`
    // flag is accepted ONLY when basename
    // is not the compat name. Pinning
    // this case here so a future
    // re-ordering of `decideMode` cannot
    // silently break the v1.1.4 contract.
    expect(decideMode("agent-recall-mcp", ["--http"])).toBe("mcp");
  });

  it("compat-name wins over AGENT_RECALL_MCP_TRANSPORT=http", () => {
    // Same as the previous test but for
    // the env override: the compat name
    // is not influenced by env either.
    // Mirrors the v1.1.4 contract that
    // "the compat name always wins".
    expect(
      decideMode(
        "agent-recall-mcp",
        [],
        { AGENT_RECALL_MCP_TRANSPORT: "http" }
      )
    ).toBe("mcp");
  });

  it("path-form compat-name wins over explicit --http flag", () => {
    // Same precedence on a path-form
    // basename, matching the v1.1.4
    // regression test "routes a path-form
    // `agent-recall-mcp.exe` to MCP". The
    // `.exe` strip + basename comparison
    // must still resolve to the compat
    // name and short-circuit the
    // dispatch.
    expect(
      decideMode("C:\\bin\\agent-recall-mcp.exe", ["--http"])
    ).toBe("mcp");
  });

  it("env value other than 'http' (exact match) does not select http", () => {
    // Match is case-sensitive and exact:
    // "HTTP", "stdio", empty, undefined all
    // fall through to the v1.1.4 dispatch.
    expect(
      decideMode("agent-recall", [], { AGENT_RECALL_MCP_TRANSPORT: "stdio" })
    ).toBe("mcp");
    expect(
      decideMode("agent-recall", [], { AGENT_RECALL_MCP_TRANSPORT: "HTTP" })
    ).toBe("mcp");
    expect(decideMode("agent-recall", [], {})).toBe("mcp");
  });
});
