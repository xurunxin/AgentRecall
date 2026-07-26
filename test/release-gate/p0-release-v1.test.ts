// test/release-gate/p0-release-v1.test.ts
//
// Stage 14 PR-E (Release v1.0.0): the v1.0 Definition
// of Done locks (spec § 17). PR-E consolidates the
// per-PR [Unreleased] blocks into a single [1.0.0]
// block, bumps `package.json.version` from 0.1.0 to
// 1.0.0, and tags the release. This release-gate
// test pins the user-visible shape of the v1.0
// release so a future maintenance patch that
// silently bumps or rewrites the version metadata
// is caught here.
//
//   DoD #3 — `package.json` version is `1.0.0`.
//   DoD #4 — `git tag v1.0.0` exists locally (the
//            tag is *not* pushed by the release
//            script; pushing is the operator's
//            explicit call).
//   DoD #5 — `CHANGELOG.md` has a `## [1.0.0]` block
//            that mentions every Stage 14 sub-PR
//            (A / B1 / B2 / C / D).
//
// Reference: spec § 17 "v1.0 Definition of Done
// #1-6", master plan § 7 "Stage 14 v1.0
// acceptance bar".

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");

function readPackage(): { version: string; name: string } {
  return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string; name: string };
}

function readChangelog(): string {
  return readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
}

function gitTagExists(tag: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", `refs/tags/${tag}`], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return true;
  } catch {
    return false;
  }
}

describe("release-gate p0-release-v1 (Stage 14 PR-E)", () => {
  it("DoD #3: package.json version is 1.1.0 (Stage 15 v1.1 release)", () => {
    // Stage 15 v1.1.0: the 8-PR v1.1 roadmap is
    // released. The v1.0 release-gate was originally
    // a 1.0.0 lock; we keep the gate but move the
    // expected version to 1.1.0. The `name` lock is
    // unchanged.
    const pkg = readPackage();
    expect(pkg.name).toBe("agent-recall");
    expect(pkg.version).toBe("1.1.0");
  });

  it("DoD #5: CHANGELOG has a [1.0.0] block that mentions Stage 14 v1.0", () => {
    const changelog = readChangelog();
    // The consolidated release block lives at the top of the
    // [Unreleased] / [1.0.0] / [x.y.z] cascade (Keep a
    // Changelog convention).
    expect(changelog).toMatch(/^## \[1\.0\.0\][^\n]*Stage 14/m);
  });

  it("DoD #5: [1.0.0] block names every Stage 14 sub-PR", () => {
    const changelog = readChangelog();
    // The block consolidates PR-A / PR-B1 / PR-B2 / PR-C / PR-D
    // as ### sub-section headers; this guarantees the release
    // note covers the full Stage 14 scope.
    const requiredSubSections = [
      /### Stage 14 PR-A \(Migrate Pre-Backup\)/,
      /### Stage 14 PR-B1 \(Request Context \+ Error Codes\)/,
      /### Stage 14 PR-B2 \(Mutation Safety\)/,
      /### Stage 14 PR-C \(Doctor Checks\)/,
      /### Stage 14 PR-D \(Cleanup\)/
    ];
    for (const pat of requiredSubSections) {
      expect(changelog, `CHANGELOG missing sub-section: ${pat}`).toMatch(pat);
    }
  });

  it("DoD #5: [1.0.0] block has a single Date: 2026-07-21 line", () => {
    // The pre-release per-PR blocks each had their own
    // `Date: 2026-07-21` line. The consolidation should leave
    // exactly one such line per `## [...]` heading in the
    // Stage 14 region.
    const changelog = readChangelog();
    const start = changelog.indexOf("## [1.0.0]");
    const end = changelog.indexOf("## [", start + 1);
    const region = end < 0 ? changelog.slice(start) : changelog.slice(start, end);
    const matches = region.match(/^Date: 2026-07-21\s*$/gm) ?? [];
    expect(matches.length, `[1.0.0] region should have exactly one Date: 2026-07-21 line, found ${matches.length}`).toBe(1);
  });

  it("DoD #5: pre-release per-PR [Unreleased] - Stage 14 blocks are gone", () => {
    // The consolidation removes the five `## [Unreleased] —
    // Stage 14 PR-X` headings; they should no longer appear.
    const changelog = readChangelog();
    expect(changelog).not.toMatch(/## \[Unreleased\] — Stage 14 PR-/);
  });

  it("DoD #4: git tag v1.0.0 exists locally", () => {
    // The release script tags v1.0.0 on the merged commit.
    // This test is informational in CI (the tag is created
    // by the release step, not the merge step) — failing
    // here means the release step was skipped.
    const exists = gitTagExists("v1.0.0");
    if (!exists) {
      // eslint-disable-next-line no-console
      console.warn("tag v1.0.0 not present locally — release step may not have run");
    }
    expect(exists, "git tag v1.0.0 should exist on the merged commit").toBe(true);
  });

  it("DoD #3: package.json name is 'agent-recall' (regression lock)", () => {
    // Pre-PR-E someone could have re-named the package by
    // accident; the v1.0 release must keep the public npm
    // name that existing clients already pin against.
    const pkg = readPackage();
    expect(pkg.name).toBe("agent-recall");
  });
});
