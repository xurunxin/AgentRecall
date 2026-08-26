#!/usr/bin/env node
// scripts/build-bun-binary.mjs
//
// Build single-file Bun executables for each canonical platform.
// One binary per (platform, kind) tuple where kind ∈ { cli, mcp }.
//
// Prereq: `bun --version` returns >= 1.3.0 on PATH. The script
// asserts this and exits non-zero with a clear message if not.
//
// Output:
//   dist-bin/agent-recall-<plat>[.exe]
//   dist-bin/agent-recall-mcp-<plat>[.exe]
//   dist-bin/MANIFEST.json  ({bun_version, source_sha, entries[]})
//
// The script is idempotent: re-running overwrites the binaries
// and the MANIFEST.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const PLATFORMS = ["linux-x64", "darwin-x64", "darwin-arm64", "win32-x64"];
const OUT_DIR = "dist-bin";

// --- Bun version gate ---
const bunVersion = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
const [maj, min] = bunVersion.split(".").map((s) => Number.parseInt(s, 10));
if (!(maj > 1 || (maj === 1 && min >= 3))) {
  console.error(`build-bun-binary: bun ${bunVersion} is too old; need >= 1.3.0`);
  process.exit(2);
}

// --- Pre-transpile to dist/ (the MCP binary must be JS) ---
// Repo convention (see scripts/run-test-suites.mjs,
// scripts/synthesize-vitest-failures.mjs): on Windows, `npx` resolves
// via `PATHEXT` to `npx.cmd`/`npx.ps1`. Without `shell: true`, Node's
// execFileSync only looks for `npx.exe` and fails with ENOENT. POSIX
// uses execFileSync directly.
execFileSync("npx", ["tsc", "-p", "tsconfig.json"], {
  stdio: "inherit",
  shell: process.platform === "win32"
});
// v1.2.0 release: the workspace package
// (`@agent-recall/contracts`) ships its own
// compiled JS under `packages/contracts/dist/`.
// The binary's launcher imports the package by
// its `main` field; the prior v1.1.x layout
// pointed `main` at `./src/index.ts`, which
// Node (and Bun's embedded resolver) cannot
// import as plain JS. The release-time build
// now compiles the contracts package so the
// `dist/index.js` entry point is present when
// the binary runs. The `composite: true` flag
// on the contracts tsconfig already wires
// incremental build through the root
// tsconfig's `references`, but the root
// `tsc -p tsconfig.json` invocation is
// effectively project-isolated; we still need
// the explicit package-level build below to
// make the `dist/` directory discoverable from
// the binary's `node_modules/@agent-recall/contracts/`.
execFileSync("npx", ["tsc", "-p", "packages/contracts/tsconfig.json"], {
  stdio: "inherit",
  shell: process.platform === "win32"
});

// --- Source SHA: package.json + all .ts files under src/ + bin/ ---
function sha256File(p) {
  const h = createHash("sha256");
  h.update(readFileSync(p));
  return h.digest("hex");
}
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const sourceFiles = [
  "package.json",
  ...execFileSync("git", ["ls-files", "src", "bin"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((f) => f.endsWith(".ts")),
];
const sourceSha = createHash("sha256");
for (const f of sourceFiles) {
  sourceSha.update(f + "\0" + sha256File(f) + "\0");
}
const SOURCE_SHA = sourceSha.digest("hex");

// --- Build ---
mkdirSync(OUT_DIR, { recursive: true });
const entries = [];
const failures = [];

for (const plat of PLATFORMS) {
  const ext = plat.startsWith("win32") ? ".exe" : "";
  const bunTarget = `bun-${plat}`;

    for (const [kind, entry, src] of [
      [
        "cli",
        `agent-recall-${plat}${ext}`,
        // v1.1.4: both Bun artifacts are
        // compiled from the unified launcher.
        // The dispatcher resolves the
        // canonical vs. compatibility name
        // at runtime via argv[0]. The
        // manifest `kind` field stays as
        // "cli" / "mcp" so the existing
        // release verifier does not need
        // to change shape.
        "dist/src/launcher.js"
      ],
      [
        "mcp",
        `agent-recall-mcp-${plat}${ext}`,
        "dist/src/launcher.js"
      ]
    ]) {
    const outfile = join(OUT_DIR, entry);
    console.log(`build-bun-binary: ${bunTarget} ${kind} -> ${outfile}`);
    // Per the brief: a non-host platform may fail (Bun cross-compile
    // download or "cross-compile not supported"). Tolerate per-platform
    // failure and continue so the host platform still gets built.
    // Failures are NOT silently swallowed: they are logged to stderr
    // and recorded in the manifest's entries.
    try {
      execFileSync(
        "bun",
        [
          "build",
          "--compile",
          `--target=${bunTarget}`,
          // v1.2.0 release: workspace package
          // (`@agent-recall/contracts`) is a sibling
          // directory, not embedded in the bundle.
          // Without `--external` Bun tries to resolve
          // the import from the binary's working
          // directory's `node_modules/`, which only
          // works when the operator runs the binary
          // from the repo root. Marking every
          // `@agent-recall/*` specifier + the node
          // built-ins as external keeps the binary
          // resolution identical to the source-mode
          // `pnpm` resolution. Node built-ins are
          // externalised defensively so the binary
          // does not embed a stale copy.
          "--external",
          "@agent-recall/contracts",
          "--external",
          "@agent-recall/*",
          "--external",
          "node:*",
          "--define",
          `process.env.AGENT_RECALL_VERSION='${pkg.version}'`,
          "--outfile",
          outfile,
          src
        ],
        { stdio: "inherit" }
      );
      const size = statSync(outfile).size;
      const sha256 = sha256File(outfile);
      entries.push({ platform: plat, kind, path: outfile, size, sha256, status: "ok" });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.error(`build-bun-binary: ${bunTarget} ${kind} FAILED: ${message}`);
      entries.push({ platform: plat, kind, path: outfile, status: "failed", error: message });
      failures.push({ plat, kind });
    }
  }
}

// --- Manifest ---
const manifest = {
  bun_version: bunVersion,
  source_sha: SOURCE_SHA,
  generated_at: new Date().toISOString(),
  entries
};
writeFileSync(join(OUT_DIR, "MANIFEST.json"), JSON.stringify(manifest, null, 2));
console.log(`build-bun-binary: wrote ${entries.length} entries + MANIFEST.json`);
if (failures.length > 0) {
  console.error(`build-bun-binary: ${failures.length} build(s) failed:`);
  for (const f of failures) {
    console.error(`  - ${f.plat} ${f.kind}`);
  }
  process.exit(1);
}
process.exit(0);
