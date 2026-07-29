import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CANONICAL_PLATFORMS, canonicalPlatform } from "./canonical-platforms.mjs";

const schema = JSON.parse(await readFile(new URL("./release-evidence.schema.json", import.meta.url), "utf8"));

test("schema pins v1.1.3 and canonical platforms", () => {
  assert.equal(schema.properties.schema_version.const, "1.1.3");
  assert.deepEqual(schema.$defs.platform.enum, CANONICAL_PLATFORMS);
});

test("legacy workflow tokens canonicalise", () => {
  assert.equal(canonicalPlatform("windows-x64"), "win32-x64");
  assert.equal(canonicalPlatform("macos-latest"), "darwin-x64");
  assert.equal(canonicalPlatform("unknown"), undefined);
});
