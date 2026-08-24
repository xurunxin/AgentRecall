import { describe, it, expect } from "vitest";
import { MemorySchema } from "../src/schema.js";

const validMemory = {
  id: "11111111-1111-1111-1111-111111111111",
  scope: "project" as const,
  project_id: "my-project",
  type: "decision" as const,
  topic: "auth",
  title: "Use JWT for auth",
  body: "We decided to use JWT...",
  tags: ["jwt", "auth"],
  importance: 4,
  confidence: 3,
  sensitivity: "normal" as const,
  status: "active" as const,
  supersedes: [],
  source: { kind: "agent" as const, ref: "session-42" },
  created_at: "2026-08-24T10:00:00.000Z",
  updated_at: "2026-08-24T10:00:00.000Z",
  revision: 1,
};

describe("MemorySchema", () => {
  it("accepts a valid memory", () => {
    const r = MemorySchema.safeParse(validMemory);
    expect(r.success).toBe(true);
  });

  it("rejects missing required field (topic)", () => {
    const r = MemorySchema.safeParse({ ...validMemory, topic: undefined });
    expect(r.success).toBe(false);
  });

  it("rejects importance out of range", () => {
    const r = MemorySchema.safeParse({ ...validMemory, importance: 7 });
    expect(r.success).toBe(false);
  });

  it("rejects invalid status enum", () => {
    const r = MemorySchema.safeParse({ ...validMemory, status: "deleted" });
    expect(r.success).toBe(false);
  });

  it("accepts source without ref (optional)", () => {
    const r = MemorySchema.safeParse({
      ...validMemory,
      source: { kind: "user" },
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty id (violates min(1))", () => {
    const r = MemorySchema.safeParse({ ...validMemory, id: "" });
    expect(r.success).toBe(false);
  });
});
