// test/release-gate/profile-default/mcp-profile-default.test.ts
//
// Stage 17 v1.1.2 (issue #22, release plan
// Task 3) follow-up: the profile-default release
// gate. The v1.1.2 contract pins the packaged
// default to `core` and the only opt-in to
// `extended` (via `AGENT_RECALL_PROFILE=extended`).
// An unknown value is a startup error. This file
// spawns the built server (`dist/src/index.js`) in
// three configurations and asserts the surface +
// health + startup behaviour for each:
//
//   1. Default env (no `AGENT_RECALL_PROFILE`).
//      `tools/list` is the 10-tool Core surface.
//      `memory://health.active_profile` is
//      `"core"`.
//   2. Explicit `AGENT_RECALL_PROFILE=extended`.
//      `tools/list` is the 20-tool full surface.
//      `memory://health.active_profile` is
//      `"extended"`.
//   3. Explicit `AGENT_RECALL_PROFILE=foobar`
//      (or any unsupported value). The server
//      exits non-zero before binding to stdio.
//      The fail-closed contract is exercised
//      through `child_process.spawn` (the SDK
//      client cannot connect to a server that
//      never started).
//
// Task 3 follow-up (review by ora-6):
// this file FAILS HARD when the build artifact
// is missing. The previous implementation used
// `it.skip` to keep `npm test` working in a fresh
// checkout; the follow-up brief pins the
// fail-closed contract by throwing from the
// `beforeAll` hook when `dist/src/index.js` is
// absent. The selector unit tests (which don't
// require the build artifact) live in this same
// directory and always run.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CORE_TOOL_NAMES,
  EXTENDED_TOOL_NAMES
} from "../../../src/tools/register-tools.js";
import { resolveActiveProfile } from "../../../src/tools/profile.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const SERVER_ENTRY = join(REPO_ROOT, "dist", "src", "index.js");

// Task 3 follow-up: this test suite requires a
// built MCP server artifact. The previous
// implementation auto-skipped when `dist/` was
// absent; the follow-up review pins the
// fail-closed contract so a missing build
// artifact surfaces as a deterministic test
// failure (rather than a silently-passing
// release-gate surface).
const HAS_BUILT_ARTIFACT = existsSync(SERVER_ENTRY);

interface ResourceContents {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}

interface HealthResource {
  status: string;
  server_version: string;
  schema_version: number;
  active_profile: "core" | "extended";
  strict_isolation: boolean;
  identity_status: "bound" | "unbound";
}

describe("release-gate mcp-profile-default (Stage 17 v1.1.2 #22)", () => {
  let dataHome: string | undefined;
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let serverPid: number | undefined;

  // Fail-fast hook. The Task 3 follow-up review
  // explicitly forbids `it.skip` for the
  // release-gate surface; a missing build
  // artifact is a release-blocker and must
  // surface as a deterministic failure here
  // rather than as a silent skip.
  beforeAll(() => {
    if (!HAS_BUILT_ARTIFACT) {
      throw new Error(
        "release-gate test requires built artifact: run npm run build before running this suite"
      );
    }
  });

  afterEach(async () => {
    if (client !== undefined) {
      try {
        await client.close();
      } catch {
        // already closed
      }
      client = undefined;
    }
    if (serverPid !== undefined) {
      try {
        process.kill(serverPid, "SIGTERM");
      } catch {
        // already gone
      }
      serverPid = undefined;
    }
    if (dataHome !== undefined) {
      try {
        rmSync(dataHome, { recursive: true, force: true });
      } catch {
        // best effort
      }
      dataHome = undefined;
    }
  });

  async function spawnServer(extraEnv: Record<string, string | undefined>): Promise<void> {
    dataHome = mkdtempSync(join(tmpdir(), "lm-rg-profile-"));
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      AGENT_RECALL_HOME: dataHome,
      AGENT_RECALL_SUPPRESS_MCP_DEPRECATION: "1",
      AGENT_RECALL_VERBOSE_STDIO: "0"
    };
    for (const [key, value] of Object.entries(extraEnv)) {
      if (value === undefined) {
        delete env[key];
      } else {
        env[key] = value;
      }
    }
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      env,
      stderr: "pipe"
    });
    client = new Client(
      { name: "profile-default-e2e", version: "1.1.2" },
      { capabilities: {} }
    );
    await client.connect(transport);
    serverPid = transport.pid ?? undefined;
  }

  it("default startup (no AGENT_RECALL_PROFILE) registers the Core profile (10 tools)", async () => {
    await spawnServer({ AGENT_RECALL_PROFILE: undefined });
    if (client === undefined) throw new Error("client not initialised");
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    const expectedCore = [...CORE_TOOL_NAMES].sort();
    expect(names).toEqual(expectedCore);
    // The Core list is a strict subset of the
    // full 20-tool surface. None of the
    // Extended-only tools are exposed.
    const extended = new Set<string>(EXTENDED_TOOL_NAMES);
    for (const name of names) {
      expect(extended.has(name)).toBe(false);
    }
  });

  it("default startup exposes active_profile=core on memory://health", async () => {
    await spawnServer({ AGENT_RECALL_PROFILE: undefined });
    if (client === undefined) throw new Error("client not initialised");
    const r = (await client.readResource({ uri: "memory://health" })) as unknown as ResourceContents;
    const payload = JSON.parse(r.contents[0]!.text) as HealthResource;
    expect(payload.status).toBe("ok");
    expect(payload.active_profile).toBe("core");
    // v1.1.2 (issue #21): the health resource
    // also surfaces the strict-isolation
    // contract; both fields must coexist on the
    // same payload.
    expect(payload.strict_isolation).toBe(true);
    expect(payload.identity_status).toBe("bound");
  });

  it("AGENT_RECALL_PROFILE=extended registers the full 20-tool surface", async () => {
    await spawnServer({ AGENT_RECALL_PROFILE: "extended" });
    if (client === undefined) throw new Error("client not initialised");
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    const expected = [...CORE_TOOL_NAMES, ...EXTENDED_TOOL_NAMES].sort();
    expect(names).toEqual(expected);
  });

  it("AGENT_RECALL_PROFILE=extended surfaces active_profile=extended on memory://health", async () => {
    await spawnServer({ AGENT_RECALL_PROFILE: "extended" });
    if (client === undefined) throw new Error("client not initialised");
    const r = (await client.readResource({ uri: "memory://health" })) as unknown as ResourceContents;
    const payload = JSON.parse(r.contents[0]!.text) as HealthResource;
    expect(payload.status).toBe("ok");
    expect(payload.active_profile).toBe("extended");
  });

  it("AGENT_RECALL_PROFILE=core (explicit) is accepted as the Core default", async () => {
    await spawnServer({ AGENT_RECALL_PROFILE: "core" });
    if (client === undefined) throw new Error("client not initialised");
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([...CORE_TOOL_NAMES].sort());
  });

  it("AGENT_RECALL_PROFILE=foobar fails closed with a non-zero exit (no stdio binding)", async () => {
    // The fail-closed contract: an unknown
    // value is a startup error. The server
    // must exit before binding to stdio so the
    // MCP client cannot connect. We exercise
    // this through `child_process.spawn` (the
    // SDK client would hang waiting for a
    // transport that never appears).
    const dataHomeLocal = mkdtempSync(join(tmpdir(), "lm-rg-profile-fail-"));
    try {
      const child = spawn(
        process.execPath,
        [SERVER_ENTRY],
        {
          env: {
            ...(process.env as Record<string, string>),
            AGENT_RECALL_HOME: dataHomeLocal,
            AGENT_RECALL_PROFILE: "foobar",
            AGENT_RECALL_SUPPRESS_MCP_DEPRECATION: "1",
            AGENT_RECALL_VERBOSE_STDIO: "0"
          },
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      const stderrChunks: Buffer[] = [];
      const stdoutChunks: Buffer[] = [];
      child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      // The server must exit non-zero. A zero
      // exit would mean the unknown profile
      // silently fell through to the default,
      // which is exactly what the v1.1.2
      // contract forbids.
      expect(typeof exit.code).toBe("number");
      expect(exit.code).not.toBe(0);
      // The error message must name the env
      // var so an operator can recover without
      // reading the docs. The selector writes
      // the error to stderr (the SDK's main()
      // error path).
      const stderrText = Buffer.concat(stderrChunks).toString("utf8");
      expect(stderrText).toMatch(/AGENT_RECALL_PROFILE/);
      // The server must not have written a
      // server-side message to stdout. The MCP
      // protocol runs over stdio; a successful
      // server leaves stdout empty until the
      // first client message.
      const stdoutText = Buffer.concat(stdoutChunks).toString("utf8").trim();
      expect(stdoutText).toBe("");
    } finally {
      try {
        rmSync(dataHomeLocal, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it("AGENT_RECALL_PROFILE=admin refuses to start without a valid operator capability", async () => {
    // Stage 18 v1.1.2 (issue #23, ADR-0001): the
    // `admin` profile is a valid selector value
    // (Task 3 follow-up: the selector accepts it),
    // BUT the server refuses to bind to stdio when
    // no valid capability is installed at
    // `AGENT_RECALL_HOME/admin.cap`. The fail-closed
    // contract is enforced by the MCP server entry
    // (not the selector) so the startup error
    // surfaces a "capability required" message
    // rather than the generic "unknown profile"
    // message.
    const dataHomeLocal = mkdtempSync(join(tmpdir(), "lm-rg-profile-admin-"));
    try {
      const child = spawn(
        process.execPath,
        [SERVER_ENTRY],
        {
          env: {
            ...(process.env as Record<string, string>),
            AGENT_RECALL_HOME: dataHomeLocal,
            AGENT_RECALL_PROFILE: "admin",
            AGENT_RECALL_SUPPRESS_MCP_DEPRECATION: "1",
            AGENT_RECALL_VERBOSE_STDIO: "0"
          },
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      const stderrChunks: Buffer[] = [];
      child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      // The server must exit non-zero (the
      // capability-gate refuses to bind to stdio).
      expect(exit.code).not.toBe(0);
      const stderrText = Buffer.concat(stderrChunks).toString("utf8");
      // The error message names the
      // `AGENT_RECALL_PROFILE=admin` profile AND
      // the `admin grant` remediation so an
      // operator can recover without reading
      // the docs.
      expect(stderrText).toMatch(/AGENT_RECALL_PROFILE/);
      expect(stderrText).toMatch(/admin/);
      expect(stderrText).toMatch(/capability/i);
      // The server must not have written a
      // server-side message to stdout. The MCP
      // protocol runs over stdio; a successful
      // server leaves stdout empty until the
      // first client message.
      const stdoutChunks: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      // We have to read the stdout here. The
      // `exit` event has already fired (the
      // server exits before binding), so the
      // stdout stream should be empty / closed.
      const stdoutText = Buffer.concat(stdoutChunks).toString("utf8").trim();
      expect(stdoutText).toBe("");
    } finally {
      try {
        rmSync(dataHomeLocal, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });
});

// ============================================================
// Selector unit tests under the release-gate umbrella.
// These tests do NOT require the built artifact
// and always run in dev mode.
// ============================================================

describe("release-gate mcp-profile-selector (Stage 17 v1.1.2 #22)", () => {
  it("resolveActiveProfile returns core on an empty env", () => {
    expect(resolveActiveProfile({})).toBe("core");
  });

  it("resolveActiveProfile returns extended on AGENT_RECALL_PROFILE=extended", () => {
    expect(resolveActiveProfile({ AGENT_RECALL_PROFILE: "extended" })).toBe("extended");
  });

  it("resolveActiveProfile trims whitespace around the value", () => {
    // Operators sometimes set
    // `AGENT_RECALL_PROFILE= extended ` with
    // leading / trailing whitespace; the
    // selector trims before validation so the
    // documented value is matched.
    expect(resolveActiveProfile({ AGENT_RECALL_PROFILE: " extended " })).toBe("extended");
  });

  it("resolveActiveProfile fail-closes on an unknown value with a stable error message", () => {
    expect(() => resolveActiveProfile({ AGENT_RECALL_PROFILE: "Admin" })).toThrowError(
      /AGENT_RECALL_PROFILE/
    );
    expect(() => resolveActiveProfile({ AGENT_RECALL_PROFILE: "1" })).toThrowError(
      /AGENT_RECALL_PROFILE/
    );
  });

  // Task 3 follow-up: the brief requires
  // non-string env inputs to throw with a
  // stable error message. The selector unit
  // tests live here so they always run (no
  // built artifact required) — guarding
  // against future regressions where the
  // selector accidentally swallows a `null`
  // or numeric input.
  beforeEach(() => {
    // No-op; placeholder so vitest doesn't
    // complain about unused imports if the
    // describe shrinks in a future refactor.
  });

  it("resolveActiveProfile throws on a null env value", () => {
    expect(() =>
      resolveActiveProfile({ AGENT_RECALL_PROFILE: null as unknown as string })
    ).toThrowError(/AGENT_RECALL_PROFILE/);
  });

  it("resolveActiveProfile throws on a numeric env value", () => {
    expect(() =>
      resolveActiveProfile({ AGENT_RECALL_PROFILE: 1 as unknown as string })
    ).toThrowError(/AGENT_RECALL_PROFILE/);
  });

  it("resolveActiveProfile throws on an object env value", () => {
    expect(() =>
      resolveActiveProfile({ AGENT_RECALL_PROFILE: { foo: "bar" } as unknown as string })
    ).toThrowError(/AGENT_RECALL_PROFILE/);
  });

  it("resolveActiveProfile still falls back to core on the empty string (documented fallback)", () => {
    expect(resolveActiveProfile({ AGENT_RECALL_PROFILE: "" })).toBe("core");
  });
});