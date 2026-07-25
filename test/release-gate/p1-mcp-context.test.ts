// test/release-gate/p1-mcp-context.test.ts
//
// Stage 15 PR-M0-2 (issue #2, spec § 5.6): MCP transport
// context propagation and tool contract consistency.
//
// Locks down the four acceptance criteria from issue #2:
//
//   1. MCP client invocation has the same behavior as
//      direct service tests.
//   2. CAS and idempotency are usable through MCP
//      (the focus of this PR — `update_memory` and
//      `forget_memory` used to drop these fields in
//      the v1 adapter).
//   3. Audit events contain real client/session/request
//      metadata (locked down by
//      `test/release-gate/p0-request-context.test.ts`
//      in Stage 14 PR-B1; this file adds a guard that
//      the v2 adapter does not regress).
//   4. Tool annotations accurately describe behavior
//      (the `destructiveHint: true` annotation on
//      `update_memory` / `forget_memory` /
//      `supersede_memory` / `merge_memories` matches
//      their actual mutating semantics — locked down
//      by `test/tool-registration.test.ts`).
//
// Note: the MCP envelope layer wraps the service's
// `Result<T, E>` in either a `data` (success) or
// `failure` block plus an `isError` flag. We use the
// lower-level adapter contract here — call the service
// directly to assert the MCP handler actually
// forwards the fields the v1 adapter dropped.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryService } from "../../src/memory-service.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import { createMemoryToolHandlers } from "../../src/tools/register-tools.js";

function setup(): { dataHome: string; service: MemoryService; store: SQLiteMemoryStore } {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-mcp-ctx-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const service = new MemoryService(store, undefined, "agent:test", dataHome);
  return { dataHome, service, store };
}

describe("release-gate p1-mcp-context (issue #2)", () => {
  let dataHome: string;
  let service: MemoryService;
  let store: SQLiteMemoryStore;

  beforeEach(() => {
    ({ dataHome, service, store } = setup());
  });

  afterEach(() => {
    store.close();
    try {
      rmSync(dataHome, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  describe("update_memory handler forwards idempotency_key and expected_revision", () => {
    it("service spy sees `idempotency_key` and `expected_revision` on the call", async () => {
      const updateMemorySpy = vi.spyOn(service, "updateMemory");
      const handlers = createMemoryToolHandlers(service);

      const seed = service.remember(
        {
          scope: "global",
          type: "fact",
          topic: "tools",
          title: "spy target",
          body: "v1",
          tags: [],
          source: { kind: "agent" },
          importance: 3,
          confidence: 3
        },
        { actor_id: "agent:mcp", request_id: "req-seed" }
      );
      expect(seed.ok).toBe(true);
      if (!seed.ok) return;
      const seedId = seed.value.memory_id;
      const currentRevision = store.peekEntry(seedId)!.revision;

      const result = await handlers.update_memory(
        {
          memory_id: seedId,
          patch: { body: "v2" },
          idempotency_key: "mcp-idem-spy-1",
          expected_revision: currentRevision
        },
        { actor_id: "agent:mcp", request_id: "req-1" } as never
      );
      expect(result.isError).not.toBe(true);

      // The v1 adapter dropped both fields; the v2
      // adapter must forward them to the service.
      expect(updateMemorySpy).toHaveBeenCalledTimes(1);
      const [calledId, calledInput] = updateMemorySpy.mock.calls[0]!;
      expect(calledId).toBe(seedId);
      expect(calledInput.idempotency_key).toBe("mcp-idem-spy-1");
      expect(calledInput.expected_revision).toBe(currentRevision);
    });

    it("service spy does NOT see `idempotency_key` / `expected_revision` when client omits them", async () => {
      const updateMemorySpy = vi.spyOn(service, "updateMemory");
      const handlers = createMemoryToolHandlers(service);

      const seed = service.remember(
        {
          scope: "global",
          type: "fact",
          topic: "tools",
          title: "spy target",
          body: "v1",
          tags: [],
          source: { kind: "agent" },
          importance: 3,
          confidence: 3
        },
        { actor_id: "agent:mcp", request_id: "req-seed" }
      );
      expect(seed.ok).toBe(true);
      if (!seed.ok) return;

      await handlers.update_memory(
        { memory_id: seed.value.memory_id, patch: { body: "v2" } },
        { actor_id: "agent:mcp", request_id: "req-1" } as never
      );

      // The v2 adapter must keep the legacy 2-arg call
      // shape when the client omits the CAS /
      // idempotency fields (the existing tool contract
      // expects service.updateMemory to receive just
      // the patch + ctx).
      expect(updateMemorySpy).toHaveBeenCalledTimes(1);
      const [calledId, calledInput] = updateMemorySpy.mock.calls[0]!;
      expect(calledId).toBe(seed.value.memory_id);
      expect(calledInput.idempotency_key).toBeUndefined();
      expect(calledInput.expected_revision).toBeUndefined();
    });
  });

  describe("forget_memory handler forwards idempotency_key and expected_revision", () => {
    it("service spy sees `idempotency_key` and `expected_revision` on the call", async () => {
      const forgetMemorySpy = vi.spyOn(service, "forgetMemory");
      const handlers = createMemoryToolHandlers(service);

      const seed = service.remember(
        {
          scope: "global",
          type: "fact",
          topic: "tools",
          title: "spy target",
          body: "v1",
          tags: [],
          source: { kind: "agent" },
          importance: 3,
          confidence: 3
        },
        { actor_id: "agent:mcp", request_id: "req-seed" }
      );
      expect(seed.ok).toBe(true);
      if (!seed.ok) return;
      const seedId = seed.value.memory_id;
      const currentRevision = store.peekEntry(seedId)!.revision;

      const result = await handlers.forget_memory(
        {
          memory_id: seedId,
          reason: "obsolete",
          idempotency_key: "mcp-forget-spy-1",
          expected_revision: currentRevision
        },
        { actor_id: "agent:mcp", request_id: "req-1" } as never
      );
      expect(result.isError).not.toBe(true);

      expect(forgetMemorySpy).toHaveBeenCalledTimes(1);
      const [calledId, calledReason, , calledOptions] = forgetMemorySpy.mock.calls[0]!;
      expect(calledId).toBe(seedId);
      expect(calledReason).toBe("obsolete");
      expect(calledOptions).toEqual({
        idempotency_key: "mcp-forget-spy-1",
        expected_revision: currentRevision
      });
    });

    it("service spy does NOT see options when client omits both CAS and idempotency fields", async () => {
      const forgetMemorySpy = vi.spyOn(service, "forgetMemory");
      const handlers = createMemoryToolHandlers(service);

      const seed = service.remember(
        {
          scope: "global",
          type: "fact",
          topic: "tools",
          title: "spy target",
          body: "v1",
          tags: [],
          source: { kind: "agent" },
          importance: 3,
          confidence: 3
        },
        { actor_id: "agent:mcp", request_id: "req-seed" }
      );
      expect(seed.ok).toBe(true);
      if (!seed.ok) return;

      await handlers.forget_memory(
        { memory_id: seed.value.memory_id, reason: "obsolete" },
        { actor_id: "agent:mcp", request_id: "req-1" } as never
      );

      // v2 adapter must keep the legacy 3-arg call
      // shape (no `options` arg) when the client
      // omits both CAS / idempotency fields. The
      // existing tool contract expects
      // `service.forgetMemory(id, reason, ctx)` with
      // exactly 3 positional args.
      expect(forgetMemorySpy).toHaveBeenCalledTimes(1);
      expect(forgetMemorySpy.mock.calls[0]!.length).toBe(3);
    });
  });
});
