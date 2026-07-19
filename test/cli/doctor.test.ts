import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doctorCommand } from "../../src/cli/commands/doctor.js";
import { parseArgs } from "../../src/cli/arg-parser.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";

function setup() {
  const dataHome = mkdtempSync(join(tmpdir(), "lm-cli-doctor-"));
  const store = new SQLiteMemoryStore(join(dataHome, "memory.sqlite"));
  return { dataHome, store };
}

describe("doctorCommand", () => {
  it("returns exitCode 0 on a healthy empty database", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["doctor"]);
    const result = doctorCommand({ dataHome, args, store });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[");
    expect(result.stdout).toContain("Summary");
    store.close();
  });

  it("emits JSON with --json", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["doctor", "--json"]);
    const result = doctorCommand({ dataHome, args, store });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.exit_code).toBeDefined();
    store.close();
  });

  it("respects --no-color", () => {
    const { dataHome, store } = setup();
    const args = parseArgs(["doctor", "--no-color"]);
    const result = doctorCommand({ dataHome, args, store });
    expect(result.stdout).not.toContain("\x1b[");
    store.close();
  });

  it("warns on schema version drift (v1)", () => {
    const { dataHome, store } = setup();
    store.setUserVersion(1);
    const args = parseArgs(["doctor", "--json"]);
    const result = doctorCommand({ dataHome, args, store });
    const parsed = JSON.parse(result.stdout);
    const schema = parsed.results.find((r: { name: string }) => r.name === "schema_version");
    expect(schema.status).toBe("warn");
    expect(result.exitCode).toBe(1);
    store.close();
  });
});
