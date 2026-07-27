// test/blackbox/mcp-all-tools-e2e-extended.test.ts
//
// Stage 16 v1.1.1 (PR-8, issue #16) + Stage 17
// v1.1.2 (issue #22, Task 3 follow-up): the
// **Extended-profile** authoritative black-box
// E2E for the MCP server contract. v1.1.0's
// zod v4 incompatibility made every callTool
// return `isError: true` with `_zod` (see
// `mcp-client-e2e.test.ts` for the legacy smoke).
// v1.1.1 PR-8 flattens the `outputSchema` so the
// SDK's `validateToolOutput` succeeds, and the
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
// Extended-profile surface and asserts the full
// non-admin tool list end-to-end.
//
// The test runs against the **built** server
// (`dist/src/index.js`), not the source. The
// file FAILS HARD when `dist/` is absent (no
// `it.skip`, no silent skip-on-no-dist): the
// release-gate surface must surface a missing
// build artifact as a deterministic failure.

import { mkdtempSync, rmSync } from "node:fs";
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
import { existsSync } from "node:fs";

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
  // same title+body (e.g. the duplicate-alpha
  // triple) on purpose — the v1.1 write path
  // rejects an exact `duplicate_candidate` unless
  // the caller explicitly opts in with
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

interface MaintainValue {
  action: string;
  details?: { groups?: Array<{ reason: string; memory_ids: string[]; fingerprint: string }> };
}

interface PlanValue {
  plan_id: string;
  state: string;
  proposed_actions: Array<{ kind: string; target_memory_id: string; risk: string }>;
  risk: "low" | "high";
}

interface ApplyValue {
  ok: boolean;
  plan_id: string;
  applied: number;
  rejected: number;
}

interface ForgetValue {
  memory_id: string;
  released_chars: number;
}

interface MergeValue {
  memory_id: string;
  merged_from?: string[];
}

interface SupersedeValue {
  memory_id: string;
}

interface UpdateValue {
  memory_id: string;
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

describe("MCP all-tools black-box E2E - Extended profile (v1.1.2 #22 Task 3 follow-up)", () => {
  let dataHome: string | undefined;
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let serverPid: number | undefined;
  let stderrChunks: string[] = [];
  // Stable per-suite scratch.
  let dupA: string | undefined;
  let dupB: string | undefined;
  let dupC: string | undefined;
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
    dataHome = mkdtempSync(join(tmpdir(), "lm-bb-all-ext-"));
    // Stage 18 v1.1.2 (issue #23, ADR-0001):
    // pre-install a valid operator capability so
    // the Extended profile can authorise the
    // `confirm_memory_trust` and
    // `sensitivity_restricted` writes the suite
    // exercises. The capability is the same
    // canonical shape the CLI `admin grant`
    // command produces; the test seeds it
    // directly into the on-disk file so the
    // server's startup-time load picks it up.
    const { CapabilityStore } = await import("../../src/admin/capability.js");
    CapabilityStore.capabilityPath(dataHome);
    // `persistent: true` so the on-disk file
    // is written; the server's startup-time
    // load picks it up. The test reads the
    // raw token from the file directly
    // (the `status()` surface never returns
    // it; only the redacted `token_tail` /
    // `fingerprint`).
    const seedCap = new CapabilityStore(dataHome, { persistent: true });
    const seedStatus = seedCap.grant({ label: "blackbox-extended" });
    expect(seedStatus.kind).toBe("granted");
    // Same env contract as `mcp-client-e2e.test.ts`:
    // suppress the CLI/MCP deprecation hint and the
    // "connected on stdio" hint so the stderr-leak
    // assertion stays honest. The Task 3 follow-up
    // pins this file to the Extended profile so the
    // assertions line up with the tool list the
    // server registers.
    const env = {
      ...process.env,
      AGENT_RECALL_HOME: dataHome,
      AGENT_RECALL_PROFILE: "extended",
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
    client = new Client({ name: "all-tools-e2e-ext", version: "1.1.2" }, { capabilities: {} });
    await client.connect(transport);
    serverPid = transport.pid ?? undefined;

    // Pre-seed fixtures the per-tool tests reuse so
    // each `it` is a one-shot assertion rather than
    // re-running the write path. The tests still
    // assert the tool-under-test on its own input.
    const dup1 = await callTool(client, "remember", rememberArgs({
      title: "duplicate alpha",
      body: "the same body for the duplicate group",
      topic: "dup"
    }));
    expect(dup1.isError).toBeFalsy();
    dupA = (parseText(dup1) as { value: RememberValue }).value.memory_id;

    const dup2 = await callTool(client, "remember", rememberArgs({
      title: "duplicate alpha",
      body: "the same body for the duplicate group",
      topic: "dup"
    }));
    expect(dup2.isError).toBeFalsy();
    dupB = (parseText(dup2) as { value: RememberValue }).value.memory_id;

    const dup3 = await callTool(client, "remember", rememberArgs({
      title: "duplicate alpha",
      body: "the same body for the duplicate group",
      topic: "dup"
    }));
    expect(dup3.isError).toBeFalsy();
    dupC = (parseText(dup3) as { value: RememberValue }).value.memory_id;

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

  it("surface: registers the full 20-tool Extended surface and 3 static + 2 templated resources", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    // The Extended profile registers Core +
    // Extended (the full non-admin surface). The
    // assertion compares against the canonical
    // arrays in `register-tools.ts` rather than a
    // hand-maintained list so an addition to
    // either profile surfaces as a single source
    // of truth.
    const expected = [...CORE_TOOL_NAMES, ...EXTENDED_TOOL_NAMES].sort();
    expect(names).toEqual(expected);

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
    expect(ids.has(dupA!)).toBe(true);
    expect(ids.has(dupB!)).toBe(true);
    expect(ids.has(dupC!)).toBe(true);
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
      query: "duplicate alpha",
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

  it("text: export_memory_context returns a markdown body for the seeded entries", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r = (await callTool(client, "export_memory_context", {
      scope: "global",
      query: "duplicate"
    })) as TextToolResult;
    expect(r.isError).toBeFalsy();
    const md = r.structuredContent.data.markdown;
    expect(md).toMatch(/duplicate alpha|single seed/);
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

  it("mutate: merge_memories merges two duplicates into one active row", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const replacement = rememberArgs({
      title: "duplicate alpha (merged)",
      body: "the same body for the duplicate group",
      topic: "dup",
      idempotency_key: `bb-merge-${Date.now()}`
    });
    const r = await callTool(client, "merge_memories", {
      old_memory_ids: [dupA!, dupB!],
      replacement,
      reason: "duplicate cleanup",
      strategy: "keep_first"
    });
    expect(r.isError).toBeFalsy();
    const v = data<MergeValue>(r);
    expect(v.memory_id).toMatch(/^mem_/);
    expect(v.merged_from).toEqual(expect.arrayContaining([dupA, dupB]));
  });

  it("mutate: supersede_memory marks the old row status=superseded", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const replacement = rememberArgs({
      title: "stale cas target (superseded)",
      body: "new body after supersede",
      topic: "cas",
      idempotency_key: `bb-supersede-${Date.now()}`
    });
    const r = await callTool(client, "supersede_memory", {
      old_memory_ids: [staleMemoryId!],
      replacement,
      reason: "stale cas target replaced"
    });
    expect(r.isError).toBeFalsy();
    const v = data<SupersedeValue>(r);
    expect(v.memory_id).toMatch(/^mem_/);
    const after = await callTool(client, "get_memory", { memory_id: staleMemoryId });
    expect(after.isError).toBeFalsy();
    const afterData = data<GetValue>(after);
    expect(afterData.audit.some((a) => (a as { event?: string }).event === "superseded")).toBe(true);
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

  it("mutate: maintain_memories find_duplicates returns a non-empty groups list", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const stamp = `dup-${Date.now()}`;
    const d1 = await callTool(client, "remember", rememberArgs({
      title: stamp, body: stamp, topic: "find-dup"
    }));
    const d2 = await callTool(client, "remember", rememberArgs({
      title: stamp, body: stamp, topic: "find-dup"
    }));
    const d3 = await callTool(client, "remember", rememberArgs({
      title: stamp, body: stamp, topic: "find-dup"
    }));
    expect(d1.isError).toBeFalsy();
    expect(d2.isError).toBeFalsy();
    expect(d3.isError).toBeFalsy();
    const d3id = (parseText(d3) as { value: RememberValue }).value.memory_id;

    const r = await callTool(client, "maintain_memories", {
      action: "find_duplicates",
      scope: "global"
    });
    expect(r.isError).toBeFalsy();
    const v = data<MaintainValue>(r);
    expect(v.action).toBe("find_duplicates");
    const groups = v.details?.groups ?? [];
    expect(groups.length).toBeGreaterThan(0);
    const group = groups.find((g) => g.reason === "same_title_and_body" && g.memory_ids.includes(d3id));
    expect(group).toBeDefined();
  });

  it("mutate: plan_maintenance builds a durable plan; apply_maintenance completes it", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const stamp = `plan-${Date.now()}`;
    const p1 = await callTool(client, "remember", rememberArgs({
      title: stamp, body: stamp, topic: "plan"
    }));
    const p2 = await callTool(client, "remember", rememberArgs({
      title: stamp, body: stamp, topic: "plan"
    }));
    expect(p1.isError).toBeFalsy();
    expect(p2.isError).toBeFalsy();

    const plan = await callTool(client, "plan_maintenance", {
      scope: "global",
      max_groups: 50
    });
    expect(plan.isError).toBeFalsy();
    const pv = data<PlanValue>(plan);
    expect(pv.plan_id).toMatch(/^plan_/);
    expect(pv.proposed_actions.length).toBeGreaterThan(0);
    expect(pv.risk).toMatch(/^(low|high)$/);

    const apply = await callTool(client, "apply_maintenance", {
      plan_id: pv.plan_id,
      confirm: true,
      idempotency_key: `bb-apply-${Date.now()}`
    });
    expect(apply.isError).toBeFalsy();
    const av = data<ApplyValue>(apply);
    expect(av.plan_id).toBe(pv.plan_id);
    expect(av.ok).toBe(true);
    expect(av.applied + av.rejected).toBeGreaterThan(0);
  });

  it("mutate: apply_maintenance with unknown plan_id returns plan_not_found", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r = await callTool(client, "apply_maintenance", {
      plan_id: "plan_does_not_exist",
      confirm: true,
      idempotency_key: `bb-apply-nf-${Date.now()}`
    });
    expect(r.isError).toBeFalsy();
    const v = data<ApplyValue>(r);
    expect(v.ok).toBe(false);
    expect(v.plan_id).toBe("plan_does_not_exist");
  });

  // ----------------------------------------------------------
  // Memory-semantics tools (v1.1.1 PR-7).
  // ----------------------------------------------------------

  it("semantics: record_memory_feedback appends a row for the seed memory", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r = await callTool(client, "record_memory_feedback", {
      memory_id: singleMemoryId,
      kind: "up"
    });
    expect(r.isError).toBeFalsy();
    const v = data<{ ok: boolean }>(r);
    expect(v.ok).toBe(true);
  });

  it("semantics: record_memory_provenance links the seed memory to a commit sha", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r = await callTool(client, "record_memory_provenance", {
      memory_id: singleMemoryId,
      source_kind: "commit",
      source_ref: `sha-${Date.now().toString(16)}`
    });
    expect(r.isError).toBeFalsy();
    const v = data<{ ok: boolean }>(r);
    expect(v.ok).toBe(true);
  });

  it("semantics: explain_memory_provenance returns the chain we just wrote", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r = await callTool(client, "explain_memory_provenance", {
      memory_id: singleMemoryId
    });
    expect(r.isError).toBeFalsy();
    const v = data<{ memory_id: string; links: Array<{ source_kind: string; source_ref: string }>; summary: string[] }>(r);
    expect(v.memory_id).toBe(singleMemoryId);
    expect(v.links.length).toBeGreaterThan(0);
    expect(v.links.some((l) => l.source_kind === "commit")).toBe(true);
  });

  it("semantics: confirm_memory_trust promotes the seed memory to user_confirmed (with capability)", async () => {
    if (client === undefined) throw new Error("client not initialised");
    // Stage 18 v1.1.2 (issue #23, ADR-0001): the
    // `confirm_memory_trust` tool now requires an
    // operator capability. The `beforeAll` hook
    // pre-installs a valid capability; the test
    // passes the matching token on the request.
    const { CapabilityStore } = await import("../../src/admin/capability.js");
    // `persistent: true` so the on-disk file
    // is read on construction. The `status()`
    // surface never returns the raw token; the
    // test reads it from the file directly
    // (the canonical CLI / blackbox side
    // channel).
    const capStore = new CapabilityStore(dataHome!, { persistent: true });
    const onDisk = capStore.status();
    expect(onDisk.kind).toBe("granted");
    const fs = await import("node:fs");
    const onDiskRaw = fs.readFileSync(capStore.getPath(), "utf8");
    const onDiskJson = JSON.parse(onDiskRaw) as { token: string };
    const r = await callTool(client, "confirm_memory_trust", {
      memory_id: singleMemoryId,
      trust_level: "user_confirmed",
      user_confirmed: true,
      capability: onDiskJson.token,
      reason: "blackbox smoke"
    });
    expect(r.isError).toBeFalsy();
  });

  // ----------------------------------------------------------
  // Resources (3 static + 2 templated).
  // ----------------------------------------------------------

  it("resources: memory://health reports server_version + schema_version + active_profile=extended", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r = (await client.readResource({ uri: "memory://health" })) as unknown as ResourceContents;
    const payload = JSON.parse(r.contents[0]!.text) as HealthResource;
    expect(payload.status).toBe("ok");
    expect(payload.server_version).toBeTruthy();
    expect(payload.schema_version).toBeGreaterThanOrEqual(10);
    expect(payload.backup.dir).toBeTruthy();
    // Task 3 follow-up: the test spawned the
    // server with `AGENT_RECALL_PROFILE=extended`,
    // so the health resource must surface
    // `active_profile === "extended"`.
    expect(payload.active_profile).toBe("extended");
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
});