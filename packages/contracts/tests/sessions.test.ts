// packages/contracts/tests/sessions.test.ts
//
// v1.2.0-alpha.1 (issue #49): schema tests for the
// SessionTraceBundle v1 contracts.

import { describe, it, expect } from "vitest";

import {
  SessionEventTypeSchema,
  SessionScopeSchema,
  SessionTraceEventV1Schema,
  SessionTraceBundleV1Schema,
  SessionContentRefSchema
} from "../src/sessions.js";

const eventBase = {
  schema_version: "1" as const,
  source_kind: "opencode",
  source_version: "1.0.0",
  source_instance_id: "instance-1",
  source_session_id: "opencode-session-1",
  project_id: "proj_alpha" as string | null,
  project_path: "/repo/proj",
  actor_id: "user:tester",
  client_name: "opencode",
  client_version: "1.0.0",
  event_id: "evt_1",
  sequence: 0,
  turn_id: "turn_1",
  event_type: "user_message" as const,
  role: "user" as const,
  content: "hello",
  content_digest: "sha256:" + "a".repeat(64),
  timestamp: "2026-08-25T10:00:00.000Z",
  sensitivity: "normal" as const,
  redaction_flags: [] as Array<never>,
  metadata: {}
};

describe("Session contracts (v1.2.0-alpha.1, issue #49)", () => {
  it("accepts a minimal user_message event", () => {
    const parsed = SessionTraceEventV1Schema.parse(eventBase);
    expect(parsed.event_type).toBe("user_message");
  });

  it("rejects a missing schema_version", () => {
    const bad = { ...eventBase } as Record<string, unknown>;
    delete bad["schema_version"];
    const result = SessionTraceEventV1Schema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects an unknown event_type", () => {
    const result = SessionEventTypeSchema.safeParse("raw_html");
    expect(result.success).toBe(false);
  });

  it("rejects a content_digest that is not sha256:hex", () => {
    const result = SessionTraceEventV1Schema.safeParse({
      ...eventBase,
      content_digest: "md5:abc"
    });
    expect(result.success).toBe(false);
  });

  it("requires `content` or `content_ref`", () => {
    const bad = { ...eventBase } as Record<string, unknown>;
    delete bad["content"];
    const result = SessionTraceEventV1Schema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("accepts a content_ref with an inline body", () => {
    const ref = {
      digest: "sha256:" + "b".repeat(64),
      media_type: "text/plain",
      size_bytes: 5,
      content_inline: "hello"
    };
    const parsed = SessionContentRefSchema.parse(ref);
    expect(parsed.content_inline).toBe("hello");
  });

  it("rejects a content_ref with neither `ref` nor `content_inline`", () => {
    const ref = {
      digest: "sha256:" + "c".repeat(64),
      media_type: "text/plain",
      size_bytes: 0
    };
    const result = SessionContentRefSchema.safeParse(ref);
    expect(result.success).toBe(false);
  });

  it("accepts a complete bundle with one event", () => {
    const parsed = SessionTraceBundleV1Schema.parse({
      schema_version: "1",
      bundle_id: "bundle-1",
      source_kind: "opencode",
      source_version: "1.0.0",
      source_instance_id: "instance-1",
      source_session_id: "opencode-session-1",
      project_id: "proj_alpha",
      actor_id: "user:tester",
      client_name: "opencode",
      client_version: "1.0.0",
      scope: "project",
      sensitivity: "normal",
      started_at: "2026-08-25T10:00:00.000Z",
      adapter_id: "jsonl",
      adapter_version: "1.0.0",
      events: [eventBase]
    });
    expect(parsed.events.length).toBe(1);
  });

  it("accepts a bundle with an empty events array (header-only JSONL format)", () => {
    const result = SessionTraceBundleV1Schema.safeParse({
      schema_version: "1",
      bundle_id: "bundle-1",
      source_kind: "opencode",
      source_version: "1.0.0",
      source_instance_id: "instance-1",
      source_session_id: "opencode-session-1",
      project_id: "proj_alpha",
      actor_id: "user:tester",
      client_name: "opencode",
      client_version: "1.0.0",
      scope: "project",
      sensitivity: "normal",
      started_at: "2026-08-25T10:00:00.000Z",
      adapter_id: "jsonl",
      adapter_version: "1.0.0",
      events: []
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown scope", () => {
    const result = SessionScopeSchema.safeParse("repo");
    expect(result.success).toBe(false);
  });
});
