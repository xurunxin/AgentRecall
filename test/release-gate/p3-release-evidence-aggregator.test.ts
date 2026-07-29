import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../.."); const SHA = "a".repeat(40);
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "aggregate-e2e-")); const fragments = join(dir, "fragments"); mkdirSync(fragments);
  ["linux-x64", "darwin-x64", "win32-x64"].forEach((platform, i) => { const name = `${platform}.tgz`; const bytes = Buffer.from(platform); writeFileSync(join(dir, name), bytes); const digest = createHash("sha256").update(bytes).digest("hex"); const job = { os: platform, node: "24", job_url: "https://github.com/x/y/actions/runs/1", conclusion: "success", duration_ms: 1, head_sha: SHA }; writeFileSync(join(fragments, `${i}.json`), JSON.stringify({ platform, version: "1.1.3", release_commit: SHA, candidate_sha: SHA, tag: "v1.1.3", ci_job: job, release_workflow: { ...job, platform: "linux-x64" }, artifact: { name, size_bytes: bytes.length, sha256: digest }, test_summary: { passed: 1, failed: 0, skipped: 0, filtered: 0, totals_from: "actual" }, stress_summary: { process_count: 1, operations: 1, invariants_ok: 1 }, migration_summary: { sources_tested: ["v0"], each_passed: true } })); });
  return { dir, fragments, output: join(dir, "release-evidence.json") };
}
function aggregate(x: ReturnType<typeof setup>) { return spawnSync(process.execPath, [join(root, "scripts/release-evidence.mjs"), "--fragments", x.fragments, "--output", x.output], { encoding: "utf8" }); }
function verify(path: string) { return spawnSync(process.execPath, [join(root, "scripts/verify-release-evidence.mjs"), "--stable", "--evidence", path], { encoding: "utf8" }); }

describe("release evidence aggregator", () => {
  it("aggregates three fragments into verified evidence", () => { const x = setup(); expect(aggregate(x).status).toBe(0); expect(verify(x.output).status).toBe(0); });
  it("fails when a fragment is missing", () => { const x = setup(); rmSync(join(x.fragments, "2.json")); const result = aggregate(x); expect(result.status).not.toBe(0); expect(result.stderr).toContain("MISMATCHED_PLATFORMS"); });
  it("detects artifact checksum mismatch", () => { const x = setup(); expect(aggregate(x).status).toBe(0); writeFileSync(join(x.dir, "linux-x64.tgz"), "tampered"); const result = verify(x.output); expect(result.status).not.toBe(0); expect(JSON.parse(result.stderr).code).toBe("CHECKSUM_BYTES_MISMATCH"); });
});
