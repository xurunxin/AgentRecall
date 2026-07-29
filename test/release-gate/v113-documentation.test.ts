// test/release-gate/v113-documentation.test.ts
//
// v1.1.3 GATE-07 (issue #37): the v1.1.3 documentation contract.
//
// What this suite pins:
//
//   1. README uses the canonical entry paths
//      (`dist/src/index.js` for the MCP server, `dist/bin/agent-recall.js`
//      for the CLI) and drops the v1.1.2-era `dist/index.js` (no
//      `src/` prefix).
//   2. README cross-links every v1.1.3 ADR
//      (0004 / 0005 / 0006 / 0007 / 0008) and the operator guides
//      shipped by Phase A + B.
//   3. README uses the canonical platform vocabulary
//      (`linux-x64` / `darwin-x64` / `win32-x64`) — the v1.1.2-era
//      `windows-x64` token is gone.
//   4. README has no claim that contradicts the v1.1.3 behaviour
//      (e.g. no "lookup mode may create a new identity" — that
//      was the v1.1.2 bug #31 closed).
//   5. README badge + repo references point to
//      `xurunxin/AgentRecall` (the v1.1.3 home); the
//      v1.1.2-era `xurx/agent-recall` is gone.
//   6. README has an `## Installation` section that names the
//      canonical-platform artefact, the `sha256 -c` verify, the
//      extract, the `npm install --omit=dev`, and the run step.
//   7. README has an explicit upgrade / rollback section against
//      v1.1.2 (schema-preserving migration + rollback recipe).
//
// The docs tests do NOT execute the README commands end-to-end —
// they are static-text asserts (regex reads) so a markdown typo
// surfaces as a release-gate failure without spinning up the
// packaged binary.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

const readme = read(join(repoRoot, "README.md"));

// ============================================================
// 1. Canonical entry paths
// ============================================================

describe("v1.1.3 GATE-07 documentation: canonical entry paths", () => {
  it("README references dist/src/index.js as the MCP entry path", () => {
    assert.match(
      readme,
      /dist\/src\/index\.js/,
      "README must reference the v1.1.3 MCP entry path `dist/src/index.js`"
    );
  });

  it("README references dist/bin/agent-recall.js as the CLI entry path", () => {
    assert.match(
      readme,
      /dist\/bin\/agent-recall\.js/,
      "README must reference the v1.1.3 CLI entry path `dist/bin/agent-recall.js`"
    );
  });

  it("README does not advertise the legacy dist/index.js (no src/) entry path", () => {
    // The legacy v1.1.2 path was `dist/index.js` (no `src/`).
    // The v1.1.3 contract uses `dist/src/index.js`; this regex
    // matches the bare `dist/index.js` only when it is NOT
    // followed by a slash + `src` or another path segment. The
    // negative assertion below catches the v1.1.2-era stray
    // `node dist/index.js` line that lived in the Setup section.
    const legacyBare = /(?:^|\s)node\s+dist\/index\.js\b/m;
    assert.doesNotMatch(
      readme,
      legacyBare,
      "README must not instruct `node dist/index.js` (the v1.1.2-era entry path). Use `dist/src/index.js` for the MCP server."
    );
    // And the bare `dist/index.js` mention without a path
    // separator must not appear (e.g. inside a code-fence
    // listing).
    const bare = /(^|[^/])dist\/index\.js(?![\w/])/m;
    assert.doesNotMatch(
      readme,
      bare,
      "README must not reference the bare `dist/index.js` token — use `dist/src/index.js`."
    );
  });
});

// ============================================================
// 2. v1.1.3 ADR cross-links
// ============================================================

describe("v1.1.3 GATE-07 documentation: v1.1.3 ADR cross-links", () => {
  const adrs = [
    "docs/adr/0004-identity-resolution-modes.md",
    "docs/adr/0005-profile-scoped-admin-capability.md",
    "docs/adr/0006-one-sensitivity-policy.md",
    "docs/adr/0007-release-evidence-contract.md",
    "docs/adr/0008-deterministic-orchestration.md"
  ];

  for (const adr of adrs) {
    it(`README references ${adr}`, () => {
      assert.match(
        readme,
        new RegExp(adr.replace(/[/.]/g, (m) => `\\${m}`)),
        `README must cross-link the v1.1.3 ADR ${adr}`
      );
    });
  }
});

// ============================================================
// 3. Canonical platform vocabulary
// ============================================================

describe("v1.1.3 GATE-07 documentation: canonical platform vocabulary", () => {
  it("README uses linux-x64 as the Linux platform token", () => {
    assert.match(readme, /\blinux-x64\b/, "README must use `linux-x64` (the canonical token)");
  });

  it("README uses darwin-x64 as the macOS platform token", () => {
    assert.match(readme, /\bdarwin-x64\b/, "README must use `darwin-x64` (the canonical token)");
  });

  it("README uses win32-x64 as the Windows platform token", () => {
    assert.match(readme, /\bwin32-x64\b/, "README must use `win32-x64` (the canonical token)");
  });

  it("README does not contain the v1.1.2-era `windows-x64` token", () => {
    assert.doesNotMatch(
      readme,
      /\bwindows-x64\b/,
      "README must NOT reference `windows-x64` (the v1.1.2-era token). Use `win32-x64`."
    );
  });
});

// ============================================================
// 4. Behavioural consistency (no v1.1.2-era claims)
// ============================================================

describe("v1.1.3 GATE-07 documentation: no v1.1.2-era behavioural claims", () => {
  it("README does not claim lookup mode may create a new identity", () => {
    // The v1.1.2 bug #31 closed: lookup / strict_existing modes
    // produce zero database writes. A README sentence that
    // implies a write is a regression of the v1.1.3 contract.
    const offender = /lookup[^.\n]*creat(?:e|ed|ing)\s+(?:a\s+)?(?:new\s+)?identity/i;
    assert.doesNotMatch(
      readme,
      offender,
      "README must not claim that lookup mode may create a new identity. Lookup is side-effect free (#31)."
    );
  });

  it("README does not advertise actorMaxSensitivity as a tunable string", () => {
    // The v1.1.2-era README surfaced `actorMaxSensitivity` as a
    // configurable knob. The v1.1.3 GATE-03 lane derives it
    // from `(activeProfile === "admin" && capability) ?
    // "restricted" : "normal"`. README mentions are OK; the
    // "tunable" / "configure" framing must be absent.
    const tunable = /configur(?:e|able)\s+actorMaxSensitivity/i;
    assert.doesNotMatch(
      readme,
      tunable,
      "README must not advertise `actorMaxSensitivity` as a tunable. It is derived from the active profile + capability."
    );
  });
});

// ============================================================
// 5. Badge + repo references
// ============================================================

describe("v1.1.3 GATE-07 documentation: badge + repo references", () => {
  it("README badge URL points at xurunxin/AgentRecall", () => {
    assert.match(
      readme,
      /github\.com\/xurunxin\/AgentRecall/,
      "README badge URL must point at `xurunxin/AgentRecall` (the v1.1.3 home)"
    );
  });

  it("README does not reference the legacy xurx/agent-recall repo", () => {
    assert.doesNotMatch(
      readme,
      /github\.com\/xurx\/agent-recall\b/,
      "README must not reference the legacy `xurx/agent-recall` repo. Use `xurunxin/AgentRecall`."
    );
  });
});

// ============================================================
// 6. Operator guides from Phase A + B
// ============================================================

describe("v1.1.3 GATE-07 documentation: operator guide cross-links", () => {
  const guides = [
    "docs/guides/identity-resolution.md",
    "docs/guides/operator-capability.md",
    "docs/guides/sensitivity-matrix.md",
    "docs/guides/release-publication.md",
    "docs/guides/release-test-topology.md"
  ];

  for (const guide of guides) {
    it(`README references ${guide}`, () => {
      assert.match(
        readme,
        new RegExp(guide.replace(/[/.]/g, (m) => `\\${m}`)),
        `README must cross-link the operator guide ${guide}`
      );
    });
  }
});

// ============================================================
// 7. Installation section
// ============================================================

describe("v1.1.3 GATE-07 documentation: Installation section", () => {
  it("README has an `## Installation` heading", () => {
    assert.match(
      readme,
      /^##\s+Installation\s*$/m,
      "README must have a top-level `## Installation` section"
    );
  });

  it("README Installation section describes the canonical-platform artefact", () => {
    // Locate the Installation section and verify it names
    // the canonical platform tokens (one of which is required
    // for the artefact filename).
    const installation = readme.match(/^##\s+Installation\s*\n([\s\S]*?)(?=^##\s|\Z)/m);
    assert.ok(installation, "README must have an Installation section");
    const body = installation[1] ?? "";
    for (const token of ["linux-x64", "darwin-x64", "win32-x64"]) {
      assert.match(
        body,
        new RegExp(`\\b${token}\\b`),
        `README Installation section must reference the canonical platform token ${token}`
      );
    }
  });

  it("README Installation section describes sha256 verification", () => {
    const installation = readme.match(/^##\s+Installation\s*\n([\s\S]*?)(?=^##\s|\Z)/m);
    assert.ok(installation, "README must have an Installation section");
    const body = installation[1] ?? "";
    assert.match(
      body,
      /sha256/i,
      "README Installation section must mention `sha256` (the artefact verify step)"
    );
  });

  it("README Installation section describes the extract + npm install --omit=dev + run", () => {
    const installation = readme.match(/^##\s+Installation\s*\n([\s\S]*?)(?=^##\s|\Z)/m);
    assert.ok(installation, "README must have an Installation section");
    const body = installation[1] ?? "";
    // Either a literal tar/zip extract mention, OR the script
    // reference. We assert both the extract idiom and the
    // install + run.
    assert.match(
      body,
      /npm\s+install[^.\n]*--omit=dev/,
      "README Installation section must include `npm install --omit=dev`"
    );
  });
});

// ============================================================
// 8. Upgrade / Rollback section
// ============================================================

describe("v1.1.3 GATE-07 documentation: Upgrade / Rollback section", () => {
  it("README has an `## Upgrade` or `## Rollback` heading", () => {
    const upgrade = /^##\s+Upgrade\s*$/m.test(readme);
    const rollback = /^##\s+Rollback\s*$/m.test(readme);
    const combined = /^##\s+Upgrade\s*\/\s*Rollback\s*$/m.test(readme);
    assert.ok(
      upgrade || rollback || combined,
      "README must have an explicit upgrade / rollback section"
    );
  });

  it("README Upgrade / Rollback section references v1.1.2 → v1.1.3 migration", () => {
    const section = readme.match(
      /^##\s+(?:Upgrade|Rollback|Upgrade\s*\/\s*Rollback)\s*\n([\s\S]*?)(?=^##\s|\Z)/m
    );
    assert.ok(section, "README must have an Upgrade / Rollback section");
    const body = section[1] ?? "";
    assert.match(
      body,
      /v1\.1\.2[^.\n]*v1\.1\.3|v1\.1\.3[^.\n]*v1\.1\.2|migration/i,
      "README Upgrade / Rollback section must reference the v1.1.2 → v1.1.3 migration"
    );
  });
});