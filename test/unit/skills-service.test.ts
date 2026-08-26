// test/unit/skills-service.test.ts
//
// v1.2.0-alpha.2 (issue #53): unit tests for the
// type-specific `SkillService`. The contract
// under test:
//
//   importSkillMd   -- parse + write v1
//   appendSkillVersion -- CAS-style new version
//   search          -- lexical match (name + description + triggers)
//   get             -- envelope + head + body
//   exportSkillMd   -- canonical SKILL.md string
//
// Skill activation state is the asset envelope's
// `lifecycle_state`. The service does NOT have a
// separate "activate" verb.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION, SQLiteMemoryStore } from "../../src/sqlite-store.js";
import { SkillService } from "../../src/skills/service.js";
import { parseSkillMd } from "../../src/skills/skill-md.js";

const SHA256_A = "sha256:" + "a".repeat(64);
const SHA256_B = "sha256:" + "b".repeat(64);

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "lm-skills-")), "memory.sqlite");
}

function openStore(dbPath: string): SQLiteMemoryStore {
  return new SQLiteMemoryStore(dbPath);
}

function skillMd(opts: {
  name?: string;
  description?: string;
  triggers?: string[];
  body?: string;
}): string {
  const name = opts.name ?? "hello-world";
  const description = opts.description ?? "A small test skill";
  const body = opts.body ?? "# hello-world\n\nThis is the body.";
  const triggerBlock =
    opts.triggers && opts.triggers.length > 0
      ? `\ntriggers:\n${opts.triggers.map((t) => `  - ${t}`).join("\n")}`
      : "";
  return `---
name: ${name}
description: ${description}
schema_version: "1"${triggerBlock}
---

${body}`;
}

describe("SkillService (v1.2.0-alpha.2, issue #53)", () => {
  let dbPath: string;
  let store: SQLiteMemoryStore;
  let skills: SkillService;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = openStore(dbPath);
    skills = new SkillService(store);
    expect(store.getUserVersion()).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBe(19);
  });
  afterEach(() => {
    if (store !== undefined) {
      try {
        store.close();
      } catch {
        // already closed
      }
    }
    try {
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  describe("importSkillMd + show + export round-trip", () => {
    it("imports a SKILL.md, shows it, and exports the canonical bytes", () => {
      const md = skillMd({ name: "hello-world", description: "x" });
      const imported = skills.importSkillMd({
        skillMd: md,
        source: "manual",
        scope: "global",
        owner_actor_id: "user:test"
      });
      expect(imported.version).toBe(1);
      expect(imported.body_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
      const got = skills.get(imported.asset_id);
      expect(got).toBeDefined();
      if (got === undefined) return;
      expect(got.row.name).toBe("hello-world");
      expect(got.row.description).toBe("x");
      const exported = skills.exportSkillMd(imported.asset_id);
      expect(exported).toBe(got.row.skill_md_canonical);
      // The exported bytes should round-trip
      // through parseSkillMd.
      const parsed = parseSkillMd(exported ?? "");
      expect(parsed.frontmatter.name).toBe("hello-world");
    });

    it("import computes the correct body_hash (sha256 over canonical bytes)", () => {
      const md = skillMd({ name: "hello-world" });
      const imported = skills.importSkillMd({
        skillMd: md,
        source: "manual",
        scope: "global",
        owner_actor_id: "user:test"
      });
      // The body_hash is sha256 of the canonical
      // SKILL.md. The export is the canonical
      // bytes, so its hash must match.
      const exported = skills.exportSkillMd(imported.asset_id) ?? "";
      const expected = "sha256:" + createHash("sha256").update(exported).digest("hex");
      expect(imported.body_hash).toBe(expected);
    });
  });

  describe("appendSkillVersion", () => {
    it("appends a v2 with a CAS-style bump", () => {
      const md1 = skillMd({ name: "hello-world", description: "v1" });
      const r1 = skills.importSkillMd({
        skillMd: md1,
        source: "manual",
        scope: "global",
        owner_actor_id: "user:test"
      });
      const md2 = skillMd({ name: "hello-world", description: "v2" });
      const r2 = skills.appendSkillVersion({
        asset_id: r1.asset_id,
        skillMd: md2,
        created_by_actor_id: "user:test"
      });
      expect(r2.version).toBe(2);
      const got = skills.get(r1.asset_id, 2);
      expect(got?.row.description).toBe("v2");
    });

    it("rejects with cas_mismatch when expected_previous_version is stale", async () => {
      const md1 = skillMd({ name: "hello-world", description: "v1" });
      const r1 = skills.importSkillMd({
        skillMd: md1,
        source: "manual",
        scope: "global",
        owner_actor_id: "user:test"
      });
      // First, advance the envelope to v2 through
      // the SkillService.
      const md2 = skillMd({ name: "hello-world", description: "v2" });
      skills.appendSkillVersion({
        asset_id: r1.asset_id,
        skillMd: md2,
        created_by_actor_id: "user:test"
      });
      // The SkillService's public surface always
      // reads the current version before
      // appending, so the CAS check is at the
      // AssetService level. Drive a stale-version
      // append through the AssetService directly
      // to verify the CAS gate.
      const { AssetService } = await import("../../src/assets/service.js");
      const assets = new AssetService(store);
      try {
        assets.appendSkillVersion({
          asset_id: r1.asset_id,
          expected_previous_version: 1,
          body_hash: SHA256_A,
          name: "hello-world",
          created_by_actor_id: "user:test"
        });
        throw new Error("expected cas_mismatch");
      } catch (error) {
        const err = error as Error & { code?: string };
        expect(err.code).toBe("cas_mismatch");
      }
    });
  });

  describe("search", () => {
    it("matches against name, description, and triggers", () => {
      skills.importSkillMd({
        skillMd: skillMd({
          name: "alpha-skill",
          description: "first",
          triggers: ["alpha trigger"]
        }),
        source: "manual",
        scope: "global",
        owner_actor_id: "user:test"
      });
      skills.importSkillMd({
        skillMd: skillMd({
          name: "beta-skill",
          description: "second description has gamma",
          triggers: ["unrelated"]
        }),
        source: "manual",
        scope: "global",
        owner_actor_id: "user:test"
      });
      skills.importSkillMd({
        skillMd: skillMd({
          name: "gamma-skill",
          description: "third",
          triggers: ["delta"]
        }),
        source: "manual",
        scope: "global",
        owner_actor_id: "user:test"
      });

      // Name match.
      const byName = skills.search({ query: "alpha" });
      expect(byName.length).toBeGreaterThan(0);
      expect(byName.some((s) => s.name === "alpha-skill")).toBe(true);

      // Description match.
      const byDesc = skills.search({ query: "gamma" });
      expect(byDesc.length).toBeGreaterThan(0);
      // The description match (`second description has gamma`)
      // and the name match (`gamma-skill`) both qualify.
      const names = byDesc.map((s) => s.name).sort();
      expect(names).toContain("beta-skill");
      expect(names).toContain("gamma-skill");

      // Trigger match.
      const byTrigger = skills.search({ query: "delta" });
      expect(byTrigger.some((s) => s.name === "gamma-skill")).toBe(true);
    });

    it("does NOT return the full body in search results", () => {
      skills.importSkillMd({
        skillMd: skillMd({
          name: "alpha-skill",
          description: "a unique needle xq7",
          body: "# SECRET BODY that must not appear in search"
        }),
        source: "manual",
        scope: "global",
        owner_actor_id: "user:test"
      });
      const matches = skills.search({ query: "xq7" });
      expect(matches.length).toBe(1);
      const summary = matches[0]!;
      // The summary is a typed struct; it has
      // no `body` / `skill_md_canonical` field.
      const keys = Object.keys(summary);
      expect(keys).not.toContain("body");
      expect(keys).not.toContain("skill_md_canonical");
    });
  });

  describe("resource validation", () => {
    it("rejects a SKILL.md with type='binary' on a resource", () => {
      const md = `---
name: bad-resources
description: x
schema_version: "1"
resources:
  - { path: img.png, type: binary, media_type: image/png, sha256: ${SHA256_A} }
---

body`;
      try {
        skills.importSkillMd({
          skillMd: md,
          source: "manual",
          scope: "global",
          owner_actor_id: "user:test"
        });
        throw new Error("expected skill_invalid");
      } catch (error) {
        const err = error as Error & { code?: string };
        expect(err.code).toBe("skill_invalid");
      }
    });

    it("accepts type='text' and type='reference'", () => {
      const md = `---
name: good-resources
description: x
schema_version: "1"
resources:
  - { path: notes.md, type: text, media_type: text/markdown, sha256: ${SHA256_A} }
  - { path: "https://example.com/spec", type: reference, media_type: text/html, sha256: ${SHA256_B} }
---

body`;
      const r = skills.importSkillMd({
        skillMd: md,
        source: "manual",
        scope: "global",
        owner_actor_id: "user:test"
      });
      const got = skills.get(r.asset_id);
      const resources = JSON.parse(got?.row.resources_json ?? "[]") as Array<{
        type: string;
      }>;
      expect(resources.length).toBe(2);
      expect(resources.map((r2) => r2.type).sort()).toEqual(["reference", "text"]);
    });
  });
});
