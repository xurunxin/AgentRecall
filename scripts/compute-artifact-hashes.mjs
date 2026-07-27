#!/usr/bin/env node
//
// scripts/compute-artifact-hashes.mjs
//
// Stage 18 v1.1.2 (issue #28, task 9): compute the
// SHA-256 hashes + sizes for the release archives
// produced by `.github/workflows/release.yml`. The
// `release-evidence.json` consumer
// (`scripts/verify-release-evidence.mjs`) needs the
// hash manifest to gate the `sha256_checksums` field;
// this script is the dependency-free producer.
//
// The script is intentionally dependency-free (Node 18+
// stdlib only): it relies on `node:crypto.createHash`
// and `node:fs` (no external tarball parsers, no
// `js-yaml`, no `undici`). The output is a JSON
// document of the shape the existing
// `release-evidence.mjs` script expects
// (`{ schema_version, candidate_sha, generated_at,
// artifacts: [{ platform, artifact_path, sha256,
// size_bytes, mtime }] }`).
//
// Usage (CI):
//
//   GITHUB_SHA=<sha> \
//   MATRIX_OS=<os> \
//   RELEASE_HASHES_OUTPUT=<path> \
//     node scripts/compute-artifact-hashes.mjs <artifact> [<artifact> ...]
//
// Exit codes:
//   0 - hashes written.
//   1 - missing args, missing artifact, or read failure.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

const sha = process.env.GITHUB_SHA ?? "local";
const platform = process.env.MATRIX_OS ?? process.platform;
const outputPath =
  process.env.RELEASE_HASHES_OUTPUT ?? "release-artifact-hashes.json";
const args = process.argv.slice(2);

function fail(message) {
  console.error(`compute-artifact-hashes: ${message}`);
  process.exit(1);
}

if (args.length === 0) {
  fail("usage: node scripts/compute-artifact-hashes.mjs <artifact> [...]");
}

const entries = [];
for (const artifactPath of args) {
  if (!existsSync(artifactPath)) {
    fail(`artifact not found: ${artifactPath}`);
  }
  const stats = statSync(artifactPath);
  if (!stats.isFile()) {
    fail(`artifact is not a regular file: ${artifactPath}`);
  }
  const content = readFileSync(artifactPath);
  const hash = createHash("sha256");
  hash.update(content);
  const sha256 = hash.digest("hex");
  entries.push({
    platform,
    artifact_path: artifactPath,
    sha256,
    size_bytes: stats.size,
    mtime: stats.mtime.toISOString()
  });
}

const output = {
  schema_version: 1,
  candidate_sha: sha,
  generated_at: new Date().toISOString(),
  artifacts: entries
};

writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(
  `compute-artifact-hashes: wrote ${entries.length} artifact(s) to ${outputPath} (candidate_sha=${sha})`
);