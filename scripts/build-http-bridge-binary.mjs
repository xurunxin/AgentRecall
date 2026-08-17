#!/usr/bin/env node
//
// scripts/build-http-bridge-binary.mjs
//
// Build a single-file Bun executable for the http-bridge.
//
// Output:
//   dist-bin/agent-recall-http-bridge-<plat>[.exe]
//
// The bridge reads .bridge.env next to its CWD (set by the install
// script's WorkingDirectory) and starts an HTTP MCP server on the
// requested port.  Bundling the whole dist/ tree lets the binary run
// on hosts without Node.js / a checkout of the source tree.
//
// Prereq: `bun --version` returns >= 1.3.0 on PATH.  Cross-compile
// targets are attempted and skipped on failure (per-platform
// toleration, same as scripts/build-bun-binary.mjs).

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, statSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";

const PLATFORMS = process.env.BRIDGE_PLATFORMS
  ? process.env.BRIDGE_PLATFORMS.split(",")
  : [process.platform === "win32" ? "win32-x64" : "linux-x64"];

const OUT_DIR = "dist-bin";
const ENTRY = "http-bridge/bridge.mjs";
const KIND = "http-bridge";

// --- Bun version gate ---
const bunVersion = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
const [maj, min] = bunVersion.split(".").map((s) => Number.parseInt(s, 10));
if (!(maj > 1 || (maj === 1 && min >= 3))) {
  console.error(`build-http-bridge-binary: bun ${bunVersion} is too old; need >= 1.3.0`);
  process.exit(2);
}

if (!existsSync(ENTRY)) {
  console.error(`build-http-bridge-binary: missing entrypoint ${ENTRY}`);
  process.exit(2);
}

function sha256File(p) {
  const h = createHash("sha256");
  h.update(readFileSync(p));
  return h.digest("hex");
}

// --- Source SHA: bridge.mjs + the project dist/ it depends on ---
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const sourceFiles = [ENTRY];
// Include every .js file under dist/src/ that bridge.mjs reaches via
// dynamic import (src/index.js, src/admin/capability.js, src/actor.js,
// src/scope-resolver.js, src/services/auth-context.js, src/mcp/resources.js,
// src/tools/register-tools.js).  Hash the whole dist/src tree so the
// manifest reflects the bundled bytecode provenance.
function walk(dir) {
  const out = [];
  for (const e of readFileSync(dir, "utf8") ? null : null) ; // (no-op, kept for symmetry)
  return out;
}
import { readdirSync } from "node:fs";
function listJs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name.endsWith(".js")) out.push(full);
    else if (readdirSync(full, { withFileTypes: true }).some((d) => d.isDirectory())) {
      out.push(...listJs(full));
    }
  }
  return out;
}
if (existsSync("dist/src")) {
  sourceFiles.push(...listJs("dist/src"));
}
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
  const outfile = join(OUT_DIR, `agent-recall-${KIND}-${plat}${ext}`);

  console.log(`build-http-bridge-binary: ${bunTarget} -> ${outfile}`);
  try {
    execFileSync(
      "bun",
      [
        "build",
        "--compile",
        `--target=${bunTarget}`,
        // bake the package version into the binary so /health style
        // surfaces can report it without a sidecar
        "--define",
        `process.env.AGENT_RECALL_VERSION='${pkg.version}'`,
        // v1.1.6 follow-up: hide the console window when the binary
        // is launched by Task Scheduler / RunKey / Startup shortcut.
        // Sets the PE subsystem to WINDOWS so Windows doesn't
        // allocate a console for the child; the bridge's stderr
        // (where the env-load line, request logs, and errors go) is
        // still written — it just doesn't open a visible window.
        // (No-op on non-Windows targets.)
        ...(plat.startsWith("win32")
          ? [
              "--windows-hide-console",
              // Title the binary so it shows up with a sensible name
              // in Task Manager / schtasks /query, not "Bun".
              "--windows-title=agent-recall HTTP MCP bridge",
              "--windows-description=agent-recall HTTP MCP bridge (Streamable HTTP, localhost)",
            ]
          : []),
        // bridge reads from ./.bridge.env; baking CWD is unsafe (the
        // install script sets WorkingDirectory on Task Scheduler), so
        // leave it dynamic
        "--outfile", outfile,
        ENTRY
      ],
      { stdio: "inherit" }
    );
    const size = statSync(outfile).size;
    const sha256 = sha256File(outfile);
    entries.push({ platform: plat, kind: KIND, path: outfile, size, sha256, status: "ok" });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error(`build-http-bridge-binary: ${bunTarget} FAILED: ${message}`);
    entries.push({ platform: plat, kind: KIND, path: outfile, status: "failed", error: message });
    failures.push(plat);
  }
}

// --- Manifest (append-only; the project may already have its own) ---
const manifestPath = join(OUT_DIR, "MANIFEST.json");
let existing = { entries: [] };
if (existsSync(manifestPath)) {
  try { existing = JSON.parse(readFileSync(manifestPath, "utf8")); } catch {}
}
const filtered = (existing.entries || []).filter((e) => e.kind !== KIND);
const manifest = {
  ...existing,
  bridge_binary_generated_at: new Date().toISOString(),
  bridge_binary_bun_version: bunVersion,
  bridge_binary_source_sha: SOURCE_SHA,
  bridge_binary_entry: ENTRY,
  entries: [...filtered, ...entries]
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`build-http-bridge-binary: wrote ${entries.length} entries to MANIFEST.json`);

if (failures.length > 0) {
  console.error(`build-http-bridge-binary: ${failures.length} build(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
process.exit(0);
