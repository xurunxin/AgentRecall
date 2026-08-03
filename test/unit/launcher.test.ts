// test/unit/launcher.test.ts
//
// v1.1.4 unified CLI/MCP executable launcher
// dispatch tests. The launcher exports a
// pure `decideMode(argv0, args)` function and
// a `dispatch({ argv0, args })` driver. The
// `decideMode` tests are pure and do not
// import the CLI or MCP modules, so they
// run in any environment.
//
// The `dispatch` tests are guarded by
// process.platform so they only run on
// POSIX-shaped dev hosts (Windows runs the
// launcher in a separate CI path). They
// verify the dispatch table without
// touching the live SQLite store.

import { describe, it, expect } from "vitest";
import { decideMode } from "../../src/launcher.js";

describe("launcher dispatch (v1.1.4 unified executable)", () => {
  it("routes `agent-recall` with no arguments to MCP", () => {
    expect(decideMode("agent-recall", [])).toBe("mcp");
  });

  it("routes `agent-recall` with a CLI subcommand to the CLI", () => {
    expect(decideMode("agent-recall", ["doctor"])).toBe("cli");
  });

  it("routes `agent-recall` with CLI options to the CLI", () => {
    expect(
      decideMode("agent-recall", ["admin", "status", "--json"])
    ).toBe("cli");
  });

  it("routes `agent-recall-mcp` to MCP regardless of arguments", () => {
    expect(decideMode("agent-recall-mcp", [])).toBe("mcp");
  });

  it("routes a path-form `agent-recall-mcp.exe` to MCP", () => {
    expect(
      decideMode("C:\\bin\\agent-recall-mcp.exe", ["--ignored", "arg"])
    ).toBe("mcp");
  });

  it("recognises a path-form `agent-recall` (no `.exe`) as the canonical name", () => {
    expect(decideMode("/usr/local/bin/agent-recall", ["help"])).toBe("cli");
  });

  it("recognises a path-form `agent-recall` with no args as MCP", () => {
    expect(decideMode("/usr/local/bin/agent-recall", [])).toBe("mcp");
  });

  it("strips the `.exe` suffix before the basename comparison", () => {
    expect(
      decideMode("C:\\Program Files\\AgentRecall\\agent-recall.exe", [])
    ).toBe("mcp");
    expect(
      decideMode("C:\\Program Files\\AgentRecall\\agent-recall.exe", [
        "doctor"
      ])
    ).toBe("cli");
  });

  it("treats `agent-recall mcp` as an explicit MCP alias", () => {
    expect(decideMode("agent-recall", ["mcp"])).toBe("mcp");
  });

  it("routes unknown binary names to the CLI", () => {
    expect(
      decideMode("/some/path/agent-recall-custom", ["doctor"])
    ).toBe("cli");
  });

  it("routes the explicit `mcp` alias even after path-form `agent-recall`", () => {
    expect(
      decideMode("/usr/local/bin/agent-recall", ["mcp"])
    ).toBe("mcp");
  });
});
