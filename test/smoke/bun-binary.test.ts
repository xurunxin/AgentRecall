import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

const HOST =
  `${process.platform}-${process.arch}` === "linux-x64" ? "linux-x64"
  : `${process.platform}-${process.arch}` === "darwin-x64" ? "darwin-x64"
  : `${process.platform}-${process.arch}` === "darwin-arm64" ? "darwin-arm64"
  : `${process.platform}-${process.arch}` === "win32-x64" ? "win32-x64"
  : null;

const EXT = process.platform === "win32" ? ".exe" : "";
const BINARY = `dist-bin/agent-recall-${HOST}${EXT}`;
const HAS_BINARY = HOST !== null && existsSync(BINARY);

(HAS_BINARY ? describe : describe.skip)("Bun CLI binary (local build)", () => {
  // Each test gets its own fresh AGENT_RECALL_HOME so DB state cannot leak.
  const homes = new Set<string>();
  let home = "";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agent-recall-vitest-bun-"));
    homes.add(home);
  });

  it("--version prints 1.1.3", () => {
    const out = execFileSync(BINARY, ["--version"], {
      encoding: "utf8",
      env: { ...process.env, AGENT_RECALL_HOME: home }
    }).trim();
    expect(out).toBe("1.1.3");
  });

  it("help lists every command name", () => {
    const out = execFileSync(BINARY, ["help"], {
      encoding: "utf8",
      env: { ...process.env, AGENT_RECALL_HOME: home }
    });
    for (const cmd of ["list", "show", "search", "audit", "doctor", "export", "import", "backup", "restore", "migrate", "admin", "version", "help"]) {
      expect(out).toContain(`\n  ${cmd} `);
    }
  });

  it("doctor --json on empty DB returns summary.fail=0", () => {
    const out = execFileSync(BINARY, ["doctor", "--json"], {
      encoding: "utf8",
      env: { ...process.env, AGENT_RECALL_HOME: home }
    });
    const parsed = JSON.parse(out);
    expect(parsed.summary.fail).toBe(0);
  });

  // Cleanup every data home created by the suite.
  afterAll(() => {
    for (const h of homes) {
      rmSync(h, { recursive: true, force: true });
    }
  });
});
