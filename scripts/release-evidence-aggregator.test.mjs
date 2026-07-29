import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { aggregateFragments } from "./release-evidence.mjs";

const SHA = "a".repeat(40);
test("aggregates and canonicalises three fragments", () => {
  const dir = mkdtempSync(join(tmpdir(), "aggregate-unit-"));
  const tokens = ["ubuntu-latest", "macos-latest", "windows-x64"];
  const paths = tokens.map((platform, i) => {
    const canonical = ["linux-x64", "darwin-x64", "win32-x64"][i]; const name = `${canonical}.tgz`; const bytes = Buffer.from(canonical); writeFileSync(join(dir, name), bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const job = { os: platform, node: "24", job_url: "https://github.com/x/y/actions/runs/1", conclusion: "success", duration_ms: 1, head_sha: SHA };
    const fragment = { platform, version: "1.1.3", release_commit: SHA, candidate_sha: SHA, tag: "v1.1.3", ci_job: job, release_workflow: { ...job, platform: "linux-x64" }, artifact: { name, size_bytes: bytes.length, sha256: digest }, test_summary: { passed: 2, failed: 0, skipped: 0, filtered: 0, totals_from: "actual" }, stress_summary: { process_count: 1, operations: 1, invariants_ok: 1 }, migration_summary: { sources_tested: ["v0"], each_passed: true } };
    const path = join(dir, `fragment-${i}.json`); writeFileSync(path, JSON.stringify(fragment)); return path;
  });
  const doc = aggregateFragments(paths);
  assert.deepEqual(doc.artifacts.map(a => a.platform), ["linux-x64", "darwin-x64", "win32-x64"]);
  assert.equal(doc.test_summary.passed, 6);
  assert.equal(doc.test_summary.totals_from, "actual");
});
