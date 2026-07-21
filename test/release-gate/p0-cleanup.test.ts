// test/release-gate/p0-cleanup.test.ts
//
// Stage 14 PR-D (Cleanup): the release-gate locks
// for the documentation / shape invariants that
// the PR-D commit is supposed to leave behind. The
// goal of these tests is not to assert runtime
// behaviour (the runtime tests already do that),
// but to prevent a future PR from silently
// regressing the user-visible surface of the
// v1.0 release:
//
//   1. `runDoctor` reports exactly 24 check
//      results. Pre-PR-C the count was 12; the
//      v1.0 acceptance criteria (spec § 9.1)
//      doubled it.
//   2. The 12 v1.0 doctor check names are all
//      present in the report. A future PR that
//      drops one of them (e.g. renames
//      `idempotency_integrity` to
//      `mutation_requests_integrity`) without a
//      matching README / CHANGELOG update is
//      caught here.
//   3. README.md's "Doctor" section mentions
//      "24" (the v1.0 count), not the pre-PR-C
//      "12".
//   4. CHANGELOG.md has a `## [Unreleased] — Stage
//      14 PR-D (Cleanup)` block so a future PR
//      that removes the cleanup entry without
//      adding a replacement is caught.
//   5. CHANGELOG.md has a `## [Unreleased] — Stage
//      14 PR-C (Doctor Checks)` block, the
//      closest upstream PR whose regression the
//      doctor check count depends on.
//   6. The package's `version` field is still
//      `0.1.0` (per master plan: "don't change
//      package.json dependencies / version in
//      this stage; v1.0.0 is the explicit
//      Stage 14 PR-E step").
//
// These tests are intentionally tolerant: they
// guard the *invariant* the user-facing surface
// promises, not the exact wording. A future
// maintainer who wants to rewrite the README
// section header from "Doctor" to "Health" only
// has to keep "24" in the prose.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../../src/doctor/index.js";
import { SQLiteMemoryStore } from "../../src/sqlite-store.js";

const EXPECTED_V1_CHECKS = [
  "scope_safety",
  "revision_integrity",
  "journal_mode",
  "sqlite_runtime",
  "lock_health",
  "backup_verification",
  "project_alias_collision",
  "ranking_health",
  "export_collision",
  "audit_revision_gap",
  "secret_policy_version",
  "idempotency_integrity"
];

describe("release-gate p0-cleanup (Stage 14 PR-D)", () => {
  let store: SQLiteMemoryStore;
  let dataHome: string;

  beforeEach(() => {
    dataHome = mkdtempSync(join(tmpdir(), "lm-rg-cleanup-"));
    const dbPath = join(dataHome, "memory.sqlite");
    store = new SQLiteMemoryStore(dbPath);
  });

  afterEach(() => {
    try { store.close(); } catch { /* already closed */ }
  });

  it("runDoctor reports 24 checks on a healthy store", () => {
    const report = runDoctor({ dataHome, store, now: () => new Date() });
    expect(report.results.length).toBe(24);
  });

  it("the 12 v1.0 acceptance doctor checks are all present", () => {
    const report = runDoctor({ dataHome, store, now: () => new Date() });
    const names = new Set(report.results.map((r) => r.name));
    for (const expected of EXPECTED_V1_CHECKS) {
      expect(names.has(expected), `doctor check '${expected}' is missing`).toBe(true);
    }
  });

  it("README mentions the 24-check doctor surface (not the pre-PR-C 12)", () => {
    // Resolve the repo root from this test file.
    const repoRoot = join(import.meta.dirname, "..", "..");
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    // The "Doctor" section explicitly says "runs **24** health
    // checks". A future PR that reverts to "twelve" or drops
    // the count is caught here. Tolerate Markdown emphasis
    // (`**24**`) and trailing punctuation.
    expect(readme).toMatch(/\*?\*?24\*?\*?\s+health checks/);
    // The pre-PR-C wording must not survive.
    expect(readme).not.toMatch(/twelve health checks/);
  });

  it("CHANGELOG has a Stage 14 PR-D (Cleanup) block", () => {
    const repoRoot = join(import.meta.dirname, "..", "..");
    const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
    expect(changelog).toMatch(/## \[Unreleased\] — Stage 14 PR-D \(Cleanup\)/);
  });

  it("CHANGELOG has a Stage 14 PR-C (Doctor Checks) block", () => {
    const repoRoot = join(import.meta.dirname, "..", "..");
    const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
    expect(changelog).toMatch(/## \[Unreleased\] — Stage 14 PR-C \(Doctor Checks\)/);
  });

  it("package.json version is still 0.1.0 (master plan rule: PR-E bumps to 1.0.0)", () => {
    const repoRoot = join(import.meta.dirname, "..", "..");
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };
    expect(pkg.version).toBe("0.1.0");
  });
});
