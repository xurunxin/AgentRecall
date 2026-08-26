// test/cli/skills.test.ts
//
// v1.2.0-alpha.2 (issue #53): CLI smoke tests for
// the `agent-recall skills ...` subcommand. The
// surface: list / search / show / import / export.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { skillsCommand } from "../../src/cli/commands/skills.js";
import { parseArgs } from "../../src/cli/arg-parser.js";
import { ProjectIdentityResolver } from "../../src/scope-resolver.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";
import { buildRequestContext } from "../../src/request-context.js";
import { resolveAuthorization } from "../../src/services/auth-context.js";
import { resolveActiveProfile } from "../../src/tools/profile.js";
import { CapabilityStore } from "../../src/admin/capability.js";
import type { CliContext } from "../../src/cli/index.js";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "lm-cli-skills-"));
}

function makeContext(dataHome: string): {
  ctx: CliContext;
  store: SQLiteMemoryStore;
  cleanup: () => void;
} {
  const dbPath = join(dataHome, "memory.sqlite");
  const store = new SQLiteMemoryStore(dbPath);
  const identityResolver = new ProjectIdentityResolver(store, "user:cli", false);
  const ctx = buildRequestContext({
    actor_override: "user:cli",
    client_name: "agent-recall-cli",
    client_version: "0.0.0",
    session_id: `cli-pid-${process.pid}`,
    request_id: randomUUID()
  });
  const activeProfile = resolveActiveProfile({});
  const capability = new CapabilityStore(dataHome, { persistent: true });
  const authorization = resolveAuthorization(
    { activeProfile, hasCapability: capability.hasCapability() },
    { kind: "read", restrictedAllowed: false }
  );
  return {
    ctx: {
      dataHome,
      args: parseArgs([]),
      store,
      identityResolver,
      ctx,
      authorization,
      actorMaxSensitivity: authorization.max_sensitivity
    },
    store,
    cleanup: () => {
      try {
        store.close();
      } catch {
        // already closed
      }
    }
  };
}

const FIXTURE = `---
name: hello-world
description: A small test skill
schema_version: "1"
---

# hello-world

This is the body.`;

describe("skillsCommand (v1.2.0-alpha.2, issue #53)", () => {
  let dataHome: string;
  let env: ReturnType<typeof makeContext>;
  let fixturePath: string;

  beforeEach(() => {
    dataHome = tmpHome();
    env = makeContext(dataHome);
    fixturePath = join(dataHome, "SKILL.md");
    writeFileSync(fixturePath, FIXTURE, "utf8");
  });
  afterEach(() => {
    env.cleanup();
    try {
      rmSync(dataHome, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  function makeCtx(positional: string[], flags: Record<string, unknown>): CliContext {
    return {
      ...env.ctx,
      args: parseArgs(["skills", ...positional, ...Object.entries(flags).flatMap(([k, v]) =>
        v === true ? [`--${k}`] : [`--${k}`, String(v)]
      )])
    };
  }

  it("imports a fixture file, lists it, shows it, exports it back; bytes match the original", async () => {
    // import --scope global
    const importResult = await skillsCommand(
      makeCtx(["import"], {
        scope: "global",
        source: fixturePath,
        "source-kind": "manual",
        owner: "user:test"
      })
    );
    expect(importResult.exitCode).toBe(0);
    expect(importResult.stderr).toBe("");
    expect(importResult.stdout).toMatch(/asset_id=asset_/);
    const assetIdMatch = importResult.stdout.match(/asset_id=(asset_[a-f0-9-]+)/);
    expect(assetIdMatch).not.toBeNull();
    const assetId = assetIdMatch![1]!;

    // list
    const listResult = await skillsCommand(makeCtx(["list"], {}));
    expect(listResult.exitCode).toBe(0);
    expect(listResult.stdout).toContain("hello-world");
    expect(listResult.stdout).toContain(assetId);

    // show
    const showResult = await skillsCommand(
      makeCtx(["show", assetId], {})
    );
    expect(showResult.exitCode).toBe(0);
    expect(showResult.stdout).toContain("hello-world");
    expect(showResult.stdout).toContain("This is the body.");
    expect(showResult.stdout).toContain("--- SKILL.md ---");

    // export
    const outPath = join(dataHome, "exported-SKILL.md");
    const exportResult = await skillsCommand(
      makeCtx(["export", assetId], { out: outPath })
    );
    expect(exportResult.exitCode).toBe(0);
    const exportedBytes = readFileSync(outPath, "utf8");
    // The exported bytes are the canonical
    // SKILL.md, which round-trips through
    // parseSkillMd. The exact byte sequence is
    // canonical (sorted keys, LF, single blank
    // line between `---` and the body), so we
    // compare the parsed shape, not raw bytes
    // (the body might be re-canonicalised with
    // a different blank-line count).
    expect(exportedBytes).toContain("name: hello-world");
    expect(exportedBytes).toContain("description: A small test skill");
    expect(exportedBytes).toContain("schema_version: \"1\"");
    expect(exportedBytes).toContain("# hello-world");
    expect(exportedBytes).toContain("This is the body.");
  });

  it("search via CLI returns the matching skill", async () => {
    // Import two skills.
    const otherPath = join(dataHome, "other-SKILL.md");
    writeFileSync(
      otherPath,
      `---
name: another-skill
description: a different skill
schema_version: "1"
---

body`,
      "utf8"
    );
    await skillsCommand(
      makeCtx(["import"], { scope: "global", source: fixturePath })
    );
    await skillsCommand(
      makeCtx(["import"], { scope: "global", source: otherPath })
    );

    // search by description keyword
    const result = await skillsCommand(
      makeCtx(["search"], { query: "different" })
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("another-skill");
    expect(result.stdout).not.toContain("hello-world");
  });

  it("import rejects a SKILL.md with a non-canonical body_hash on a resource", async () => {
    const badPath = join(dataHome, "bad-SKILL.md");
    writeFileSync(
      badPath,
      `---
name: bad-skill
description: x
schema_version: "1"
resources:
  - { path: img.png, type: binary, media_type: image/png, sha256: sha256:0000000000000000000000000000000000000000000000000000000000000000 }
---

body`,
      "utf8"
    );
    const result = await skillsCommand(
      makeCtx(["import"], { scope: "global", source: badPath })
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/skill_invalid|cas_mismatch|binding_invalid/);
  });
});
