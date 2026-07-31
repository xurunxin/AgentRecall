// src/server-version.ts
//
// Stage 12 PR9 (spec § 6.3): every tool result carries
// `meta.server_version` and `meta.schema_version`. We
// resolve both lazily and cache them in module scope so we
// do not re-read the package on every call.
//
// Spec § 14 also says: "Server、package、CLI 和 export
// schema 使用同一版本源" — so this module is the single
// source of truth for the wire-level server version. The
// CLI command prints the same value, the MCP handshake
// reports it, and `meta.server_version` on every tool
// result reuses it.
//
// We deliberately do not import the `package.json` at
// build time (e.g. via `import pkg from "../package.json"`
// with `resolveJsonModule`); the project keeps
// `resolveJsonModule` off so that `tsc` is happy in
// deployment contexts where the package.json may not be
// next to the dist. Instead we read it once at module
// load and fall back to `0.0.0` if anything goes wrong —
// the wire-level version is informational, not security-
// critical.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FALLBACK_VERSION = "0.0.0";

function resolvePackageVersion(): string {
  // Bun-compiled binaries inject the package version at
  // build time via `--define process.env.AGENT_RECALL_VERSION='"X.Y.Z"'`
  // (see scripts/build-bun-binary.mjs). If present and
  // non-empty, prefer it: under the Bun binary,
  // `import.meta.url` resolves to a virtual path with no
  // package.json, so the walk below would fall through to
  // FALLBACK_VERSION. Under Node, this env var is unset
  // during normal use, and the package.json walk handles
  // resolution as before.
  const envVersion = process.env.AGENT_RECALL_VERSION;
  if (typeof envVersion === "string" && envVersion.length > 0) {
    return envVersion;
  }
  try {
    // Walk up from this file's location looking for a
    // package.json with a `name` matching this package.
    // We do not assume a fixed depth because tests and
    // bundles can be in different relative locations.
    const here = dirname(fileURLToPath(import.meta.url));
    let cursor = here;
    for (let depth = 0; depth < 6; depth += 1) {
      const candidate = resolve(cursor, "package.json");
      try {
        const text = readFileSync(candidate, "utf8");
        const parsed = JSON.parse(text) as { name?: unknown; version?: unknown };
        if (typeof parsed.name === "string" && parsed.name.length > 0 && typeof parsed.version === "string" && parsed.version.length > 0) {
          return parsed.version;
        }
      } catch {
        // Not a package.json or unreadable; keep walking.
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  } catch {
    // ignore — return fallback below
  }
  return FALLBACK_VERSION;
}

let cached: string | undefined;

export function serverVersion(): string {
  if (cached === undefined) {
    cached = resolvePackageVersion();
  }
  return cached;
}
