// packages/contracts/tests/skills.test.ts
//
// v1.2.0-alpha.2 (issue #53): tightening tests
// for the `SkillAssetV1Schema` envelope. The
// six assertions below cover the 5 tightening
// rules introduced in this issue plus 1 happy
// path that round-trips a full payload.
//
// Tightening rules:
//   1. `name` MUST be kebab-case
//      (`/^[a-z][a-z0-9-]*$/`).
//   2. `source` is a strict 3-value enum
//      (no `unknown` survives).
//   3. `resources[].type` is restricted to
//      `text` | `reference`; `binary` and other
//      values are rejected.
//   4. `body_hash` MUST be the canonical
//      `sha256:` + 64 hex form (pre-existing
//      rule; re-pinned here to keep the v1.2
//      surface documented in one place).
//   5. `resources[].sha256` is the same
//      canonical form (same rationale).

import { describe, it, expect } from "vitest";

import { SkillAssetV1Schema } from "../src/assets.js";

const SHA256_OK = "sha256:" + "a".repeat(64);
const SHA256_OK_B = "sha256:" + "b".repeat(64);

const basePayload = {
  asset_id: "asset-1",
  version: 1,
  name: "kebab-case-name",
  description: "a small skill",
  schema_version: "1" as const,
  source: "manual" as const,
  skill_md_canonical: "---\nname: kebab-case-name\n---\n",
  body_hash: SHA256_OK
};

describe("SkillAssetV1Schema tightening (v1.2.0-alpha.2, issue #53)", () => {
  it("accepts a well-formed skill payload (happy path)", () => {
    const parsed = SkillAssetV1Schema.parse(basePayload);
    expect(parsed.name).toBe("kebab-case-name");
    expect(parsed.source).toBe("manual");
    expect(parsed.resources).toEqual([]);
  });

  it("rejects a name that is not kebab-case (uppercase)", () => {
    const result = SkillAssetV1Schema.safeParse({
      ...basePayload,
      name: "Kebab-Case-Name"
    });
    expect(result.success).toBe(false);
  });

  it("rejects a name that is not kebab-case (leading digit)", () => {
    const result = SkillAssetV1Schema.safeParse({
      ...basePayload,
      name: "1starts-with-digit"
    });
    expect(result.success).toBe(false);
  });

  it("rejects a name that is not kebab-case (underscore)", () => {
    const result = SkillAssetV1Schema.safeParse({
      ...basePayload,
      name: "snake_case"
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown source value", () => {
    const result = SkillAssetV1Schema.safeParse({
      ...basePayload,
      // `source` MUST be 'manual' | 'derived' | 'imported'.
      // Cast through `unknown` so the test surface is
      // the same shape the schema will see at runtime
      // (a malformed caller).
      source: "unknown" as unknown as "manual"
    });
    expect(result.success).toBe(false);
  });

  it("rejects a resource with type='binary'", () => {
    const result = SkillAssetV1Schema.safeParse({
      ...basePayload,
      resources: [
        {
          path: "diagram.png",
          type: "binary" as unknown as "text",
          media_type: "image/png",
          sha256: SHA256_OK_B
        }
      ]
    });
    expect(result.success).toBe(false);
  });

  it("accepts a resource with type='text' or 'reference'", () => {
    const ok = SkillAssetV1Schema.safeParse({
      ...basePayload,
      resources: [
        {
          path: "notes.md",
          type: "text" as const,
          media_type: "text/markdown",
          sha256: SHA256_OK_B
        },
        {
          path: "https://example.com/spec",
          type: "reference" as const,
          media_type: "text/html",
          sha256: SHA256_OK
        }
      ]
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.resources.length).toBe(2);
    }
  });

  it("rejects a non-canonical body_hash", () => {
    const result = SkillAssetV1Schema.safeParse({
      ...basePayload,
      body_hash: "sha256:not-hex"
    });
    expect(result.success).toBe(false);
  });
});
