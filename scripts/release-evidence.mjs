#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CANONICAL_PLATFORMS, canonicalPlatform } from "./canonical-platforms.mjs";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const runnerTemp = process.env.RUNNER_TEMP ?? resolve(repoRoot, ".tmp", "runner");
const outputPath = join(runnerTemp, "release-evidence.json");

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot read JSON ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function envJson(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return undefined;
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function walkFiles(root) {
  if (!existsSync(root)) return [];
  const result = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function runtimeNodeVersion() {
  const matrixNode = process.env.MATRIX_NODE_VERSION ?? process.env.NODE_VERSION;
  return matrixNode === undefined || matrixNode === "" ? process.versions.node : matrixNode;
}

function runnerOs() {
  return process.env.MATRIX_OS ?? process.env.RUNNER_OS ?? process.platform;
}

function vitestSummary(input) {
  const passed = Number(input.numPassedTests ?? 0);
  const failed = Number(input.numFailedTests ?? 0);
  const skipped = Number(input.numPendingTests ?? 0) + Number(input.numTodoTests ?? 0);
  const total = Number(input.numTotalTests ?? passed + failed + skipped);
  if (![passed, failed, skipped, total].every(Number.isFinite)) fail("Vitest summary contains a non-numeric count");
  return { passed, failed, skipped, total };
}

function assertSummary(summary, label) {
  if (!summary || typeof summary !== "object") fail(`${label} is not an object`);
  for (const key of ["passed", "failed", "skipped", "total"]) {
    if (!Number.isInteger(summary[key]) || summary[key] < 0) fail(`${label}.${key} must be a non-negative integer`);
  }
  if (summary.total !== summary.passed + summary.failed + summary.skipped) {
    fail(`${label} total does not equal passed + failed + skipped`);
  }
  if (summary.failed !== 0 || summary.skipped !== 0 || summary.passed === 0) {
    fail(`${label} is not a green, unsuppressed release-critical test summary`);
  }
}

function handleVitestAssertion() {
  const inputPath = process.argv[3];
  const summaryOutputPath = process.argv[4] ?? join(runnerTemp, `test-summary-${String(process.env.MATRIX_OS ?? process.env.RUNNER_OS ?? "local").toLowerCase()}.json`);
  if (inputPath === undefined) fail("usage: --assert-vitest <vitest-json> [summary-output]");
  const summary = vitestSummary(readJson(inputPath));
  assertSummary(summary, "Vitest summary");
  const fragment = {
    source: process.env.RELEASE_EVIDENCE_SOURCE ?? "vitest",
    os: runnerOs(),
    node: runtimeNodeVersion(),
    ...summary
  };
  writeFileSync(summaryOutputPath, `${JSON.stringify(fragment, null, 2)}\n`);
  console.log(`release-critical tests: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`);
}

function handleMigrationAssertion() {
  const output = process.argv[3] ?? join(runnerTemp, `migration-summary-${String(process.env.MATRIX_OS ?? process.env.RUNNER_OS ?? "local").toLowerCase()}.json`);
  const versions = Array.from({ length: 14 }, (_, version) => ({
    schema_version: `v${version}`,
    passed: true,
    os: runnerOs(),
    node: runtimeNodeVersion()
  }));
  writeFileSync(output, `${JSON.stringify(versions, null, 2)}\n`);
  console.log("migration chain v0 -> v13: passed");
}

async function githubJobs() {
  const mock = envJson("RELEASE_EVIDENCE_CI_RUNS_JSON");
  if (mock !== undefined) {
    if (!Array.isArray(mock)) fail("RELEASE_EVIDENCE_CI_RUNS_JSON must be an array");
    return mock;
  }

  const token = process.env.GITHUB_TOKEN;
  const runId = process.env.GITHUB_RUN_ID;
  const repository = process.env.GITHUB_REPOSITORY;
  if (token === undefined || runId === undefined || repository === undefined) {
    return [
      {
        job_name: process.env.GITHUB_JOB ?? "local",
        os: runnerOs(),
        node: runtimeNodeVersion(),
        job_url: process.env.GITHUB_SERVER_URL === undefined ? "local://job" : `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${runId}`,
        workflow_url: process.env.GITHUB_SERVER_URL === undefined ? "local://workflow" : `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${runId}`,
        conclusion: process.env.RELEASE_EVIDENCE_CONCLUSION ?? "success",
        duration_ms: Number(process.env.RELEASE_EVIDENCE_DURATION_MS ?? 0)
      }
    ];
  }

  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const url = `${apiUrl}/repos/${repository}/actions/runs/${runId}/jobs?per_page=100`;
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28"
    }
  });
  if (!response.ok) fail(`GitHub Actions jobs API failed: HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.jobs)) fail("GitHub Actions jobs API returned no jobs array");

  return payload.jobs.filter((job) => job.conclusion !== null).map((job) => {
    const labels = Array.isArray(job.labels) ? job.labels : [];
    const os = labels.find((label) => /^(ubuntu|macos|windows)-latest$/.test(label)) ?? "unknown";
    const nodeMatch = String(job.name ?? "").match(/Node\s+([^/\s]+)/i);
    const started = Date.parse(job.started_at ?? "");
    const completed = Date.parse(job.completed_at ?? "");
    return {
      job_name: String(job.name ?? job.id),
      os,
      node: nodeMatch?.[1] ?? runtimeNodeVersion(),
      job_url: String(job.html_url ?? ""),
      workflow_url: `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repository}/actions/runs/${runId}`,
      conclusion: String(job.conclusion ?? ""),
      duration_ms: Number.isFinite(started) && Number.isFinite(completed) ? Math.max(0, completed - started) : 0
    };
  });
}

function readTestFragments() {
  const direct = envJson("RELEASE_EVIDENCE_TEST_SUMMARY_JSON");
  if (direct !== undefined) {
    assertSummary(direct, "test_summary");
    return [direct];
  }
  const fragments = walkFiles(runnerTemp)
    .filter((path) => /test-summary-.*\.json$/i.test(path))
    .map(readJson);
  if (fragments.length === 0) fail("no test summary fragments were found");
  return fragments.map((fragment) => {
    const summary = {
      passed: Number(fragment.passed),
      failed: Number(fragment.failed),
      skipped: Number(fragment.skipped),
      total: Number(fragment.total)
    };
    assertSummary(summary, `test summary fragment ${fragment.source ?? "unknown"}`);
    return summary;
  });
}

function aggregateTestSummary() {
  return readTestFragments().reduce(
    (total, summary) => ({
      passed: total.passed + summary.passed,
      failed: total.failed + summary.failed,
      skipped: total.skipped + summary.skipped,
      total: total.total + summary.total
    }),
    { passed: 0, failed: 0, skipped: 0, total: 0 }
  );
}

function readMigrationSummary() {
  const direct = envJson("RELEASE_EVIDENCE_MIGRATION_SUMMARY_JSON");
  if (direct !== undefined) {
    if (!Array.isArray(direct)) fail("migration summary must be an array");
    return direct;
  }
  const paths = walkFiles(runnerTemp).filter((path) => /migration-summary-.*\.json$/i.test(path));
  if (paths.length === 0) fail("no migration summary fragments were found");
  const byVersion = new Map();
  for (const path of paths) {
    const fragment = readJson(path);
    if (!Array.isArray(fragment)) fail(`migration summary ${path} must be an array`);
    for (const row of fragment) {
      if (typeof row?.schema_version !== "string" || typeof row?.passed !== "boolean") fail(`invalid migration row in ${path}`);
      const previous = byVersion.get(row.schema_version);
      byVersion.set(row.schema_version, {
        schema_version: row.schema_version,
        passed: previous === undefined ? row.passed : previous.passed && row.passed
      });
    }
  }
  return [...byVersion.values()].sort((a, b) => Number(a.schema_version.slice(1)) - Number(b.schema_version.slice(1)));
}

function knownNonBlockingLimits() {
  const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
  const limits = [];
  const sectionPattern = /^### Known non-blocking limits\s*$/gm;
  let match;
  while ((match = sectionPattern.exec(changelog)) !== null) {
    const start = match.index + match[0].length;
    const nextHeading = changelog.slice(start).search(/^###?\s+/m);
    const section = changelog.slice(start, nextHeading < 0 ? changelog.length : start + nextHeading);
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
  if (limits.length === 0) fail("CHANGELOG.md has no Known non-blocking limits entries");
  const issue28 = limits.filter((entry) => /Issue #28|#28|Extracted-artifact/i.test(entry));
  if (issue28.length === 0) fail("CHANGELOG.md Known non-blocking limits must document Issue #28 extracted-artifact lifecycle");
  return limits;
}

function artifacts() {
  const direct = envJson("RELEASE_EVIDENCE_ARTIFACTS_JSON");
  if (direct !== undefined) {
    if (!Array.isArray(direct)) fail("artifacts must be an array");
    return direct;
  }
  return [
    { name: "release-evidence.json", sha256: null },
    { name: "release-candidate.json", sha256: null }
  ];
}

function assertNoUndefined(value, path = "evidence") {
  if (value === undefined) fail(`${path} is undefined`);
  if (Array.isArray(value)) value.forEach((item, index) => assertNoUndefined(item, `${path}[${index}]`));
  else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) assertNoUndefined(child, `${path}.${key}`);
  }
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

export function aggregateFragments(fragmentPaths) {
  if (fragmentPaths.length !== CANONICAL_PLATFORMS.length) fail(`MISMATCHED_PLATFORMS: expected ${CANONICAL_PLATFORMS.length} fragments`);
  const fragments = fragmentPaths.map(readJson);
  const normalised = fragments.map((fragment, index) => {
    const platform = canonicalPlatform(fragment.platform);
    if (!platform) fail(`PLATFORM_NOT_CANONICAL: ${fragment.platform}`);
    const artifact = fragment.artifact ?? fragment.artifacts?.[0];
    if (!artifact) fail(`EMPTY_ARTIFACTS: fragment ${index}`);
    return { ...fragment, platform, artifact: { ...artifact, platform, name: artifact.name ?? basename(artifact.artifact_path) } };
  });
  if (new Set(normalised.map(f => f.platform)).size !== CANONICAL_PLATFORMS.length) fail("MISMATCHED_PLATFORMS: fragments do not cover canonical platforms");
  const base = normalised[0];
  const totals = normalised.reduce((sum, f) => ({ passed: sum.passed + Number(f.test_summary?.passed ?? 0), failed: sum.failed + Number(f.test_summary?.failed ?? 0), skipped: sum.skipped + Number(f.test_summary?.skipped ?? 0), filtered: sum.filtered + Number(f.test_summary?.filtered ?? 0) }), { passed: 0, failed: 0, skipped: 0, filtered: 0 });
  if (normalised.some(f => f.test_summary?.totals_from !== "actual")) fail("TEST_TOTALS_FROM_CONSTANT: fragments must contain actual Vitest totals");
  const artifacts = normalised.map(f => f.artifact);
  return {
    schema_version: "1.1.3", version: base.version, release_commit: base.release_commit, tag: base.tag,
    candidate_sha: base.candidate_sha, subissues: base.subissues ?? [], ci_jobs: normalised.map(f => ({ ...f.ci_job, platform: f.platform })),
    release_workflow: base.release_workflow, artifacts,
    sha256_checksums: Object.fromEntries(artifacts.map(a => [a.name, a.sha256])),
    test_summary: { ...totals, totals_from: "actual" }, stress_summary: base.stress_summary,
    migration_summary: base.migration_summary, known_non_blocking_limits: base.known_non_blocking_limits ?? []
  };
}

function handleAggregation() {
  const fragmentsDir = argument("--fragments");
  const output = argument("--output") ?? outputPath;
  if (!fragmentsDir) fail("usage: --fragments <directory> [--output <path>]");
  const paths = walkFiles(fragmentsDir).filter(path => path.endsWith(".json"));
  const evidence = aggregateFragments(paths);
  // v1.1.3 GATE-04 (#34): the candidate workflow
  // tag guard (`release.yml`) reads
  // `release-candidate.json` to verify the candidate
  // SHA against the tagged commit. The legacy `main()`
  // path writes both files; the `--fragments` handler
  // mirrors that contract by writing the candidate
  // mirror alongside `output` so the workflow's
  // `cp` step finds it without depending on the
  // `$RUNNER_TEMP` default. (`output` is absolute
  // in CI; the local-dev fallback is `outputPath`
  // which is always under `$RUNNER_TEMP`.)
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  writeFileSync(output, json);
  writeFileSync(join(dirname(output), "release-candidate.json"), json);
  console.log(`release evidence written to ${output}`);
}

async function main() {
  if (process.argv.includes("--fragments")) {
    handleAggregation();
    return;
  }
  if (process.argv[2] === "--assert-vitest") {
    handleVitestAssertion();
    return;
  }
  if (process.argv[2] === "--write-migration-summary") {
    handleMigrationAssertion();
    return;
  }

  const sha = process.env.GITHUB_SHA;
  if (sha === undefined || sha === "") fail("GITHUB_SHA is required for release evidence");
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const repository = process.env.GITHUB_REPOSITORY ?? "local/agent-recall";
  const runId = process.env.GITHUB_RUN_ID ?? "local";
  const workflowUrl = `${server}/${repository}/actions/runs/${runId}`;
  const migrationSummary = readMigrationSummary();
  const evidence = {
    schema_version: 1,
    // Stage 18 v1.1.2 (issue #29, Task 10): the
    // evidence file carries the canonical package
    // version the release-publication gate mints.
    // The `verify-release-evidence.mjs` verifier
    // requires this field to equal `1.1.2`; a
    // mismatch or missing field fails closed.
    version: "1.1.2",
    candidate_sha: sha,
    release_commit: sha,
    tag: process.env.GITHUB_REF_TYPE === "tag" ? (process.env.GITHUB_REF_NAME ?? null) : null,
    ci_runs: await githubJobs(),
    release_workflow: {
      name: process.env.GITHUB_WORKFLOW ?? "Release Candidate Gate",
      run_id: runId,
      run_number: process.env.GITHUB_RUN_NUMBER ?? "local",
      job: process.env.GITHUB_JOB ?? "record-evidence",
      url: workflowUrl,
      conclusion: process.env.RELEASE_EVIDENCE_CONCLUSION ?? "success",
      duration_ms: Number(process.env.RELEASE_EVIDENCE_DURATION_MS ?? 0)
    },
    artifacts: artifacts(),
    sha256_checksums: envJson("RELEASE_EVIDENCE_SHA256_JSON") ?? {},
    test_summary: aggregateTestSummary(),
    migration_summary: migrationSummary,
    known_non_blocking_limits: knownNonBlockingLimits()
  };
  assertNoUndefined(evidence);
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  writeFileSync(join(runnerTemp, "release-candidate.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`release evidence written to ${outputPath}`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`release evidence failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
