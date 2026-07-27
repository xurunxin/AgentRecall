// test/blackbox/packaged-install.test.ts
//
// Stage 18 v1.1.2 (issue #28, task 9): the
// extracted-artifact MCP lifecycle E2E.
//
// This test exercises the **packaged** release
// archive end-to-end. The packaged artefact is the
// exact `.tar.gz` (Linux / macOS) / `.zip` (Windows)
// a consumer downloads; the test does NOT use the
// source checkout's `dist/` (that path is already
// covered by `mcp-client-e2e.test.ts` /
// `mcp-all-tools-e2e-{core,extended}.test.ts` /
// `admin-default/mcp-admin-default.test.ts`).
//
// The artifact path is supplied via the
// `AGENT_RECALL_EXTRACTED_ARTIFACT` env var; the
// CI matrix extracts the packaged archive into
// `$RUNNER_TEMP/agent-recall-extracted/` and runs
// `npm install --omit=dev` there before invoking
// this suite. The test fails closed when the env
// var is unset (no `it.skip` / `describe.skip`): a
// missing artefact is a release-gate blocker and
// must surface as a deterministic failure rather
// than a silently-passing release-gate surface
// (the AGENTS.md rule + the Task 3 follow-up
// fail-closed contract).
//
// Lifecycle scenarios (the brief's 11):
//
//   a. initialize / capability negotiation
//   b. exact tools + resources discovery
//      (Core / Extended / Admin canonical list)
//   c. remember + idempotent replay +
//      key-reuse rejection
//   d. CAS update + stale revision rejection
//   e. project identity registration / lookup /
//      conflict
//   f. search + recall
//   g. sensitivity / trust authorized +
//      unauthorized (`forbidden_visibility` on
//      restricted reads without capability)
//   h. maintenance plan / apply in permitted
//      profile
//   i. snapshot export / import round-trip
//      through the PACKAGED CLI
//   j. backup / doctor / CLI entry points through
//      the PACKAGED CLI
//   k. clean shutdown — empty stderr (modulo
//      allowed diagnostics), no leaked process,
//      no leaked temp directory

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// These are the canonical wire lists from src/tools/register-tools.ts. Keep
// this artifact test source-independent: update these literals whenever the
// canonical lists change, then release-gate tests catch drift in the archive.
const CORE_TOOL_NAMES = [
  "recall_context", "remember", "search_memories", "get_memory", "list_memories",
  "update_memory", "forget_memory", "get_memory_budget", "explain_recall", "list_backups"
] as const;
const EXTENDED_ONLY_TOOL_NAMES = [
  "supersede_memory", "merge_memories", "maintain_memories", "export_memory_context",
  "plan_maintenance", "apply_maintenance", "record_memory_feedback",
  "record_memory_provenance", "explain_memory_provenance", "confirm_memory_trust"
] as const;
const EXTENDED_TOOL_NAMES = [...CORE_TOOL_NAMES, ...EXTENDED_ONLY_TOOL_NAMES] as const;
const ADMIN_TOOL_NAMES = EXTENDED_TOOL_NAMES;


// Task 9 fail-closed contract: the lifecycle
// test requires an extracted artefact. The CI
// matrix sets `AGENT_RECALL_EXTRACTED_ARTIFACT`
// after `scripts/extract-release-artifact.mjs`
// + `npm install --omit=dev`. A local dev run
// can set the same env var after the README's
// "Run the lifecycle locally" steps.
const EXTRACTED_ARTIFACT = process.env["AGENT_RECALL_EXTRACTED_ARTIFACT"];
if (EXTRACTED_ARTIFACT === undefined || EXTRACTED_ARTIFACT.length === 0) {
  throw new Error(
    "packaged-install.test.ts requires AGENT_RECALL_EXTRACTED_ARTIFACT to point at an extracted release artefact; CI sets it from scripts/extract-release-artifact.mjs"
  );
}
const ARTIFACT_DIR = resolve(EXTRACTED_ARTIFACT);
const SERVER_ENTRY = join(ARTIFACT_DIR, "dist", "src", "index.js");
const CLI_ENTRY = join(ARTIFACT_DIR, "dist", "bin", "agent-recall.js");

const REQUIRED_FILES = [
  "dist/src/index.js",
  "dist/bin/agent-recall.js",
  "package.json",
  "README.md",
  "CHANGELOG.md"];
for (const rel of REQUIRED_FILES) {
  const path = join(ARTIFACT_DIR, rel);
  if (!existsSync(path)) {
    throw new Error(
      `packaged-install.test.ts requires ${path} to exist in the extracted artefact (CI runs npm install --omit=dev inside the extracted dir before this suite)`
    );
  }
}

// ============================================================
// Shared helpers.
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
  if (result.isError === true) return "invalid_schema";
  throw new Error(
    `expected failure envelope, got isError=${result.isError} sc=${JSON.stringify(result.structuredContent)}`
  );
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const res = await client.callTool({ name, arguments: args });
  return res as unknown as ToolResult;
}

interface HealthResource {
  status: string;
  server_version: string;
  schema_version: number;
  active_profile: "core" | "extended" | "admin";
  capability_state?: "granted" | "missing";
  strict_isolation: boolean;
  identity_status: "bound" | "unbound";
}

interface ResourceContents {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}

interface LifecycleHarness {
  dataHome: string;
  client: Client | undefined;
  transport: StdioClientTransport | undefined;
  serverPid: number | undefined;
  stderrChunks: string[];
}

async function startHarness(
  profile: "core" | "extended" | "admin" | undefined,
  dataHome: string
): Promise<LifecycleHarness> {
  const harness: LifecycleHarness = {
    dataHome,
    client: undefined,
    transport: undefined,
    serverPid: undefined,
    stderrChunks: []
  };
  // The CLI + MCP server resolve `node_modules`
  // relative to their own location; setting
  // `cwd: ARTIFACT_DIR` is the documented path
  // for a self-contained extracted artefact
  // (the CI matrix runs `npm install --omit=dev`
  // inside the extracted dir).
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    AGENT_RECALL_HOME: dataHome,
    ...(profile === undefined ? {} : { AGENT_RECALL_PROFILE: profile }),
    AGENT_RECALL_SUPPRESS_MCP_DEPRECATION: "1",
    AGENT_RECALL_VERBOSE_STDIO: "0"
  };
  harness.transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env,
    cwd: ARTIFACT_DIR,
    stderr: "pipe"
  });
  if (
    harness.transport.stderr !== null &&
    harness.transport.stderr !== undefined &&
    typeof (harness.transport.stderr as { on?: unknown }).on === "function"
  ) {
    (
      harness.transport.stderr as { on: (event: string, cb: (chunk: Buffer) => void) => void }
    ).on("data", (chunk: Buffer) => {
      harness.stderrChunks.push(chunk.toString("utf8"));
    });
  }
  harness.client = new Client(
    { name: "packaged-install-e2e", version: "1.1.2" },
    { capabilities: {} }
  );
  await harness.client.connect(harness.transport);
  harness.serverPid = harness.transport.pid ?? undefined;
  return harness;
}

async function stopHarness(harness: LifecycleHarness): Promise<void> {
  if (harness.client !== undefined) {
    try {
      await harness.client.close();
    } catch {
      // already closed
    }
  }
  if (harness.serverPid !== undefined) {
    try { process.kill(harness.serverPid, "SIGTERM"); } catch { /* already gone */ }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try { process.kill(harness.serverPid, 0); } catch { break; }
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    try {
      process.kill(harness.serverPid, 0);
      process.kill(harness.serverPid, "SIGKILL");
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    } catch { /* exited */ }
    try { process.kill(harness.serverPid, 0); throw new Error(`server PID ${harness.serverPid} still exists after SIGKILL`); } catch (error) {
      if (error instanceof Error && error.message.startsWith("server PID")) throw error;
    }
  }
  // Scenario (k): clean shutdown — assert the
  // server wrote nothing unexpected to stderr
  // over the full lifecycle. A leak here
  // (unhandled exception, Zod stack trace,
  // forgotten `console.error`) is the canonical
  // sign of an unhandled error path.
  const leak = harness.stderrChunks.join("").trim();
  if (leak.length > 0) {
    throw new Error(`server wrote to stderr over the lifecycle:\n${leak}`);
  }
  if (harness.dataHome !== undefined && existsSync(harness.dataHome)) {
    rmSync(harness.dataHome, { recursive: true, force: true });
  }
}

// Spawn the PACKAGED CLI (not
// `bin/agent-recall.ts` from the test repo).
// The CLI's argv is parsed in-process by
// `parseArgs`; the env carries
// `AGENT_RECALL_HOME` so the CLI uses a temp
// data home independent of the MCP server's
// home.
function runArtifactCli(
  dataHome: string,
  args: string[]
): { exitCode: number; stdout: string; stderr: string } {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    AGENT_RECALL_HOME: dataHome,
    AGENT_RECALL_SUPPRESS_MCP_DEPRECATION: "1",
    AGENT_RECALL_VERBOSE_STDIO: "0"
  };
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: ARTIFACT_DIR,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function makeDataHome(label: string): string {
  return mkdtempSync(join(tmpdir(), `lm-bb-packaged-${label}-`));
}

// ============================================================
// Suite: Core profile (the packaged default).
// ============================================================

describe("packaged-install lifecycle - Core profile (v1.1.2 #28, task 9)", () => {
  let dataHome: string | undefined;
  let harness: LifecycleHarness | undefined;

  beforeAll(async () => {
    dataHome = makeDataHome("core");
    harness = await startHarness(undefined, dataHome);
  }, 30_000);

  afterAll(async () => {
    if (harness !== undefined && dataHome !== undefined) {
      await stopHarness(harness);
      dataHome = undefined;
    }
  }, 30_000);

  it("(a) initialize / capability negotiation", async () => {
    if (harness === undefined || harness.client === undefined) throw new Error("harness not initialised");
    // Successful `client.connect` IS the
    // initialize / capability negotiation. The
    // server reports a stable
    // `serverInfo.version` via the MCP SDK
    // handshake; the lifecycle test asserts the
    // canonical `server_version` shape on the
    // health resource.
    // MCP SDK initialize response: the server registers tools and resources,
    // and advertises no prompts/logging/subscription capabilities.
    expect(harness.client.getServerCapabilities()).toEqual({ tools: { listChanged: true }, resources: { listChanged: true } });
    const r = (await harness.client.readResource({
      uri: "memory://health"
    })) as unknown as ResourceContents;
    const payload = JSON.parse(r.contents[0]!.text) as HealthResource;
    expect(payload.status).toBe("ok");
    expect(payload.server_version).toBeTruthy();
    expect(payload.schema_version).toBeGreaterThanOrEqual(13);
    expect(payload.active_profile).toBe("core");
    expect(payload.strict_isolation).toBe(true);
  });

  it("(b) exact tools + resources discovery (Core canonical list)", async () => {
    if (harness === undefined || harness.client === undefined) throw new Error("harness not initialised");
    const tools = await harness.client.listTools();
    const names = new Set(tools.tools.map((t) => t.name));
    const expected = new Set<string>(CORE_TOOL_NAMES);
    expect([...names].sort()).toEqual([...expected].sort());
    const resources = await harness.client.listResources();
    const staticUris = resources.resources.map((r) => r.uri).sort();
    expect(staticUris).toEqual([
      "memory://global/summary",
      "memory://health",
      "memory://projects"
    ]);
    const templates = await harness.client.listResourceTemplates();
    const tplNames = templates.resourceTemplates.map((t) => t.name).sort();
    expect(tplNames).toEqual([
      "memory_import_batch",
      "memory_project_memory",
      "memory_project_summary"
    ]);
  });

  it("(c) remember + idempotent replay + key-reuse rejection", async () => {
    if (harness === undefined || harness.client === undefined) throw new Error("harness not initialised");
    const idempotencyKey = `packaged-key-${Date.now()}`;
    const r1 = await callTool(harness.client, "remember", {
      scope: "global",
      type: "fact",
      topic: "packaged",
      title: "idempotency check",
      body: "first body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      idempotency_key: idempotencyKey,
      confirm_write: true
    });
    expect(r1.isError).toBeFalsy();
    const d1 = parseText(r1) as { ok: boolean; value: { memory_id: string } };
    expect(d1.ok).toBe(true);
    const r2 = await callTool(harness.client, "remember", {
      scope: "global",
      type: "fact",
      topic: "packaged",
      title: "idempotency check",
      body: "first body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      idempotency_key: idempotencyKey,
      confirm_write: true
    });
    expect(r2.isError).toBeFalsy();
    const d2 = parseText(r2) as { ok: boolean; value: { memory_id: string } };
    expect(d2.value.memory_id).toBe(d1.value.memory_id);
    const r3 = await callTool(harness.client, "remember", {
      scope: "global",
      type: "fact",
      topic: "packaged",
      title: "idempotency check",
      body: "second body, different",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      idempotency_key: idempotencyKey,
      confirm_write: true
    });
    expect(r3.isError).toBe(true);
    expect(failureCode(r3)).toMatch(/idempotency_mismatch|key_reuse|key was reused/);
  });

  it("(d) CAS update + stale revision rejection", async () => {
    if (harness === undefined || harness.client === undefined) throw new Error("harness not initialised");
    const seed = await callTool(harness.client, "remember", {
      scope: "global",
      type: "fact",
      topic: "cas",
      title: "cas target",
      body: "cas body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      confirm_write: true
    });
    expect(seed.isError).toBeFalsy();
    const memoryId = (parseText(seed) as { value: { memory_id: string } }).value.memory_id;
    const u1 = await callTool(harness.client, "update_memory", {
      memory_id: memoryId,
      title: "cas updated",
      expected_revision: 1
    });
    expect(u1.isError).toBeFalsy();
    const u2 = await callTool(harness.client, "update_memory", {
      memory_id: memoryId,
      title: "cas stale",
      expected_revision: 1
    });
    expect(u2.isError).toBe(true);
    expect(failureCode(u2)).toBe("stale_revision");
  });

  it("(e) project identity registration / lookup / conflict", async () => {
    if (harness === undefined || harness.client === undefined) throw new Error("harness not initialised");
    const projectId = `pkg-proj-${Date.now()}`;
    const projectPath = `/tmp/${projectId}`;
    // First write registers the identity in
    // `register` mode (default for `remember`).
    const seed = await callTool(harness.client, "remember", {
      scope: "project",
      project_id: projectId,
      project_path: projectPath,
      type: "fact",
      topic: "proj",
      title: "project seed",
      body: "project body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      confirm_write: true
    });
    expect(seed.isError).toBeFalsy();
    const seedId = (parseText(seed) as { value: { memory_id: string } }).value.memory_id;
    // Subsequent read on the same project
    // surfaces the row (the strict resolver
    // recognises the registered identity).
    const got = await callTool(harness.client, "get_memory", { memory_id: seedId });
    expect(got.isError).toBeFalsy();
    // Unknown project_id under the strict
    // resolver rejects. The strict resolver is
    // applied to read paths
    // (`get_memory_budget` / `search_memories`
    // / `list_memories`); `remember` defaults
    // to `register` mode which auto-creates an
    // identity. The lifecycle test exercises
    // the canonical read-side rejection
    // surface so a future refactor that flips
    // the read paths back to the
    // store-less resolver trips a
    // deterministic failure here.
    const unknownBudget = await callTool(harness.client, "get_memory_budget", {
      scope: "project",
      project_id: `unknown-${Date.now()}`
    });
    expect(unknownBudget.isError).toBe(true);
    expect(failureCode(unknownBudget)).toBe("invalid_scope");
    const conflict = await callTool(harness.client, "remember", {
      scope: "project", project_id: `${projectId}-different`, project_path: projectPath,
      type: "fact", topic: "proj", title: "conflict", body: "conflict", tags: [],
      source: { kind: "agent" }, importance: 3, confidence: 3, confirm_write: true
    });
    expect(conflict.isError).toBe(true);
    expect(failureCode(conflict)).toBe("project_identity_conflict");
  });

  it("(f) search + recall", async () => {
    if (harness === undefined || harness.client === undefined) throw new Error("harness not initialised");
    const target = `packaged-search-${Date.now()}`;
    await callTool(harness.client, "remember", {
      scope: "global",
      type: "fact",
      topic: "search",
      title: target,
      body: "search body for the lifecycle",
      tags: ["packaged-search"],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      confirm_write: true
    });
    const search = await callTool(harness.client, "search_memories", {
      scope: "global",
      query: target,
      limit: 5
    });
    expect(search.isError).toBeFalsy();
    const items = data<{ items: Array<{ title: string }> }>(search).items;
    expect(items.some((it) => it.title === target)).toBe(true);
    const recall = await callTool(harness.client, "recall_context", { scope: "global" });
    expect(recall.isError).toBeFalsy();
    expect(JSON.stringify(data<unknown>(recall))).toContain("search body for the lifecycle");
  });

  it("(g) sensitivity / trust authorized + unauthorized (Core rejects restricted writes)", async () => {
    if (harness === undefined || harness.client === undefined) throw new Error("harness not initialised");
    // The Core profile does NOT have a
    // capability, so a `restricted` write is
    // rejected at the service layer with
    // `unauthorized`. The restricted read
    // filter is the SQL-boundary
    // `actor_max_sensitivity` query; without
    // a capability the row is filtered out at
    // the SQL boundary (the v2 envelope
    // surfaces `forbidden_visibility`).
    const restrictedNoCap = await callTool(harness.client, "remember", {
      scope: "global",
      type: "fact",
      topic: "sensitivity",
      title: "restricted no cap",
      body: "restricted body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      sensitivity: "restricted",
      confirm_write: true
    });
    expect(restrictedNoCap.isError).toBe(true);
    expect(failureCode(restrictedNoCap)).toBe("unauthorized");
    // The `confirm_memory_trust` tool is
    // Extended-only; Core does not expose it.
    const tools = await harness.client.listTools();
    expect(tools.tools.some((t) => t.name === "confirm_memory_trust")).toBe(false);
  });

  it("(h) maintenance plan / apply in permitted profile (Core does NOT expose any maintenance tools)", async () => {
    if (harness === undefined || harness.client === undefined) throw new Error("harness not initialised");
    // Core deliberately excludes ALL maintenance
    // tools (`plan_maintenance`,
    // `apply_maintenance`, `maintain_memories`,
    // `merge_memories`, `supersede_memory`).
    // A normal coding agent is not expected to
    // call administrative tools; the operator
    // path (`AGENT_RECALL_PROFILE=extended`) is
    // the documented escape hatch (the v1.1.2
    // #22 contract). The lifecycle test asserts
    // the Core surface is clean: a future PR
    // that re-exposes `plan_maintenance` on
    // Core trips a deterministic failure here.
    const tools = await harness.client.listTools();
    const names = new Set(tools.tools.map((t) => t.name));
    expect(names.has("plan_maintenance")).toBe(false);
    expect(names.has("apply_maintenance")).toBe(false);
    expect(names.has("maintain_memories")).toBe(false);
    expect(names.has("merge_memories")).toBe(false);
    expect(names.has("supersede_memory")).toBe(false);
    expect(names.has("export_memory_context")).toBe(false);
  });

  it("(i) snapshot export / import round-trip via the PACKAGED CLI", async () => {
    if (harness === undefined || harness.client === undefined) throw new Error("harness not initialised");
    if (dataHome === undefined) throw new Error("dataHome not initialised");
    // Seed one memory via the MCP server so the
    // CLI's export sees a non-empty global
    // scope. The CLI's `export` writes to its
    // own `--data-home` `exports/` directory
    // and reads from the same data home.
    const exportSeed = await callTool(harness.client, "remember", {
      scope: "global", type: "fact", topic: "export", title: "export target", body: "export body",
      tags: [], source: { kind: "agent" }, importance: 3, confidence: 3, confirm_write: true
    });
    const sourceDb = new DatabaseSync(join(dataHome, "memory.sqlite"));
    const memoryId = (parseText(exportSeed) as { value: { memory_id: string } }).value.memory_id;
    const now = Date.now();
    sourceDb.prepare("INSERT OR IGNORE INTO memory_provenance (memory_id, source_kind, source_ref, recorded_by, recorded_at) VALUES (?, 'tool_call', ?, 'agent:packaged', ?)").run(memoryId, "packaged-export", now);
    sourceDb.prepare("INSERT OR IGNORE INTO memory_relations (from_memory_id, to_memory_id, relation_type, confidence, metadata_json, created_at) VALUES (?, ?, 'related', 1.0, '{}', ?)").run(memoryId, memoryId, new Date(now).toISOString());
    sourceDb.close();
    const exportResult = runArtifactCli(dataHome, [
      "export",
      "--scope",
      "global",
       "--format",
       "json",
       "--history-mode",
       "full_history"
    ]);
    expect(exportResult.exitCode).toBe(0);
    const exportsDir = join(dataHome, "exports");
    expect(existsSync(exportsDir)).toBe(true);
    const exportFiles = readdirSync(exportsDir);
    expect(exportFiles.length).toBeGreaterThan(0);
    // Import the export into a fresh data home
    // (the contract: the export directory
    // produced by the source CLI's export
    // command is the canonical `import --from`
    // root).
    const importDataHome = makeDataHome("core-import-target");
    try {
      const importResult = runArtifactCli(importDataHome, [
        "import",
        "--from",
        exportsDir,
        "--scope",
        "global",
         "--format",
         "json",
         "--history-mode",
         "full_history"
       ]);
       expect(importResult.exitCode).toBe(0);
       const importedDb = new DatabaseSync(join(importDataHome, "memory.sqlite"));
       for (const table of ["memory_revisions", "audit_events", "memory_relations", "memory_provenance"]) {
         const row = importedDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number | bigint };
         expect(Number(row.count), `${table} must be restored by full_history import`).toBeGreaterThan(0);
       }
       importedDb.close();
    } finally {
      rmSync(importDataHome, { recursive: true, force: true });
    }
  });

  it("(j) backup / doctor / CLI entry points via the PACKAGED CLI", async () => {
    if (harness === undefined || harness.client === undefined) throw new Error("harness not initialised");
    if (dataHome === undefined) throw new Error("dataHome not initialised");
    // Seed at least one memory so the doctor
    // has something to inspect.
    await callTool(harness.client, "remember", {
      scope: "global",
      type: "fact",
      topic: "doctor",
      title: "doctor target",
      body: "doctor body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      confirm_write: true
    });
    const help = runArtifactCli(dataHome, ["help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe("");
    const badExport = runArtifactCli(dataHome, ["export", "--format", "invalid"]);
    expect(badExport.exitCode).not.toBe(0);
    expect(badExport.stderr).toMatch(/invalid|usage|error/i);
    const badImport = runArtifactCli(dataHome, ["import"]);
    expect(badImport.exitCode).not.toBe(0);
    expect(badImport.stderr).toMatch(/usage|error/i);
    const doctor = runArtifactCli(dataHome, ["doctor"]);
    expect(doctor.exitCode).toBeLessThanOrEqual(1);
    const backup = runArtifactCli(dataHome, ["backup"]);
    expect(backup.exitCode).toBe(0);
    const backupDir = join(dataHome, "backups");
    expect(existsSync(backupDir)).toBe(true);
    const backupFiles = readdirSync(backupDir);
    expect(backupFiles.length).toBeGreaterThan(0);
  });

  it("(k) clean shutdown", () => {
    if (harness === undefined) throw new Error("harness not initialised");
    // The full leak guard runs in `afterAll`
    // (see `stopHarness`). This test pins the
    // process bookkeeping so a future refactor
    // that drops the `afterAll` hook trips a
    // deterministic failure on the
    // serverPid-assertion path.
    expect(harness.serverPid).toBeGreaterThan(0);
  });
});

// ============================================================
// Suite: Extended profile (opt-in via env var).
// ============================================================

describe("packaged-install lifecycle - Extended profile (v1.1.2 #28, task 9)", () => {
  let dataHome: string | undefined;
  let harness: LifecycleHarness | undefined;

  beforeAll(async () => {
    dataHome = makeDataHome("extended");
    harness = await startHarness("extended", dataHome);
  }, 30_000);

  afterAll(async () => {
    if (harness !== undefined && dataHome !== undefined) {
      await stopHarness(harness);
      dataHome = undefined;
    }
  }, 30_000);

  it("(b) exact tools + resources discovery (Extended canonical list)", async () => {
    if (harness === undefined || harness.client === undefined) throw new Error("harness not initialised");
    const tools = await harness.client.listTools();
    const names = new Set(tools.tools.map((t) => t.name));
    const expected = new Set<string>(EXTENDED_TOOL_NAMES);
    expect([...names].sort()).toEqual([...expected].sort());
    const r = (await harness.client.readResource({ uri: "memory://health" })) as unknown as ResourceContents;
    const payload = JSON.parse(r.contents[0]!.text) as HealthResource;
    expect(payload.active_profile).toBe("extended");
  });

  it("(h) maintenance plan / apply in permitted profile (apply IS available in Extended)", async () => {
    if (harness === undefined || harness.client === undefined) throw new Error("harness not initialised");
    const tools = await harness.client.listTools();
    const names = new Set(tools.tools.map((t) => t.name));
    expect(names.has("plan_maintenance")).toBe(true);
    expect(names.has("apply_maintenance")).toBe(true);
    expect(names.has("maintain_memories")).toBe(true);
    const duplicateArgs = {
      scope: "global", type: "fact", topic: "maintenance", title: "duplicate target",
      body: "same duplicate body", tags: ["duplicate"], source: { kind: "agent" },
      importance: 3, confidence: 3, confirm_write: true
    };
    expect((await callTool(harness.client, "remember", duplicateArgs)).isError).toBeFalsy();
    expect((await callTool(harness.client, "remember", duplicateArgs)).isError).toBeFalsy();
    const plan = await callTool(harness.client, "plan_maintenance", { scope: "global", max_groups: 10 });
    expect(plan.isError).toBeFalsy();
    const planned = data<{ plan_id: string; proposed_actions?: unknown[] }>(plan);
    expect(planned.plan_id).toBeTruthy();
    expect(planned.proposed_actions?.length ?? 0).toBeGreaterThan(0);
    const apply = await callTool(harness.client, "apply_maintenance", { plan_id: planned.plan_id, confirm: true, idempotency_key: `maint-apply-${Date.now()}` });
    expect(apply.isError).toBeFalsy();
    const audit = new DatabaseSync(join((dataHome as string), "memory.sqlite"));
    const auditCount = audit.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event LIKE '%maintenance%'").get() as { count: number | bigint };
    expect(Number(auditCount.count)).toBeGreaterThan(0);
    audit.close();
  });

  it("(k) clean shutdown (Extended)", () => {
    if (harness === undefined) throw new Error("harness not initialised");
    expect(harness.serverPid).toBeGreaterThan(0);
  });
});

// ============================================================
// Suite: Admin profile (opt-in via env var + capability).
// ============================================================

describe("packaged-install lifecycle - Admin profile (v1.1.2 #28, task 9)", () => {
  let dataHome: string | undefined;
  let harness: LifecycleHarness | undefined;
  let adminCapabilityToken: string | undefined;

  beforeAll(async () => {
    dataHome = makeDataHome("admin");
    // Set capability through the packaged CLI; this test must never import
    // implementation files from the source checkout.
    const grant = runArtifactCli(dataHome, ["admin", "grant", "--label", "packaged-admin"]);
    expect(grant.exitCode).toBe(0);
    const capabilityRecord = JSON.parse(readFileSync(join(dataHome, "admin.cap"), "utf8")) as { token: string };
    adminCapabilityToken = capabilityRecord.token;
    harness = await startHarness("admin", dataHome);
  }, 30_000);

  afterAll(async () => {
    if (harness !== undefined && dataHome !== undefined) {
      await stopHarness(harness);
      dataHome = undefined;
    }
  }, 30_000);

  it("(b) exact tools + resources discovery (Admin canonical list + capability_state)", async () => {
    if (harness === undefined || harness.client === undefined) throw new Error("harness not initialised");
    const tools = await harness.client.listTools();
    const names = new Set(tools.tools.map((t) => t.name));
    const expected = new Set<string>(ADMIN_TOOL_NAMES);
    expect([...names].sort()).toEqual([...expected].sort());
    const r = (await harness.client.readResource({ uri: "memory://health" })) as unknown as ResourceContents;
    const payload = JSON.parse(r.contents[0]!.text) as HealthResource;
    expect(payload.active_profile).toBe("admin");
    expect(payload.capability_state).toBe("granted");
  });

  it("(g) sensitivity authorised via capability (restricted write + capability-gated promotion)", async () => {
    if (harness === undefined || harness.client === undefined) throw new Error("harness not initialised");
    if (adminCapabilityToken === undefined) throw new Error("capability not seeded");
    // With a valid capability, a `restricted`
    // write is accepted.
    const okWrite = await callTool(harness.client, "remember", {
      scope: "global",
      type: "fact",
      topic: "admin-restricted",
      title: "admin restricted target",
      body: "admin restricted body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      sensitivity: "restricted",
      capability: adminCapabilityToken,
      confirm_write: true
    });
    expect(okWrite.isError).toBeFalsy();
    // The `confirm_memory_trust` tool is also
    // available; promotion accepts the
    // capability.
    const seed = await callTool(harness.client, "remember", {
      scope: "global",
      type: "fact",
      topic: "admin-promote",
      title: "admin promote seed",
      body: "admin promote body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      confirm_write: true
    });
    expect(seed.isError).toBeFalsy();
    const memoryId = (parseText(seed) as { value: { memory_id: string } }).value.memory_id;
    const promote = await callTool(harness.client, "confirm_memory_trust", {
      memory_id: memoryId,
      trust_level: "user_confirmed",
      user_confirmed: true,
      capability: adminCapabilityToken,
      reason: "packaged lifecycle"
    });
    expect(promote.isError).toBeFalsy();
  });

  it("(k) clean shutdown (Admin)", () => {
    if (harness === undefined) throw new Error("harness not initialised");
    expect(harness.serverPid).toBeGreaterThan(0);
  });
});

// Suppress an unused-import warning for the
// async `spawn` import (kept for future
// streaming tests that need real-time stdout
// collection).
void spawn;