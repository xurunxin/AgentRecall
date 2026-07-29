import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const candidateWorkflowPath = join(repoRoot, ".github", "workflows", "release-candidate.yml");
const releaseWorkflowPath = join(repoRoot, ".github", "workflows", "release.yml");
const evidenceScriptPath = join(repoRoot, "scripts", "release-evidence.mjs");
const verifyScriptPath = join(repoRoot, "scripts", "verify-release-evidence.mjs");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function runNode(script: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8"
  });
}

function migrationSummary() {
  return Array.from({ length: 14 }, (_, version) => ({
    schema_version: `v${version}`,
    passed: true
  }));
}

describe("release candidate exact-SHA gate (#27)", () => {
  it("defines a dependency-free, release-critical candidate workflow on rc-* branches", () => {
    const workflow = read(candidateWorkflowPath);

    assert.match(workflow, /^name:\s*Release Candidate Gate\s*$/m);
    assert.match(workflow, /branches:\s*\["rc-\*"\]/);
    assert.match(workflow, /^jobs:\s*$/m);
    // v1.1.3 GATE-06 (issue #36): the monolithic
    // `matrix` / `mcp-blackbox-extracted` /
    // `verify-artifact-globs` / `record-evidence`
    // jobs are replaced by 5 segregated per-suite
    // jobs + a matrix leg + a release-aggregate job.
    for (const job of [
      "matrix",
      "unit-integration",
      "mcp-blackbox",
      "migrations",
      "stress",
      "packaged-artifact",
      "release-aggregate"
    ]) {
      assert.match(workflow, new RegExp(`^  ${job}:\\s*$`, "m"), `${job} job must exist in release-candidate.yml`);
    }
    for (const os of ["ubuntu-latest", "macos-latest", "windows-latest"]) {
      assert.match(workflow, new RegExp(`\\b${os}\\b`));
    }
    assert.match(workflow, /node(?:-version)?:\s*"24"/);

    for (const command of [
      "npm ci",
      "npm run typecheck",
      "npm run build",
      "npm test",
      "STRESS_PROFILE: release",
      "npm run verify:artifacts",
      "scripts/release-evidence.mjs",
      "scripts/verify-release-evidence.mjs"
    ]) {
      assert.ok(workflow.includes(command), `candidate workflow must contain ${command}`);
    }

    // v1.1.3 GATE-06 (issue #36): the per-suite
    // vitest configs are wired into the workflow;
    // the monolithic matrix leg still runs the
    // default config for cross-OS coverage. The
    // individual test-file references are now in the
    // per-suite configs (vitest.<suite>.config.ts),
    // not in the workflow YAML.
    for (const config of [
      "vitest.config.ts",
      "vitest.blackbox.config.ts",
      "vitest.migrations.config.ts",
      "vitest.stress.config.ts",
      "vitest.packaged-artifact.config.ts"
    ]) {
      assert.match(workflow, new RegExp(config.replace(/\./g, "\\.")), `${config} must be referenced by the workflow`);
    }
    assert.match(workflow, /AGENT_RECALL_RELEASE_MODE:\s*"1"/);
    assert.match(workflow, /release-evidence\.json/);
    assert.match(workflow, /release-candidate\.json/);
    assert.match(workflow, /if-no-files-found:\s*error/);
    assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
    assert.doesNotMatch(workflow, /\|\|\s*true/);
    assert.doesNotMatch(workflow, /\t/, "workflow YAML must not contain tab indentation");
  });

  it("keeps release tag-only and guards the tag commit with verified candidate evidence", () => {
    const workflow = read(releaseWorkflowPath);

    assert.match(workflow, /tags:\s*\n\s*-\s*"v\*"/);
    assert.doesNotMatch(workflow, /^\s*workflow_dispatch:/m);
    assert.match(workflow, /^  verify-release-evidence:\s*$/m);
    assert.match(workflow, /release-candidate\.yml/);
    assert.match(workflow, /release-candidate\.json/);
    assert.match(workflow, /tag_commit_sha/);
    assert.match(workflow, /release_commit/);
    assert.match(workflow, /workflow_url/);
    assert.match(workflow, /conclusion/);
    assert.match(workflow, /exit 1/);
    assert.match(workflow, /needs:\s*verify-release-evidence/);
    assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
    assert.doesNotMatch(workflow, /\|\|\s*true/);
  });

  it("writes strict release evidence from mocked GitHub Actions context", () => {
    const runnerTemp = mkdtempSync(join(tmpdir(), "agent-recall-evidence-"));
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const ciRuns = [
      {
        job_name: "Matrix ubuntu-latest / Node 24",
        os: "ubuntu-latest",
        node: "24",
        job_url: "https://github.com/xurx/agent-recall/actions/runs/42/job/100",
        workflow_url: "https://github.com/xurx/agent-recall/actions/runs/42",
        conclusion: "success",
        duration_ms: 1250
      }
    ];
    const testSummary = { passed: 12, failed: 0, skipped: 0, total: 12 };
    const env = {
      ...process.env,
      RUNNER_TEMP: runnerTemp,
      RUNNER_OS: "Linux",
      GITHUB_SHA: sha,
      GITHUB_RUN_ID: "42",
      GITHUB_RUN_NUMBER: "7",
      GITHUB_WORKFLOW: "Release Candidate Gate",
      GITHUB_JOB: "record-evidence",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "xurx/agent-recall",
      GITHUB_REF_NAME: "rc-1.1.2",
      GITHUB_REF_TYPE: "branch",
      RELEASE_EVIDENCE_CI_RUNS_JSON: JSON.stringify(ciRuns),
      RELEASE_EVIDENCE_TEST_SUMMARY_JSON: JSON.stringify(testSummary),
      RELEASE_EVIDENCE_MIGRATION_SUMMARY_JSON: JSON.stringify(migrationSummary()),
      RELEASE_EVIDENCE_ARTIFACTS_JSON: JSON.stringify([
        { name: "candidate-dist-ubuntu-latest", sha256: null }
      ]),
      RELEASE_EVIDENCE_CONCLUSION: "success",
      RELEASE_EVIDENCE_DURATION_MS: "1250"
    };

    const result = runNode(evidenceScriptPath, [], env);
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(read(join(runnerTemp, "release-evidence.json"))) as Record<string, unknown>;

    assert.equal(evidence["candidate_sha"], sha);
    assert.equal(evidence["release_commit"], sha);
    // Stage 18 v1.1.2 (issue #29, Task 10): the
    // evidence must include `version` so the
    // release-publication gate can correlate the
    // evidence with the package metadata.
    assert.equal(evidence["version"], "1.1.2");
    assert.equal(evidence["tag"], null);
    assert.deepEqual(evidence["ci_runs"], ciRuns);
    assert.deepEqual(evidence["test_summary"], testSummary);
    assert.deepEqual(evidence["migration_summary"], migrationSummary());
    assert.ok(Array.isArray(evidence["known_non_blocking_limits"]));
    assert.ok((evidence["known_non_blocking_limits"] as unknown[]).length > 0);
    assert.ok(evidence["release_workflow"] !== null);
    assert.ok(Array.isArray(evidence["artifacts"]));
    assert.deepEqual(evidence["sha256_checksums"], {});
    assert.equal(JSON.stringify(evidence).includes("undefined"), false);
  });

  it("accepts complete evidence and rejects incomplete or wrong-SHA evidence", () => {
    const runnerTemp = mkdtempSync(join(tmpdir(), "agent-recall-verify-evidence-"));
    const evidencePath = join(runnerTemp, "release-evidence.json");
    const sha = "fedcba9876543210fedcba9876543210fedcba98";
    const validEvidence = {
      schema_version: 1,
      // Stage 18 v1.1.2 (issue #29, Task 10): the
      // evidence file MUST carry the `version`
      // field the release-publication gate mints.
      version: "1.1.2",
      candidate_sha: sha,
      release_commit: sha,
      tag: null,
      ci_runs: [
        {
          job_name: "Matrix ubuntu-latest / Node 24",
          os: "ubuntu-latest",
          node: "24",
          job_url: "https://github.com/xurx/agent-recall/actions/runs/42/job/100",
          workflow_url: "https://github.com/xurx/agent-recall/actions/runs/42",
          conclusion: "success",
          duration_ms: 1000
        }
      ],
      release_workflow: {
        name: "Release Candidate Gate",
        run_id: "42",
        run_number: "7",
        job: "record-evidence",
        url: "https://github.com/xurx/agent-recall/actions/runs/42",
        conclusion: "success",
        duration_ms: 1000
      },
      // Stage 18 v1.1.2 (issue #29, Task 10): the
      // `artifacts` array MUST cover all three
      // publication platforms (linux-x64 / darwin-x64
      // / win32-x64). A partial manifest is rejected
      // by the verifier.
      artifacts: [
        { name: "agent-recall-1.1.2-linux-x64.tar.gz", sha256: "a".repeat(64) },
        { name: "agent-recall-1.1.2-darwin-x64.tar.gz", sha256: "b".repeat(64) },
        { name: "agent-recall-1.1.2-win32-x64.zip", sha256: "c".repeat(64) }
      ],
      sha256_checksums: {},
      test_summary: { passed: 10, failed: 0, skipped: 0, total: 10 },
      migration_summary: migrationSummary(),
      known_non_blocking_limits: ["Task 9 will replace the extracted-dist wiring with the final package fixture."]
    };
    writeFileSync(evidencePath, `${JSON.stringify(validEvidence, null, 2)}\n`);

    const env = { ...process.env, RUNNER_TEMP: runnerTemp, GITHUB_SHA: sha };
    const accepted = runNode(verifyScriptPath, [evidencePath], env);
    assert.equal(accepted.status, 0, accepted.stderr);

    writeFileSync(evidencePath, `${JSON.stringify({ ...validEvidence, release_commit: "wrong" }, null, 2)}\n`);
    const wrongSha = runNode(verifyScriptPath, [evidencePath], env);
    assert.equal(wrongSha.status, 1);

    writeFileSync(
      evidencePath,
      `${JSON.stringify({
        ...validEvidence,
        test_summary: { passed: 0, failed: 1, skipped: 0, total: 1 },
        migration_summary: migrationSummary().slice(1)
      }, null, 2)}\n`
    );
    const incomplete = runNode(verifyScriptPath, [evidencePath], env);
    assert.equal(incomplete.status, 1);
  });

  it("documents the frozen candidate mechanism and operator procedure", () => {
    const adr = read(join(repoRoot, "docs", "adr", "0002-release-candidate-gate.md"));
    const changelog = read(join(repoRoot, "CHANGELOG.md"));
    const readme = read(join(repoRoot, "README.md"));

    assert.match(adr, /candidate SHA/i);
    assert.match(adr, /tag guard/i);
    assert.match(adr, /release-evidence\.json/);
    assert.match(adr, /workflow URL/i);
    assert.match(changelog, /\[1\.1\.2\].*#27/i);
    assert.match(changelog, /release-evidence\.json/);
    assert.match(changelog, /Known non-blocking limits/);
    assert.match(readme, /^## Release Candidate Gate$/m);
    assert.match(readme, /rc-\*/);
    assert.match(readme, /#19/);
    assert.match(readme, /workflow URL/i);
  });
});
