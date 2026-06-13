import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createService, resolveDataHome, serverName } from "../src/index.js";
import type { MemoryService } from "../src/memory-service.js";

function closeService(service: MemoryService): void {
  (service as unknown as { store: { close(): void } }).store.close();
}

describe("project scaffold", () => {
  it("exports the server name", () => {
    expect(serverName()).toBe("agent-recall");
  });

  it("imports the MCP server SDK entry points", () => {
    expect(McpServer).toBeTypeOf("function");
    expect(StdioServerTransport).toBeTypeOf("function");
  });

  it("resolves the data home from defaults, env, and home-relative paths", () => {
    expect(resolveDataHome({})).toBe(resolve(join(homedir(), ".agent-recall")));
    expect(resolveDataHome({ AGENT_RECALL_HOME: "G:\\Projects\\MetronX\\memory-home" })).toBe(
      resolve("G:\\Projects\\MetronX\\memory-home")
    );
    expect(resolveDataHome({ AGENT_RECALL_HOME: "~/memory-home" })).toBe(resolve(join(homedir(), "memory-home")));
    expect(resolveDataHome({ LOCAL_MEMORY_MCP_HOME: "~/legacy-memory-home" })).toBe(
      resolve(join(homedir(), "legacy-memory-home"))
    );
  });

  it("creates a service that can remember and export context", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-mcp-smoke-"));
    const service = createService(dataHome);
    try {
      const remembered = service.remember({
        scope: "global",
        type: "lesson",
        topic: "smoke",
        title: "Created service exports context",
        body: "The index factory wires SQLite storage and markdown export.",
        tags: ["factory"],
        source: { kind: "agent" },
        importance: 3,
        confidence: 4
      });

      expect(remembered.ok).toBe(true);
      expect(
        service.exportMemoryContext({
          scope: "global",
          query: "factory",
          budget_chars: 2000
        })
      ).toContain("Created service exports context");
    } finally {
      closeService(service);
      rmSync(dataHome, { recursive: true, force: true });
    }
  });
});
