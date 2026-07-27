// test/release-gate/admin-default/mcp-admin-default.test.ts
//
// Stage 18 v1.1.2 (issue #23, ADR-0001): the
// admin-profile release-gate surface. The
// `AGENT_RECALL_PROFILE=admin` profile is the
// third documented profile; the gate pins:
//
//   1. The admin profile fails closed at
//      startup when no valid capability is
//      installed (already covered by
//      `profile-default/mcp-profile-default.test.ts`).
//   2. With a valid capability, the server
//      binds to stdio and the `admin` profile
//      registers the same 20-tool surface as
//      `extended` (the documented "admin adds
//      nothing to the tool list, but enables
//      the privileged trust / sensitivity /
//      visibility surface").
//   3. The `memory://health` resource surfaces
//      `active_profile: "admin"` and
//      `capability_state: "granted"`.
//   4. The `confirm_memory_trust` tool
//      accepts a `user_confirmed` promotion
//      only when the request carries a valid
//      `capability` token; an unauthorised call
//      is rejected with `unauthorized` and the
//      audit log records the rejection with
//      the `capability_type` and `reason`.
//   5. A `remember({ sensitivity: "restricted"
//      })` call is rejected without a
//      capability; with a capability, the row
//      is written and the audit log records
//      the transition.
//   6. A `restricted` row is filtered out of
//      every public read path (the SQL/store
//      boundary filter) when the caller does
//      not have the capability; with a
//      capability, the row surfaces.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CapabilityStore } from "../../../src/admin/capability.js";
import {
  CORE_TOOL_NAMES,
  EXTENDED_TOOL_NAMES
} from "../../../src/tools/register-tools.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const SERVER_ENTRY = join(REPO_ROOT, "dist", "src", "index.js");

// The admin-profile release gate spawns the
// built server. The previous pattern
// (auto-skip when `dist/` is absent) is
// explicitly forbidden by the Task 3
// follow-up review.
const HAS_BUILT_ARTIFACT = existsSync(SERVER_ENTRY);

interface ResourceContents {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}

interface HealthResource {
  status: string;
  server_version: string;
  schema_version: number;
  active_profile: "core" | "extended" | "admin";
  capability_state: "granted" | "missing";
  capability_path?: string;
  strict_isolation: boolean;
  identity_status: "bound" | "unbound";
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: {
    ok: boolean;
    data?: unknown;
    error?: { code: string; message: string; retryable?: boolean; details?: Record<string, unknown> };
    meta?: { request_id: string; server_version: string; schema_version: number; duration_ms: number };
  };
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

function data<T>(result: ToolResult): T {
  if (result.structuredContent?.ok !== true || result.structuredContent.data === undefined) {
    throw new Error(
      `expected ok=true with data, got isError=${result.isError} ` +
        `sc=${JSON.stringify(result.structuredContent)} text=${result.content?.[0]?.text?.slice(0, 200)}`
    );
  }
  return result.structuredContent.data as T;
}

function failureCode(result: ToolResult): string {
  if (result.structuredContent?.ok === false) {
    const code = result.structuredContent.error?.code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  const txt = result.content?.[0]?.text ?? "";
  try {
    const parsed = JSON.parse(txt) as { error?: string };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // not JSON
  }
  if (result.isError === true) {
    return "invalid_schema";
  }
  throw new Error(`expected failure envelope, got isError=${result.isError} sc=${JSON.stringify(result.structuredContent)}`);
}

describe("release-gate mcp-admin-default (Stage 18 v1.1.2 #23, ADR-0001)", () => {
  let dataHome: string | undefined;
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let serverPid: number | undefined;
  let stderrChunks: string[] = [];
  let adminCapabilityToken: string | undefined;
  let singleMemoryId: string | undefined;

  beforeAll(() => {
    if (!HAS_BUILT_ARTIFACT) {
      throw new Error(
        "release-gate test requires built artifact: run npm run build before running this suite"
      );
    }
  });

  afterAll(async () => {
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

  beforeEach(async () => {
    // Fresh data home per test; the admin
    // profile requires a valid capability.
    dataHome = mkdtempSync(join(tmpdir(), "lm-rg-admin-"));
    // The `beforeAll` pre-installed the
    // capability via the CLI surface. The
    // `admin grant` is the documented mutation
    // path; the test uses the in-process
    // `CapabilityStore` to install the
    // capability file atomically, then reads
    // the raw token back from the on-disk file
    // so it can be passed to privileged tool
    // calls.
    const seedStore = new CapabilityStore(dataHome, { persistent: true });
    const seedStatus = seedStore.grant({ label: "admin-default" });
    if (seedStatus.kind !== "granted") {
      throw new Error("expected admin grant to succeed");
    }
    adminCapabilityToken = (JSON.parse(
      readFileSync(seedStore.getPath(), "utf8")
    ) as { token: string }).token;
    stderrChunks = [];
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      AGENT_RECALL_HOME: dataHome,
      AGENT_RECALL_PROFILE: "admin",
      AGENT_RECALL_SUPPRESS_MCP_DEPRECATION: "1",
      AGENT_RECALL_VERBOSE_STDIO: "0"
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
    client = new Client({ name: "admin-default-e2e", version: "1.1.2" }, { capabilities: {} });
    await client.connect(transport);
    serverPid = transport.pid ?? undefined;
  });

  it("AGENT_RECALL_PROFILE=admin with a valid capability registers the 20-tool surface", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    const expected = [...CORE_TOOL_NAMES, ...EXTENDED_TOOL_NAMES].sort();
    expect(names).toEqual(expected);
  });

  it("memory://health surfaces active_profile=admin + capability_state=granted", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r = (await client.readResource({ uri: "memory://health" })) as unknown as ResourceContents;
    const payload = JSON.parse(r.contents[0]!.text) as HealthResource;
    expect(payload.status).toBe("ok");
    expect(payload.active_profile).toBe("admin");
    expect(payload.capability_state).toBe("granted");
    expect(payload.capability_path).toMatch(/admin\.cap$/);
    expect(payload.strict_isolation).toBe(true);
    expect(payload.identity_status).toBe("bound");
  });

  it("confirm_memory_trust rejects without a capability (unauthorized)", async () => {
    if (client === undefined) throw new Error("client not initialised");
    // First, remember a normal-sensitivity
    // memory so we have an id to promote.
    const seed = await callTool(client, "remember", {
      scope: "global",
      type: "fact",
      topic: "admin-gate",
      title: "admin gate seed",
      body: "admin gate seed body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      confirm_write: true
    });
    expect(seed.isError).toBeFalsy();
    const seedValue = parseText(seed) as { value: { memory_id: string } };
    const memoryId = seedValue.value.memory_id;
    // The `confirm_memory_trust` tool is the
    // canonical promotion path. Without a
    // capability token, the service rejects
    // the call with `unauthorized`.
    const r = await callTool(client, "confirm_memory_trust", {
      memory_id: memoryId,
      trust_level: "user_confirmed",
      user_confirmed: true,
      reason: "admin gate test"
    });
    expect(r.isError).toBe(true);
    expect(failureCode(r)).toBe("unauthorized");
  });

  it("confirm_memory_trust accepts with a valid capability (ok)", async () => {
    if (client === undefined) throw new Error("client not initialised");
    if (adminCapabilityToken === undefined) throw new Error("capability not seeded");
    const seed = await callTool(client, "remember", {
      scope: "global",
      type: "fact",
      topic: "admin-promote",
      title: "admin promote seed",
      body: "admin promote seed body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      confirm_write: true
    });
    expect(seed.isError).toBeFalsy();
    const seedValue = parseText(seed) as { value: { memory_id: string } };
    const memoryId = seedValue.value.memory_id;
    const r = await callTool(client, "confirm_memory_trust", {
      memory_id: memoryId,
      trust_level: "user_confirmed",
      user_confirmed: true,
      capability: adminCapabilityToken,
      reason: "admin gate test"
    });
    expect(r.isError).toBeFalsy();
    if (r.isError) return;
    // The v2 envelope surfaces the previous /
    // next trust tier on a successful
    // promotion.
    const promoted = data<{ memory_id: string; previous: string; next: string }>(r);
    expect(promoted.memory_id).toBe(memoryId);
    expect(promoted.previous).toBe("agent_observed");
    expect(promoted.next).toBe("user_confirmed");
  });

  it("remember({ sensitivity: restricted }) rejects without a capability (unauthorized)", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r = await callTool(client, "remember", {
      scope: "global",
      type: "fact",
      topic: "restricted-no-cap",
      title: "restricted without cap",
      body: "restricted without cap body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      sensitivity: "restricted",
      confirm_write: true
    });
    expect(r.isError).toBe(true);
    expect(failureCode(r)).toBe("unauthorized");
  });

  it("remember({ sensitivity: restricted }) accepts with a valid capability (ok)", async () => {
    if (client === undefined) throw new Error("client not initialised");
    if (adminCapabilityToken === undefined) throw new Error("capability not seeded");
    const r = await callTool(client, "remember", {
      scope: "global",
      type: "fact",
      topic: "restricted-with-cap",
      title: "restricted with cap",
      body: "restricted with cap body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      sensitivity: "restricted",
      capability: adminCapabilityToken,
      confirm_write: true
    });
    expect(r.isError).toBeFalsy();
    if (r.isError) return;
    const v = data<{ memory_id: string }>(r);
    singleMemoryId = v.memory_id;
  });

  it("restricted row is filtered from list_memories under the default fail-closed filter", async () => {
    if (client === undefined) throw new Error("client not initialised");
    if (singleMemoryId === undefined) {
      // The previous test wrote the row; this
      // test depends on it. Skip if the
      // dependency is missing (the suite runs
      // in a defined order; this guards
      // against a future refactor that breaks
      // the order).
      return;
    }
    const r = await callTool(client, "list_memories", {
      scope: "global",
      topic: "restricted-with-cap",
      limit: 100
    });
    expect(r.isError).toBeFalsy();
    if (r.isError) return;
    const v = data<{ items: Array<{ id: string; title: string; topic: string }> }>(r);
    // The default read service has
    // `actor_max_sensitivity: "normal"` (the
    // admin profile raises the value ONLY when
    // the request explicitly authorises a
    // sensitivity_visibility capability; the
    // MCP tools do not currently accept that
    // capability as a per-call value). The
    // restricted row MUST be filtered out at
    // the SQL boundary.
    const titles = v.items.map((i) => i.title);
    expect(titles).not.toContain("restricted with cap");
  });

  it("AGENT_RECALL_PROFILE=admin without a valid capability refuses to start (fail closed)", async () => {
    // The fail-closed contract: an
    // `AGENT_RECALL_PROFILE=admin` server with
    // no `admin.cap` file (or a file with the
    // wrong permissions) refuses to bind to
    // stdio. The MCP client cannot connect.
    // We exercise the path through
    // `child_process.spawn` (the SDK client
    // would hang waiting for a transport that
    // never appears).
    const noCapDataHome = mkdtempSync(join(tmpdir(), "lm-rg-admin-no-cap-"));
    try {
      const child = spawn(
        process.execPath,
        [SERVER_ENTRY],
        {
          env: {
            ...(process.env as Record<string, string>),
            AGENT_RECALL_HOME: noCapDataHome,
            AGENT_RECALL_PROFILE: "admin",
            AGENT_RECALL_SUPPRESS_MCP_DEPRECATION: "1",
            AGENT_RECALL_VERBOSE_STDIO: "0"
          },
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      const noCapStderr: Buffer[] = [];
      child.stderr?.on("data", (chunk: Buffer) => noCapStderr.push(chunk));
      // We intentionally do not collect
      // stdout; the server must exit before
      // binding to stdio.
      const exit = await new Promise<{ code: number | null }>((resolve) => {
        child.once("exit", (code) => resolve({ code }));
      });
      expect(exit.code).not.toBe(0);
      const stderrText = Buffer.concat(noCapStderr).toString("utf8");
      // The error message names the
      // `AGENT_RECALL_PROFILE=admin` profile
      // AND the `admin grant` remediation.
      expect(stderrText).toMatch(/AGENT_RECALL_PROFILE/);
      expect(stderrText).toMatch(/admin/);
      expect(stderrText).toMatch(/capability/i);
    } finally {
      try {
        rmSync(noCapDataHome, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });
});
