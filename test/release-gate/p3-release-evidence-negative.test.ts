import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const SHA = "a".repeat(40);
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "negative-evidence-"));
  const artifacts = ["linux-x64", "darwin-x64", "win32-x64"].map(platform => { const name = `${platform}.tgz`; const bytes = Buffer.from(platform); writeFileSync(join(dir, name), bytes); return { platform, name, size_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }; });
  const job = (platform: string) => ({ platform, os: platform, node: "24", job_url: "https://github.com/x/y/actions/runs/1", conclusion: "success", duration_ms: 1, head_sha: SHA });
  const doc: any = { schema_version: "1.1.3", version: "1.1.3", release_commit: SHA, tag: "v1.1.3", candidate_sha: SHA, subissues: [], ci_jobs: artifacts.map(a => job(a.platform)), release_workflow: job("linux-x64"), artifacts, sha256_checksums: Object.fromEntries(artifacts.map(a => [a.name, a.sha256])), test_summary: { passed: 1, failed: 0, skipped: 0, filtered: 0, totals_from: "actual" }, stress_summary: { process_count: 1, operations: 1, invariants_ok: 1 }, migration_summary: { sources_tested: ["v0"], each_passed: true }, known_non_blocking_limits: [] };
  return { dir, doc };
}
function reject(expected: string, mutate: (doc: any) => void) { const { dir, doc } = fixture(); mutate(doc); const path = join(dir, "release-evidence.json"); writeFileSync(path, JSON.stringify(doc)); const result = spawnSync(process.execPath, [join(root, "scripts/verify-release-evidence.mjs"), "--stable", "--evidence", path], { encoding: "utf8" }); expect(result.status).not.toBe(0); expect(JSON.parse(result.stderr).code).toBe(expected); }

describe("stable evidence rejection codes", () => {
  const cases: [string, (d: any) => void][] = [
    ["LOCAL_URL_FORBIDDEN", d => d.release_workflow.job_url = "local://workflow"], ["PLATFORM_NOT_CANONICAL", d => d.artifacts[0].platform = "windows-x64"], ["CHECKSUM_TYPE_INVALID", d => d.sha256_checksums = []], ["CHECKSUM_BYTES_MISMATCH", d => d.artifacts[0].sha256 = "0".repeat(64)], ["CANDIDATE_SHA_MISMATCH", d => d.candidate_sha = "b".repeat(40)], ["DURATION_PLACEHOLDER", d => d.ci_jobs[0].duration_ms = 0], ["TEST_TOTALS_FROM_CONSTANT", d => d.test_summary.totals_from = "constant"], ["MISSING_GITHUB_JOB_URL", d => d.ci_jobs[0].job_url = "https://example.com/job"], ["EMPTY_ARTIFACTS", d => { d.artifacts = []; d.sha256_checksums = {}; }], ["DUPLICATE_ARTIFACTS", d => d.artifacts[1].name = d.artifacts[0].name], ["MISMATCHED_PLATFORMS", d => { d.artifacts.pop(); delete d.sha256_checksums["win32-x64.tgz"]; }], ["SCHEMA_INVALID", d => delete d.version]
  ];
  for (const [code, mutate] of cases) it(code, () => reject(code, mutate));
});
