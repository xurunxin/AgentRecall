#!/usr/bin/env node
//
// scripts/extract-release-artifact.mjs
//
// Stage 18 v1.1.2 (issue #28, task 9): extract a
// release archive produced by `.github/workflows/release.yml`
// into a clean directory the extracted-artifact lifecycle
// E2E (`test/blackbox/packaged-install.test.ts`) can
// launch. The script is the single source of truth for the
// platform-specific extraction command:
//
//   - Linux / macOS `.tar.gz`: Node spawns `tar -xzf`.
//   - Windows `.zip`: Node spawns PowerShell
//     `Expand-Archive -Path <artifact> -DestinationPath
//     <dir> -Force`. The PowerShell path is intentional:
//     the Windows runner image does NOT ship `unzip` on
//     PATH, so depending on `unzip` would silently break
//     the matrix leg (the same regression that the
//     Stage 16 PR-8 `agent-recall-*.zip` upload-glob fix
//     surfaced for `release.yml`).
//
// The script is intentionally dependency-free (Node 18+
// stdlib only). It rejects an extracted tree that is
// missing the canonical entry points
// (`dist/src/index.js` / `dist/bin/agent-recall.js` /
// `package.json`); a partial extraction is a release-gate
// blocker and must surface as a non-zero exit code so the
// CI workflow's `set -euo pipefail` halts the matrix leg.
//
// Usage (CI):
//
//   AGENT_RECALL_PACKAGED_ARTIFACT=<path> \
//   AGENT_RECALL_EXTRACT_DIR=<dir> \
//   AGENT_RECALL_PLATFORM=<linux|darwin|win32> \
//     node scripts/extract-release-artifact.mjs
//
// Exit codes:
//   0 - extracted and verified.
//   1 - missing env var, missing artifact, extraction
//       command failed, or extracted tree is missing one
//       of the canonical entry points.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";

const artifact = process.env.AGENT_RECALL_PACKAGED_ARTIFACT;
const extractDir = process.env.AGENT_RECALL_EXTRACT_DIR;
const platform = process.env.AGENT_RECALL_PLATFORM ?? process.platform;

function fail(message) {
  console.error(`extract-release-artifact: ${message}`);
  process.exit(1);
}

if (artifact === undefined || artifact.length === 0) {
  fail("AGENT_RECALL_PACKAGED_ARTIFACT is required");
}
if (extractDir === undefined || extractDir.length === 0) {
  fail("AGENT_RECALL_EXTRACT_DIR is required");
}
if (!existsSync(artifact)) {
  fail(`artifact not found: ${artifact}`);
}
// The extract directory is created fresh. A
// pre-existing directory would mean the CI job is
// reusing a stale path (the matrix leg runs on a
// clean `$RUNNER_TEMP` per matrix entry).
if (existsSync(extractDir)) {
  rmSync(extractDir, { recursive: true, force: true });
}
mkdirSync(extractDir, { recursive: true });

const lowerArtifact = artifact.toLowerCase();
const isTar =
  lowerArtifact.endsWith(".tar.gz") ||
  lowerArtifact.endsWith(".tgz") ||
  lowerArtifact.endsWith(".tar");
const isZip = lowerArtifact.endsWith(".zip");
if (!isTar && !isZip) {
  fail(
    `unrecognized archive format: ${artifact} (expected .tar.gz / .tgz / .tar / .zip)`
  );
}

function spawnAndWait(cmd, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", (error) => {
      reject(new Error(`${label} failed to start: ${error.message}`));
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(undefined);
      } else {
        reject(new Error(`${label} exited with code ${code ?? "null"}`));
      }
    });
  });
}

async function runExtract() {
  if (isTar) {
    // `tar -xzf <archive> -C <dir>` works on Linux,
    // macOS, and modern Windows (10+ ships BSD tar).
    // The matrix job's runner images all carry it.
    await spawnAndWait(
      "tar",
      ["-xzf", artifact, "-C", extractDir],
      "tar extraction"
    );
    return;
  }
  // .zip path. The Windows runner does NOT ship
  // `unzip` on PATH (the same surprise Stage 16 PR-8
  // surfaced for `release.yml`'s upload-glob). On
  // Windows we always go through PowerShell
  // `Expand-Archive`. On Linux / macOS we fall back
  // to the POSIX `unzip` (pre-installed on the
  // runner images).
  if (platform === "win32") {
    // Quote the artifact + destination so paths with
    // spaces survive the PowerShell call. PowerShell
    // single-quoted strings do not interpret
    // backticks / $vars, which is exactly the
    // behaviour we want here.
    await spawnAndWait(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${artifact}' -DestinationPath '${extractDir}' -Force`
      ],
      "powershell Expand-Archive"
    );
    return;
  }
  await spawnAndWait(
    "unzip",
    ["-q", "-o", artifact, "-d", extractDir],
    "unzip extraction"
  );
}

function verifyExtractedTree() {
  const canonical = [
    "dist/src/index.js",
    "dist/bin/agent-recall.js",
    "package.json"
  ];
  for (const rel of canonical) {
    // Node's `path.join` on Windows uses backslashes;
    // both forms are accepted by the file system, so
    // a literal forward-slash path resolves on every
    // platform. Using a literal keeps the cross-OS
    // check deterministic.
    const candidate = `${extractDir}/${rel}`;
    if (!existsSync(candidate)) {
      fail(`missing required file in extracted archive: ${candidate}`);
    }
  }
}

async function main() {
  await runExtract();
  verifyExtractedTree();
  console.log(
    `extract-release-artifact: extracted ${artifact} -> ${extractDir} (platform=${platform})`
  );
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});