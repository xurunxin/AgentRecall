import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { err, ok, type MemoryBudget, type MemoryScope, type Result } from "./domain.js";

const WINDOWS_RESERVED_BASENAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

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

function isWindowsUnsafeProjectId(value: string): boolean {
  return value.endsWith(".") || WINDOWS_RESERVED_BASENAMES.test(value.split(".")[0] ?? "");
}

function normalizeProjectId(value: string): string | undefined {
  const sanitized = sanitizeProjectId(value);
  return /[A-Za-z0-9]/.test(sanitized) && !isWindowsUnsafeProjectId(sanitized) ? sanitized : undefined;
}

function sanitizeDerivedProjectName(value: string): string {
  const sanitized = sanitizeProjectId(value).replace(/\.+$/g, "");
  return /[A-Za-z0-9]/.test(sanitized) && !isWindowsUnsafeProjectId(sanitized) ? sanitized : "project";
}

function canonicalizePath(projectPath: string): string {
  const absolute = resolve(projectPath);
  return existsSync(absolute) ? realpathSync.native(absolute) : absolute;
}

function deriveProjectId(canonicalPath: string): string {
  const hash = createHash("sha256").update(canonicalPath).digest("hex").slice(0, 12);
  const name = sanitizeDerivedProjectName(basename(canonicalPath) || "project");
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
    const project_id = input.project_id === undefined ? deriveProjectId(project_path) : normalizeProjectId(input.project_id);
    if (project_id === undefined) {
      return err("invalid_scope", "project_id must contain letters or numbers");
    }
    return ok({
      scope: "project",
      project_id,
      project_path,
      display_name: basename(project_path)
    });
  }
  if (input.project_id !== undefined) {
    const project_id = normalizeProjectId(input.project_id);
    if (project_id === undefined) {
      return err("invalid_scope", "project_id must contain letters or numbers");
    }
    return ok({
      scope: "project",
      project_id,
      display_name: project_id
    });
  }
  return err("invalid_scope", "project scope requires project_id or project_path");
}
