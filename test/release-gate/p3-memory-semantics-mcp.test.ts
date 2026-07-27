// test/release-gate/p3-memory-semantics-mcp.test.ts
//
// Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4): the
// memory semantics surface — controlled fields,
// authorization policy, temporal-window enforcement,
// and the four new MCP tools (`record_memory_feedback`,
// `record_memory_provenance`,
// `explain_memory_provenance`, `confirm_memory_trust`).
//
// The pre-PR-7 domain had `tier` / `pinned` /
// `valid_from` / `valid_until` / `sensitivity` /
// `trust_level` on `MemoryEntry` but the write
// service hard-coded defaults and the MCP tool
// surface did not expose them. PR-7 wires every
// controlled field through the validator, the
// service, the MCP schema, and the ranker's
// temporal-window filter. The four new tools
// round out the policy surface so a normal
// coding agent can promote trust / record
// provenance / explain the source chain /
// record feedback through MCP.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../../src/memory-service.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import type { MemoryEntry } from "../../src/domain.js";
import {
  confirmMemoryTrustToolSchema,
  recordMemoryFeedbackToolSchema,
  recordMemoryProvenanceToolSchema,
  explainMemoryProvenanceToolSchema
} from "../../src/tools/schemas.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-semantics-"));
  const dbPath = join(dataHome, "memory.sqlite");
  const store = new SQLiteMemoryStore(dbPath);
  const service = new MemoryService(store, undefined, "agent:test", dataHome);
  return { service, store, dataHome };
}

function baseRemember(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope: "global",
    type: "fact",
    topic: "tools",
    title: "tool rule",
    body: "useful tool rule",
    tags: [],
    source: { kind: "agent" },
    importance: 3,
    confidence: 3,
    ...overrides
  };
}

describe("release-gate p3-memory-semantics-mcp (issue #17, spec § 5.4)", () => {
  let service: MemoryService;
  let store: SQLiteMemoryStore;
  let dataHome: string;

  beforeEach(() => {
    ({ service, store, dataHome } = setup());
  });
  afterEach(() => {
    store.close();
    rmSync(dataHome, { recursive: true, force: true });
  });

  // -------------------------------------------------------------
  // Controlled fields through the validator
  // -------------------------------------------------------------
  it("accepts a remember with tier=core, pinned=true, valid_from, valid_until, sensitivity=normal", () => {
    const r = service.remember(
      baseRemember({
        tier: "core",
        pinned: true,
        valid_from: "2020-01-01T00:00:00.000Z",
        valid_until: "2099-12-31T00:00:00.000Z",
        sensitivity: "normal"
      }) as Parameters<MemoryService["remember"]>[0]
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const got = store.getEntry(r.value.memory_id);
    expect(got?.tier).toBe("core");
    expect(got?.pinned).toBe(true);
    expect(got?.valid_from).toBe("2020-01-01T00:00:00.000Z");
    expect(got?.valid_until).toBe("2099-12-31T00:00:00.000Z");
    expect(got?.sensitivity).toBe("normal");
  });

  it("defaults omitted fields to the documented safe values (tier=working, pinned=false, sensitivity=normal, trust=agent_observed)", () => {
    const r = service.remember(
      baseRemember() as Parameters<MemoryService["remember"]>[0]
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const got = store.getEntry(r.value.memory_id);
    expect(got?.tier).toBe("working");
    expect(got?.pinned).toBe(false);
    expect(got?.sensitivity).toBe("normal");
    expect(got?.trust_level).toBe("agent_observed");
    expect(got?.valid_from).toBeUndefined();
    expect(got?.valid_until).toBeUndefined();
  });

  it("rejects valid_from > valid_until as invalid_state", () => {
    const r = service.remember(
      baseRemember({
        valid_from: "2099-12-31T00:00:00.000Z",
        valid_until: "2020-01-01T00:00:00.000Z"
      }) as Parameters<MemoryService["remember"]>[0]
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_state");
  });

  // -------------------------------------------------------------
  // Authorization policy: user_confirmed requires the flag
  // -------------------------------------------------------------
  it("rejects trust_level=user_confirmed without an operator capability (unauthorized)", () => {
    // Stage 18 v1.1.2 (issue #23, ADR-0001): the
    // v1.1.1 `user_confirmed: true` flag is no
    // longer authorization evidence. The
    // validator no longer gates on the flag; the
    // service performs the capability check.
    // Without a capability store, the service
    // rejects the request with `unauthorized`.
    const r = service.remember(
      baseRemember({
        trust_level: "user_confirmed"
      }) as Parameters<MemoryService["remember"]>[0]
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("unauthorized");
  });

  it("rejects trust_level=user_confirmed with a malformed capability (unauthorized)", () => {
    // The service accepts the `capability` field
    // (validator extracts it) but rejects the
    // request when the token does not match the
    // on-disk store. The test here uses a
    // well-formed but unmatched token; the
    // service returns `unauthorized` with a
    // `token_mismatch` reason in the details.
    const r = service.remember(
      baseRemember({
        trust_level: "user_confirmed",
        user_confirmed: true,
        // 64 hex chars (matches the validator's
        // shape) but does NOT match any
        // capability the service knows about
        // (the test service has no
        // `CapabilityStore` installed).
        capability: "0".repeat(64)
      }) as Parameters<MemoryService["remember"]>[0]
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("unauthorized");
  });

  it("accepts trust_level=user_confirmed with a valid operator capability", async () => {
    // Stage 18 v1.1.2 (issue #23, ADR-0001): the
    // v1.1.1 `user_confirmed: true` flag is no
    // longer authorization evidence. The
    // canonical authorization is the operator
    // capability; the test installs a fresh
    // capability via the `CapabilityStore` and
    // supplies the token on the request. The
    // service accepts the request and the row
    // carries `trust_level: "user_confirmed"`.
    const { CapabilityStore } = await import("../../src/admin/capability.js");
    const capDb = mkdtempSync(join(tmpdir(), "lm-rg-semantics-cap-"));
    try {
      const capStore2 = new SQLiteMemoryStore(join(capDb, "memory.sqlite"));
      const capStore = new CapabilityStore(capDb, { persistent: false });
      const grantStatus = capStore.grant({ label: "rg-test" });
      if (grantStatus.kind !== "granted") {
        throw new Error("expected grant to succeed");
      }
      // Recover the freshly-generated token via a
      // synthetic authorization request. The
      // `InMemoryCapabilityStore.authorize(...)`
      // path does not surface the raw token; the
      // test relies on the store's `grant()`
      // having stored it. We re-derive the token
      // by granting again (the second grant
      // overwrites the in-memory record) and
      // read it via a synthetic comparison.
      // The cleanest approach: a fresh
      // `CapabilityStore` instance with a
      // pre-seeded capability record. The
      // `InMemoryCapabilityStore` accepts an
      // initial record in the constructor, so
      // we can pass the token we know was just
      // generated. But the `CapabilityStore`
      // does not expose the token. The test
      // here uses an `InMemoryCapabilityStore`
      // with a known token, then constructs a
      // `MemoryService` against it.
      const { InMemoryCapabilityStore } = await import("../../src/admin/capability.js");
      const knownToken = "a".repeat(64);
      const inMemStore = new InMemoryCapabilityStore({
        token: knownToken,
        created_at: new Date().toISOString(),
        label: "rg-test"
      });
      const capService = new MemoryService(
        capStore2,
        undefined,
        "agent:test",
        capDb,
        // Structural cast: the `MemoryService`
        // constructor's `capabilityStore`
        // parameter is typed as the
        // `CapabilityStore` class; the
        // `InMemoryCapabilityStore` has the same
        // `authorize(...)` / `hasCapability()`
        // / `getPath()` surface, so the cast is
        // a no-op at runtime. The service
        // consults only the duck-typed methods.
        inMemStore as unknown as ConstructorParameters<typeof MemoryService>[4]
      );
      const r = capService.remember(
        baseRemember({
          trust_level: "user_confirmed",
          user_confirmed: true,
          capability: knownToken
        }) as Parameters<MemoryService["remember"]>[0]
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const got = capStore2.getEntry(r.value.memory_id);
      expect(got?.trust_level).toBe("user_confirmed");
    } finally {
      try { rmSync(capDb, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  // -------------------------------------------------------------
  // Temporal policy: future valid_from excluded, expired
  // valid_until excluded
  // -------------------------------------------------------------
  it("excludes a memory whose valid_from is in the future from recall", () => {
    const r1 = service.remember(
      baseRemember({ title: "future window", body: "future window content" }) as Parameters<MemoryService["remember"]>[0]
    );
    if (!r1.ok) throw new Error("setup1");
    const r2 = service.remember(
      baseRemember({ title: "eligible always", body: "eligible always content" }) as Parameters<MemoryService["remember"]>[0]
    );
    if (!r2.ok) throw new Error("setup2");
    // Push r1 into the future
    store.updateEntry(r1.value.memory_id, {
      updated_at: new Date().toISOString(),
      valid_from: "2099-12-31T00:00:00.000Z"
    });
    // Query that matches BOTH memories' body text.
    const result = service.searchMemories({ query: "content", scope: "global", limit: 10 });
    const ids = result.items.map((i) => i.id);
    expect(ids).toContain(r2.value.memory_id);
    expect(ids).not.toContain(r1.value.memory_id);
  });

  it("excludes a memory whose valid_until is in the past from recall", () => {
    const r1 = service.remember(
      baseRemember({ title: "expired window", body: "expired window content" }) as Parameters<MemoryService["remember"]>[0]
    );
    if (!r1.ok) throw new Error("setup1");
    const r2 = service.remember(
      baseRemember({ title: "still valid", body: "still valid content" }) as Parameters<MemoryService["remember"]>[0]
    );
    if (!r2.ok) throw new Error("setup2");
    // Push r1 into the past
    store.updateEntry(r1.value.memory_id, {
      updated_at: new Date().toISOString(),
      valid_until: "2020-01-01T00:00:00.000Z"
    });
    // Query that matches BOTH memories' body text.
    const result = service.searchMemories({ query: "content", scope: "global", limit: 10 });
    const ids = result.items.map((i) => i.id);
    expect(ids).toContain(r2.value.memory_id);
    expect(ids).not.toContain(r1.value.memory_id);
  });

  // -------------------------------------------------------------
  // recordProvenance / explainProvenance (service-level)
  // -------------------------------------------------------------
  it("recordProvenance appends a link; explainProvenance renders the chain", () => {
    const r = service.remember(
      baseRemember() as Parameters<MemoryService["remember"]>[0]
    );
    if (!r.ok) throw new Error("setup");
    const write = service.recordProvenance({
      memory_id: r.value.memory_id,
      source_kind: "issue",
      source_ref: "https://github.com/xurunxin/AgentRecall/issues/17"
    });
    expect(write.ok).toBe(true);
    const explain = service.explainProvenance(r.value.memory_id);
    expect("memory_id" in explain).toBe(true);
    if (!("memory_id" in explain)) return;
    expect(explain.links.length).toBe(1);
    expect(explain.links[0]?.source_kind).toBe("issue");
    expect(explain.summary.length).toBe(1);
  });

  it("recordProvenance is a no-op for repeat calls with the same triple (PRIMARY KEY)", () => {
    const r = service.remember(
      baseRemember() as Parameters<MemoryService["remember"]>[0]
    );
    if (!r.ok) throw new Error("setup");
    const a = service.recordProvenance({
      memory_id: r.value.memory_id,
      source_kind: "pr",
      source_ref: "https://github.com/xurunxin/AgentRecall/pull/1"
    });
    const b = service.recordProvenance({
      memory_id: r.value.memory_id,
      source_kind: "pr",
      source_ref: "https://github.com/xurunxin/AgentRecall/pull/1"
    });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const explain = service.explainProvenance(r.value.memory_id);
    if (!("memory_id" in explain)) throw new Error("not found");
    expect(explain.links.length).toBe(1);
  });

  it("recordProvenance returns not_found for an unknown memory id", () => {
    const r = service.recordProvenance({
      memory_id: "mem_does_not_exist",
      source_kind: "session",
      source_ref: "session-abc"
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("not_found");
  });

  // -------------------------------------------------------------
  // recordFeedback (existing) — kept and audited
  // -------------------------------------------------------------
  it("recordFeedback appends a row; the per-actor count surfaces in the ranker", () => {
    const r = service.remember(
      baseRemember({ title: "feedback target", body: "feedback target content" }) as Parameters<MemoryService["remember"]>[0]
    );
    if (!r.ok) throw new Error("setup");
    const before = service.explainRecall({ query: "feedback", scope: "global" });
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const beforeScore = before.value.items.find((i) => i.memory_id === r.value.memory_id)?.score ?? 0;
    const fb = service.recordFeedback({
      memory_id: r.value.memory_id,
      kind: "up",
      actor_id: "agent:test"
    });
    expect(fb.ok).toBe(true);
    const after = service.explainRecall({ query: "feedback", scope: "global" });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    const afterScore = after.value.items.find((i) => i.memory_id === r.value.memory_id)?.score ?? 0;
    expect(afterScore).toBeGreaterThan(beforeScore);
  });

  // -------------------------------------------------------------
  // confirmMemoryTrust — the trusted-user confirmation gate
  // -------------------------------------------------------------
  it("confirmMemoryTrust rejects without a capability store (unauthorized)", () => {
    // Stage 18 v1.1.2 (issue #23, ADR-0001): the
    // `confirmMemoryTrust` service helper now
    // requires a `CapabilityStore`. Without a
    // store, the helper returns `unauthorized`
    // BEFORE the row is updated; the audit log
    // records the rejection under the
    // `write_rejected` event.
    const r = service.remember(
      baseRemember() as Parameters<MemoryService["remember"]>[0]
    );
    if (!r.ok) throw new Error("setup");
    const confirm = service.confirmMemoryTrust({
      memory_id: r.value.memory_id,
      trust_level: "user_confirmed",
      user_confirmed: true as const,
      reason: "human review approved"
    });
    expect(confirm.ok).toBe(false);
    if (confirm.ok) return;
    expect(confirm.error).toBe("unauthorized");
  });

  it("confirmMemoryTrust rejects with a mismatched capability (unauthorized)", () => {
    // The service accepts a `capability` arg on
    // the input. The token is well-formed (64 hex
    // chars) but does NOT match the on-disk
    // store. The helper returns `unauthorized`
    // with a `token_mismatch` reason in the
    // message.
    const r = service.remember(
      baseRemember() as Parameters<MemoryService["remember"]>[0]
    );
    if (!r.ok) throw new Error("setup");
    const confirm = service.confirmMemoryTrust({
      memory_id: r.value.memory_id,
      trust_level: "user_confirmed",
      user_confirmed: true as const,
      capability: "0".repeat(64)
    });
    expect(confirm.ok).toBe(false);
    if (confirm.ok) return;
    expect(confirm.error).toBe("unauthorized");
  });

  // -------------------------------------------------------------
  // The 4 new MCP tool schemas exist and are wired
  // -------------------------------------------------------------
  it("the four new MCP tool schemas are present and parseable", () => {
    expect(recordMemoryFeedbackToolSchema.safeParse({
      memory_id: "mem_x",
      kind: "up"
    }).success).toBe(true);
    expect(recordMemoryFeedbackToolSchema.safeParse({
      memory_id: "mem_x",
      kind: "sideways" // not in the enum
    }).success).toBe(false);
    expect(recordMemoryProvenanceToolSchema.safeParse({
      memory_id: "mem_x",
      source_kind: "issue",
      source_ref: "https://github.com/x/y/issues/1"
    }).success).toBe(true);
    expect(explainMemoryProvenanceToolSchema.safeParse({
      memory_id: "mem_x"
    }).success).toBe(true);
    expect(confirmMemoryTrustToolSchema.safeParse({
      memory_id: "mem_x",
      trust_level: "user_confirmed",
      user_confirmed: true
    }).success).toBe(true);
    // Without the user_confirmed flag the schema rejects
    expect(confirmMemoryTrustToolSchema.safeParse({
      memory_id: "mem_x",
      trust_level: "user_confirmed"
    }).success).toBe(false);
  });
});
