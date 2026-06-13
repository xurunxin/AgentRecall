import { describe, expect, it } from "vitest";
import { serverName } from "../src/index.js";

describe("project scaffold", () => {
  it("exports the server name", () => {
    expect(serverName()).toBe("local-memory-mcp");
  });
});
