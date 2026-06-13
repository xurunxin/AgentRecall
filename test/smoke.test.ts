import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { describe, expect, it } from "vitest";
import { serverName } from "../src/index.js";

describe("project scaffold", () => {
  it("exports the server name", () => {
    expect(serverName()).toBe("local-memory-mcp");
  });

  it("imports the MCP server SDK entry points", () => {
    expect(McpServer).toBeTypeOf("function");
    expect(StdioServerTransport).toBeTypeOf("function");
  });
});
