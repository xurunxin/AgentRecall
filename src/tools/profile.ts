// src/tools/profile.ts
//
// Stage 17 v1.1.2 (issue #22, spec § 5.5 + release
// plan Task 3): the MCP server's tool-profile
// selector. The selector reads the
// `AGENT_RECALL_PROFILE` env var at process
// startup, defaults to `core` (the safe,
// low-surface default for an unconfigured
// packaged server), and fail-closes on any
// other value. The selector is a single source
// of truth: `index.ts` consumes it to pick
// between `registerCoreTools` and
// `registerExtendedTools`, and `resources.ts`
// surfaces the resolved profile on
// `memory://health.active_profile`.
//
// The v1.1.2 contract pins three rules:
//
//   1. The packaged default is `core`.
//   2. `core` and `extended` are the only valid
//      values. `extended` is opt-in (the admin
//      surface is not enabled by default).
//   3. An unknown value is a startup error. The
//      error message names `AGENT_RECALL_PROFILE`
//      and lists the supported values so an
//      operator can recover without reading the
//      docs.
//
// This module is intentionally a leaf (no
// imports beyond the standard `process` types)
// so the selector can be reused by both the
// MCP server entry and the CLI without
// pulling in the broader tool registry.

export const PROFILE_NAMES = ["core", "extended"] as const;

export type ToolProfile = (typeof PROFILE_NAMES)[number];

/**
 * Validate a raw profile value. Returns the
 * canonical profile name on success; throws
 * an `Error` whose `message` includes the
 * env-var name and the supported values on
 * failure.
 *
 * The empty string and `undefined` are
 * treated as "operator did not set the env
 * var" and resolve to the documented default
 * (`core`). The error path is reserved for
 * values that the operator DID set but that
 * are not in the supported list (e.g.
 * `AGENT_RECALL_PROFILE=admin` or
 * `AGENT_RECALL_PROFILE=full`).
 */
export function selectToolProfile(value: string | undefined): ToolProfile {
  if (value === undefined || value === "") {
    return "core";
  }
  if ((PROFILE_NAMES as readonly string[]).includes(value)) {
    return value as ToolProfile;
  }
  throw new Error(
    `Invalid AGENT_RECALL_PROFILE value '${value}'. Supported values: ${PROFILE_NAMES.join(", ")}.`
  );
}

/**
 * Resolve the active tool profile from a
 * `ProcessEnv`-shaped object. Reads the
 * `AGENT_RECALL_PROFILE` key, trims it, and
 * delegates to `selectToolProfile`.
 *
 * `env` defaults to `process.env` but is
 * parameterised so the unit tests can drive
 * the selector without mutating the global
 * env.
 *
 * The empty string is treated as "operator
 * did not set the var" and falls through to
 * the documented Core default. A non-string
 * value (`null`, `undefined`, a number, an
 * object, an array) is a startup error: the
 * MCP server must NEVER silently fall back to
 * Core when the env var carries a malformed
 * value. The error message names the env var
 * and the supported values so an operator can
 * recover without reading the docs.
 */
export function resolveActiveProfile(env: NodeJS.ProcessEnv = process.env): ToolProfile {
  const raw = env.AGENT_RECALL_PROFILE;
  // The documented Core fallback is reserved for
  // "operator did not set the var" — that surfaces
  // as either `undefined` (the env key is absent)
  // or the empty string (the env key is present
  // but blank). Both are intentionally accepted
  // here. Anything else (a `null` from a test
  // double, a number from a misconfigured process
  // supervisor, an object from a JSON-encoded
  // env) is a startup error: the MCP server must
  // NEVER silently fall back to Core when the
  // env var carries a malformed value. The error
  // message names the env var and lists the
  // supported values so an operator can recover
  // without reading the docs.
  if (raw === undefined) {
    return selectToolProfile(undefined);
  }
  if (typeof raw !== "string") {
    throw new Error(
      `Invalid AGENT_RECALL_PROFILE value (non-string). Supported values: ${PROFILE_NAMES.join(", ")}.`
    );
  }
  const value = raw.trim();
  return selectToolProfile(value === "" ? undefined : value);
}
