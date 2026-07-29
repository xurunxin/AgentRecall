import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("release evidence schema", () => {
  const schema = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../scripts/release-evidence.schema.json"), "utf8"));
  it("pins schema version 1.1.3", () => expect(schema.properties.schema_version.const).toBe("1.1.3"));
  it("uses canonical platforms", () => expect(schema.$defs.platform.enum).toEqual(["linux-x64", "darwin-x64", "win32-x64"]));
  it("requires checksums as an object", () => expect(schema.properties.sha256_checksums.type).toBe("object"));
});
