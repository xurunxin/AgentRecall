import { describe, it, expect } from "vitest";
import {
  GraphNodeSchema,
  GraphEdgeSchema,
  GraphFilterSchema,
  GraphResponseSchema,
} from "../src/graph.js";

describe("GraphNodeSchema", () => {
  it("accepts a valid node", () => {
    const node = {
      id: "11111111-1111-1111-1111-111111111111",
      label: "Use JWT for auth",
      type: "decision" as const,
      topic: "auth",
      scope: "project" as const,
      project_id: "my-project",
      importance: 4,
      status: "active" as const,
      created_at: "2026-08-24T10:00:00.000Z",
    };
    expect(GraphNodeSchema.safeParse(node).success).toBe(true);
  });
});

describe("GraphEdgeSchema", () => {
  it("accepts supersede edge", () => {
    const edge = {
      source: "11111111-1111-1111-1111-111111111111",
      target: "22222222-2222-2222-2222-222222222222",
      kind: "supersede" as const,
      weight: 1.0,
    };
    expect(GraphEdgeSchema.safeParse(edge).success).toBe(true);
  });

  it("rejects weight > 1", () => {
    const edge = {
      source: "11111111-1111-1111-1111-111111111111",
      target: "22222222-2222-2222-2222-222222222222",
      kind: "merge" as const,
      weight: 1.5,
    };
    expect(GraphEdgeSchema.safeParse(edge).success).toBe(false);
  });
});

describe("GraphFilterSchema", () => {
  it("applies defaults", () => {
    const r = GraphFilterSchema.parse({});
    expect(r.scope).toBe("all");
    expect(r.status).toEqual(["active"]);
    expect(r.max_nodes).toBe(500);
    expect(r.include_co_topic).toBe(true);
    expect(r.include_co_scope).toBe(false);
  });

  it("rejects max_nodes > 2000", () => {
    expect(GraphFilterSchema.safeParse({ max_nodes: 5000 }).success).toBe(false);
  });

  it("defaults organization to 'none' and accepts all 5 modes", () => {
    expect(GraphFilterSchema.parse({}).organization).toBe("none");
    for (const m of ["none", "by_topic", "by_type", "by_scope", "by_status"]) {
      expect(GraphFilterSchema.parse({ organization: m }).organization).toBe(m);
    }
    expect(GraphFilterSchema.safeParse({ organization: "by_zzz" }).success).toBe(false);
  });
});

describe("GraphResponseSchema", () => {
  it("accepts empty graph", () => {
    const r = GraphResponseSchema.parse({
      nodes: [],
      edges: [],
      total: 0,
      truncated: false,
      generated_at: "2026-08-24T10:00:00.000Z",
    });
    expect(r.total).toBe(0);
  });
});
