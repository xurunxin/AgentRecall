import { describe, it, expect } from "vitest";
import { RelatedNodeSchema, MemoryRelationsSchema, MemoryDetailSchema } from "../src/memory.js";

const fullMemory = {
  id: "mem_aaaaaaaaaaaaaaaaaaaaaaaa",
  scope: "project" as const,
  project_id: "p1",
  type: "decision" as const,
  topic: "auth",
  title: "Use JWT for stateless auth",
  body: "Long body here…",
  tags: ["auth", "jwt"],
  importance: 4,
  confidence: 5,
  sensitivity: "private" as const,
  status: "active" as const,
  supersedes: ["mem_bbbbbbbbbbbbbbbbbbbbbb"],
  source: { kind: "user" as const, ref: "claude" },
  created_at: "2026-08-25T10:00:00.000Z",
  updated_at: "2026-08-25T10:00:00.000Z",
  revision: 1,
};

const relatedNode = {
  id: "mem_cccccccccccccccccccccccc",
  title: "Use refresh tokens",
  topic: "auth",
  type: "decision" as const,
  status: "active" as const,
  importance: 3,
};

describe("RelatedNodeSchema", () => {
  it("accepts a valid node", () => {
    expect(RelatedNodeSchema.safeParse(relatedNode).success).toBe(true);
  });
  it("rejects importance out of range", () => {
    expect(RelatedNodeSchema.safeParse({ ...relatedNode, importance: 6 }).success).toBe(false);
  });
});

describe("MemoryRelationsSchema", () => {
  it("accepts empty relations", () => {
    const r = MemoryRelationsSchema.parse({
      supersedes: [], superseded_by: [], merge: [],
      co_topic: [], co_topic_total: 0, co_scope: [], co_scope_total: 0,
    });
    expect(r.co_topic_total).toBe(0);
  });
});

describe("MemoryDetailSchema", () => {
  it("extends Memory and adds related", () => {
    const d = MemoryDetailSchema.parse({
      ...fullMemory,
      related: {
        supersedes: [relatedNode], superseded_by: [], merge: [],
        co_topic: [relatedNode], co_topic_total: 1, co_scope: [], co_scope_total: 0,
      },
    });
    expect(d.related.supersedes[0].id).toBe(relatedNode.id);
    expect(d.body).toBe("Long body here…");
  });
  it("rejects when related is missing", () => {
    expect(MemoryDetailSchema.safeParse(fullMemory).success).toBe(false);
  });
});
