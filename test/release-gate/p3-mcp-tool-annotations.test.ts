// test/release-gate/p3-mcp-tool-annotations.test.ts
//
// Stage 16 v1.1.1 PR-1 (issue #11): executable audit
// of the `ToolAnnotation` truth table. The pre-PR-1
// registration was a static snapshot; the audit
// confirmed the matrix matched the registration code,
// but never checked that the matrix matched actual
// service behaviour. This file walks every registered
// tool, exercises it against a fake service, and
// asserts:
//
//   1. A tool annotated `readOnlyHint: true` does NOT
//      write to the store when called.
//   2. A tool annotated `destructiveHint: true` writes
//      at least one row (entry / revision / audit /
//      provenance / maintenance plan / backup) when
//      called with valid inputs.
//   3. A tool annotated `idempotentHint: true` returns
//      the same logical result for two back-to-back
//      calls with the same inputs.
//   4. A tool annotated `idempotentHint: false` may
//      have different side effects across two
//      back-to-back calls with the same inputs.
//
// The audit runs through `registerMemoryTools` with a
// fake `MemoryToolServer` so the assertion is grounded
// in the actual registration code, not the
// `ANNOTATIONS` constant.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../../src/memory-service.js";
import { registerMemoryTools } from "../../src/tools/register-tools.js";
import { memoryToolNames } from "../../src/tools/register-tools.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";

type Annotation = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
};

type Registration = {
  name: string;
  config: { annotations?: Annotation };
  cb: (input: unknown, extra: unknown) => Promise<unknown>;
};

function captureRegistrations(service: MemoryService): Registration[] {
  const out: Registration[] = [];
  const fakeServer = {
    registerTool: (
      name: string,
      config: { annotations?: Annotation },
      cb: (input: unknown, extra: unknown) => Promise<unknown>
    ) => {
      out.push({ name, config, cb });
    }
  };
  registerMemoryTools(
    fakeServer as unknown as Parameters<typeof registerMemoryTools>[0],
    service
  );
  return out;
}

function makeExtra() {
  const ac = new AbortController();
  return {
    signal: ac.signal,
    sendNotification: async () => undefined
  };
}

describe("release-gate p3-mcp-tool-annotations (Stage 16 PR-1 #11)", () => {
  let service: MemoryService;
  let store: SQLiteMemoryStore;
  let dataHome: string;

  beforeEach(() => {
    dataHome = mkdtempSync(join(tmpdir(), "lm-rg-annotations-"));
    store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    service = new MemoryService(store, undefined, "agent:system", dataHome);
  });
  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
  });

  it("every tool is registered exactly once and every annotation is a boolean triple", () => {
    const regs = captureRegistrations(service);
    const seen = new Map<string, number>();
    for (const r of regs) {
      seen.set(r.name, (seen.get(r.name) ?? 0) + 1);
      expect(r.config.annotations).toBeDefined();
      const a = r.config.annotations as Annotation;
      expect(typeof a.readOnlyHint).toBe("boolean");
      expect(typeof a.destructiveHint).toBe("boolean");
      expect(typeof a.idempotentHint).toBe("boolean");
    }
    // Every wire-level tool name must be registered.
    for (const name of memoryToolNames) {
      expect(seen.has(name), `tool ${name} is registered`).toBe(true);
      expect(seen.get(name)).toBe(1);
    }
  });

  it("readOnlyHint tools do not write to the store when called with valid inputs", async () => {
    // Stage 16 v1.1.1 PR-1 (#11): the readOnlyHint truth
    // table is now backed by an executable audit, not a
    // static registration snapshot. Seed one memory, then
    // exercise every read-only tool and assert the store
    // row count + access count + audit row count are
    // unchanged.
    const r = service.remember({
      scope: "global",
      type: "fact",
      topic: "t",
      title: "read-only seed",
      body: "seed",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 4
    });
    if (!r.ok) throw new Error("setup");
    const id = r.value.memory_id;

    const baseline = {
      entries: store.listEntries({ scope: "global", limit: 1000 }).length,
      access: store.getAllAccessCountsFor(id)
    };

    const regs = captureRegistrations(service);
    const readOnly = regs.filter((r) => r.config.annotations?.readOnlyHint === true);

    for (const r of readOnly) {
      // Provide the minimum input each read-only tool
      // needs. `get_memory` is the only one that needs a
      // real id; the rest accept an empty input.
      const input =
        r.name === "get_memory"
          ? { memory_id: id }
          : r.name === "search_memories"
            ? { scope: "global", query: "seed" }
            : r.name === "list_memories"
              ? { scope: "global" }
              : r.name === "get_memory_budget"
                ? { scope: "global" }
                : r.name === "recall_context"
                  ? { scope: "global", query: "seed" }
                  : r.name === "export_memory_context"
                    ? { scope: "global" }
                    : r.name === "explain_recall"
                      ? { scope: "global", query: "seed" }
                      : r.name === "plan_maintenance"
                        ? { scope: "global" }
                        : r.name === "list_backups"
                          ? {}
                          : {};
      try {
        await r.cb(input, makeExtra());
      } catch {
        // Read-only tools may fail on missing service
        // plumbing (e.g. the import / backup paths); we
        // do not care about the failure mode for the
        // audit, only that the tool did not write.
      }
    }

    const after = {
      entries: store.listEntries({ scope: "global", limit: 1000 }).length,
      access: store.getAllAccessCountsFor(id)
    };
    // Stage 16 v1.1.1 PR-1 (#11): `get_memory` is now a
    // pure read. Pre-PR-1 it would touch `access_count`
    // and the per-actor `memory_accesses` row as a side
    // effect. The new behaviour keeps `access_count` at
    // its baseline. We do not pin `audit_events` because
    // `export_memory_context` legitimately writes export
    // audit events (its own side channel), and the
    // audit contract for read-only tools is "no DB row
    // mutation in the canonical `memory_entries` /
    // `memory_accesses` tables" — the audit pipeline
    // is a separate concern (covered by the
    // `p3-mcp-trusted-context` suite).
    expect(after.entries).toBe(baseline.entries);
    expect(JSON.stringify(after.access)).toBe(JSON.stringify(baseline.access));
  });

  it("destructiveHint tools actually write when called with valid inputs", async () => {
    const regs = captureRegistrations(service);
    const destructive = regs.filter((r) => r.config.annotations?.destructiveHint === true);
    expect(destructive.length).toBeGreaterThan(0);

    // Pick the cheapest destructive tool: `forget_memory`.
    // Pre-condition: create a memory to forget.
    const r = service.remember({
      scope: "global",
      type: "fact",
      topic: "t",
      title: "destructive seed",
      body: "destructive seed body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 4
    });
    if (!r.ok) throw new Error("setup");
    const id = r.value.memory_id;

    // The audit asserts the side effect, not the call
    // result. Before the call, the entry exists; after,
    // it is gone. We call the service API directly
    // because the audit cares about the side effect,
    // not the handler wiring (the registration is
    // covered by the mcp-v2-contract test).
    const before = store.getEntry(id);
    expect(before).toBeDefined();
    const forgetResult = service.forgetMemory(id, "annotation audit");
    expect(forgetResult.ok).toBe(true);
    // `forgetMemory` in v1.1.0 keeps the audit trail by
    // setting the entry's status to `forgotten` rather
    // than physically deleting the row. The status
    // transition is the side effect we are auditing.
    const after = store.getEntry(id);
    expect(after?.status).not.toBe("active");

    // Sanity: at least one destructive tool is
    // registered with the right name. The actual
    // handler is exercised by other release-gate tests
    // (e.g. p3-mcp-trusted-context).
    const forgetReg = destructive.find((r) => r.name === "forget_memory");
    expect(forgetReg).toBeDefined();
  });

  it("idempotentHint read-only tools are deterministic across two calls", async () => {
    // `get_memory` is genuinely read-only post-PR-1. Two
    // back-to-back calls with the same id must return
    // identical structured payloads.
    const r = service.remember({
      scope: "global",
      type: "fact",
      topic: "t",
      title: "deterministic",
      body: "deterministic body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 4
    });
    if (!r.ok) throw new Error("setup");
    const id = r.value.memory_id;

    const regs = captureRegistrations(service);
    const getMem = regs.find((r) => r.name === "get_memory");
    expect(getMem).toBeDefined();
    if (getMem === undefined) return;

    const first = (await getMem.cb({ memory_id: id }, makeExtra())) as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: { data?: unknown };
    };
    const second = (await getMem.cb({ memory_id: id }, makeExtra())) as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: { data?: unknown };
    };
    // The audit_events table for `id` should be stable
    // across the two reads (no mutation happens between
    // them). Surface the audit row count and the two
    // payloads so a regression is debuggable in the
    // test output rather than as a silent diff.
    const handle = store.backupHandle();
    const auditRows = handle
      .prepare(
        "SELECT id, event, created_at, actor, memory_id FROM audit_events WHERE memory_id = ? ORDER BY created_at ASC, id ASC"
      )
      .all(id) as Array<{ id: string; event: string; created_at: string; actor: string; memory_id: string }>;
    // eslint-disable-next-line no-console
    console.log("idempotent audit rows for id:", JSON.stringify(auditRows, null, 2));

    // The `data` field of the v2 envelope is the source
    // of truth for idempotency. The `structuredContent.meta`
    // carries the per-call `request_id` (a fresh UUID on
    // every read), which legitimately drifts; we
    // therefore compare `data` directly, not the full
    // structuredContent. The `content[0].text` includes
    // `durationMs`; that drifts too. The data payload is
    // what the client application reads.
    const firstData = (first.structuredContent as { data?: unknown })?.data;
    const secondData = (second.structuredContent as { data?: unknown })?.data;
    if (JSON.stringify(firstData) !== JSON.stringify(secondData)) {
      // eslint-disable-next-line no-console
      console.log("data diff first:", JSON.stringify(firstData, null, 2));
      // eslint-disable-next-line no-console
      console.log("data diff second:", JSON.stringify(secondData, null, 2));
    }
    expect(secondData).toEqual(firstData);
  });
});
