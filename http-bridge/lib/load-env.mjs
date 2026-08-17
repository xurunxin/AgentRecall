// load-env.mjs — pure env-file parsing + lookup-chain resolution
// for the agent-recall HTTP bridge.
//
// Two responsibilities, both pure and dependency-free (so they're
// trivially unit-testable in vitest without spawning node):
//
//   1) parseEnvText(text) — given the contents of a .env or
//      .bridge.env file, return a flat {KEY: VALUE} object.
//      Supports both formats:
//        - standard .env: KEY=VALUE, # comments, optional `export`,
//          "..." or '...' quoted values, trailing inline comments
//        - JSON object: {"KEY": "VALUE", ...}
//
//   2) resolveEnvSearchPath(opts) — given the runtime context
//      (execPath, explicit override, dev __dirname), return the
//      canonical path that should be loaded.  The search order
//      matches the docs at the top of bridge.mjs:
//
//        1) AGENT_RECALL_BRIDGE_ENV_FILE  (explicit override)
//        2) <exe-dir>/.env                 (binary mode, standard .env)
//        3) <exe-dir>/.bridge.env          (binary mode, JSON variant)
//        4) <devDir>/.bridge.env           (dev / node mode)
//
//   "Binary mode" is detected via the execPath basename; the dev
//   fallback only fires for `node bridge.mjs` style runs.
//
// applyEnvToProcess(entries, target=process.env) — write the parsed
// entries onto a target object (default process.env).  The env file
// is AUTHORITATIVE: existing keys are OVERWRITTEN, matching dotenv
// semantics and the long-standing contract that .bridge.env is the
// single source of truth (see commit history around install script).

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Parse the text of a .env or .bridge.env file into a flat
 * {KEY: VALUE} object.  The format is auto-detected from the first
 * non-whitespace character: `{` means JSON, anything else is parsed
 * as the standard .env format.
 *
 * @param {string} text  Raw file contents.
 * @returns {Record<string, string>}
 */
export function parseEnvText(text) {
  const trimmed = (text ?? "").trimStart();
  if (!trimmed) return {};

  if (trimmed.startsWith("{")) {
    // JSON variant — explicit object with quoted keys.
    const data = JSON.parse(text);
    /** @type {Record<string, string>} */
    const out = {};
    for (const [k, v] of Object.entries(data)) {
      out[k] = String(v);
    }
    return out;
  }

  // Standard .env: KEY=VALUE per line, with the usual allowances
  // for comments, `export`, quotes, and trailing inline comments.
  /** @type {Record<string, string>} */
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    // Strip trailing inline comments for unquoted values only:
    //   FOO=bar # this is a comment
    // is "FOO=bar" (the " # this is a comment" is dropped) but
    //   FOO="bar # literal"  (quoted)
    // is left alone.
    if (!m[2].startsWith('"') && !m[2].startsWith("'")) {
      const hashIdx = v.indexOf(" #");
      if (hashIdx >= 0) v = v.slice(0, hashIdx).trim();
    }
    out[m[1]] = v;
  }
  return out;
}

/**
 * Decide which env file to load, given the runtime context.
 *
 * @param {object} opts
 * @param {string} [opts.envFileOverride]  AGENT_RECALL_BRIDGE_ENV_FILE
 * @param {string} opts.execPath            process.execPath
 * @param {string} opts.devDir              __dirname-equivalent in dev mode
 * @returns {{ path: string, source: string } | null}
 *   `source` is one of "override" | "exe-dotenv" | "exe-json" | "dev-json".
 *   Returns null when no candidate exists.
 */
export function resolveEnvSearchPath({ envFileOverride, execPath, devDir }) {
  if (envFileOverride) {
    if (existsSync(envFileOverride)) {
      return { path: envFileOverride, source: "override" };
    }
    return null;
  }

  const isBinaryMode = /agent-recall-http-bridge/.test(execPath ?? "");
  if (isBinaryMode) {
    const exeDir = dirname(execPath);
    const dotenv = join(exeDir, ".env");
    if (existsSync(dotenv)) return { path: dotenv, source: "exe-dotenv" };
    const jsonenv = join(exeDir, ".bridge.env");
    if (existsSync(jsonenv)) return { path: jsonenv, source: "exe-json" };
    return null;
  }

  // Dev mode (node bridge.mjs)
  const devEnv = join(devDir, ".bridge.env");
  if (existsSync(devEnv)) return { path: devEnv, source: "dev-json" };
  return null;
}

/**
 * Apply the parsed entries to a target object.  Existing keys are
 * OVERWRITTEN (dotenv semantics: the env file is authoritative).
 *
 * @param {Record<string, string>} entries
 * @param {Record<string, string | undefined>} [target]
 * @returns {string[]}  the keys that were written
 */
export function applyEnvToProcess(entries, target = process.env) {
  const written = [];
  for (const [k, v] of Object.entries(entries)) {
    target[k] = v;
    written.push(k);
  }
  return written;
}
