import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveMemoryScope } from "../src/scope-resolver.js";

describe("resolveMemoryScope", () => {
  it("resolves global scope without project fields", () => {
    const result = resolveMemoryScope({ scope: "global" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.scope).toBe("global");
      expect(result.value.project_id).toBeUndefined();
    }
  });

  it("canonicalizes existing project paths and derives stable IDs", () => {
    const root = mkdtempSync(join(tmpdir(), "local-memory-mcp-"));
    const project = join(root, "repo");
    mkdirSync(project);
    const first = resolveMemoryScope({ scope: "project", project_path: project });
    const second = resolveMemoryScope({ scope: "project", project_path: join(project, ".") });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.project_id).toBe(second.value.project_id);
      expect(first.value.project_path).toBe(realpathSync.native(project));
    }
  });

  it("accepts explicit project_id for remote or not-yet-created paths", () => {
    const result = resolveMemoryScope({ scope: "project", project_id: "metronx-core" });
    expect(result).toMatchObject({
      ok: true,
      value: {
        scope: "project",
        project_id: "metronx-core"
      }
    });
  });

  it("rejects project scope without identity", () => {
    expect(resolveMemoryScope({ scope: "project" })).toMatchObject({
      ok: false,
      error: "invalid_scope"
    });
  });
});
