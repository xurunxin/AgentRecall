// test/release-gate/p3-sql-boundary-sensitivity.test.ts
//
// Stage 18 v1.1.2 follow-up (review by ora-8): the
// SQL-boundary sensitivity filter must apply to the
// single-row read paths (`peekEntry` / `getMemory` /
// `memory://project/{id}/memory/{mid}` resource / CLI
// `show`) so an unauthorized caller cannot probe the
// existence of a `private` / `restricted` row. The
// pre-follow-up `peekEntry` did `SELECT *` without
// the `actor_max_sensitivity` predicate, which let a
// caller bypass the filter by asking for one id at a
// time.
//
// The tests in this file pin the v1.1.2 follow-up
// contracts:
//
//   - C1: `getMemory` (service-level) returns
//         `undefined` when the entry's sensitivity
//         exceeds the read service's
//         `actorMaxSensitivity`; the response is
//         indistinguishable from a not-found row.
//
//   - C2: `confirmMemoryTrust` (service-level)
//         threads `ctx?.request_id` into every
//         `appendAudit(...)` call when `ctx` is
//         supplied, so a privileged trust-promotion
//         audit row is correlatable to the original
//         MCP request.
//
//   - M5: the canonical capability token shape
//         (`^[0-9a-f]{64}$`) is exported as
//         `CAPABILITY_TOKEN_SHAPE` from
//         `src/admin/capability.ts` AND reused by the
//         write validator so the two layers never
//         drift.
//
//   - M6: `remember({ sensitivity: "restricted",
//         capability: "<token>" })` succeeds at the
//         service layer when the supplied token
//         matches the on-disk store, and the
//         resulting row carries
//         `sensitivity: "restricted"`.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../../src/memory-service.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import { CAPABILITY_TOKEN_SHAPE, InMemoryCapabilityStore } from "../../src/admin/capability.js";
import { buildRequestContext, type RequestContext } from "../../src/request-context.js";
import type { MemoryEntry } from "../../src/domain.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-sql-sens-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const service = new MemoryService(store, undefined, "agent:test", dataHome);
  return { service, store, dataHome };
}

function setupWithCapability() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-rg-sql-sens-cap-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  const knownToken = "a".repeat(64);
  const inMemStore = new InMemoryCapabilityStore({
    token: knownToken,
    created_at: new Date().toISOString(),
    label: "follow-up-test"
  });
  const service = new MemoryService(
    store,
    undefined,
    "agent:test",
    dataHome,
    inMemStore as unknown as ConstructorParameters<typeof MemoryService>[4]
  );
  return { service, store, dataHome, knownToken };
}

function seedEntry(
  store: SQLiteMemoryStore,
  input: { id: string; sensitivity?: MemoryEntry["sensitivity"]; trust_level?: MemoryEntry["trust_level"] }
): MemoryEntry {
  const entry: MemoryEntry = {
    id: input.id,
    scope: "global",
    type: "fact",
    topic: "follow-up",
    title: `title ${input.id}`,
    body: `body ${input.id}`,
    tags: [`tag-${input.id}`],
    source: { kind: "agent" },
    importance: 3,
    confidence: 3,
    status: "active",
    created_at: "2026-07-27T00:00:00.000Z",
    updated_at: "2026-07-27T00:00:00.000Z",
    access_count: 0,
    supersedes: [],
    token_estimate: 1,
    char_count: 2,
    revision: 1,
    writer_actor_id: "agent:test",
    pinned: false,
    trust_level: input.trust_level ?? "agent_observed",
    sensitivity: input.sensitivity ?? "normal",
    tier: "working",
    metadata: {}
  };
  store.insertEntry(entry);
  store.appendAudit({
    id: `aud_${input.id}`,
    memory_id: input.id,
    scope: "global",
    event: "created",
    actor: "agent:test",
    metadata: {},
    created_at: "2026-07-27T00:00:00.000Z"
  });
  return entry;
}

describe("release-gate p3-sql-boundary-sensitivity (follow-up #23 review by ora-8)", () => {
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

  // -----------------------------------------------------------------
  // C1: getMemory (service-level) is sensitivity-aware.
  // -----------------------------------------------------------------
  it("getMemory returns undefined for a restricted row under the default fail-closed actorMaxSensitivity", () => {
    // The follow-up closes the leak where
    // `peekEntry` (the SQL single-row read) bypassed
    // the sensitivity filter. The default
    // `MemoryService` has no capability store, so
    // its read service is configured with
    // `actorMaxSensitivity: "normal"` (fail-closed).
    // A `restricted` row must NOT surface through
    // `getMemory`.
    seedEntry(store, { id: "mem_restricted", sensitivity: "restricted" });
    const got = service.getMemory("mem_restricted");
    expect(got).toBeUndefined();
  });

  it("getMemoryWithVisibility distinguishes forbidden_visibility from not_found at the public boundary", () => {
    // Stage 18 v1.1.2 follow-up (review by ora-8):
    // the public-boundary read distinguishes
    // `forbidden_visibility` (row exists at a
    // higher sensitivity) from `not_found` (row
    // does not exist). The MCP `get_memory` tool
    // and the per-project resource route through
    // this method.
    seedEntry(store, { id: "mem_visible_only", sensitivity: "restricted" });
    seedEntry(store, { id: "mem_visible", sensitivity: "normal" });
    // A restricted row surfaces a structured
    // `forbidden_visibility` error.
    const forbidden = service.getMemoryWithVisibility("mem_visible_only");
    expect(forbidden.ok).toBe(false);
    if (forbidden.ok) return;
    expect(forbidden.error).toBe("forbidden_visibility");
    expect(forbidden.details?.["entry_sensitivity"]).toBe("restricted");
    expect(forbidden.details?.["memory_id"]).toBe("mem_visible_only");
    // The error message MUST NOT leak the title
    // or body — only the operational metadata.
    expect(forbidden.message).not.toContain("title mem_visible_only");
    expect(forbidden.message).not.toContain("body mem_visible_only");
    // A non-existent row surfaces `not_found`.
    const missing = service.getMemoryWithVisibility("mem_does_not_exist");
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error).toBe("not_found");
    // A normal row surfaces the entry + audit.
    const ok = service.getMemoryWithVisibility("mem_visible");
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value.entry.id).toBe("mem_visible");
    expect(ok.value.audit.length).toBeGreaterThan(0);
  });

  it("getMemory returns the entry when sensitivity is within the actor's max sensitivity", () => {
    seedEntry(store, { id: "mem_normal", sensitivity: "normal" });
    const got = service.getMemory("mem_normal");
    expect(got).toBeDefined();
    expect(got?.entry.id).toBe("mem_normal");
  });

  it("getMemory returns the entry when an admin-profile service reads a restricted row", () => {
    // With a loaded capability, the read service
    // is configured with `actorMaxSensitivity:
    // "restricted"`; the same SQL-boundary filter
    // must surface the row.
    const capDataHome = mkdtempSync(join(tmpdir(), "lm-rg-sql-sens-cap-"));
    try {
      const capStore = new SQLiteMemoryStore(join(capDataHome, "memory.sqlite"));
      const knownToken = "b".repeat(64);
      const inMemStore = new InMemoryCapabilityStore({
        token: knownToken,
        created_at: new Date().toISOString(),
        label: "follow-up-test"
      });
      const capService = new MemoryService(
        capStore,
        undefined,
        "agent:test",
        capDataHome,
        inMemStore as unknown as ConstructorParameters<typeof MemoryService>[4]
      );
      const entry: MemoryEntry = {
        id: "mem_admin_visible",
        scope: "global",
        type: "fact",
        topic: "follow-up",
        title: "admin-visible title",
        body: "admin-visible body",
        tags: ["admin"],
        source: { kind: "agent" },
        importance: 3,
        confidence: 3,
        status: "active",
        created_at: "2026-07-27T00:00:00.000Z",
        updated_at: "2026-07-27T00:00:00.000Z",
        access_count: 0,
        supersedes: [],
        token_estimate: 1,
        char_count: 2,
        revision: 1,
        writer_actor_id: "agent:test",
        pinned: false,
        trust_level: "agent_observed",
        sensitivity: "restricted",
        tier: "working",
        metadata: {}
      };
      capStore.insertEntry(entry);
      capStore.appendAudit({
        id: "aud_admin",
        memory_id: "mem_admin_visible",
        scope: "global",
        event: "created",
        actor: "agent:test",
        metadata: {},
        created_at: "2026-07-27T00:00:00.000Z"
      });
      const got = capService.getMemory("mem_admin_visible");
      expect(got).toBeDefined();
      expect(got?.entry.id).toBe("mem_admin_visible");
      capStore.close();
    } finally {
      rmSync(capDataHome, { recursive: true, force: true });
    }
  });
});

describe("release-gate p3-sql-boundary-sensitivity (audit trace, follow-up #23)", () => {
  let store: SQLiteMemoryStore;
  let service: MemoryService;
  let dataHome: string;
  let knownToken: string;

  beforeEach(() => {
    ({ service, store, dataHome, knownToken } = setupWithCapability());
  });
  afterEach(() => {
    store.close();
    rmSync(dataHome, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------
  // C2: confirmMemoryTrust threads ctx into every audit event.
  // -----------------------------------------------------------------
  it("confirmMemoryTrust records request_id from the supplied RequestContext", () => {
    // The follow-up closes the leak where the four
    // `appendAudit(...)` calls inside
    // `confirmMemoryTrust` ignored the caller's
    // `RequestContext`, so the audit row carried no
    // `request_id` / `session_id` / `tool_call_id`
    // and was unlinkable to the originating MCP
    // request. The fix threads the `ctx` arg into
    // every audit row.
    const seeded = seedEntry(store, { id: "mem_audit_ctx", sensitivity: "normal" });
    expect(seeded.id).toBe("mem_audit_ctx");
    const ctx: RequestContext = buildRequestContext({
      request_id: "fixed-request-id-aaaa",
      session_id: "fixed-session-bbbb",
      tool_call_id: "fixed-tool-cccc",
      actor_override: "agent:test"
    });
    const result = service.confirmMemoryTrust({
      memory_id: "mem_audit_ctx",
      trust_level: "user_confirmed",
      user_confirmed: true,
      capability: knownToken,
      reason: "follow-up audit ctx",
      actor_id: "agent:test"
    }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const events = store.getAuditEvents("mem_audit_ctx");
    // The successful promotion emits at least one
    // `updated` event (the others are `write_rejected`
    // — there are no rejections in this happy-path
    // test). The `updated` event MUST carry
    // `request_id` matching the supplied ctx.
    const updated = events.find((e) => e.event === "updated" && e.metadata?.["field"] === "trust_level");
    expect(updated).toBeDefined();
    expect(updated?.metadata?.["request_id"]).toBe("fixed-request-id-aaaa");
    expect(updated?.metadata?.["session_id"]).toBe("fixed-session-bbbb");
    expect(updated?.metadata?.["tool_call_id"]).toBe("fixed-tool-cccc");
  });

  it("confirmMemoryTrust also threads ctx through write_rejected audit events", () => {
    // The pre-follow-up implementation had FOUR
    // `appendAudit(...)` calls inside
    // `confirmMemoryTrust`. Three are `write_rejected`
    // branches (capability missing / capability
    // malformed / authorize denial); the fourth is
    // the success branch. All four must thread
    // `ctx` so the audit trail is consistent.
    const seeded = seedEntry(store, { id: "mem_audit_reject", sensitivity: "normal" });
    expect(seeded.id).toBe("mem_audit_reject");
    const ctx: RequestContext = buildRequestContext({
      request_id: "fixed-request-id-reject",
      session_id: "fixed-session-reject",
      tool_call_id: "fixed-tool-reject",
      actor_override: "agent:test"
    });
    // Force a `write_rejected` by supplying a
    // well-formed but mismatched capability.
    const result = service.confirmMemoryTrust({
      memory_id: "mem_audit_reject",
      trust_level: "user_confirmed",
      user_confirmed: true,
      capability: "0".repeat(64),
      reason: "follow-up audit ctx rejection"
    }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("unauthorized");
    const events = store.getAuditEvents("mem_audit_reject");
    const rejected = events.find((e) => e.event === "write_rejected");
    expect(rejected).toBeDefined();
    expect(rejected?.metadata?.["request_id"]).toBe("fixed-request-id-reject");
    expect(rejected?.metadata?.["session_id"]).toBe("fixed-session-reject");
  });

  // -----------------------------------------------------------------
  // M6: remember({sensitivity: "restricted", capability: <token>}) end-to-end.
  // -----------------------------------------------------------------
  it("remember({ sensitivity: 'restricted', capability }) succeeds and writes the restricted row", () => {
    // The follow-up ensures the `remember` tool
    // handler forwards the `capability` field
    // through to the service. The service performs
    // the `sensitivity_restricted` capability check;
    // a matching token authorizes the write.
    const result = service.remember({
      scope: "global",
      type: "fact",
      topic: "follow-up",
      title: "M6 end-to-end restricted write",
      body: "M6 end-to-end restricted write body",
      tags: ["m6"],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      sensitivity: "restricted",
      capability: knownToken
    } as Parameters<MemoryService["remember"]>[0]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const got = store.getEntry(result.value.memory_id);
    expect(got?.sensitivity).toBe("restricted");
  });
});

describe("release-gate p3-sql-boundary-sensitivity (constant reuse, follow-up #23)", () => {
  // -----------------------------------------------------------------
  // M5: CAPABILITY_TOKEN_SHAPE is exported and reused.
  // -----------------------------------------------------------------
  it("CAPABILITY_TOKEN_SHAPE is exported as the canonical 64-hex regex", () => {
    expect(CAPABILITY_TOKEN_SHAPE).toBeInstanceOf(RegExp);
    expect(CAPABILITY_TOKEN_SHAPE.source).toBe("^[0-9a-f]{64}$");
    // A canonical token matches.
    expect(CAPABILITY_TOKEN_SHAPE.test("0".repeat(64))).toBe(true);
    expect(CAPABILITY_TOKEN_SHAPE.test("f".repeat(64))).toBe(true);
    // A malformed token does NOT match.
    expect(CAPABILITY_TOKEN_SHAPE.test("0".repeat(63))).toBe(false);
    expect(CAPABILITY_TOKEN_SHAPE.test("0".repeat(65))).toBe(false);
    expect(CAPABILITY_TOKEN_SHAPE.test("Z".repeat(64))).toBe(false);
    expect(CAPABILITY_TOKEN_SHAPE.test("not hex at all")).toBe(false);
  });

  it("the write validator accepts a token that matches CAPABILITY_TOKEN_SHAPE", async () => {
    const { validateRememberInput } = await import("../../src/write-validator.js");
    const ok = validateRememberInput({
      scope: "global",
      type: "fact",
      topic: "m5",
      title: "M5 validator reuse",
      body: "M5 validator reuse body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      capability: "0".repeat(64)
    });
    expect(ok.ok).toBe(true);
  });

  it("the write validator rejects a token that does NOT match CAPABILITY_TOKEN_SHAPE", async () => {
    const { validateRememberInput } = await import("../../src/write-validator.js");
    const bad = validateRememberInput({
      scope: "global",
      type: "fact",
      topic: "m5",
      title: "M5 validator reject",
      body: "M5 validator reject body",
      tags: [],
      source: { kind: "agent" },
      importance: 3,
      confidence: 3,
      capability: "Z".repeat(64)
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error).toBe("invalid_schema");
  });
});