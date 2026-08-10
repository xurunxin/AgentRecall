import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("release evidence schema", () => {
  const schema = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../scripts/release-evidence.schema.json"), "utf8"));
  it("pins schema version 1.1.3", () => expect(schema.properties.schema_version.const).toBe("1.1.3"));
  it("uses canonical platforms", () => expect(schema.$defs.platform.enum).toEqual(["linux-x64", "darwin-x64", "win32-x64"]));
  it("requires checksums as an object", () => expect(schema.properties.sha256_checksums.type).toBe("object"));
});

describe("verify-release-evidence v1.1.3 strict path", () => {
  // v1.1.6 follow-up A1 (Task 1): the verifier
  // dropped the v1.1.2 legacy shim. The v1.1.3
  // GATE-04 strict shape is the only accepted
  // input. These tests exercise the strict path
  // end-to-end with a real v1.1.3 fixture so
  // dropping the legacy branch stays local-CI green.
  const repoRoot = resolve(import.meta.dirname, "../..");
  const verifyScriptPath = join(repoRoot, "scripts", "verify-release-evidence.mjs");
  const SHA = "a".repeat(40);

  function buildFixture() {
    const dir = mkdtempSync(join(tmpdir(), "v113-strict-evidence-"));
    const platforms = ["linux-x64", "darwin-x64", "win32-x64"] as const;
    const artifacts = platforms.map((platform) => {
      const name = `agent-recall-${platform}.${platform === "win32-x64" ? "zip" : "tar.gz"}`;
      const bytes = `fixture ${platform}\n`;
      writeFileSync(join(dir, name), bytes);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return { platform, name, size_bytes: bytes.length, sha256 };
    });
    const job = (platform: string) => ({ platform, os: platform, node: "24", job_url: "https://github.com/x/y/actions/runs/1", conclusion: "success" as const, duration_ms: 1000, head_sha: SHA });
    const doc = {
      schema_version: "1.1.3",
      version: "1.1.6",
      release_commit: SHA,
      tag: "v1.1.6",
      candidate_sha: SHA,
      subissues: [],
      ci_jobs: artifacts.map((a) => job(a.platform)),
      release_workflow: job("linux-x64"),
      artifacts,
      sha256_checksums: Object.fromEntries(artifacts.map((a) => [a.name, a.sha256])),
      test_summary: { passed: 100, failed: 0, skipped: 0, filtered: 0, totals_from: "actual" as const },
      stress_summary: { process_count: 1, operations: 10, invariants_ok: 10 },
      migration_summary: { sources_tested: ["v0", "v1"], each_passed: true },
      known_non_blocking_limits: []
    };
    return { dir, doc };
  }

  it("accepts a complete v1.1.3 strict fixture", () => {
    const { dir, doc } = buildFixture();
    const path = join(dir, "release-evidence.json");
    writeFileSync(path, JSON.stringify(doc, null, 2));
    const result = spawnSync(process.execPath, [verifyScriptPath, "--stable", "--evidence", path], { encoding: "utf8" });
    expect(result.status).toBe(0);
  });

  it("rejects a v1.1.2-shape fixture (legacy branch is removed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "v113-strict-evidence-"));
    const doc = { schema_version: 1, version: "1.1.5", candidate_sha: SHA, release_commit: SHA, tag: null, ci_runs: [], release_workflow: { name: "x", run_id: "1", run_number: "1", job: "x", url: "x", conclusion: "success", duration_ms: 1 }, artifacts: [], sha256_checksums: {}, test_summary: {}, migration_summary: [], known_non_blocking_limits: [] };
    const path = join(dir, "release-evidence.json");
    writeFileSync(path, JSON.stringify(doc, null, 2));
    const result = spawnSync(process.execPath, [verifyScriptPath, "--stable", "--evidence", path], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stderr).code).toBe("SCHEMA_INVALID");
  });

  it("emits a soft warning when RELEASE_ARTIFACT_HASHES_PATH points at a mismatching file (does not fail)", () => {
    // v1.1.6 follow-up A1 (Task 1): the new soft
    // cross-check is a no-op when the env var is
    // unset (rc-branch case). When the env var
    // points at a `release-artifact-hashes.json`
    // with the wrong sha256 for any artifact, the
    // verifier logs `[MISMATCHED_PLATFORMS] WARNING:`
    // and continues (Phase 1 soft-mode). Task 12
    // flips this to a hard `reject()`.
    const { dir, doc } = buildFixture();
    const path = join(dir, "release-evidence.json");
    writeFileSync(path, JSON.stringify(doc, null, 2));
    const hashesPath = join(dir, "release-artifact-hashes.json");
    writeFileSync(hashesPath, JSON.stringify({
      schema_version: 1,
      candidate_sha: SHA,
      generated_at: new Date().toISOString(),
      artifacts: doc.artifacts.map((a) => ({ platform: a.platform, artifact_path: a.name, sha256: "0".repeat(64), size_bytes: a.size_bytes, mtime: new Date().toISOString() }))
    }));
    const result = spawnSync(process.execPath, [verifyScriptPath, "--stable", "--evidence", path], { encoding: "utf8", env: { ...process.env, RELEASE_ARTIFACT_HASHES_PATH: hashesPath } });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("[MISMATCHED_PLATFORMS] WARNING");
  });

  it("skips the soft cross-check when RELEASE_ARTIFACT_HASHES_PATH is unset (rc-branch default)", () => {
    const { dir, doc } = buildFixture();
    const path = join(dir, "release-evidence.json");
    writeFileSync(path, JSON.stringify(doc, null, 2));
    const result = spawnSync(process.execPath, [verifyScriptPath, "--stable", "--evidence", path], { encoding: "utf8", env: { ...process.env, RELEASE_ARTIFACT_HASHES_PATH: "" } });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("[MISMATCHED_PLATFORMS] WARNING");
  });
});
