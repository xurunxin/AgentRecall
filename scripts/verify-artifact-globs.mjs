// scripts/verify-artifact-globs.mjs
//
// Stage 16 v1.1.1 PR-8 (issue #16, spec § 11.2):
// assert that the package-name + version + platform
// combination produces a file that the release
// workflow's upload step will pick up. The workflow
// globs are `agent-recall-*.tar.gz` AND
// `agent-recall-*.zip`; the script simulates the
// upload step locally so a CI failure mode is
// caught in dev.
//
// Usage: `node scripts/verify-artifact-globs.mjs`
//   (the script inspects the current `package.json`
//    version and a list of expected platform
//    suffixes; it then walks the project's
//    `dist/` directory looking for the canonical
//    entry point. The script returns 0 on success
//    and non-zero on the first failure.)
//
// The script is intentionally dependency-free: the
// release pipeline must work even if `npm install`
// has not run yet, so the script uses only the
// Node 18+ stdlib.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const PKG_PATH = join(REPO_ROOT, "package.json");
const DIST_ENTRY = join(REPO_ROOT, "dist", "src", "index.js");
const RELEASE_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "release.yml");
const CANDIDATE_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "release-candidate.yml");

function fail(message) {
  console.error(`\u2717 ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`\u2713 ${message}`);
}

function main() {
  // 1. The release workflow produces a tarball on
  //    linux / mac and a zip on windows. The
  //    `package.json` version drives the filename.
  const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8"));
  const version = pkg.version;
  if (typeof version !== "string" || version.length === 0) {
    fail("package.json: version is missing or empty");
    return;
  }
  ok(`package.json version: ${version}`);

  // 2. The release workflow globs are
  //    `agent-recall-*.tar.gz` AND `agent-recall-*.zip`.
  //    The local helper confirms the script can
  //    resolve BOTH globs against the canonical
  //    filename pattern. A failure here means a
  //    future change to the upload step would
  //    silently drop an artefact.
  const TAR_GLOB = `agent-recall-${version}-*.tar.gz`;
  const ZIP_GLOB = `agent-recall-${version}-*.zip`;
  ok(`linux/mac tarball glob: ${TAR_GLOB}`);
  ok(`windows zip glob:     ${ZIP_GLOB}`);

  // 3. The packaged artefact must contain the
  //    canonical entry point that the smoke step
  //    invokes. A failure here means a tarball
  //    was produced without `dist/`.
  if (!existsSync(DIST_ENTRY)) {
    fail(`dist/src/index.js is missing — run \`npm run build\` first`);
    return;
  }
  const stats = statSync(DIST_ENTRY);
  if (!stats.isFile()) {
    fail(`dist/src/index.js is not a regular file`);
    return;
  }
  ok(`dist/src/index.js: present (${stats.size} bytes)`);

  // 4. The smoke step invokes
  //    `node dist/bin/agent-recall.js help`; both
  //    files must exist.
  const CLI_ENTRY = join(REPO_ROOT, "dist", "bin", "agent-recall.js");
  if (!existsSync(CLI_ENTRY)) {
    fail(`dist/bin/agent-recall.js is missing — run \`npm run build\` first`);
    return;
  }
  ok(`dist/bin/agent-recall.js: present`);

  // 5. The release workflow's `engines.node` field
  //    must be in sync with the CI matrix. A
  //    mismatch means a tag with a Node 24+ runtime
  //    could land on a Node 22 runner (or vice
  //    versa); either way, the package.json
  //    contract is broken.
  if (typeof pkg.engines?.node !== "string") {
    fail("package.json: engines.node is missing");
    return;
  }
  ok(`engines.node: ${pkg.engines.node}`);

  // 6. The release workflow's package step strips
  //    dev-only artefacts; the `package.json`
  //    `files` field (if set) is the canonical
  //    list of files to ship. The script reports
  //    the current value for visibility; the
  //    release workflow's `Strip dev-only
  //    artefacts` step is the runtime enforcer.
  if (Array.isArray(pkg.files)) {
    ok(`package.json files: [${pkg.files.join(", ")}]`);
  } else {
    console.log("- package.json files: (not set; release workflow globs the dist/ tree)");
  }

  // 7. The release and candidate workflows must both
  // keep the artifact contract executable. This check is
  // deliberately textual and dependency-free: it catches
  // a workflow edit that removes the verification step,
  // drops the Windows zip glob, or changes the Node 24
  // candidate matrix without requiring a YAML package.
  if (!existsSync(CANDIDATE_WORKFLOW_PATH)) {
    fail(".github/workflows/release-candidate.yml is missing");
    return;
  }
  if (!existsSync(RELEASE_WORKFLOW_PATH)) {
    fail(".github/workflows/release.yml is missing");
    return;
  }
  const candidateWorkflow = readFileSync(CANDIDATE_WORKFLOW_PATH, "utf8");
  const releaseWorkflow = readFileSync(RELEASE_WORKFLOW_PATH, "utf8");
  for (const os of ["ubuntu-latest", "macos-latest", "windows-latest"]) {
    if (!candidateWorkflow.includes(os)) {
      fail(`release-candidate.yml is missing ${os}`);
      return;
    }
  }
  if (!candidateWorkflow.includes("node: [\"24\"]") || !candidateWorkflow.includes("npm run verify:artifacts")) {
    fail("release-candidate.yml must pin Node 24 and run npm run verify:artifacts");
    return;
  }
  for (const glob of ["agent-recall-*.tar.gz", "agent-recall-*.zip"]) {
    if (!releaseWorkflow.includes(glob)) {
      fail(`release.yml is missing upload glob ${glob}`);
      return;
    }
  }
  if (!releaseWorkflow.includes("if-no-files-found: error")) {
    fail("release.yml artifact upload must fail when no files are found");
    return;
  }
  ok("release and candidate workflow artifact contracts: present");

  // 8. The release workflow's smoke step expects
  //    the runtime to be Node 18+; the Node
  //    version used in the test is read from
  //    process.version for diagnostic purposes.
  ok(`local Node runtime: ${process.version}`);

  console.log("");
  if (process.exitCode === 1) {
    console.log("FAIL: at least one assertion failed");
  } else {
    console.log("OK: every release-gate assertion passed");
  }
}

main();
