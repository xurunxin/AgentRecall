import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backupCommand } from "../../src/cli/commands/backup.js";
import { parseArgs } from "../../src/cli/arg-parser.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";

describe("backupCommand", () => {
  it("writes a backup and reports the path", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-backup-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const args = parseArgs(["backup"]);
    const result = backupCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("backup written");
    store.close();
  });

  it("emits JSON with --json", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-backup-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const args = parseArgs(["backup", "--json"]);
    const result = backupCommand({ dataHome, args, store });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.path).toContain("memory-");
    expect(parsed.size).toBeGreaterThan(0);
    store.close();
  });

  it("respects --keep N", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-backup-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    for (let i = 0; i < 5; i += 1) {
      const result = backupCommand({
        dataHome,
        args: parseArgs(["backup", "--keep", "2"]),
        store
      });
      expect(result.exitCode).toBe(0);
    }
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const list = readdirSync(join(dataHome, "backups"));
    expect(list.length).toBeLessThanOrEqual(2);
    store.close();
  });
});
