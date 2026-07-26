import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportCommand } from "../../src/cli/commands/export.js";
import { parseArgs } from "../../src/cli/arg-parser.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import { ProjectIdentityResolver } from "../../src/scope-resolver.js";
import { buildRequestContext } from "../../src/request-context.js";

describe("exportCommand", () => {
  it("exports an empty global scope without error", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-export-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const args = parseArgs(["export"]);
    const identityResolver = new ProjectIdentityResolver(store, "user:cli");
    const result = exportCommand({
      dataHome,
      args,
      store,
      identityResolver,
      ctx: buildRequestContext({ actor_override: "user:cli", client_name: "agent-recall-cli" })
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("exported");
    store.close();
  });

  it("rejects invalid scope", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-export-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const args = parseArgs(["export", "--scope", "nonsense"]);
    const identityResolver = new ProjectIdentityResolver(store, "user:cli");
    const result = exportCommand({
      dataHome,
      args,
      store,
      identityResolver,
      ctx: buildRequestContext({ actor_override: "user:cli", client_name: "agent-recall-cli" })
    });
    expect(result.exitCode).toBe(1);
    store.close();
  });
});
