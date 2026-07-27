// test/cli/admin.test.ts
//
// Stage 18 v1.1.2 (issue #23, ADR-0001): the
// `agent-recall admin grant / status / revoke`
// CLI commands. The CLI is the ONLY supported
// mutation surface for the operator capability;
// the test pins the wire-level contract:
//   - `admin grant` produces a 64-hex token and
//     writes the canonical `admin.cap` file with
//     owner-only permissions (POSIX 0o600).
//   - `admin status` reports the on-disk state
//     WITHOUT ever surfacing the raw token bytes
//     (only the last 4 hex + a fingerprint).
//   - `admin revoke` removes the file; the
//     subsequent `status` is `missing`.
//   - The `--json` flag produces a
//     machine-readable payload for automation.
//   - The help text names the env var / capability
//     file path so an operator can recover without
//     reading the docs.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/index.js";

function newDataHome(): string {
  return mkdtempSync(join(tmpdir(), "lm-cli-admin-"));
}

function setupEnv(dataHome: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENT_RECALL_HOME: dataHome,
    AGENT_RECALL_SUPPRESS_MCP_DEPRECATION: "1"
  };
}

describe("agent-recall admin (Stage 18 v1.1.2 #23, ADR-0001)", () => {
  let dataHome: string;
  beforeEach(() => {
    dataHome = newDataHome();
  });
  afterEach(() => {
    try {
      rmSync(dataHome, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("admin status reports missing when no capability is installed", async () => {
    const result = await runCli(["admin", "status"], setupEnv(dataHome));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/state:\s*missing/);
    expect(result.stdout).toMatch(/admin\.cap/);
  });

  it("admin status --json reports missing as a JSON object", async () => {
    const result = await runCli(["admin", "status", "--json"], setupEnv(dataHome));
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { kind: string; path: string };
    expect(parsed.kind).toBe("missing");
    expect(parsed.path).toMatch(/admin\.cap$/);
  });

  it("admin grant installs a 64-hex token, writes the file, and surfaces a redacted status", async () => {
    const result = await runCli(["admin", "grant"], setupEnv(dataHome));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/state:\s*granted/);
    // The token is never surfaced in the
    // output. The `**** <last 4 hex>` is the
    // only token-derived display.
    expect(result.stdout).toMatch(/token_tail:\s+\*\*\*\*\s+[0-9a-f]{4}/);
    expect(result.stdout).toMatch(/fingerprint:\s+[0-9a-f]{16}/);
    // The on-disk file is present and
    // owner-only.
    const path = join(dataHome, "admin.cap");
    expect(existsSync(path)).toBe(true);
    if (process.platform !== "win32") {
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("admin grant --label records the label in the on-disk file", async () => {
    const result = await runCli(
      ["admin", "grant", "--label", "operator-laptop-2026"],
      setupEnv(dataHome)
    );
    expect(result.exitCode).toBe(0);
    const path = join(dataHome, "admin.cap");
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as { label?: string };
    expect(onDisk.label).toBe("operator-laptop-2026");
  });

  it("admin grant --json surfaces the redacted state machine-readable", async () => {
    const result = await runCli(["admin", "grant", "--json"], setupEnv(dataHome));
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      path: string;
      token_tail: string;
      fingerprint: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.token_tail).toMatch(/^\*\*\*\*\s+[0-9a-f]{4}$/);
    expect(parsed.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("admin grant twice rotates the token", async () => {
    const first = await runCli(["admin", "grant", "--json"], setupEnv(dataHome));
    const firstParsed = JSON.parse(first.stdout) as { fingerprint: string };
    const second = await runCli(["admin", "grant", "--json"], setupEnv(dataHome));
    const secondParsed = JSON.parse(second.stdout) as { fingerprint: string };
    expect(secondParsed.fingerprint).not.toBe(firstParsed.fingerprint);
  });

  it("admin status after a grant reports granted + redacted token_tail + fingerprint", async () => {
    const grant = await runCli(["admin", "grant", "--json"], setupEnv(dataHome));
    const grantParsed = JSON.parse(grant.stdout) as { token_tail: string; fingerprint: string };
    const status = await runCli(["admin", "status", "--json"], setupEnv(dataHome));
    expect(status.exitCode).toBe(0);
    const statusParsed = JSON.parse(status.stdout) as {
      kind: string;
      token_tail: string;
      fingerprint: string;
    };
    expect(statusParsed.kind).toBe("granted");
    expect(statusParsed.token_tail).toBe(grantParsed.token_tail);
    expect(statusParsed.fingerprint).toBe(grantParsed.fingerprint);
  });

  it("admin revoke removes the file; a subsequent status reports missing", async () => {
    await runCli(["admin", "grant"], setupEnv(dataHome));
    const path = join(dataHome, "admin.cap");
    expect(existsSync(path)).toBe(true);
    const revoke = await runCli(["admin", "revoke"], setupEnv(dataHome));
    expect(revoke.exitCode).toBe(0);
    expect(existsSync(path)).toBe(false);
    const status = await runCli(["admin", "status", "--json"], setupEnv(dataHome));
    const statusParsed = JSON.parse(status.stdout) as { kind: string };
    expect(statusParsed.kind).toBe("missing");
  });

  it("admin revoke is a no-op when the file is missing (no error)", async () => {
    const result = await runCli(["admin", "revoke"], setupEnv(dataHome));
    expect(result.exitCode).toBe(0);
  });

  it("admin help surfaces the env var / file path / CLI subcommands", async () => {
    const result = await runCli(["admin", "help"], setupEnv(dataHome));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/admin grant/);
    expect(result.stdout).toMatch(/admin status/);
    expect(result.stdout).toMatch(/admin revoke/);
    expect(result.stdout).toMatch(/AGENT_RECALL_HOME/);
    expect(result.stdout).toMatch(/admin\.cap/);
  });

  it("admin is a recognised top-level CLI command (lists in help)", async () => {
    const result = await runCli(["help"], setupEnv(dataHome));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^Commands:/m);
    expect(result.stdout).toMatch(/^\s+admin\s/m);
  });
});
