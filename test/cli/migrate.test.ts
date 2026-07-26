import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateCommand } from "../../src/cli/commands/migrate.js";
import { parseArgs } from "../../src/cli/arg-parser.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";

describe("migrateCommand", () => {
  it("refuses to run without --yes", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-migrate-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    const args = parseArgs(["migrate"]);
    const result = migrateCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--yes");
    store.close();
  });

  it("migrates when --yes", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-migrate-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    store.setUserVersion(1);
    const args = parseArgs(["migrate", "--yes"]);
    const result = migrateCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("migrated");
    store.close();
  });

  it("emits JSON with --json", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-migrate-"));
    const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
    store.setUserVersion(1);
    const args = parseArgs(["migrate", "--yes", "--json"]);
    const result = migrateCommand({ dataHome, args, store });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.from).toBe(1);
    // Stage 11 PR7: CURRENT_SCHEMA_VERSION is now 4
    // (memory_revisions / memory_accesses / project_aliases
    // / mutation_requests / memory_relations + v4 columns
    // on memory_entries).
    // Stage 15 PR-M0-1: bumped to 5 (mutation_requests_v2).
    // Stage 15 PR-M0-4: bumped to 6 (maintenance_plans +
    // maintenance_plan_items).
    // Stage 15 PR-M1-1: bumped to 7 (memory_provenance).
    // Stage 15 PR-M1-2: bumped to 8 (project_identities
    // + project_aliases_new).
    // Stage 15 PR-M1-3: bumped to 9 (memory_feedback +
    // memory_recall_signals).
    // Stage 15 PR-M3-1: bumped to 10 (memory hierarchy:
    // tier, valid_from/until, memory_episodes).
    expect(parsed.to).toBe(11);
    store.close();
  });
});

