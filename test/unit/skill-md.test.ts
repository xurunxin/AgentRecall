// test/unit/skill-md.test.ts
//
// v1.2.0-alpha.2 (issue #53): unit tests for the
// canonical SKILL.md parser / formatter. The
// surface is two pure functions:
//
//   parseSkillMd(input)  -> ParsedSkill
//   formatSkillMd(p)     -> string (canonical bytes)
//
// The round-trip property is the contract:
// `parseSkillMd(formatSkillMd(parseSkillMd(x)))`
// is observationally identical to
// `parseSkillMd(x)` for any canonical `x`.

import { describe, expect, it } from "vitest";

import {
  formatSkillMd,
  parseSkillMd,
  SkillParseError
} from "../../src/skills/skill-md.js";

const MINIMAL = `---
name: hello-world
description: A small test skill
schema_version: "1"
---

# hello-world

This is the body.`;

describe("parseSkillMd / formatSkillMd (v1.2.0-alpha.2, issue #53)", () => {
  it("parses a minimal SKILL.md", () => {
    const parsed = parseSkillMd(MINIMAL);
    expect(parsed.frontmatter.name).toBe("hello-world");
    expect(parsed.frontmatter.description).toBe("A small test skill");
    expect(parsed.frontmatter.schema_version).toBe("1");
    expect(parsed.body_md).toContain("# hello-world");
  });

  it("rejects missing name", () => {
    const input = `---
description: missing name
schema_version: "1"
---

body`;
    expect(() => parseSkillMd(input)).toThrow(SkillParseError);
    try {
      parseSkillMd(input);
    } catch (e) {
      expect((e as SkillParseError).code).toBe("missing_name");
    }
  });

  it("rejects missing description", () => {
    const input = `---
name: hello-world
schema_version: "1"
---

body`;
    expect(() => parseSkillMd(input)).toThrow(SkillParseError);
    try {
      parseSkillMd(input);
    } catch (e) {
      expect((e as SkillParseError).code).toBe("missing_description");
    }
  });

  it("rejects a name that is not kebab-case (uppercase)", () => {
    const input = `---
name: HelloWorld
description: x
schema_version: "1"
---

body`;
    try {
      parseSkillMd(input);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SkillParseError);
      expect((e as SkillParseError).code).toBe("invalid_name");
    }
  });

  it("rejects a name that is not kebab-case (underscore)", () => {
    const input = `---
name: snake_case
description: x
schema_version: "1"
---

body`;
    try {
      parseSkillMd(input);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SkillParseError);
      expect((e as SkillParseError).code).toBe("invalid_name");
    }
  });

  it("rejects a name that is not kebab-case (leading digit)", () => {
    const input = `---
name: 1leading
description: x
schema_version: "1"
---

body`;
    try {
      parseSkillMd(input);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SkillParseError);
      expect((e as SkillParseError).code).toBe("invalid_name");
    }
  });

  it("rejects an invalid schema_version", () => {
    const input = `---
name: hello-world
description: x
schema_version: "2"
---

body`;
    try {
      parseSkillMd(input);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SkillParseError);
      expect((e as SkillParseError).code).toBe("invalid_schema_version");
    }
  });

  it("rejects an invalid source value", () => {
    const input = `---
name: hello-world
description: x
schema_version: "1"
source: agent_observed
---

body`;
    try {
      parseSkillMd(input);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SkillParseError);
      expect((e as SkillParseError).code).toBe("invalid_source");
    }
  });

  it("canonicalises CRLF to LF in the body", () => {
    const input =
      "---\r\nname: hello-world\r\ndescription: x\r\nschema_version: \"1\"\r\n---\r\n\r\n# title\r\n\r\nbody line\r\n";
    const parsed = parseSkillMd(input);
    // The body should be LF-only.
    expect(parsed.body_md).not.toContain("\r");
    expect(parsed.body_md).toContain("# title");
    expect(parsed.body_md).toContain("body line");
  });

  it("round-trip parse -> format -> parse is identity on canonical form", () => {
    const once = parseSkillMd(MINIMAL);
    const formatted = formatSkillMd(once);
    const twice = parseSkillMd(formatted);
    expect(twice.frontmatter.name).toBe(once.frontmatter.name);
    expect(twice.frontmatter.description).toBe(once.frontmatter.description);
    expect(twice.frontmatter.schema_version).toBe(once.frontmatter.schema_version);
    expect(twice.body_md).toBe(once.body_md);
  });

  it("preserves unknown frontmatter keys under the extension namespace", () => {
    const input = `---
name: hello-world
description: x
schema_version: "1"
priority: high
owner: team-platform
---

body`;
    const parsed = parseSkillMd(input);
    expect(parsed.frontmatter.extension).toBeDefined();
    expect(parsed.frontmatter.extension?.["priority"]).toBe("high");
    expect(parsed.frontmatter.extension?.["owner"]).toBe("team-platform");
    // The formatted output should round-trip the
    // namespaced keys.
    const formatted = formatSkillMd(parsed);
    const twice = parseSkillMd(formatted);
    expect(twice.frontmatter.extension?.["priority"]).toBe("high");
    expect(twice.frontmatter.extension?.["owner"]).toBe("team-platform");
  });

  it("canonicalises frontmatter key order (sorted alphabetically)", () => {
    const input = `---
schema_version: "1"
description: z
name: hello-world
---

body`;
    const parsed = parseSkillMd(input);
    const formatted = formatSkillMd(parsed);
    // description comes before name comes before
    // schema_version (alphabetical).
    const descIdx = formatted.indexOf("description:");
    const nameIdx = formatted.indexOf("name:");
    const schemaIdx = formatted.indexOf("schema_version:");
    expect(descIdx).toBeGreaterThan(0);
    expect(nameIdx).toBeGreaterThan(descIdx);
    expect(schemaIdx).toBeGreaterThan(nameIdx);
  });

  it("treats triggers as a list of strings", () => {
    const input = `---
name: hello-world
description: x
schema_version: "1"
triggers:
  - alpha
  - beta
  - "gamma delta"
---

body`;
    const parsed = parseSkillMd(input);
    expect(parsed.frontmatter.triggers).toEqual(["alpha", "beta", "gamma delta"]);
  });

  it("treats resources as a list of typed records", () => {
    const input = `---
name: hello-world
description: x
schema_version: "1"
resources:
  - { path: notes.md, type: text, media_type: text/markdown, sha256: sha256:0000000000000000000000000000000000000000000000000000000000000000 }
  - { path: "https://example.com/spec", type: reference, media_type: text/html, sha256: sha256:1111111111111111111111111111111111111111111111111111111111111111 }
---

body`;
    const parsed = parseSkillMd(input);
    expect(parsed.frontmatter.resources).toBeDefined();
    expect(parsed.frontmatter.resources?.length).toBe(2);
    expect(parsed.frontmatter.resources?.[0]?.type).toBe("text");
    expect(parsed.frontmatter.resources?.[1]?.type).toBe("reference");
  });

  it("rejects a resource with type='binary'", () => {
    const input = `---
name: hello-world
description: x
schema_version: "1"
resources:
  - { path: img.png, type: binary, media_type: image/png, sha256: sha256:0000000000000000000000000000000000000000000000000000000000000000 }
---

body`;
    try {
      parseSkillMd(input);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SkillParseError);
      expect((e as SkillParseError).code).toBe("invalid_resource_type");
    }
  });

  it("treats compatibility as an inline map", () => {
    const input = `---
name: hello-world
description: x
schema_version: "1"
compatibility:
  python: ">=3.10"
  os: linux
---

body`;
    const parsed = parseSkillMd(input);
    expect(parsed.frontmatter.compatibility).toEqual({
      python: ">=3.10",
      os: "linux"
    });
  });

  it("strips trailing whitespace and collapses 3+ blank lines to one", () => {
    const input =
      "---\nname: hello-world\ndescription: x\nschema_version: \"1\"\n---\n\n# title   \n\n\n\n\nbody line   \n";
    const formatted = formatSkillMd(parseSkillMd(input));
    expect(formatted).not.toContain("   \n");
    expect(formatted).not.toMatch(/\n{3,}/);
  });
});
