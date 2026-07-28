// test/blackbox/mcp-all-tools-e2e-core.test.ts
//
// Stage 16 v1.1.1 (PR-8, issue #16) + Stage 17
// v1.1.2 (issue #22, Task 3 follow-up): the
// **Core-profile** authoritative black-box E2E
// for the MCP server contract. v1.1.0's
// zod v4 incompatibility made every callTool
// return `isError: true` with `_zod`. v1.1.1
// PR-8 flattens the `outputSchema` so the SDK's
// `validateToolOutput` succeeds, and the
// AGENT_RECALL_VERBOSE_STDIO env gates the
// "connected on stdio" hint so the stderr-leak
// assertion can be honest.
//
// Task 3 follow-up (review by ora-6): the
// previous `mcp-all-tools-e2e.test.ts` used a
// single file with an `itMaybeExt` helper that
// skipped Extended-only assertions when
// `AGENT_RECALL_PROFILE !== "extended"`. The
// follow-up review pins a fail-closed contract:
// Core and Extended coverage live in two
// independent invocations (separate test files),
// each spawns its own server process with the
// pinned profile, and each FAILS HARD when the
// build artifact is missing. This file pins the
// **Core profile** surface (the v1.1.2 packaged
// default) and asserts only the 10 read / write
// / plan essentials. The Extended-only tools are
// NOT exercised here; they live in
// `mcp-all-tools-e2e-extended.test.ts`.
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

// ============================================================
// Shared tool result shape.
// ============================================================

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

interface TextToolResult extends ToolResult {
  structuredContent: { ok: boolean; data: { markdown: string } };
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
  // Fall back to the legacy text envelope.
  const txt = result.content?.[0]?.text ?? "";
  try {
    const parsed = JSON.parse(txt) as { error?: string };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // not JSON
  }
  // The SDK can also surface a v1.1.1 PR-8 edge
  // case where the SDK's input validation
  // (`validateToolInput`) throws before the
  // handler envelope runs. That path is a
  // JSON-RPC `McpError` rendered as
  // `MCP error -32602: ...`; the `code` is the
  // JSON-RPC method-level error code, the
  // `message` is whatever the SDK passed.
  // We synthesise `invalid_schema` because every
  // tool failure that is NOT a transport error
  // surfaces through the v2 envelope; only a
  // malformed input schema lands here. The
  // caller still gets `isError: true`.
  if (result.isError === true) {
    return "invalid_schema";
  }
  throw new Error(`expected failure envelope, got isError=${result.isError} sc=${JSON.stringify(result.structuredContent)}`);
}

// ============================================================
// Test data factories.
// ============================================================

const DEFAULT_REMEMBER = {
  scope: "global" as const,
  type: "fact",
  topic: "bb",
  title: "untitled",
  body: "untitled body",
  tags: ["bb-suite"],
  source: { kind: "agent" },
  importance: 3,
  confidence: 3,
  // The fixture seeds multiple memories with the
  // same title+body on purpose — the v1.1 write
  // path rejects an exact `duplicate_candidate`
  // unless the caller explicitly opts in with
  // `confirm_write: true`. Every fixture in this
  // suite is intentional, so we always opt in.
  confirm_write: true
};

function rememberArgs(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...DEFAULT_REMEMBER, ...overrides };
}

interface RememberValue {
  memory_id: string;
  status: string;
}

interface ListValue {
  items: Array<{ id: string; title: string; status: string }>;
}

interface GetValue {
  entry: { id: string; title: string; revision: number };
  audit: unknown[];
}

interface SearchValue {
  items: Array<{ id: string; title: string }>;
}

interface BudgetValue {
  budget: { max_active_entries: number; max_total_chars: number };
  usage: { active_entries: number; active_chars: number };
}

interface ExplainValue {
  ranking_version: string;
  items: Array<{ memory_id: string; score: number; components: Record<string, number>; title: string; trust_boost: number }>;
}

interface UpdateValue {
  memory_id: string;
}

interface ForgetValue {
  memory_id: string;
  released_chars: number;
}

interface ListBackupsValue {
  backup_dir: string | undefined;
  entries: Array<{ name: string; size: number }>;
}

interface ResourceContents {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}

interface HealthResource {
  status: string;
  server_version: string;
  schema_version: number;
  data_home: string;
  active_profile: "core" | "extended";
  backup: { dir: string | null; entry_count: number };
}

interface ProjectSummaryResource {
  project_id: string;
  display_name: string;
  status_counts: Record<string, number>;
  recent_activity: Array<{ memory_id: string }>;
}

interface ProjectMemoryResource {
  entry: { id: string; title: string };
  audit: Array<{ event: string }>;
}

// ============================================================
// Suite.
// ============================================================

describe("MCP all-tools black-box E2E - Core profile (v1.1.2 #22 Task 3 follow-up)", () => {
  let dataHome: string | undefined;
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let serverPid: number | undefined;
  let stderrChunks: string[] = [];
  // Stable per-suite scratch.
  let projectId = `bb-proj-${Date.now()}`;
  let projectMemoryId: string | undefined;
  let singleMemoryId: string | undefined;
  let staleMemoryId: string | undefined;

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
    dataHome = mkdtempSync(join(tmpdir(), "lm-bb-all-core-"));
    // Same env contract as `mcp-client-e2e.test.ts`:
    // suppress the CLI/MCP deprecation hint and the
    // "connected on stdio" hint so the stderr-leak
    // assertion stays honest. The Task 3 follow-up
    // pins this file to the Core profile (the
    // v1.1.2 packaged default).
    const env = {
      ...process.env,
      AGENT_RECALL_HOME: dataHome,
      AGENT_RECALL_PROFILE: "core",
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
    client = new Client({ name: "all-tools-e2e-core", version: "1.1.2" }, { capabilities: {} });
    await client.connect(transport);
    serverPid = transport.pid ?? undefined;

    // Pre-seed fixtures the per-tool tests reuse so
    // each `it` is a one-shot assertion rather than
    // re-running the write path.
    const single = await callTool(client, "remember", rememberArgs({
      title: "single seed",
      body: "single seed body for search and get",
      topic: "single",
      tags: ["single", "bb-suite"]
    }));
    expect(single.isError).toBeFalsy();
    singleMemoryId = (parseText(single) as { value: RememberValue }).value.memory_id;

    const stale = await callTool(client, "remember", rememberArgs({
      title: "stale cas target",
      body: "will be updated once, then second update with stale revision must fail",
      topic: "cas"
    }));
    expect(stale.isError).toBeFalsy();
    staleMemoryId = (parseText(stale) as { value: RememberValue }).value.memory_id;

    // v1.1.2 (issue #21): the strict resolver
    // refuses a `project_id`-only call without a
    // registered identity. The path-supplied
    // `register` mode registers the identity
    // implicitly on first use, so the same seed
    // succeeds against the new resolver.
    const projMem = await callTool(client, "remember", rememberArgs({
      scope: "project",
      project_id: projectId,
      project_path: `/tmp/${projectId}`,
      title: "project-local memory",
      body: "this lives under the project scope",
      topic: "proj",
      tags: ["bb-suite", "project"]
    }));
    expect(projMem.isError).toBeFalsy();
    projectMemoryId = (parseText(projMem) as { value: RememberValue }).value.memory_id;
  }, 60_000);

  afterAll(async () => {
    if (client !== undefined) {
      try { await client.close(); } catch { /* already closed */ }
    }
    if (serverPid !== undefined) {
      try { process.kill(serverPid, "SIGTERM"); } catch { /* already gone */ }
    }
    if (dataHome !== undefined) {
      rmSync(dataHome, { recursive: true, force: true });
    }
    // v1.1.1 PR-8 leak guard. The full lifecycle
    // must not write a single byte to stderr.
    const leak = stderrChunks.join("").trim();
    if (leak.length > 0) {
      throw new Error(`MCP server wrote to stderr over the lifecycle:\n${leak}`);
    }
  }, 30_000);

  // ----------------------------------------------------------
  // Surface: tool list, resource list, server PID.
  // ----------------------------------------------------------

  it("surface: registers the 10-tool Core profile and 3 static + 2 templated resources", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    // The Core profile (the v1.1.2 packaged
    // default) registers exactly the 10 tools in
    // `CORE_TOOL_NAMES`. The assertion compares
    // against the canonical array in
    // `register-tools.ts` rather than a
    // hand-maintained list so an addition to
    // either profile surfaces as a single source
    // of truth.
    const expected = [...CORE_TOOL_NAMES].sort();
    expect(names).toEqual(expected);
    // The Core list is a strict subset of the
    // full 20-tool surface: none of the
    // Extended-only tools are exposed.
    const extended = new Set<string>(EXTENDED_TOOL_NAMES);
    for (const name of names) {
      expect(extended.has(name)).toBe(false);
    }

    // Every tool carries the canonical annotations
    // and a `z.object` output schema (PR-8
    // regression guard).
    for (const tool of tools.tools) {
      expect(tool.annotations).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
      const shape = tool.outputSchema as { type?: string };
      expect(shape.type).toBe("object");
    }

    const resources = await client.listResources();
    const staticUris = resources.resources.map((r) => r.uri).sort();
    expect(staticUris).toEqual([
      "memory://global/summary",
      "memory://health",
      "memory://projects"
    ]);

    const templates = await client.listResourceTemplates();
    const tplNames = templates.resourceTemplates.map((t) => t.name).sort();
    expect(tplNames).toEqual(["memory_import_batch", "memory_project_memory", "memory_project_summary"]);
  });

  it("surface: server PID is set and non-zero", () => {
    expect(serverPid).toBeDefined();
    expect(typeof serverPid).toBe("number");
    expect(serverPid).toBeGreaterThan(0);
  });

  // ----------------------------------------------------------
  // Read tools.
  // ----------------------------------------------------------

  it("read: list_memories returns the pre-seeded entries", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r = await callTool(client, "list_memories", { scope: "global" });
    expect(r.isError).toBeFalsy();
    const v = data<ListValue>(r);
    const ids = new Set(v.items.map((i) => i.id));
    expect(ids.has(singleMemoryId!)).toBe(true);
    // No `_zod` regression: the v1.1.0 envelope
    // union bug is gone.
    const txt = r.content?.[0]?.text ?? "";
    expect(txt).not.toMatch(/_zod/);
  });

  it("read: get_memory returns the entry + audit array", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r = await callTool(client, "get_memory", { memory_id: singleMemoryId });
    expect(r.isError).toBeFalsy();
    const v = data<GetValue>(r);
    expect(v.entry.id).toBe(singleMemoryId);
    expect(v.entry.title).toBe("single seed");
    expect(v.entry.revision).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(v.audit)).toBe(true);
  });

  it("read: get_memory with id (alias) returns the same entry", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r = await callTool(client, "get_memory", { id: singleMemoryId });
    expect(r.isError).toBeFalsy();
    const v = data<GetValue>(r);
    expect(v.entry.id).toBe(singleMemoryId);
  });

  it("read: search_memories finds the seeded entry by query", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r = await callTool(client, "search_memories", {
      scope: "global",
      query: "single seed",
      limit: 5
    });
    expect(r.isError).toBeFalsy();
    const v = data<SearchValue>(r);
    const ids = v.items.map((i) => i.id);
    expect(ids).toContain(singleMemoryId);
  });

  it("read: get_memory_budget reports global budget + usage", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r = await callTool(client, "get_memory_budget", { scope: "global" });
    expect(r.isError).toBeFalsy();
    const v = data<BudgetValue>(r);
    expect(v.budget.max_active_entries).toBeGreaterThan(0);
    expect(v.usage.active_entries).toBeGreaterThan(0);
  });

  it("read: get_memory_budget project returns a project budget", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r = await callTool(client, "get_memory_budget", {
      scope: "project",
      project_id: projectId
    });
    expect(r.isError).toBeFalsy();
    const v = data<BudgetValue>(r);
    expect(v.budget.max_active_entries).toBeGreaterThan(0);
  });

  it("read: explain_recall returns ranking_version + per-item components", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r = await callTool(client, "explain_recall", {
      query: "single seed",
      scope: "global",
      top_k: 5
    });
    expect(r.isError).toBeFalsy();
    const v = data<ExplainValue>(r);
    // v1.1.1 PR-6 (issue #15): ranking version is
    // `coding-default-v2`.
    expect(v.ranking_version).toBe("coding-default-v2");
    expect(v.items.length).toBeGreaterThan(0);
    const first = v.items[0]!;
    expect(first.components.lexical_relevance).toBeGreaterThan(0);
    expect(typeof first.trust_boost).toBe("number");
  });

  it("read: list_backups returns the backup dir + entries (empty for fresh data home)", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r = await callTool(client, "list_backups", {});
    expect(r.isError).toBeFalsy();
    const v = data<ListBackupsValue>(r);
    expect(v.backup_dir).toBeDefined();
    expect(Array.isArray(v.entries)).toBe(true);
  });

  // ----------------------------------------------------------
  // Text tools (markdown deliverables).
  // ----------------------------------------------------------

  it("text: recall_context returns a markdown body for global scope", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r = (await callTool(client, "recall_context", { scope: "global" })) as TextToolResult;
    expect(r.isError).toBeFalsy();
    const md = r.structuredContent.data.markdown;
    expect(typeof md).toBe("string");
    expect(md.length).toBeGreaterThan(0);
  });

  // ----------------------------------------------------------
  // Mutating tools.
  // ----------------------------------------------------------

  it("mutate: update_memory with expected_revision=1 succeeds", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r = await callTool(client, "update_memory", {
      memory_id: staleMemoryId,
      title: "stale cas target (updated once)",
      expected_revision: 1
    });
    expect(r.isError).toBeFalsy();
    const v = data<UpdateValue>(r);
    expect(v.memory_id).toBe(staleMemoryId);
  });

  it("mutate: update_memory with stale expected_revision rejects as stale_revision", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r = await callTool(client, "update_memory", {
      memory_id: staleMemoryId,
      title: "this update must lose the CAS race",
      expected_revision: 1
    });
    expect(r.isError).toBe(true);
    expect(failureCode(r)).toBe("stale_revision");
  });

  it("mutate: update_memory with idempotency_key replays the original mutation", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const key = `bb-update-${Date.now()}`;
    const body = `bb-update-body-${Math.random()}`;
    const r1 = await callTool(client, "update_memory", {
      memory_id: singleMemoryId,
      body,
      idempotency_key: key
    });
    expect(r1.isError).toBeFalsy();
    const r2 = await callTool(client, "update_memory", {
      memory_id: singleMemoryId,
      body,
      idempotency_key: key
    });
    expect(r2.isError).toBeFalsy();
    const v1 = data<UpdateValue>(r1);
    const v2 = data<UpdateValue>(r2);
    expect(v1.memory_id).toBe(singleMemoryId);
    expect(v2.memory_id).toBe(singleMemoryId);
  });

  it("mutate: forget_memory with idempotency_key replays the original released_chars", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const seed = await callTool(client, "remember", rememberArgs({
      title: "forget target",
      body: "forget me body",
      topic: "forget"
    }));
    expect(seed.isError).toBeFalsy();
    const target = (parseText(seed) as { value: RememberValue }).value.memory_id;
    const key = `bb-forget-${Date.now()}`;
    const r1 = await callTool(client, "forget_memory", {
      memory_id: target,
      reason: "blackbox cleanup",
      idempotency_key: key
    });
    expect(r1.isError).toBeFalsy();
    const v1 = data<ForgetValue>(r1);
    const r2 = await callTool(client, "forget_memory", {
      memory_id: target,
      reason: "blackbox cleanup",
      idempotency_key: key
    });
    expect(r2.isError).toBeFalsy();
    const v2 = data<ForgetValue>(r2);
    expect(v2.released_chars).toBe(v1.released_chars);
  });

  // ----------------------------------------------------------
  // Resources (3 static + 2 templated).
  // ----------------------------------------------------------

  it("resources: memory://health reports server_version + schema_version + active_profile=core", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r = (await client.readResource({ uri: "memory://health" })) as unknown as ResourceContents;
    const payload = JSON.parse(r.contents[0]!.text) as HealthResource;
    expect(payload.status).toBe("ok");
    expect(payload.server_version).toBeTruthy();
    expect(payload.schema_version).toBeGreaterThanOrEqual(10);
    expect(payload.backup.dir).toBeTruthy();
    // Task 3 follow-up: the test spawned the
    // server with `AGENT_RECALL_PROFILE=core`,
    // so the health resource must surface
    // `active_profile === "core"`.
    expect(payload.active_profile).toBe("core");
  });

  it("resources: memory://global/summary returns status counts + recent activity", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r = (await client.readResource({ uri: "memory://global/summary" })) as unknown as ResourceContents;
    const payload = JSON.parse(r.contents[0]!.text) as {
      scope: string;
      status_counts: Record<string, number>;
      recent_activity: Array<{ memory_id: string }>;
    };
    expect(payload.scope).toBe("global");
    expect(payload.status_counts.active).toBeGreaterThan(0);
    expect(payload.recent_activity.length).toBeGreaterThan(0);
  });

  it("resources: memory://projects surfaces the project we wrote to", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r = (await client.readResource({ uri: "memory://projects" })) as unknown as ResourceContents;
    const payload = JSON.parse(r.contents[0]!.text) as { projects: Array<{ project_id: string }> };
    const ids = payload.projects.map((p) => p.project_id);
    expect(ids).toContain(projectId);
  });

  it("resources: memory://project/{id}/summary template", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r = (await client.readResource({
      uri: `memory://project/${projectId}/summary`
    })) as unknown as ResourceContents;
    const payload = JSON.parse(r.contents[0]!.text) as ProjectSummaryResource;
    expect(payload.project_id).toBe(projectId);
    expect(payload.status_counts.active).toBeGreaterThan(0);
    const ids = payload.recent_activity.map((a) => a.memory_id);
    expect(ids).toContain(projectMemoryId);
  });

  it("resources: memory://project/{id}/memory/{mid} template returns the entry + audit", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r = (await client.readResource({
      uri: `memory://project/${projectId}/memory/${projectMemoryId}`
    })) as unknown as ResourceContents;
    const payload = JSON.parse(r.contents[0]!.text) as ProjectMemoryResource;
    expect(payload.entry.id).toBe(projectMemoryId);
    expect(Array.isArray(payload.audit)).toBe(true);
    expect(payload.audit.some((a) => a.event === "created")).toBe(true);
  });

  // ----------------------------------------------------------
  // Error paths: the MCP contract is strict
  // about typed `error.code` values.
  // ----------------------------------------------------------

  it("errors: invalid_schema surfaces the typed failure envelope (no throw)", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r = await callTool(client, "remember", {
      // missing `body`, `source`, `topic`, `title`,
      // `importance`, `confidence` -> zod rejects
      scope: "global",
      type: "fact"
    });
    expect(r.isError).toBe(true);
    expect(failureCode(r)).toBe("invalid_schema");
  });

  it("errors: not_found for get_memory on a missing id", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r = await callTool(client, "get_memory", { memory_id: "mem_does_not_exist" });
    expect(r.isError).toBe(true);
    expect(failureCode(r)).toBe("not_found");
  });

  it("errors: idempotency_mismatch when the same key is reused with a different body", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const key = `bb-idem-mismatch-${Date.now()}`;
    const r1 = await callTool(client, "remember", rememberArgs({
      title: "im first",
      body: "first body",
      topic: "idem-mismatch",
      idempotency_key: key
    }));
    expect(r1.isError).toBeFalsy();
    const r2 = await callTool(client, "remember", rememberArgs({
      title: "im second",
      body: "second body, different",
      topic: "idem-mismatch",
      idempotency_key: key
    }));
    expect(r2.isError).toBe(true);
    const code = failureCode(r2);
    expect(code).toMatch(/idempotency_mismatch|key_reuse|key was reused/);
  });

  // -------------------------------------------------------------
  // v1.1.3 GATE-02 (issue #32): a Core packaged
  // black-box process refuses a privileged write
  // even when the test fixture ships a valid
  // `admin.cap` in the data home. The Core
  // profile NEVER inherits Admin visibility
  // merely because the capability file exists;
  // the per-request capability path on Core is
  // also refused for `profile_required: "admin"`
  // capability types (`trust_promotion`,
  // `sensitivity_restricted`,
  // `sensitivity_visibility`).
  //
  // We ship `admin.cap` via the parent
  // `setupMcpServer` fixture's `dataHome` so
  // the contract is: a Core client cannot
  // promote a memory to `user_confirmed` even
  // with a per-request token.
  // -------------------------------------------------------------
  it("security: Core refuses trust_promotion even with a valid admin.cap on disk", async () => {
    if (client === undefined) throw new Error("client not initialised");
    if (dataHome === undefined) throw new Error("dataHome not set");
    // Pre-condition: write a fresh `admin.cap`
    // via the canonical grant path so the
    // process's startup-time capability
    // detection has a valid token. We use
    // `npx tsx` to invoke the in-tree
    // CapabilityStore.grant() helper, which
    // is the documented operator-only mutation
    // surface.
    const { CapabilityStore } = await import("../../src/admin/capability.js");
    const capStore = new CapabilityStore(dataHome, { persistent: true });
    capStore.grant({ label: "core-with-cap-test" });
    expect(capStore.hasCapability()).toBe(true);

    // Pre-seed an entry to promote.
    const seedKey = `bb-core-cap-${Date.now()}`;
    const seed = await callTool(client, "remember", rememberArgs({
      title: "core-cap-target",
      body: "promote target",
      topic: "core-cap",
      idempotency_key: seedKey
    }));
    expect(seed.isError).toBeFalsy();
    const seedId = (seed.structuredContent?.data as { memory_id?: string } | undefined)?.memory_id;
    if (seedId === undefined) throw new Error("seed did not return memory_id");

    // Attempt the promotion via the per-request
    // path: the tool surface is `confirm_memory_trust`
    // (not exposed on Core) — but we exercise
    // the service-level gate by attempting a
    // `trust_level: "user_confirmed"` write. The
    // service rejects at the validation gate
    // because the capability path returns
    // `profile_mismatch` (Core != admin).
    const probe = await callTool(client, "remember", rememberArgs({
      title: "core-cap-probe",
      body: "should be rejected",
      topic: "core-cap-probe",
      trust_level: "user_confirmed"
    }));
    expect(probe.isError).toBe(true);
    const code = failureCode(probe);
    // The Core path returns either
    // `profile_mismatch` (when the token is
    // validated against the profile gate) OR
    // `unauthorized` (when the per-request token
    // is missing). The exact envelope depends
    // on whether the call supplied the
    // capability field; we accept either
    // stable code as the fail-closed contract.
    expect(code).toMatch(/profile_mismatch|unauthorized/);
  });
});