import { describe, it, expect } from "vitest";
import { ErrorCodeSchema, AppErrorSchema } from "../src/errors.js";

describe("ErrorCodeSchema", () => {
  it("accepts known codes", () => {
    for (const code of [
      "SCHEMA_VERSION_MISMATCH",
      "DB_NOT_FOUND",
      "MCP_PROCESS_UNAVAILABLE",
      "DISABLED_IN_V0_1",
    ]) {
      expect(ErrorCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  it("rejects unknown code", () => {
    expect(ErrorCodeSchema.safeParse("FOO_BAR").success).toBe(false);
  });
});

describe("AppErrorSchema", () => {
  it("round-trips an error with details", () => {
    const e = {
      code: "GRAPH_TOO_LARGE",
      message: "图谱已截断",
      details: { total: 1234, max: 500 },
    };
    const r = AppErrorSchema.parse(e);
    expect(r.code).toBe("GRAPH_TOO_LARGE");
    expect(r.details?.total).toBe(1234);
  });
});
