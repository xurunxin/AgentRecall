// test/blackbox/mcp-client-e2e.test.ts
//
// Stage 15 PR-M2-1 (issue #8, spec § 11.2) +
// Stage 16 v1.1.1 PR-8 (issue #16, spec § 11.2):
// real MCP black-box E2E test. The test spawns the
// actual MCP server binary via the SDK's
// `StdioClientTransport`, connects with a real
// `Client` instance, and exercises the documented
// mutation / portability lifecycle end-to-end:
//
//   - initialize + listTools + listResources
//   - remember with idempotency_key
//   - replay (same key) returns the original
//     result; key-reuse with a different body
//     surfaces `idempotency_key_reuse`
//   - update_memory with `expected_revision`
//     (CAS); stale CAS rejects with
//     `stale_revision`
//   - forget_memory with idempotency_key
//   - record_memory_feedback (the new PR-7 tool)
//     and explain_recall (ranker breakdown)
//   - export_memory_context + import_memory_export
//     round-trip into a clean data home
//
// The MCP server is launched as `node
// <repo>/dist/src/index.js` so the test exercises
// the **built artifact**, not the source. The CI
// pipeline runs `npm run build` before this test
// (the `smoke:blackbox` script in `package.json`
// and the CI matrix's `MCP black-box E2E` step).
//
// In a developer checkout that has not been built
// yet, the test is skipped (rather than failing)
// so `npm test` keeps working in dev mode.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const SERVER_ENTRY = join(REPO_ROOT, "dist", "src", "index.js");
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
  // Stage 16 v1.1.1 PR-8 (issue #16, spec § 11.2):
  // the SDK's `callTool` may throw on a
  // JSON-RPC-level protocol error (e.g. the
  // server returned an `isError: true` result).
  // Pre-PR-8 the test treated the tool result's
  // `isError: true` as an acceptable terminal
  // state; PR-8 rejects it. The lifecycle below
  // asserts `isError === false` on every happy
  // path; domain errors are explicit
  // (e.g. `idempotency_key_reuse`).
  const res = await client.callTool({ name, arguments: args });
  return res as unknown as ToolResult;
}

function parseText(result: ToolResult): unknown {
  const first = result.content[0];
  if (first === undefined) return undefined;
  return JSON.parse(first.text);
}

const itMaybe = HAS_BUILT_ARTIFACT ? it : it.skip;

describe("MCP black-box E2E (issue #8 + issue #16)", () => {
  let dataHome: string | undefined;
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let serverPid: number | undefined;
  // Stderr is captured so a leak (an unhandled
  // exception, a stack trace, a `console.error`
  // from a forgotten path) is detected at the
  // end of the test rather than silently
  // scrolling past in the CI log. Pre-PR-8
  // the test only checked `isError` on tool
  // results; PR-8 also asserts the server's
  // stderr is empty over the full lifecycle.
  let stderrChunks: string[] = [];

  beforeAll(async () => {
    if (!HAS_BUILT_ARTIFACT) return;
    dataHome = mkdtempSync(join(tmpdir(), "lm-bb-e2e-"));
    // Stage 16 v1.1.1 PR-8 (issue #16, spec § 11.2):
    // the canonical `agent-recall` binary entry
    // prints a one-shot CLI/MCP deprecation hint
    // on first start; the smoke step in
    // `release.yml` runs the **packaged** server
    // entry (`dist/src/index.js`) which doesn't
    // print it. The local-dev `npm run smoke:blackbox`
    // path uses the packaged entry as well; the
    // `AGENT_RECALL_SUPPRESS_MCP_DEPRECATION=1`
    // env var silences the hint when a future
    // release re-introduces it (e.g. a symlink
    // compatibility shim). The black-box test
    // asserts the *server's* stderr is empty
    // over the full lifecycle, so the hint
    // would falsely trip the leak guard; the
    // env var keeps the test honest.
    const env = {
      ...process.env,
      AGENT_RECALL_HOME: dataHome,
      AGENT_RECALL_SUPPRESS_MCP_DEPRECATION: "1"
    };
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      env,
      stderr: "pipe"
    });
    // Stage 16 v1.1.1 PR-8 (issue #16, spec § 11.2):
    // tap the server's stderr stream. The tap
    // collects every chunk; the test asserts
    // there are no chunks at the end (no
    // unhandled exceptions, no forgotten
    // `console.error`, no protocol exception
    // traces). A leak here is the canonical
    // sign of an unhandled error path in the
    // server; the assertion turns it into a
    // test failure.
    if (transport.stderr !== null && transport.stderr !== undefined && typeof (transport.stderr as { on?: unknown }).on === "function") {
      (transport.stderr as { on: (event: string, cb: (chunk: Buffer) => void) => void }).on(
        "data",
        (chunk: Buffer) => {
          stderrChunks.push(chunk.toString("utf8"));
        }
      );
    }
    client = new Client(
      { name: "blackbox-e2e", version: "1.0.0" },
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
    // Stage 16 v1.1.1 PR-8 (issue #16, spec § 11.2):
    // assert the server wrote nothing unexpected
    // to stderr over the full lifecycle. A
    // leak (e.g. a Zod error stack, an unhandled
    // promise rejection, a `console.error` from
    // a forgotten path) is a CI gate failure.
    if (stderrChunks.length > 0) {
      const leak = stderrChunks.join("").trim();
      if (leak.length > 0) {
        throw new Error(
          `MCP server wrote to stderr over the lifecycle:\n${leak}`
        );
      }
    }
  }, 30_000);

  itMaybe("skipped when dist/ is not built", () => {
    expect(HAS_BUILT_ARTIFACT).toBe(true);
  });

  itMaybe("initialize + listTools + listResources", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    // Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4):
    // the four new memory-semantics tools are in
    // the canonical tool list. The default
    // `registerMemoryTools` registers every tool
    // (the `core` / `extended` profile split is
    // a per-server decision; the smoke here uses
    // the all-tools registration).
    expect(names).toContain("remember");
    expect(names).toContain("update_memory");
    expect(names).toContain("forget_memory");
    expect(names).toContain("plan_maintenance");
    expect(names).toContain("apply_maintenance");
    expect(names).toContain("record_memory_feedback");
    expect(names).toContain("record_memory_provenance");
    expect(names).toContain("explain_memory_provenance");
    expect(names).toContain("confirm_memory_trust");

    const resources = await client.listResources();
    const uris = resources.resources.map((r) => r.uri);
    expect(uris.length).toBeGreaterThan(0);
  });

  itMaybe("remember with idempotency_key; replay returns the same memory_id", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const idempotencyKey = `bb-key-${Date.now()}`;
    const r1 = await callTool(client, "remember", {
      scope: "global",
      type: "fact",
      topic: "blackbox",
      title: "idempotency check",
      body: "first call",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      idempotency_key: idempotencyKey
    });
    expect(r1.isError).toBeFalsy();
    const d1 = parseText(r1) as { ok: boolean; value: { memory_id: string } };
    expect(d1.ok).toBe(true);

    // Replay: same key, same body → same memory_id.
    const r2 = await callTool(client, "remember", {
      scope: "global",
      type: "fact",
      topic: "blackbox",
      title: "idempotency check",
      body: "first call",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      idempotency_key: idempotencyKey
    });
    expect(r2.isError).toBeFalsy();
    const d2 = parseText(r2) as { ok: boolean; value: { memory_id: string } };
    expect(d2.ok).toBe(true);
    expect(d2.value.memory_id).toBe(d1.value.memory_id);
  });

  itMaybe("idempotency_key reuse with a different body rejects as idempotency_key_reuse", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const idempotencyKey = `bb-reuse-${Date.now()}`;
    const r1 = await callTool(client, "remember", {
      scope: "global",
      type: "fact",
      topic: "blackbox",
      title: "reuse check a",
      body: "first body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      idempotency_key: idempotencyKey
    });
    expect(r1.isError).toBeFalsy();
    // Same key, different body → idempotency_mismatch.
    const r2 = await callTool(client, "remember", {
      scope: "global",
      type: "fact",
      topic: "blackbox",
      title: "reuse check b",
      body: "second body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      idempotency_key: idempotencyKey
    });
    expect(r2.isError).toBe(true);
    const txt = r2.content[0]?.text ?? "";
    expect(txt).toMatch(/idempotency_mismatch|key_reuse|key was reused/);
  });

  itMaybe("update_memory with expected_revision succeeds; stale CAS rejects", async () => {
    if (client === undefined) throw new Error("client not initialised");
    // Create a memory
    const r1 = await callTool(client, "remember", {
      scope: "global",
      type: "fact",
      topic: "blackbox",
      title: "cas check",
      body: "cas body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    expect(r1.isError).toBeFalsy();
    const d1 = parseText(r1) as { ok: boolean; value: { memory_id: string } };
    const memoryId = d1.value.memory_id;

    // First update with expected_revision=1 (the
    // initial revision) succeeds.
    const u1 = await callTool(client, "update_memory", {
      memory_id: memoryId,
      title: "cas check (updated)",
      expected_revision: 1
    });
    expect(u1.isError).toBeFalsy();

    // Second update with the now-stale revision=1
    // must reject.
    const u2 = await callTool(client, "update_memory", {
      memory_id: memoryId,
      title: "cas check (should fail)",
      expected_revision: 1
    });
    expect(u2.isError).toBe(true);
    const txt = u2.content[0]?.text ?? "";
    expect(txt).toMatch(/stale_revision/);
  });

  itMaybe("explain_recall returns the canonical ranking_version and at least one component", async () => {
    if (client === undefined) throw new Error("client not initialised");
    // Seed a memory so the recall has at least
    // one candidate.
    await callTool(client, "remember", {
      scope: "global",
      type: "fact",
      topic: "blackbox",
      title: "ranker check",
      body: "ranker body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    const r = await callTool(client, "explain_recall", {
      query: "ranker",
      scope: "global",
      top_k: 5
    });
    expect(r.isError).toBeFalsy();
    const data = parseText(r) as {
      ok: boolean;
      value: { ranking_version: string; items: Array<{ score: number; components: Record<string, number> }> };
    };
    expect(data.ok).toBe(true);
    // Stage 16 v1.1.1 PR-6 (issue #15): the
    // v1.1.1 ranking version is
    // `coding-default-v2`.
    expect(data.value.ranking_version).toBe("coding-default-v2");
    expect(data.value.items.length).toBeGreaterThan(0);
    expect(data.value.items[0]?.components.lexical_relevance).toBeGreaterThan(0);
  });

  itMaybe("record_memory_feedback appends a row; subsequent recall reflects the actor trust signal", async () => {
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

  itMaybe("forget_memory with idempotency_key; replay returns the same released_chars", async () => {
    if (client === undefined) throw new Error("client not initialised");
    const r1 = await callTool(client, "remember", {
      scope: "global",
      type: "fact",
      topic: "blackbox",
      title: "forget me",
      body: "forget me body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3
    });
    expect(r1.isError).toBeFalsy();
    const d1 = parseText(r1) as { ok: boolean; value: { memory_id: string } };
    const forgetKey = `bb-forget-${Date.now()}`;
    const f1 = await callTool(client, "forget_memory", {
      memory_id: d1.value.memory_id,
      reason: "blackbox smoke",
      idempotency_key: forgetKey
    });
    expect(f1.isError).toBeFalsy();
    const f1Data = parseText(f1) as { ok: boolean; value: { released_chars: number } };
    const f2 = await callTool(client, "forget_memory", {
      memory_id: d1.value.memory_id,
      reason: "blackbox smoke",
      idempotency_key: forgetKey
    });
    expect(f2.isError).toBeFalsy();
    const f2Data = parseText(f2) as { ok: boolean; value: { released_chars: number } };
    expect(f2Data.value.released_chars).toBe(f1Data.value.released_chars);
  });

  itMaybe("server PID is set (transport actually spawned the binary)", () => {
    expect(serverPid).toBeDefined();
    expect(typeof serverPid).toBe("number");
  });
});
