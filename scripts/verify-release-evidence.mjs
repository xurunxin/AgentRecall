#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";

const evidencePath = process.argv[2] ?? join(process.env.RUNNER_TEMP ?? ".", "release-evidence.json");
const requiredVersions = Array.from({ length: 14 }, (_, version) => `v${version}`);

function fail(message) {
  throw new Error(message);
}

function readEvidence() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(evidencePath, "utf8"));
  } catch (error) {
    fail(`cannot read release evidence: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail("release evidence must be a JSON object");
  return parsed;
}

function requiredString(object, field, label = field) {
  if (typeof object[field] !== "string" || object[field].trim() === "") fail(`${label} is required`);
}

function verifyCiRuns(evidence) {
  if (!Array.isArray(evidence.ci_runs) || evidence.ci_runs.length === 0) fail("ci_runs must be a non-empty array");
  for (const [index, run] of evidence.ci_runs.entries()) {
    if (run === null || typeof run !== "object") fail(`ci_runs[${index}] must be an object`);
    for (const field of ["job_name", "os", "node", "job_url", "workflow_url", "conclusion"]) {
      requiredString(run, field, `ci_runs[${index}].${field}`);
    }
    if (!Number.isInteger(run.duration_ms) || run.duration_ms < 0) fail(`ci_runs[${index}].duration_ms must be non-negative`);
    if (run.conclusion !== "success") fail(`ci_runs[${index}] conclusion is ${run.conclusion}, not success`);
    if (!run.job_url.startsWith("http://") && !run.job_url.startsWith("https://") && !run.job_url.startsWith("local://")) {
      fail(`ci_runs[${index}].job_url must be a workflow job URL`);
    }
    if (!run.workflow_url.startsWith("http://") && !run.workflow_url.startsWith("https://") && !run.workflow_url.startsWith("local://")) {
      fail(`ci_runs[${index}].workflow_url must be a workflow URL`);
    }
  }
}

function verifyReleaseWorkflow(evidence) {
  const workflow = evidence.release_workflow;
  if (workflow === null || typeof workflow !== "object") fail("release_workflow is required");
  for (const field of ["name", "run_id", "run_number", "job", "url", "conclusion"]) {
    requiredString(workflow, field, `release_workflow.${field}`);
  }
  if (workflow.conclusion !== "success") fail(`release_workflow conclusion is ${workflow.conclusion}, not success`);
  if (!workflow.url.startsWith("http://") && !workflow.url.startsWith("https://") && !workflow.url.startsWith("local://")) {
    fail("release_workflow.url must be a workflow URL");
  }
  if (!Number.isInteger(workflow.duration_ms) || workflow.duration_ms < 0) fail("release_workflow.duration_ms must be non-negative");
}

function verifyTestSummary(evidence) {
  const summary = evidence.test_summary;
  if (summary === null || typeof summary !== "object") fail("test_summary is required");
  for (const field of ["passed", "failed", "skipped", "total"]) {
    if (!Number.isInteger(summary[field]) || summary[field] < 0) fail(`test_summary.${field} must be a non-negative integer`);
  }
  if (summary.passed <= 0) fail("test_summary.passed must be greater than zero");
  if (summary.failed !== 0) fail("test_summary.failed must equal zero");
  if (summary.skipped !== 0) fail("release-critical tests cannot be skipped");
  if (summary.total !== summary.passed + summary.failed + summary.skipped) fail("test_summary total is inconsistent");
}

function verifyMigrationSummary(evidence) {
  const summary = Array.isArray(evidence.migration_summary)
    ? evidence.migration_summary
    : evidence.migration_summary !== null && Array.isArray(evidence.migration_summary.versions)
      ? evidence.migration_summary.versions
      : undefined;
  if (summary === undefined) fail("migration_summary must be an array or an object with versions");
  const byVersion = new Map();
  for (const row of summary) {
    if (row === null || typeof row !== "object") fail("migration_summary contains a non-object row");
    requiredString(row, "schema_version", "migration schema_version");
    if (typeof row.passed !== "boolean") fail(`migration ${row.schema_version}.passed must be boolean`);
    byVersion.set(row.schema_version, row);
  }
  for (const version of requiredVersions) {
    const row = byVersion.get(version);
    if (row === undefined) fail(`migration_summary is missing ${version}`);
    if (row.passed !== true) fail(`${version} migration did not pass`);
  }
}

function verifyArtifacts(evidence) {
  if (!Array.isArray(evidence.artifacts)) fail("artifacts must be an array");
  if (evidence.sha256_checksums === null || typeof evidence.sha256_checksums !== "object" || Array.isArray(evidence.sha256_checksums)) {
    fail("sha256_checksums must be an object");
  }
}

function main() {
  const evidence = readEvidence();
  for (const field of [
    "schema_version",
    "candidate_sha",
    "release_commit",
    "tag",
    "ci_runs",
    "release_workflow",
    "artifacts",
    "sha256_checksums",
    "test_summary",
    "migration_summary",
    "known_non_blocking_limits"
  ]) {
    if (!Object.prototype.hasOwnProperty.call(evidence, field)) fail(`release evidence is missing ${field}`);
  }
  requiredString(evidence, "candidate_sha");
  requiredString(evidence, "release_commit");
  if (evidence.release_commit !== evidence.candidate_sha) fail("release_commit must equal candidate_sha");
  const githubSha = process.env.GITHUB_SHA;
  if (githubSha === undefined || githubSha === "") fail("GITHUB_SHA is required for evidence verification");
  if (evidence.release_commit !== githubSha) fail(`release_commit ${evidence.release_commit} does not equal GITHUB_SHA ${githubSha}`);
  if (evidence.tag !== null && typeof evidence.tag !== "string") fail("tag must be a string or null");
  verifyCiRuns(evidence);
  verifyReleaseWorkflow(evidence);
  verifyArtifacts(evidence);
  verifyTestSummary(evidence);
  verifyMigrationSummary(evidence);
  if (!Array.isArray(evidence.known_non_blocking_limits) || evidence.known_non_blocking_limits.length === 0) {
    fail("known_non_blocking_limits must be a non-empty array");
  }
  for (const [index, limit] of evidence.known_non_blocking_limits.entries()) {
    if (typeof limit !== "string" || limit.trim() === "") fail(`known_non_blocking_limits[${index}] must be a non-empty string`);
  }
  console.log(`verified release evidence for ${evidence.release_commit}`);
}

try {
  main();
} catch (error) {
  console.error(`release evidence verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
