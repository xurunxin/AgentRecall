import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditCommand } from "../../src/cli/commands/audit.js";
import { parseArgs } from "../../src/cli/arg-parser.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-audit-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  store.appendAudit({
    id: "aud_1",
    memory_id: "mem_a",
    scope: "global",
    event: "created",
    actor: "agent:claude-code",
    metadata: {},
    created_at: "2026-07-19T00:00:00.000Z"
  });
  store.appendAudit({
    id: "aud_2",
    memory_id: "mem_a",
    scope: "global",
    event: "updated",
    actor: "user:cli",
    metadata: { fields: ["title"] },
    created_at: "2026-07-19T01:00:00.000Z"
  });
  return { dataHome, store };
}

describe("auditCommand", () => {
  it("shows audit events for a memory", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["audit", "mem_a"]);
    const result = auditCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("created");
    expect(result.stdout).toContain("updated");
    expect(result.stdout).toContain("agent:claude-code");
    expect(result.stdout).toContain("user:cli");
    store.close();
  });

  it("returns exit 1 for unknown id", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-audit-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const args = parseArgs(["audit", "mem_missing"]);
    const result = auditCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(1);
    store.close();
  });

  it("emits JSON with --json", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["audit", "mem_a", "--json"]);
    const result = auditCommand({ dataHome, args, store });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.events.length).toBe(2);
    store.close();
  });
});
