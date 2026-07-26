import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createService, resolveDataHome } from "../src/index.js";

function closeService(service: ReturnType<typeof createService>): void {
  (service as unknown as { store?: { close: () => void } }).store?.close();
}

describe("AgentRecall e2e", () => {
  it("resolves data home from AGENT_RECALL_HOME and home-relative paths", () => {
    const configuredHome = mkdtempSync(join(tmpdir(), "lm-e2e-home-"));

    expect(resolveDataHome({ AGENT_RECALL_HOME: configuredHome })).toBe(resolve(configuredHome));
    expect(resolveDataHome({ AGENT_RECALL_HOME: "~/lm-e2e-home" })).toBe(resolve(join(homedir(), "lm-e2e-home")));
    expect(resolveDataHome({ AGENT_RECALL_HOME: "~\\lm-e2e-home" })).toBe(resolve(join(homedir(), "lm-e2e-home")));
    expect(resolveDataHome({ AGENT_RECALL_HOME: "   " })).toBe(resolve(join(homedir(), ".agent-recall")));
  });

  it("creates a service that remembers global memory and exports it as context", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-e2e-service-"));
    const service = createService(dataHome);

    try {
      const remembered = service.remember({
        scope: "global",
        type: "constraint",
        topic: "memory",
        title: "Do not store secrets",
        body: "Reject secret-looking content before memory storage.",
        tags: ["security"],
        source: { kind: "agent", ref: "e2e" },
        importance: 5,
        confidence: 5
      });

      expect(remembered.ok).toBe(true);
      expect(service.exportMemoryContext({ scope: "global", query: "secrets", budget_chars: 1000 })).toContain(
        "Do not store secrets"
      );
    } finally {
      closeService(service);
    }
  });

  it("round-trips project-scoped memory through remember, search, and export", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-e2e-project-"));
    const service = createService(dataHome);

    try {
      const remembered = service.remember({
        scope: "project",
        project_id: "repo-e2e",
        project_path: "/tmp/repo-e2e",
        type: "lesson",
        topic: "sqlite",
        title: "Project memory stays scoped",
        body: "Project-specific SQLite notes should be available only for the matching project.",
        tags: ["sqlite", "project"],
        source: { kind: "agent", ref: "e2e" },
        importance: 4,
        confidence: 5
      });

      expect(remembered.ok).toBe(true);
      expect(service.searchMemories({ scope: "project", project_id: "repo-e2e", query: "SQLite", limit: 5 }).items).toEqual([
        expect.objectContaining({
          scope: "project",
          project_id: "repo-e2e",
          title: "Project memory stays scoped"
        })
      ]);
      expect(
        service.exportMemoryContext({ scope: "project", project_id: "repo-e2e", query: "SQLite", budget_chars: 1000 })
      ).toContain("Project memory stays scoped");
    } finally {
      closeService(service);
    }
  });
});
