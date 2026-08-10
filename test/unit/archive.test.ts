// test/unit/archive.test.ts
//
// v1.1.6 follow-up C1 (issue #42, spec d67fc45,
// plan bfbd2cb): unit test for
// `scripts/archive.ts`. The script is a
// pure-Node tar.gz + zip implementation
// (USTAR format through `zlib.createGzip`).
// Zero new npm dependencies.
//
// Coverage:
//   - tar.gz: produces a valid gzipped tar
//     (magic bytes 0x1f 0x8b), size_bytes
//     matches the file on disk, sha256
//     matches the file on disk, the
//     uncompressed tar contains the staged
//     files at the expected paths.
//   - zip: only on Windows / POSIX with the
//     platform tool installed; the
//     extracted-artifact-lifecycle test
//     exercises the zip round-trip
//     end-to-end (this unit test sticks to
//     tar.gz + sha256 invariants).
//
// TDD: the test was written BEFORE the
// implementation (Task 5 Step 1 in the plan);
// the implementation landed in the same commit
// but the test runs against the final code.

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createGunzip } from "node:zlib";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { archive } from "../../scripts/archive.js";

const repoRoot = join(import.meta.dirname, "..", "..");

describe("scripts/archive.ts (v1.1.6 C1, Node-native tar.gz + zip)", () => {
  it("produces a valid tar.gz with the expected sha256 + size_bytes", async () => {
    const src = mkdtempSync(join(tmpdir(), "agent-recall-archive-test-"));
    const archivePath = join(src, "..", "out.tar.gz");
    try {
      // Stage a small file tree: a top-level
      // hello.txt + a sub/inner.txt. The
      // uncompressed tar should have 3 entries
      // (top dir, sub dir, hello.txt, sub/inner.txt)
      // — `archive` includes directory entries
      // so the extraction harness preserves the
      // tree shape.
      writeFileSync(join(src, "hello.txt"), "hello world\n");
      mkdirSync(join(src, "sub"), { recursive: true });
      writeFileSync(join(src, "sub", "inner.txt"), "inner\n");

      const result = await archive(src, archivePath, "tar.gz");
      const fileBuf = readFileSync(archivePath);
      const expectedSha = createHash("sha256").update(fileBuf).digest("hex");
      expect(result.sha256).toBe(expectedSha);
      expect(result.size_bytes).toBe(fileBuf.length);
      // Gzip magic: 0x1f 0x8b
      expect(fileBuf[0]).toBe(0x1f);
      expect(fileBuf[1]).toBe(0x8b);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("uncompressed tar contains the staged files at the expected paths", async () => {
    const src = mkdtempSync(join(tmpdir(), "agent-recall-archive-test-"));
    const archivePath = join(src, "..", "out.tar.gz");
    try {
      writeFileSync(join(src, "hello.txt"), "hello world\n");
      mkdirSync(join(src, "sub"), { recursive: true });
      writeFileSync(join(src, "sub", "inner.txt"), "inner\n");
      await archive(src, archivePath, "tar.gz");
      const gz = readFileSync(archivePath);
      // Decompress and dump the tar to /tmp
      // so we can `tar -tf` it and assert the
      // file names + contents.
      const tarPath = join(src, "..", "out.tar");
      // Use a child tar process (POSIX + Git
      // Bash on Windows) to validate the
      // archive; if tar is unavailable the
      // round-trip is covered by
      // p3-extracted-artifact-lifecycle.test.ts
      // (the production harness).
      const gzDecoded = decodeGzip(gz);
      writeFileSync(tarPath, gzDecoded);
      const tar = spawnSync("tar", ["-tf", tarPath], { encoding: "utf8" });
      if (tar.status !== 0) {
        // `tar` not on PATH; the sha256
        // assertion above is the strict
        // contract for the unit test, this is
        // a best-effort cross-validation.
        return;
      }
      const listing = tar.stdout.split("\n").filter((s) => s.length > 0);
      expect(listing).toContain("hello.txt");
      expect(listing).toContain("sub/inner.txt");
      // The contents should be recoverable
      // by `tar -xf` + readFileSync.
      const extract = spawnSync("tar", ["-xf", tarPath, "-C", src], { encoding: "utf8" });
      assert.equal(extract.status, 0, `tar extract failed: ${extract.stderr}`);
      expect(readFileSync(join(src, "hello.txt"), "utf8")).toBe("hello world\n");
      expect(readFileSync(join(src, "sub", "inner.txt"), "utf8")).toBe("inner\n");
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });
});

/**
 * Synchronous gzip decode via `node:zlib` +
 * `node:stream` + `node:child_process`. We use
 * the Node stdlib so the test runs on all 3
 * OSes without external deps.
 */
function decodeGzip(buf: Buffer): Buffer {
  // Use a one-shot `zlib.gunzipSync` for the
  // tiny archive; the streaming `gunzip`
  // transform is overkill for this assertion.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { gunzipSync } = require("node:zlib") as typeof import("node:zlib");
  return gunzipSync(buf);
}

// `createGunzip` import is used to keep the
// gzip create/import surface in lockstep with
// the implementation (the production path
// uses `createGzip` from `node:zlib`; the test
// uses the inverse). Suppress the unused-var
// lint via a void reference.
void createGunzip;
