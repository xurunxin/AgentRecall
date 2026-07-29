// test/release-gate/v113-distribution-contract.test.ts
//
// v1.1.3 GATE-07 (issue #37): the v1.1.3 distribution contract.
// Companion to `p3-release-immutability.test.ts` (which pins the
// v1.1.2 publication surface) — this suite pins the v1.1.3
// surface: the canonical entry points, the `files` array, the
// LICENSE file, the canonical version source (the
// `serverVersion()` helper + the CLI `--version` flag), and the
// post-build artefact tree.
//
// What this suite pins:
//
//   1. `package.json` `files` includes `dist`, `README.md`,
//      `LICENSE`, `CHANGELOG.md` (the canonical publication
//      surface — no `node_modules`, no `node_modules/.bin`).
//   2. `LICENSE` exists at the project root.
//   3. `dist/src/index.js` exists after `npm run build`.
//   4. `dist/bin/agent-recall.js` exists after `npm run build`.
//   5. `src/server-version.ts` resolves to `1.1.3` (the canonical
//      version source for the MCP server + the CLI).
//   6. The CLI `agent-recall --version` outputs `1.1.3`.
//
// The suite is RED against the v1.1.2 implementation:
// - `package.json` version is `1.1.2` (test 5 fails).
// - The CLI does not expose `--version` (test 6 fails).
// - The `dist/` tree is empty until `npm run build` runs
//   (tests 3 + 4 fail until the build completes; the suite
//   builds in `beforeAll` so the assertions run on a fresh tree).

import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function readJson<T>(path: string): T {
  return JSON.parse(readText(path)) as T;
}

// ============================================================
// Build the dist/ tree once so the artefact existence tests
// have a stable fixture. The build is the same one `npm test`
// relies on (the README / scripts / workflows all chain through
// it). A failure here is a release-gate failure.
// ============================================================

describe("v1.1.3 GATE-07 distribution contract: build", () => {
  beforeAll(() => {
    const result = spawnSync(process.execPath, [
      join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      join(repoRoot, "tsconfig.json")
    ], {
      cwd: repoRoot,
      encoding: "utf8"
    });
    assert.equal(
      result.status,
      0,
      `npm run build must exit 0; got ${result.status}; stderr=${result.stderr}; stdout=${result.stdout}`
    );
  }, 120_000);

  it("dist/src/index.js exists after npm run build", () => {
    assert.ok(
      existsSync(join(repoRoot, "dist", "src", "index.js")),
      "dist/src/index.js must exist after `npm run build` (the MCP canonical entry path)"
    );
  });

  it("dist/bin/agent-recall.js exists after npm run build", () => {
    assert.ok(
      existsSync(join(repoRoot, "dist", "bin", "agent-recall.js")),
      "dist/bin/agent-recall.js must exist after `npm run build` (the CLI canonical entry path)"
    );
  });
});

// ============================================================
// package.json surface
// ============================================================

describe("v1.1.3 GATE-07 distribution contract: package.json surface", () => {
  const pkg = readJson<{ name: string; version: string; files: string[]; private: boolean }>(
    join(repoRoot, "package.json")
  );

  it("package.json version is 1.1.3", () => {
    assert.equal(pkg.version, "1.1.3", "package.json version must be `1.1.3`");
  });

  it("package.json is marked private (npm publish stays out of scope)", () => {
    assert.equal(pkg.private, true, "package.json must remain `private: true` (the GitHub release artefacts are the canonical distribution surface)");
  });

  it("package.json `files` includes the canonical publication surface", () => {
    for (const required of ["dist", "README.md", "LICENSE", "CHANGELOG.md"]) {
      assert.ok(
        pkg.files.includes(required),
        `package.json \`files\` must include \`${required}\`; got ${JSON.stringify(pkg.files)}`
      );
    }
  });

  it("package.json `files` does NOT include node_modules", () => {
    assert.doesNotMatch(
      JSON.stringify(pkg.files),
      /node_modules/,
      "package.json `files` must NOT include `node_modules` (the consumer-side `npm install --omit=dev` is the canonical install path)"
    );
  });
});

// ============================================================
// LICENSE exists at project root
// ============================================================

describe("v1.1.3 GATE-07 distribution contract: LICENSE", () => {
  it("LICENSE file exists at the project root", () => {
    assert.ok(
      existsSync(join(repoRoot, "LICENSE")),
      "LICENSE must exist at the project root (required by both `release-candidate.yml` and `release.yml`)"
    );
  });
});

// ============================================================
// src/server-version.ts returns 1.1.3
// ============================================================

describe("v1.1.3 GATE-07 distribution contract: src/server-version.ts", () => {
  it("src/server-version.ts resolves to 1.1.3", () => {
    // The module walks up looking for a package.json with the
    // matching `name`. We exercise it via a child process that
    // imports the source via `tsx` (the project ships `tsx` as
    // a dev dependency; this avoids the dist/ build path for
    // this assertion). The probe is identical to the pattern
    // used in `p3-release-immutability.test.ts`.
    const probe = [
      "import { serverVersion } from './src/server-version.ts';",
      "console.log(serverVersion());",
      ""
    ].join("\n");
    const probePath = join(repoRoot, ".tmp-v113-gate-07-version-probe.mts");
    writeFileSync(probePath, probe);
    try {
      const result = spawnSync("npx", ["tsx", probePath], {
        cwd: repoRoot,
        env: { ...process.env },
        encoding: "utf8",
        shell: true
      });
      assert.equal(
        result.status,
        0,
        `tsx probe must exit 0; got ${result.status}; stderr=${result.stderr}; stdout=${result.stdout}`
      );
      assert.equal(
        result.stdout.trim(),
        "1.1.3",
        `serverVersion() must return 1.1.3; got '${result.stdout.trim()}'; stderr='${result.stderr}'`
      );
    } finally {
      try {
        unlinkSync(probePath);
      } catch {
        // ignore — best-effort cleanup
      }
    }
  });
});

// ============================================================
// CLI `agent-recall --version` outputs 1.1.3
// ============================================================

describe("v1.1.3 GATE-07 distribution contract: CLI --version", () => {
  it("`node dist/bin/agent-recall.js --version` outputs 1.1.3", async () => {
    // The CLI is exercised through the canonical built
    // artefact. We spawn with `shell: true` so the shim
    // resolution works on every platform (Windows + POSIX).
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          "node",
          [join(repoRoot, "dist", "bin", "agent-recall.js"), "--version"],
          {
            cwd: repoRoot,
            env: { ...process.env },
            shell: true
          }
        );
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", reject);
        child.on("close", (code) => {
          resolve({ code, stdout, stderr });
        });
      }
    );
    assert.equal(
      result.code,
      0,
      `\`node dist/bin/agent-recall.js --version\` must exit 0; got ${result.code}; stderr=${result.stderr}; stdout=${result.stdout}`
    );
    assert.equal(
      result.stdout.trim(),
      "1.1.3",
      `\`agent-recall --version\` must output 1.1.3; got '${result.stdout.trim()}'; stderr='${result.stderr}'`
    );
  }, 30_000);
});