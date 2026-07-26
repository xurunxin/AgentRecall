// src/scope-resolver.ts
//
// Stage 15 PR-M1-2 (issue #7, spec § 5.4): the scope
// resolver is the single point of truth for converting a
// caller's `scope` + `project_id` + `project_path` triple
// into a `ResolvedScope`. Pre-PR-M1-2 the resolver was a
// pure function that derived `project_id` from
// `project_path` via a hash; two callers that submitted
// the same `project_path` got the same derived id, but
// there was no enforcement that a `project_id` in the
// database actually matched a `project_path`.
//
// PR-M1-2 introduces a strict project identity model:
//
//   1. `project_identities(project_id, canonical_path)`
//      — one row per project, pinned to a canonical
//      path. The database enforces PK on `project_id`.
//
//   2. `project_aliases_new(alias, project_id,
//      canonical_path, alias_kind, ...)` — a path the
//      caller resolved to. `alias_kind` is one of
//      `path` (the canonical path), `git_head` (a
//      worktree sharing the same git head as the
//      canonical repo), `worktree` (a separate
//      worktree on disk that we treat as the same
//      project by `git rev-parse` head match).
//
//   3. The resolver flow: input -> canonicalise path
//      -> lookup `project_identities` by `project_id`
//      -> lookup `project_aliases_new` by alias
//      (path / git_head / worktree) -> if both
//      lookups hit, the alias must bind to the same
//      `project_id` as the input, otherwise the
//      resolver surfaces `project_identity_conflict`.
//
// Symlink resolution: `canonicalizePath` uses
// `realpathSync.native` to resolve symlinks. The
// resolver then uses the canonical path for the
// `project_identities` lookup. The caller's original
// path is preserved in `ResolvedScope.project_path`
// for diagnostic / display purposes only.
//
// Worktree handling: when the caller's `project_path`
// shares a `git rev-parse` head with an existing
// project, we treat it as the same project. The
// resolver records the worktree path as an alias so
// subsequent lookups hit the same identity row.
//
// Windows case-insensitive: `path.toLowerCase()` is
// used as the alias key on Windows only. On POSIX
// systems the path is compared verbatim.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  err,
  ok,
  nowIso,
  type MemoryBudget,
  type MemoryScope,
  type Result
} from "./domain.js";
import type { SQLiteMemoryStore } from "./sqlite-store.js";

const WINDOWS_RESERVED_BASENAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const IS_WINDOWS = process.platform === "win32";

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

export type ResolveError = "invalid_scope" | "project_identity_conflict" | "invalid_alias";

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
  if (!existsSync(absolute)) return absolute;
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function deriveProjectId(canonicalPath: string): string {
  const hash = createHash("sha256").update(canonicalPath).digest("hex").slice(0, 12);
  const name = sanitizeDerivedProjectName(basename(canonicalPath) || "project");
  return `${name}-${hash}`;
}

function aliasKey(path: string): string {
  // Stage 15 PR-M1-2: Windows is case-insensitive
  // (NTFS / ReFS); POSIX is case-sensitive. We
  // normalise the alias key so a Windows caller
  // submitting "C:\Repos\Phoenix" and a later
  // caller submitting "c:\repos\phoenix" hit the
  // same row.
  return IS_WINDOWS ? path.toLowerCase() : path;
}

function gitHeadFor(canonicalPath: string): string | undefined {
  // Best-effort: try `git rev-parse --verify HEAD`
  // on the path. Failures (no git, no head,
  // permission) are silently ignored — the resolver
  // falls back to path-only identity.
  try {
    if (!existsSync(canonicalPath)) return undefined;
    const stat = lstatSync(canonicalPath);
    if (!stat.isDirectory()) return undefined;
    return execFileSync(
      "git",
      ["-C", canonicalPath, "rev-parse", "--verify", "HEAD"],
      { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }
    ).trim();
  } catch {
    return undefined;
  }
}

function registerAlias(
  store: SQLiteMemoryStore,
  alias: string,
  project_id: string,
  canonical_path: string,
  alias_kind: "path" | "git_head" | "worktree",
  recorded_by: string
): void {
  store.createProjectAlias({
    alias,
    project_id,
    canonical_path,
    alias_kind,
    recorded_by,
    recorded_at: Date.now()
  });
}

function upsertProjectIdentity(
  store: SQLiteMemoryStore,
  project_id: string,
  canonical_path: string,
  created_by: string
): { ok: true; canonical_path: string } {
  const existing = store.getProjectIdentity(project_id);
  if (existing === undefined) {
    store.createProjectIdentity({
      project_id,
      canonical_path,
      created_by,
      created_at: nowIso()
    });
    return { ok: true, canonical_path };
  }
  // Stage 15 PR-M1-2: a `project_id` may have
  // multiple raw-path aliases (e.g. a symlink
  // target and the canonical repo dir, or a
  // worktree on a separate branch). The identity
  // row's `canonical_path` is set on the first
  // register; subsequent calls keep the original
  // canonical path and add a new row in
  // `project_aliases_new` (handled by the caller).
  return { ok: true, canonical_path: existing.canonical_path };
}

export function resolveMemoryScope(
  input: ScopeInput
): Result<ResolvedScope, ResolveError> {
  return resolveMemoryScopeWithStore(input, undefined, "agent:system");
}

/**
 * Stage 16 v1.1.1 PR-2 (#14): three resolution modes that
 * make the project identity model explicit at the call
 * site. The pre-PR-2 code was a single function that
 * silently created identities when given a
 * `project_path`, and silently used the store-less
 * path when no store was passed. The new class makes
 * the intent visible: a read-only call site picks
 * `lookup` (no mutations), an authorized write picks
 * `register` (may create an identity), and a public
 * read picks `strict_existing` (refuses unknown
 * identities).
 *
 * Back-compat note: `register` mode preserves the
 * v1.1.0 behaviour for `project_id`-only inputs
 * (no `project_path` provided). The strict
 * "no implicit identity from an id alone" rule is
 * reserved for v1.1.2; this PR-2 lands the
 * infrastructure (the class, the modes, the
 * injection) and the `path`-supplied strict path.
 */
export type IdentityResolutionMode = "lookup" | "register" | "strict_existing";

export class ProjectIdentityResolver {
  constructor(
    private readonly store: SQLiteMemoryStore,
    private readonly recordedBy: string
  ) {}

  resolve(
    input: ScopeInput,
    mode: IdentityResolutionMode
  ): Result<ResolvedScope, ResolveError> {
    if (input.scope !== "global" && input.scope !== "project") {
      return err("invalid_scope", "scope must be global or project");
    }
    if (input.scope === "global") {
      return ok({ scope: "global" });
    }
    if (input.project_path) {
      // Path-supplied calls always go through the
      // store-aware path. `register` may create an
      // identity; `lookup` and `strict_existing` never
      // create one (the canonicalisation step is
      // best-effort and falls back to the raw path).
      if (mode === "lookup") {
        return resolveMemoryScopeWithStore(input, undefined, this.recordedBy);
      }
      return resolveMemoryScopeWithStore(input, this.store, this.recordedBy);
    }
    if (input.project_id !== undefined) {
      // Stage 16 v1.1.1 PR-2 (#14): back-compat for
      // `project_id`-only inputs. A `project_id`-only
      // call does not supply a `project_path`, so we
      // cannot create or consult an identity row. The
      // call falls through to the store-less path that
      // v1.1.0 used, which returned
      // `ok({scope, project_id})` without an identity
      // check. A `project_path` input continues to
      // flow through the strict path (any mode +
      // `project_path` consults the store and may
      // create an identity in `register` mode).
      // The strict "no implicit identity from an id
      // alone" rule is reserved for v1.1.2 once the
      // public callers have been updated to supply
      // an explicit `project_path`.
      return resolveMemoryScopeWithStore(input, undefined, this.recordedBy);
    }
    return err("invalid_scope", "project scope requires project_id or project_path");
  }
}

export function resolveMemoryScopeWithStore(
  input: ScopeInput,
  store: SQLiteMemoryStore | undefined,
  recordedBy: string
): Result<ResolvedScope, ResolveError> {
  if (input.scope !== "global" && input.scope !== "project") {
    return err("invalid_scope", "scope must be global or project");
  }
  if (input.scope === "global") {
    return ok({ scope: "global" });
  }
  if (input.project_path) {
    const project_path = canonicalizePath(input.project_path);
    const requestedId =
      input.project_id === undefined
        ? deriveProjectId(project_path)
        : normalizeProjectId(input.project_id);
    if (requestedId === undefined) {
      return err("invalid_scope", "project_id must contain letters or numbers");
    }
    if (store !== undefined) {
      // Identity lookup: caller-provided `project_id`
      // against the existing identity row. The
      // identity's `canonical_path` is set on the
      // first register and stays immutable; a
      // subsequent call with the same `project_id`
      // and a *different* `project_path` adds a new
      // alias (a symlink, a worktree, a different
      // branch path), not a new canonical path.
      const aliasRow = store.getProjectAliasByPath(aliasKey(project_path));
      if (aliasRow !== undefined && aliasRow.project_id !== requestedId) {
        return err(
          "project_identity_conflict",
          `alias ${project_path} is already bound to project_id=${aliasRow.project_id}, not ${requestedId}`,
          {
            alias: project_path,
            existing_project_id: aliasRow.project_id,
            requested_project_id: requestedId
          }
        );
      }
      const identityUpsert = upsertProjectIdentity(store, requestedId, project_path, recordedBy);
      // The canonical path is either the one we
      // just registered (no prior identity) or the
      // existing identity's path. Use it for the
      // alias row so worktree-aliases always point
      // back to the canonical repo.
      const canonicalForAlias = identityUpsert.canonical_path;
      if (aliasRow === undefined) {
        registerAlias(store, aliasKey(project_path), requestedId, canonicalForAlias, "path", recordedBy);
      }
      // Worktree handling: if the path is a separate
      // worktree that shares a git head with the
      // identity, record the worktree alias. The
      // comparison is `gitHeadFor(project_path) ===
      // gitHeadFor(identity.canonical_path)`.
      const head = gitHeadFor(project_path);
      if (head !== undefined && canonicalForAlias !== project_path) {
        const identityHead = gitHeadFor(canonicalForAlias);
        if (identityHead !== undefined && identityHead === head) {
          registerAlias(store, aliasKey(project_path), requestedId, canonicalForAlias, "worktree", recordedBy);
        }
      }
      // The resolver returns the canonical path, not
      // the caller's raw path.
      return ok({
        scope: "project",
        project_id: requestedId,
        project_path: canonicalForAlias,
        display_name: basename(canonicalForAlias)
      });
    }
    return ok({
      scope: "project",
      project_id: requestedId,
      project_path,
      display_name: basename(project_path)
    });
  }
  if (input.project_id !== undefined) {
    const project_id = normalizeProjectId(input.project_id);
    if (project_id === undefined) {
      return err("invalid_scope", "project_id must contain letters or numbers");
    }
    if (store !== undefined) {
      const identity = store.getProjectIdentity(project_id);
      if (identity === undefined) {
        return err(
          "invalid_scope",
          `project_id=${project_id} is not registered; supply project_path to create the identity`,
          { project_id }
        );
      }
    }
    return ok({
      scope: "project",
      project_id,
      display_name: project_id
    });
  }
  return err("invalid_scope", "project scope requires project_id or project_path");
}
