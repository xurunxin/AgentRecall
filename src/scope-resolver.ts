import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { err, ok, type MemoryBudget, type MemoryScope, type Result } from "./domain.js";

export type ScopeInput = {
  scope: MemoryScope | string;
  project_id?: string;
  project_path?: string;
};

export type ResolvedScope = {
  scope: MemoryScope;
  project_id?: string;
  project_path?: string;
  display_name?: string;
  budget?: MemoryBudget;
};

function sanitizeProjectId(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-").slice(0, 96);
}

function canonicalizePath(projectPath: string): string {
  const absolute = resolve(projectPath);
  return existsSync(absolute) ? realpathSync.native(absolute) : absolute;
}

function deriveProjectId(canonicalPath: string): string {
  const hash = createHash("sha256").update(canonicalPath).digest("hex").slice(0, 12);
  const name = sanitizeProjectId(basename(canonicalPath) || "project");
  return `${name}-${hash}`;
}

export function resolveMemoryScope(input: ScopeInput): Result<ResolvedScope, "invalid_scope"> {
  if (input.scope !== "global" && input.scope !== "project") {
    return err("invalid_scope", "scope must be global or project");
  }
  if (input.scope === "global") {
    return ok({ scope: "global" });
  }
  if (input.project_path) {
    const project_path = canonicalizePath(input.project_path);
    return ok({
      scope: "project",
      project_id: input.project_id ? sanitizeProjectId(input.project_id) : deriveProjectId(project_path),
      project_path,
      display_name: basename(project_path)
    });
  }
  if (input.project_id) {
    return ok({
      scope: "project",
      project_id: sanitizeProjectId(input.project_id),
      display_name: sanitizeProjectId(input.project_id)
    });
  }
  return err("invalid_scope", "project scope requires project_id or project_path");
}
