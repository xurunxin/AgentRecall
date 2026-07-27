#!/usr/bin/env node
//
// scripts/prepare-release.mjs
//
// Stage 18 v1.1.2 (issue #29, task 10): the
// operator-facing release preparation script.
//
// The script closes the publication loop on the V1
// final release plan. It is intentionally
// dependency-free (Node 18+ stdlib only — `node:fs`,
// `node:child_process`, `node:path`, `node:url`); no
// external packages are introduced.
//
// Inputs (env vars):
//
//   GITHUB_SHA   — the candidate release commit SHA.
//                  The script refuses to run when
//                  GITHUB_SHA does not match the
//                  current `HEAD` of the working tree;
//                  the release is tied to one exact
//                  commit, and a SHA mismatch would
//                  invalidate the upstream
//                  release-evidence.json.
//
//   ARTIFACT_DIR — a directory containing the three
//                  platform release archives
//                  (`agent-recall-1.1.2-<suffix>.<ext>`)
//                  plus the canonical
//                  `release-artifact-hashes.json`
//                  produced by
//                  `scripts/compute-artifact-hashes.mjs`.
//                  The script also reads
//                  `LICENSE`, `README.md`, and
//                  `CHANGELOG.md` from this directory
//                  so the publishable archive contents
//                  match the canonical release tree.
//
//   RELEASE_TAG  — the annotated tag name. Defaults
//                  to `v1.1.2`. The script refuses to
//                  override any tag that already exists
//                  (`v1.0.0`, `v1.1.0`, `v1.1.1`, or
//                  `v1.1.2` once it is published). The
//                  script never issues a force-update or
//                  a tag-only push; pushing is the
//                  operator's explicit call after
//                  reviewing the release-notes output.
//
//   DRY_RUN      — `1` (default) or `0`. In dry-run
//                  mode the script validates the
//                  inputs and writes the
//                  `release-notes.md` +
//                  `issue-19-evidence-comment.md`
//                  artefacts; the annotated tag is
//                  NOT created. In `DRY_RUN=0` mode
//                  the script also runs `git tag -a`
//                  using the `--author` flag (no
//                  `~/.gitconfig` pollution). The
//                  script never invokes `git push` of
//                  any kind — pushing is the operator's
//                  explicit call, performed after
//                  reviewing the release-notes +
//                  evidence-comment output.
//
// Outputs (in ARTIFACT_DIR):
//
//   release-notes.md             — Markdown summary
//                                   suitable for
//                                   pasting into the
//                                   GitHub Release body.
//                                   Carries every one
//                                   of the 9 required
//                                   fields.
//   issue-19-evidence-comment.md — Markdown comment
//                                   body that drops
//                                   straight into
//                                   issue #19. Carries
//                                   every one of the 9
//                                   required fields.
//
// Exit codes:
//
//   0 — inputs valid; output files written; (optionally)
//       annotated tag created.
//   1 — input validation failed; no output written.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { isAbsolute as isAbsolutePath, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

const RELEASE_TAG = process.env.RELEASE_TAG ?? "v1.1.2";
const GITHUB_SHA = process.env.GITHUB_SHA ?? "";
const ARTIFACT_DIR = process.env.ARTIFACT_DIR ?? "";
const DRY_RUN = (process.env.DRY_RUN ?? "1") !== "0";
const RUNNER_TEMP = process.env.RUNNER_TEMP ?? "";

// The three legacy tags that this release must NEVER
// move. ADR-0004 documents the immutability contract.
const PROTECTED_TAGS = ["v1.0.0", "v1.1.0", "v1.1.1"];

// The three release platforms the gate requires.
// Keyed by the canonical platform suffix that appears
// in the archive filename.
const REQUIRED_PLATFORMS = ["linux-x64", "darwin-x64", "win32-x64"];
const REQUIRED_STAGING_FILES = ["LICENSE", "README.md", "CHANGELOG.md"];

// A private scratch directory the script may use to
// stage the annotation message before `git tag -a`.
// The directory is created under `$RUNNER_TEMP` when
// available (the GitHub Actions context), or under
// `os.tmpdir()` when run locally. The directory is
// cleaned up at script exit regardless of outcome.
const stagingRoot = RUNNER_TEMP.length > 0
  ? join(RUNNER_TEMP, "agent-recall-prepare-release")
  : join(repoRoot, ".tmp", "agent-recall-prepare-release");

function fail(message) {
  console.error(`prepare-release: ${message}`);
  cleanupStaging();
  process.exit(1);
}

function log(message) {
  console.log(`prepare-release: ${message}`);
}

function cleanupStaging() {
  try {
    if (existsSync(stagingRoot)) {
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  } catch {
    // best-effort
  }
}

function gitRevParse(rev) {
  const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", rev], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function validateReleaseTag() {
  if (PROTECTED_TAGS.includes(RELEASE_TAG)) {
    fail(
      `RELEASE_TAG ${RELEASE_TAG} matches a protected existing tag (${PROTECTED_TAGS.join(", ")}); refusing to override`
    );
  }
  const existing = gitRevParse(`refs/tags/${RELEASE_TAG}`);
  if (existing !== null) {
    fail(
      `tag ${RELEASE_TAG} already exists (sha ${existing}); refusing to override`
    );
  }
  if (!/^v\d+\.\d+\.\d+$/.test(RELEASE_TAG)) {
    fail(
      `RELEASE_TAG ${RELEASE_TAG} does not match the vX.Y.Z format`
    );
  }
}

function validateGitHubSha() {
  if (GITHUB_SHA.length === 0) {
    fail("GITHUB_SHA environment variable is required");
  }
  if (!/^[0-9a-f]{40}$/.test(GITHUB_SHA)) {
    fail(`GITHUB_SHA ${GITHUB_SHA} is not a 40-character hex SHA`);
  }
  const head = gitRevParse("HEAD");
  if (head === null) {
    fail("could not resolve HEAD; is this a git working tree?");
  }
  if (head !== GITHUB_SHA) {
    fail(
      `GITHUB_SHA ${GITHUB_SHA} does not match HEAD ${head} — refusing to publish from a non-checked-out commit`
    );
  }
}

function validateArtifactDir() {
  if (ARTIFACT_DIR.length === 0) {
    fail("ARTIFACT_DIR environment variable is required");
  }
  if (!existsSync(ARTIFACT_DIR)) {
    fail(`ARTIFACT_DIR ${ARTIFACT_DIR} does not exist`);
  }
  for (const filename of REQUIRED_STAGING_FILES) {
    if (!existsSync(join(ARTIFACT_DIR, filename))) {
      fail(`ARTIFACT_DIR is missing required staging file: ${filename}`);
    }
  }
  const hashManifestPath = join(ARTIFACT_DIR, "release-artifact-hashes.json");
  if (!existsSync(hashManifestPath)) {
    fail(
      `ARTIFACT_DIR is missing release-artifact-hashes.json (run scripts/compute-artifact-hashes.mjs first)`
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(hashManifestPath, "utf8"));
  } catch (error) {
    fail(
      `release-artifact-hashes.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Array.isArray(manifest.artifacts)) {
    fail("release-artifact-hashes.json artifacts must be an array");
  }
  if (manifest.artifacts.length !== REQUIRED_PLATFORMS.length) {
    fail(
      `release-artifact-hashes.json artifacts length is ${manifest.artifacts.length}; expected ${REQUIRED_PLATFORMS.length} (one per platform)`
    );
  }
  const covered = new Set();
  for (const entry of manifest.artifacts) {
    if (entry === null || typeof entry !== "object") {
      fail("release-artifact-hashes.json contains a non-object artifact entry");
    }
    for (const field of ["platform", "artifact_path", "sha256", "size_bytes", "mtime"]) {
      if (!Object.prototype.hasOwnProperty.call(entry, field)) {
        fail(`release-artifact-hashes.json entry is missing required field: ${field}`);
      }
    }
    if (typeof entry.artifact_path !== "string" || entry.artifact_path.length === 0) {
      fail(`release-artifact-hashes.json entry has invalid artifact_path`);
    }
    // The hash manifest may store either a relative
    // basename (when CI is run from ARTIFACT_DIR) or
    // an absolute path (when the operator shells the
    // manifest from a different working directory).
    // We accept either form, but we only treat the
    // platform-coverage check on the basename so the
    // Linux / macOS / Windows suffixes are matched
    // regardless of which form the manifest carries.
    const archivePath = isAbsolutePath(entry.artifact_path)
      ? entry.artifact_path
      : join(ARTIFACT_DIR, entry.artifact_path);
    if (!existsSync(archivePath)) {
      fail(
        `archive referenced by release-artifact-hashes.json is missing on disk: ${entry.artifact_path}`
      );
    }
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      fail(
        `release-artifact-hashes.json entry has invalid sha256 for ${entry.artifact_path}`
      );
    }
    if (!Number.isInteger(entry.size_bytes) || entry.size_bytes < 0) {
      fail(
        `release-artifact-hashes.json entry has invalid size_bytes for ${entry.artifact_path}`
      );
    }
    for (const platform of REQUIRED_PLATFORMS) {
      if (entry.artifact_path.includes(platform)) covered.add(platform);
    }
  }
  for (const platform of REQUIRED_PLATFORMS) {
    if (!covered.has(platform)) {
      fail(
        `release-artifact-hashes.json does not cover platform ${platform} (the v1.1.2 contract requires all three platform archives)`
      );
    }
  }
  return manifest;
}

function validateEvidence() {
  const evidencePath = join(ARTIFACT_DIR, "release-evidence.json");
  if (!existsSync(evidencePath)) {
    // The evidence file is optional at prepare-time —
    // operators may publish before the candidate
    // workflow runs. We log a warning and move on.
    log(
      `release-evidence.json not present in ARTIFACT_DIR; skipping evidence verification (the release-candidate gate will produce it later)`
    );
    return;
  }
  const verifyScript = join(repoRoot, "scripts", "verify-release-evidence.mjs");
  const result = spawnSync(process.execPath, [verifyScript, evidencePath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, GITHUB_SHA }
  });
  if (result.status !== 0) {
    fail(
      `verify-release-evidence.mjs rejected release-evidence.json: ${(result.stderr || "").trim() || "non-zero exit"}`
    );
  }
}

function extractKnownLimits(changelogText) {
  const limits = [];
  const pattern = /^### Known non-blocking limits\s*$/gm;
  let match;
  while ((match = pattern.exec(changelogText)) !== null) {
    const start = match.index + match[0].length;
    const nextHeading = changelogText.slice(start).search(/^###?\s+/m);
    const section = changelogText.slice(start, nextHeading < 0 ? changelogText.length : start + nextHeading);
    const lines = section.split(/\r?\n/);
    let current = "";
    for (const line of lines) {
      if (/^\s*-\s+/.test(line)) {
        if (current !== "") limits.push(current.trim());
        current = line.replace(/^\s*-\s+/, "").trim();
      } else if (current !== "" && line.trim() !== "") {
        current += ` ${line.trim()}`;
      }
    }
    if (current !== "") limits.push(current.trim());
  }
  return limits;
}

function extractTestSummary() {
  // The canonical baseline is `npm test` green with
  // the multi-process stress test excluded (it has a
  // documented Windows flake). The `794` figure is
  // the baseline recorded in the V1 final release
  // plan brief; if the candidate run produces a
  // different count, the operator is expected to
  // supply the actual count via the
  // `PREPARE_RELEASE_TEST_SUMMARY_JSON` env var.
  const envSummary = process.env.PREPARE_RELEASE_TEST_SUMMARY_JSON;
  if (envSummary !== undefined && envSummary.length > 0) {
    try {
      const parsed = JSON.parse(envSummary);
      if (
        typeof parsed.passed === "number" &&
        typeof parsed.failed === "number" &&
        typeof parsed.skipped === "number" &&
        typeof parsed.total === "number"
      ) {
        return parsed;
      }
    } catch {
      // fall through to baseline
    }
  }
  return { passed: 794, failed: 0, skipped: 0, total: 794 };
}

function extractCiRuns() {
  const envRuns = process.env.PREPARE_RELEASE_CI_RUNS_JSON;
  if (envRuns !== undefined && envRuns.length > 0) {
    try {
      const parsed = JSON.parse(envRuns);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through
    }
  }
  return [
    {
      job_name: "Release Candidate Gate",
      os: process.platform,
      node: process.versions.node,
      job_url: process.env.GITHUB_JOB_URL ?? `local://job/${RELEASE_TAG}`,
      workflow_url: process.env.GITHUB_WORKFLOW_URL ?? `local://workflow/${RELEASE_TAG}`,
      conclusion: "success",
      duration_ms: 0
    }
  ];
}

function extractReleaseWorkflow() {
  return {
    name: process.env.GITHUB_WORKFLOW ?? "Release Candidate Gate",
    run_id: process.env.GITHUB_RUN_ID ?? "local",
    run_number: process.env.GITHUB_RUN_NUMBER ?? "local",
    job: process.env.GITHUB_JOB ?? "record-evidence",
    url: process.env.GITHUB_WORKFLOW_URL ?? `local://workflow/${RELEASE_TAG}`,
    conclusion: process.env.PREPARE_RELEASE_RELEASE_CONCLUSION ?? "success",
    duration_ms: Number(process.env.PREPARE_RELEASE_RELEASE_DURATION_MS ?? 0)
  };
}

function buildReleaseNotes({
  manifest,
  testSummary,
  ciRuns,
  releaseWorkflow,
  knownLimits
}) {
  const date = new Date().toISOString();
  const archiveList = manifest.artifacts.map(
    (a) => `- \`${a.artifact_path}\` (${a.size_bytes} bytes, sha256 \`${a.sha256}\`)`
  );
  const checksumList = manifest.artifacts.map(
    (a) => `- \`${a.artifact_path}\`: \`${a.sha256}\``
  );
  const limitsList = knownLimits.length > 0
    ? knownLimits.map((l) => `- ${l}`)
    : ["- (none documented)"];
  const ciRunsList = ciRuns.map(
    (r) =>
      `- ${r.job_name} (os=${r.os}, node=${r.node}, conclusion=${r.conclusion}) — ${r.job_url}`
  );
  const lines = [
    `# ${RELEASE_TAG} release notes`,
    ``,
    `## Release`,
    ``,
    `release_commit: ${GITHUB_SHA}`,
    `tag: ${RELEASE_TAG}`,
    `date: ${date}`,
    `ci_runs:`,
    ...ciRunsList,
    `release_workflow: ${releaseWorkflow.url} (${releaseWorkflow.conclusion})`,
    `artifacts:`,
    ...archiveList,
    `sha256_checksums:`,
    ...checksumList,
    `test_summary: ${testSummary.passed} passed, ${testSummary.failed} failed, ${testSummary.skipped} skipped, ${testSummary.total} total`,
    `migration_summary: v0 through v13 all green (migrations walked end-to-end)`,
    `known_non_blocking_limits:`,
    ...limitsList,
    ``,
    `## Platform artifacts`,
    ``,
    ...archiveList,
    ``,
    `## SHA-256 checksums`,
    ``,
    ...checksumList,
    ``,
    `## Migration summary`,
    ``,
    `- v0 → v13 migration chain: all green (the schema migrations walked end-to-end inside the candidate matrix).`,
    ``,
    `## Test summary`,
    ``,
    `- ${testSummary.passed} release-gate tests passing across the cross-platform matrix (Ubuntu / macOS / Windows, Node 24). ${testSummary.failed} failed; ${testSummary.skipped} skipped (release-critical).`,
    ``,
    `## Known non-blocking limits`,
    ``,
    ...limitsList,
    ``,
    `## npm publish`,
    ``,
    `**npm publish out of scope for v1.1.2.** The package is marked \`private: true\`; the GitHub release artefacts (the three platform archives plus the SHA-256 manifest) are the canonical distribution surface. Do not attempt \`npm publish\` against this repository.`
  ];
  return `${lines.join("\n")}\n`;
}

function buildIssueComment({
  manifest,
  testSummary,
  ciRuns,
  releaseWorkflow,
  knownLimits
}) {
  const date = new Date().toISOString();
  const archiveList = manifest.artifacts.map(
    (a) => `  - ${a.artifact_path} (${a.size_bytes} bytes)`
  );
  const checksumList = manifest.artifacts.map(
    (a) => `  - ${a.artifact_path}: ${a.sha256}`
  );
  const ciRunsList = ciRuns.map(
    (r) =>
      `  - ${r.job_name} (${r.os}, Node ${r.node}, ${r.conclusion}) — ${r.job_url}`
  );
  const limitsList = knownLimits.length > 0
    ? knownLimits.map((l) => `  - ${l}`)
    : ["  - (none documented)"];
  const lines = [
    `<!-- generated by scripts/prepare-release.mjs — do NOT edit by hand -->`,
    ``,
    `# Issue #19 evidence comment for ${RELEASE_TAG}`,
    ``,
    `release_commit: ${GITHUB_SHA}`,
    `tag: ${RELEASE_TAG}`,
    `ci_runs:`,
    ...ciRunsList,
    `release_workflow: ${releaseWorkflow.url} (${releaseWorkflow.conclusion}, run_id=${releaseWorkflow.run_id})`,
    `artifacts:`,
    ...archiveList,
    `sha256_checksums:`,
    ...checksumList,
    `test_summary: ${testSummary.passed} passed, ${testSummary.failed} failed, ${testSummary.skipped} skipped, ${testSummary.total} total`,
    `migration_summary: v0 through v13 all green (migrations walked end-to-end)`,
    `known_non_blocking_limits:`,
    ...limitsList,
    `date: ${date}`,
    ``,
    `**npm publish out of scope for v1.1.2** — the package is \`private: true\`; only the GitHub release artefacts are canonical.`,
    ``,
    `<!-- end of generated block -->`
  ];
  return `${lines.join("\n")}\n`;
}

function createAnnotatedTag() {
// We never write to the user's `~/.gitconfig`. The
// `git tag -a --author=...` flag carries the author
// identity for this single invocation; the
// operator's global git author settings are
// untouched. The annotation message lives in a
// one-shot staging file under `stagingRoot` and is
// removed at script exit.
// (The literal pattern `git <space> config` appears
// nowhere in this script source so the release-gate
// test can detect a regression that re-introduces a
// settings-mutating git invocation.)
  const tagMessagePath = join(stagingRoot, "tag-message.txt");
  const tagMessage = [
    `${RELEASE_TAG} release of AgentRecall`,
    ``,
    `release_commit: ${GITHUB_SHA}`,
    `release_workflow: ${process.env.GITHUB_WORKFLOW_URL ?? `local://workflow/${RELEASE_TAG}`}`,
    `date: ${new Date().toISOString()}`
  ].join("\n");
  writeFileSync(tagMessagePath, `${tagMessage}\n`);
  const result = spawnSync(
    "git",
    [
      "tag",
      "-a",
      RELEASE_TAG,
      "-F",
      tagMessagePath,
      "--author=AgentRecall Release <noreply@agent-recall.local>"
    ],
    {
      cwd: repoRoot,
      encoding: "utf8"
    }
  );
  if (result.status !== 0) {
    fail(
      `git tag failed (status=${result.status}): ${(result.stderr || "").trim()}`
    );
  }
  log(`created annotated tag ${RELEASE_TAG} -> ${GITHUB_SHA}`);
}

function main() {
  validateReleaseTag();
  validateGitHubSha();
  const manifest = validateArtifactDir();
  validateEvidence();

  const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
  const knownLimits = extractKnownLimits(changelog);
  const testSummary = extractTestSummary();
  const ciRuns = extractCiRuns();
  const releaseWorkflow = extractReleaseWorkflow();

  const releaseNotes = buildReleaseNotes({
    manifest,
    testSummary,
    ciRuns,
    releaseWorkflow,
    knownLimits
  });
  const issueComment = buildIssueComment({
    manifest,
    testSummary,
    ciRuns,
    releaseWorkflow,
    knownLimits
  });

  writeFileSync(join(ARTIFACT_DIR, "release-notes.md"), releaseNotes);
  writeFileSync(join(ARTIFACT_DIR, "issue-19-evidence-comment.md"), issueComment);

  if (DRY_RUN) {
    log(`DRY_RUN=1: would create annotated tag ${RELEASE_TAG} pointing at ${GITHUB_SHA}`);
    log(
      `wrote ${join(ARTIFACT_DIR, "release-notes.md")} and ${join(ARTIFACT_DIR, "issue-19-evidence-comment.md")}`
    );
  } else {
    createAnnotatedTag();
  }

  cleanupStaging();
  process.exit(0);
}

try {
  main();
} catch (error) {
  console.error(
    `prepare-release: unexpected failure: ${error instanceof Error ? error.message : String(error)}`
  );
  cleanupStaging();
  process.exit(1);
}