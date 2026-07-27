// test/blackbox/mcp-client-e2e-extended.test.ts
//
// Stage 15 PR-M2-1 (issue #8, spec § 11.2) +
// Stage 16 v1.1.1 PR-8 (issue #16, spec § 11.2)
// + Stage 17 v1.1.2 (issue #22, Task 3
// follow-up): the Extended-profile companion to
// `mcp-client-e2e.test.ts`. The Core profile
// smoke (the v1.1.2 packaged default) lives in
// `mcp-client-e2e.test.ts`; this file pins the
// Extended profile smoke so the two profiles
// are independent invocations (no shared skip
// gate).
//
// Task 3 follow-up (review by ora-6): the
// previous `mcp-client-e2e.test.ts` used a
// single file with an `itMaybeExt` helper that
// skipped Extended-only assertions when
// `AGENT_RECALL_PROFILE !== "extended"`. The
// follow-up review pins a fail-closed contract:
// Core and Extended coverage live in two
// independent invocations (separate test files),
// each spawns its own server process with the
// pinned profile, and each FAILS HARD when the
// build artifact is missing.
//
// The test runs against the **built** server
// (`dist/src/index.js`), not the source. The
// file FAILS HARD when `dist/` is absent (no
// `it.skip`, no silent skip-on-no-dist): the
// release-gate surface must surface a missing
// build artifact as a deterministic failure.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CORE_TOOL_NAMES,
  EXTENDED_TOOL_NAMES
} from "../../src/tools/register-tools.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const SERVER_ENTRY = join(REPO_ROOT, "dist", "src", "index.js");

// Task 3 follow-up: this test suite requires a
// built MCP server artifact. The previous
// implementation auto-skipped when `dist/` was
// absent (via `it.skip`); the follow-up review
// pins the fail-closed contract so a missing
// build artifact surfaces as a deterministic
// test failure (rather than a silently-passing
// release-gate surface).
const HAS_BUILT_ARTIFACT = existsSync(SERVER_ENTRY);

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const res = await client.callTool({ name, arguments: args });
  return res as unknown as ToolResult;
}

function parseText(result: ToolResult): unknown {
  const first = result.content[0];
  if (first === undefined) return undefined;
  return JSON.parse(first.text);
}

describe("MCP black-box E2E - Extended profile (issue #16 + #22 Task 3 follow-up)", () => {
  let dataHome: string | undefined;
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let serverPid: number | undefined;
  let stderrChunks: string[] = [];

  // Fail-fast hook: a missing build artifact is
  // a release-blocker and must surface as a
  // deterministic test failure here rather than
  // as a silent skip. The Task 3 follow-up
  // review (ora-6) explicitly forbids
  // `it.skip` / `describe.skip` for the
  // release-gate surface.
  beforeAll(() => {
    if (!HAS_BUILT_ARTIFACT) {
      throw new Error(
        "blackbox test requires built artifact: run npm run build before running this suite"
      );
    }
  });

  beforeAll(async () => {
    dataHome = mkdtempSync(join(tmpdir(), "lm-bb-e2e-ext-"));
    // Same env contract as the Core smoke:
    // suppress the CLI/MCP deprecation hint and
    // the "connected on stdio" hint so the
    // stderr-leak assertion stays honest. This
    // file pins the spawned server to the
    // Extended profile so the smoke assertions
    // match the tool list the server registers.
    const env = {
      ...process.env,
      AGENT_RECALL_HOME: dataHome,
      AGENT_RECALL_PROFILE: "extended",
      AGENT_RECALL_SUPPRESS_MCP_DEPRECATION: "1"
    };
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      env,
      stderr: "pipe"
    });
    if (transport.stderr !== null && transport.stderr !== undefined && typeof (transport.stderr as { on?: unknown }).on === "function") {
      (transport.stderr as { on: (event: string, cb: (chunk: Buffer) => void) => void }).on(
        "data",
        (chunk: Buffer) => {
          stderrChunks.push(chunk.toString("utf8"));
        }
      );
    }
    client = new Client(
      { name: "blackbox-e2e-ext", version: "1.0.0" },
      { capabilities: {} }
    );
    await client.connect(transport);
    serverPid = transport.pid ?? undefined;
  }, 30_000);

  afterAll(async () => {
    if (client !== undefined) {
      try {
        await client.close();
      } catch {
        // already closed
      }
    }
    if (serverPid !== undefined) {
      try {
        process.kill(serverPid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    if (dataHome !== undefined) {
      rmSync(dataHome, { recursive: true, force: true });
    }
    if (stderrChunks.length > 0) {
      const leak = stderrChunks.join("").trim();
      if (leak.length > 0) {
        throw new Error(
          `MCP server wrote to stderr over the lifecycle:\n${leak}`
        );
      }
    }
  }, 30_000);

  it("initialize + listTools + listResources (Extended profile)", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const tools = await client.listTools();
    const names = new Set(tools.tools.map((t) => t.name));
    // The Extended smoke asserts the 20-tool
    // full surface (Core + Extended).
    const expected = new Set<string>([...CORE_TOOL_NAMES, ...EXTENDED_TOOL_NAMES]);
    for (const name of expected) {
      expect(names.has(name), `expected tool ${name} in extended profile`).toBe(true);
    }

    const resources = await client.listResources();
    const uris = resources.resources.map((r) => r.uri);
    expect(uris.length).toBeGreaterThan(0);
  });

  it("record_memory_feedback appends a row (Extended-only smoke)", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r1 = await callTool(client, "remember", {
      scope: "global",
      type: "fact",
      topic: "blackbox",
      title: "feedback target",
      body: "feedback body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    expect(r1.isError).toBeFalsy();
    const d1 = parseText(r1) as { ok: boolean; value: { memory_id: string } };
    const fb = await callTool(client, "record_memory_feedback", {
      memory_id: d1.value.memory_id,
      kind: "up"
    });
    expect(fb.isError).toBeFalsy();
  });

  it("server PID is set (transport actually spawned the binary)", () => {
    expect(serverPid).toBeDefined();
    expect(typeof serverPid).toBe("number");
  });
});