// Unit tests for http-bridge/lib/load-env.mjs
// Run with: npm test (picked up by vitest via the include glob in
// vitest.config.ts after the project's "*.test.ts" pattern is
// extended to also match "*.test.mjs" in test/http-bridge/).

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseEnvText,
  resolveEnvSearchPath,
  applyEnvToProcess,
} from "../../http-bridge/lib/load-env.mjs";

// Convenience: temp dir + cleanup for tests that need a real
// filesystem (resolveEnvSearchPath relies on existsSync).
function withTmpDir(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "load-env-test-"));
    try {
      return await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe("parseEnvText", () => {
  it("parses simple KEY=VALUE pairs", () => {
    const out = parseEnvText("FOO=bar\nBAZ=qux\n");
    expect(out).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("ignores # comment lines and empty lines", () => {
    const out = parseEnvText(`
# a comment
FOO=bar

# another comment
BAZ=qux
`);
    expect(out).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips double quotes from values", () => {
    const out = parseEnvText('FOO="hello world"\n');
    expect(out).toEqual({ FOO: "hello world" });
  });

  it("strips single quotes from values", () => {
    const out = parseEnvText("FOO='hello world'\n");
    expect(out).toEqual({ FOO: "hello world" });
  });

  it("strips optional `export` prefix", () => {
    const out = parseEnvText("export FOO=bar\nexport BAZ='q u x'\n");
    expect(out).toEqual({ FOO: "bar", BAZ: "q u x" });
  });

  it("strips trailing inline comments for unquoted values", () => {
    const out = parseEnvText("FOO=bar # this is a comment\n");
    expect(out).toEqual({ FOO: "bar" });
  });

  it("preserves # inside quoted values", () => {
    const out = parseEnvText('FOO="bar # not a comment"\n');
    expect(out).toEqual({ FOO: "bar # not a comment" });
  });

  it("preserves Windows-style paths with backslashes", () => {
    const out = parseEnvText('HOME=G:\\Memory\\AgentRecall\n');
    expect(out).toEqual({ HOME: "G:\\Memory\\AgentRecall" });
  });

  it("handles CRLF line endings", () => {
    const out = parseEnvText("FOO=bar\r\nBAZ=qux\r\n");
    expect(out).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("returns empty object for empty/whitespace input", () => {
    expect(parseEnvText("")).toEqual({});
    expect(parseEnvText("   \n\t\n")).toEqual({});
  });

  it("parses JSON object form when the file starts with `{`", () => {
    const json = `{
  "FOO": "bar",
  "BAZ": 42,
  "QUOTED": "hello world"
}`;
    const out = parseEnvText(json);
    expect(out).toEqual({ FOO: "bar", BAZ: "42", QUOTED: "hello world" });
  });

  it("skips malformed lines (e.g. `=leading-equals` or `no-equals`)", () => {
    const out = parseEnvText("=leading-equals\nno-equals\nGOOD=ok\n");
    // "=leading-equals" and "no-equals" don't match the regex, so dropped.
    expect(out).toEqual({ GOOD: "ok" });
  });

  it("preserves variable names with underscores and digits", () => {
    const out = parseEnvText("FOO_BAR_2=ok\nA_1=also_ok\n");
    expect(out).toEqual({ FOO_BAR_2: "ok", A_1: "also_ok" });
  });

  it("rejects variable names starting with a digit", () => {
    const out = parseEnvText("1FOO=bar\nFOO=ok\n");
    expect(out).toEqual({ FOO: "ok" });
  });

  it("later assignments win on duplicate keys (last-wins)", () => {
    const out = parseEnvText("FOO=first\nFOO=second\n");
    expect(out).toEqual({ FOO: "second" });
  });
});

describe("resolveEnvSearchPath", () => {
  it("returns the override path when AGENT_RECALL_BRIDGE_ENV_FILE is set and exists", withTmpDir((workDir) => {
    const override = join(workDir, "override.env");
    writeFileSync(override, "FOO=bar\n");
    const r = resolveEnvSearchPath({
      envFileOverride: override,
      execPath: "G:\\node\\node.exe",
      devDir: "G:\\Projects\\app\\http-bridge",
    });
    expect(r).toEqual({ path: override, source: "override" });
  }));

  it("returns null when override is set but file is missing", () => {
    const r = resolveEnvSearchPath({
      envFileOverride: "C:\\does-not-exist\\nope.env",
      execPath: "G:\\node\\node.exe",
      devDir: "G:\\Projects\\app\\http-bridge",
    });
    expect(r).toBeNull();
  });

  it("returns exe-dir .env when running in binary mode", withTmpDir((dir) => {
    const exeDir = join(dir, "dist-bin");
    mkdirSync(exeDir, { recursive: true });
    const exePath = join(exeDir, "agent-recall-http-bridge-win32-x64.exe");
    writeFileSync(join(exeDir, ".env"), "FOO=exe_dotenv\n");
    const r = resolveEnvSearchPath({
      execPath: exePath,
      devDir: "G:\\Projects\\app\\http-bridge",
    });
    expect(r).toEqual({ path: join(exeDir, ".env"), source: "exe-dotenv" });
  }));

  it("falls back to exe-dir .bridge.env when .env is absent", withTmpDir((dir) => {
    const exeDir = join(dir, "dist-bin");
    mkdirSync(exeDir, { recursive: true });
    const exePath = join(exeDir, "agent-recall-http-bridge-win32-x64.exe");
    writeFileSync(join(exeDir, ".bridge.env"), '{"FOO":"exe_json"}');
    const r = resolveEnvSearchPath({
      execPath: exePath,
      devDir: "G:\\Projects\\app\\http-bridge",
    });
    expect(r).toEqual({
      path: join(exeDir, ".bridge.env"),
      source: "exe-json",
    });
  }));

  it("prefers .env over .bridge.env when both exist in the exe dir", withTmpDir((dir) => {
    const exeDir = join(dir, "dist-bin");
    mkdirSync(exeDir, { recursive: true });
    const exePath = join(exeDir, "agent-recall-http-bridge-win32-x64.exe");
    writeFileSync(join(exeDir, ".env"), "FOO=dotenv_wins\n");
    writeFileSync(join(exeDir, ".bridge.env"), '{"FOO":"json_loses"}');
    const r = resolveEnvSearchPath({
      execPath: exePath,
      devDir: "G:\\Projects\\app\\http-bridge",
    });
    expect(r?.source).toBe("exe-dotenv");
  }));

  it("returns null in binary mode when no env file is in the exe dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "load-env-bin-"));
    try {
      const exePath = join(dir, "agent-recall-http-bridge-linux-x64");
      const r = resolveEnvSearchPath({ execPath: exePath, devDir: "/tmp/dev" });
      expect(r).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns dev .bridge.env in node mode (execPath is node.exe)", withTmpDir((dir) => {
    writeFileSync(join(dir, ".bridge.env"), '{"FOO":"dev"}');
    const r = resolveEnvSearchPath({
      execPath: "C:\\node\\node.exe",
      devDir: dir,
    });
    expect(r).toEqual({
      path: join(dir, ".bridge.env"),
      source: "dev-json",
    });
  }));

  it("skips exe-dir lookup in node mode (does not look at node install dir)", withTmpDir((dir) => {
    // Note: dir is the devDir, NOT the exe dir.  In node mode the
    // exe dir is something like C:\node\ which we must NOT pollute.
    const r = resolveEnvSearchPath({
      execPath: "C:\\node\\node.exe",
      devDir: dir,
    });
    expect(r).toBeNull();
  }));
});

describe("applyEnvToProcess", () => {
  it("writes each key to the target object", () => {
    const target = {};
    const written = applyEnvToProcess({ FOO: "1", BAR: "2" }, target);
    expect(target).toEqual({ FOO: "1", BAR: "2" });
    expect(written.sort()).toEqual(["BAR", "FOO"]);
  });

  it("overwrites existing keys (dotenv semantics, env file is authoritative)", () => {
    const target = { FOO: "old", KEEP: "stays" };
    applyEnvToProcess({ FOO: "new" }, target);
    expect(target).toEqual({ FOO: "new", KEEP: "stays" });
  });

  it("returns the list of written keys", () => {
    const target = {};
    const written = applyEnvToProcess({ A: "1", B: "2", C: "3" }, target);
    expect(written).toEqual(["A", "B", "C"]);
  });

  it("skips undefined target key writes (just overwrites with new value)", () => {
    const target = { FOO: undefined };
    applyEnvToProcess({ FOO: "set" }, target);
    expect(target.FOO).toBe("set");
  });
});

describe("end-to-end (parseEnvText + applyEnvToProcess)", () => {
  it("loads a standard .env and applies to a fresh target", () => {
    const text = `
# bridge config
AGENT_RECALL_HOME=G:\\Memory\\AgentRecall
AGENT_RECALL_PROFILE=extended
AGENT_RECALL_ACTOR="agent:shared-memory"
MCP_HTTP_PORT=7781
export AGENT_RECALL_SUPPRESS_MCP_DEPRECATION=1
`;
    const target = {};
    applyEnvToProcess(parseEnvText(text), target);
    expect(target).toEqual({
      AGENT_RECALL_HOME: "G:\\Memory\\AgentRecall",
      AGENT_RECALL_PROFILE: "extended",
      AGENT_RECALL_ACTOR: "agent:shared-memory",
      MCP_HTTP_PORT: "7781",
      AGENT_RECALL_SUPPRESS_MCP_DEPRECATION: "1",
    });
  });

  it("loads a JSON .bridge.env and applies to a fresh target", () => {
    const text = `{
  "AGENT_RECALL_HOME": "G:\\\\Memory\\\\AgentRecall",
  "MCP_HTTP_PORT": "7781"
}`;
    const target = {};
    applyEnvToProcess(parseEnvText(text), target);
    expect(target).toEqual({
      AGENT_RECALL_HOME: "G:\\Memory\\AgentRecall",
      MCP_HTTP_PORT: "7781",
    });
  });
});
