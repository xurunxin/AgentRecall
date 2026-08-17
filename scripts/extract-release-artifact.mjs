#!/usr/bin/env node
//
// scripts/extract-release-artifact.mjs
//
// Stage 18 v1.1.2 (issue #28, task 9): extract a
// release archive produced by `.github/workflows/release.yml`
// into a clean directory the extracted-artifact lifecycle
// E2E (`test/blackbox/packaged-install.test.ts`) can
// launch. The script is the single source of truth for the
// platform-specific extraction command:
//
// v1.1.6 (Task 11 / Phase 3 follow-up): the v1.1.5
// `tar -xzf <archive>` shell-out is REPLACED with a
// Node-native tar parser + zlib gunzip. The reason is
// the GitHub Actions Windows-latest runner's PATH
// resolves the GNU tar (msys / Git for Windows) before
// the Windows 10+ built-in BSD tar; the GNU tar
// interprets the `C:\` drive letter in absolute Windows
// paths as a remote-host spec (the `user@host:path`
// scp convention) and fails with:
//
//   tar (child): Cannot connect to C: resolve failed
//   tar: Child returned status 128
//
// The `--force-local` flag fixes the GNU tar case
// but is unsupported by the BSD tar (the Windows 10+
// built-in + macOS), so adding it unconditionally
// flips the bug from one platform to the other. The
// Node-native path uses no shell, so the cross-platform
// extraction is deterministic on all 3 OSes.
//
// The script is intentionally dependency-free (Node 18+
// stdlib only — `node:zlib`, `node:fs/promises`,
// `node:stream/consumers`, `node:path`).
//
// Archive formats handled:
//   - .tar.gz: gzipped USTAR tar; the `node:zlib`
//     `createGunzip` transform feeds a hand-rolled
//     USTAR block parser.
//   - .zip: PowerShell `Expand-Archive` on Windows,
//     POSIX `unzip` on Linux + macOS. The `.zip`
//     path was always a shell-out (the production
//     archive is .zip on Windows-latest because the
//     Windows runner doesn't ship GNU tar with the
//     full USTAR prefix-extension support; the
//     POSIX .zip is the canonical v1.1.2 release
//     format too).
//
// Exit codes:
//   0 - extracted and verified.
//   1 - missing env var, missing artifact, extraction
//       failed, or extracted tree is missing one of
//       the canonical entry points.

import { createReadStream, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createGunzip } from "node:zlib";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";

const artifact = process.env.AGENT_RECALL_PACKAGED_ARTIFACT;
const extractDir = process.env.AGENT_RECALL_EXTRACT_DIR;
const platform = process.env.AGENT_RECALL_PLATFORM ?? process.platform;

function fail(message) {
  console.error(`extract-release-artifact: ${message}`);
  process.exit(1);
}

if (artifact === undefined || artifact.length === 0) {
  fail("AGENT_RECALL_PACKAGED_ARTIFACT is required");
}
if (extractDir === undefined || extractDir.length === 0) {
  fail("AGENT_RECALL_EXTRACT_DIR is required");
}
try {
  statSync(artifact);
} catch {
  fail(`artifact not found: ${artifact}`);
}
// The extract directory is created fresh. A
// pre-existing directory would mean the CI job is
// reusing a stale path (the matrix leg runs on a
// clean `$RUNNER_TEMP` per matrix entry).
await rm(extractDir, { recursive: true, force: true });
await mkdir(extractDir, { recursive: true });

const lowerArtifact = artifact.toLowerCase();
const isTar =
  lowerArtifact.endsWith(".tar.gz") ||
  lowerArtifact.endsWith(".tgz") ||
  lowerArtifact.endsWith(".tar");
const isZip = lowerArtifact.endsWith(".zip");
if (!isTar && !isZip) {
  fail(
    `unrecognized archive format: ${artifact} (expected .tar.gz / .tgz / .tar / .zip)`
  );
}

// v1.1.6 (Task 11 / Phase 3 follow-up): USTAR
// block parser. Reads 512-byte header blocks
// and follows the body blocks to the next header.
// The format is the POSIX.1-1988 (ustar) variant
// — no `prefix` (long-name) extension, no
// sparse-file / pax extensions. The v1.1.6
// `scripts/archive.ts` and the release.yml's
// `tar -czf ...` + `tar -czf` both produce
// plain USTAR so the surface is small.
//
//   0   100  name (NUL-terminated ASCII)
//  100  8    mode (octal, NUL-terminated)
//  108  8    uid
//  116  8    gid
//  124  12   size (octal)
//  136  12   mtime (octal)
//  148  8    chksum (octal + NUL + SPACE)
//  156  1    typeflag ('0' = file, '5' = dir, '\0' = legacy normal file)
//  157  100  linkname
//  257  6    magic ("ustar\0")
//  263  2    version ("00")
//  265  32   uname
//  297  32   gname
//  329  8    devmajor
//  337  8    devminor
//  345  155  prefix
//  500  12   pad (zero-fill)
const TAR_BLOCK = 512;
const TAR_NAME_MAX = 100;
const TAR_NAME_OFFSET = 0;
const TAR_SIZE_OFFSET = 124;
const TAR_TYPEFLAG_OFFSET = 156;
const TAR_NAME_END = TAR_NAME_OFFSET + TAR_NAME_MAX; // 100
const TAR_SIZE_END = TAR_SIZE_OFFSET + 12; // 136
const TAR_TYPEFLAG_END = TAR_TYPEFLAG_OFFSET + 1; // 157
const ZERO_BLOCK = Buffer.alloc(TAR_BLOCK);

function parseOctal(buf, start, end) {
  // Octal digits, padded with NUL or SPACE; trim
  // both + parse base-8. Empty / all-zero → 0.
  const slice = buf.subarray(start, end);
  const s = slice.toString("binary").replace(/[\0\s]/g, "");
  if (s.length === 0) return 0;
  const n = Number.parseInt(s, 8);
  if (Number.isNaN(n)) {
    // Some tar producers (Windows BSD tar via
    // `Compress-Archive` + `Expand-Archive`) write
    // the size as a binary little-endian uint32
    // (the `ustar` 1988 POSIX variant with the
    // "binary" size encoding) instead of octal.
    // The high bit (0x80) of the first byte of the
    // size field is the marker; the lower 7 bits
    // of the first byte + the next 3 bytes are
    // the big-endian size. We handle that here
    // so the same parser works on archives made
    // by the v1.1.6 production `tar -czf` (POSIX
    // octal) AND the `Compress-Archive` .zip
    // round-trip (BSD tar binary size).
    if ((slice[0] & 0x80) !== 0) {
      const b0 = slice[0] & 0x7f;
      const b1 = slice[1] ?? 0;
      const b2 = slice[2] ?? 0;
      const b3 = slice[3] ?? 0;
      return (b0 << 24) | (b1 << 16) | (b2 << 8) | b3;
    }
  }
  return n;
}

function parseName(buf) {
  // NUL-terminated ASCII. Strip the terminator and
  // any padding. The 100-byte field is supposed to
  // hold the basename; the 155-byte `prefix` field
  // (which we don't support — USTAR v0 only) would
  // hold the directory part for >99-byte names.
  const slice = buf.subarray(TAR_NAME_OFFSET, TAR_NAME_END);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? TAR_NAME_MAX : nul).toString("utf8");
}

async function extractTarGz(archivePath, outDir) {
  // Stream the gzipped archive through `createGunzip`
  // into a hand-rolled USTAR block accumulator. The
  // gzip → tar pipe is:
  //   fs.ReadStream(archive) → createGunzip → block reader
  // The block reader consumes 512-byte tar blocks
  // and writes each file's body to disk between
  // header + body blocks.
  //
  // v1.1.6 (Task 11 / Phase 3 follow-up): the
  // parser is now tolerant of both dir-body
  // conventions. Some producers (GNU tar on
  // ubuntu-latest) write a zero-padded 512-byte
  // body block after every dir entry (typeflag
  // "5"); others (BSD tar on macOS / Windows,
  // Node-native `scripts/archive.ts`,
  // `tarfile` in default USTAR mode) emit no
  // body for dirs at all. The strict USTAR
  // spec only requires `size` body bytes
  // (rounded up to 512) — for dirs `size` is
  // 0, so the body is optional. The pre-fix
  // parser hard-coded `offset += TAR_BLOCK * 2`
  // for dirs, which aligned with GNU tar but
  // was 512 bytes off on the BSD/Node-native
  // archives that the v1.1.6 release-gate
  // produces via `scripts/archive.ts`. The
  // post-fix parser:
  //   - For dir entries: skip the 512-byte
  //     header only (`offset += TAR_BLOCK`).
  //   - If the next block is all zeros, it's
  //     either a GNU tar dir body OR the start
  //     of the end-of-archive marker. Probe the
  //     block AFTER it: if it's a non-zero
  //     header, the zero block was a dir body
  //     — skip it and continue. If it's also
  //     zero, this is end-of-archive (the spec
  //     mandates two consecutive zero blocks).
  //   - If the next block is non-zero, it's a
  //     new entry header — process it directly.
  // The result: a single parser handles every
  // tar flavour that ships through the
  // v1.1.6 production pipeline (the
  // release.yml `tar -czf` archive AND the
  // `scripts/archive.ts` test archive).
  const fileStream = createReadStream(archivePath);
  const gunzip = createGunzip();

  let buffer = Buffer.alloc(0);
  const collected = [];

  // Collect the entire decompressed tar into memory.
  // The v1.1.6 archive is small (~400 KB); the
  // E2E packaging doesn't ship 100+ MB artefacts,
  // so the memory cost is bounded.
  await pipeline(fileStream, gunzip, async function* (source) {
    for await (const chunk of source) {
      collected.push(chunk);
    }
  });
  buffer = Buffer.concat(collected);

  let offset = 0;
  let pendingHeader = null;
  while (offset + TAR_BLOCK <= buffer.length) {
    const block = buffer.subarray(offset, offset + TAR_BLOCK);
    if (pendingHeader === null) {
      // Header mode: the current block should be
      // an entry header. Detect three cases:
      //   1. all-zero block: end-of-archive OR
      //      a stray dir body. Probe the next
      //      block to disambiguate.
      //   2. typeflag "5" (dir): create the
      //      directory and skip the 512-byte
      //      header. The next iteration will
      //      see the post-dir body (if any).
      //   3. typeflag "0" (file): record the
      //      header; the next iteration reads
      //      the body.
      if (block.equals(ZERO_BLOCK)) {
        // Two consecutive zero blocks = end-of-
        // archive. A single zero block between
        // a dir header and the next entry is
        // the GNU tar dir-body convention —
        // skip it and continue.
        const next = offset + TAR_BLOCK;
        if (next + TAR_BLOCK <= buffer.length) {
          const nextBlock = buffer.subarray(next, next + TAR_BLOCK);
          if (nextBlock.equals(ZERO_BLOCK)) {
            // End-of-archive: 2 zero blocks in
            // a row. Stop.
            break;
          }
          // Single zero block: GNU tar dir
          // body. Skip it and read the next
          // entry header on the following
          // iteration.
          offset += TAR_BLOCK;
          continue;
        }
        // Single zero block at end of buffer:
        // treat as end-of-archive (malformed but
        // bounded).
        break;
      }
      const name = parseName(block);
      const typeflag = String.fromCharCode(block[TAR_TYPEFLAG_OFFSET]);
      const size = parseOctal(block, TAR_SIZE_OFFSET, TAR_SIZE_END);
      if (typeflag === "5") {
        // Directory entry. The USTAR size is 0
        // for dirs; some producers also write
        // a zero-padded body block (GNU tar),
        // others don't (BSD tar, archive.ts).
        // We skip the header only and let the
        // next iteration's ZERO_BLOCK probe
        // absorb a GNU tar dir body if present.
        await mkdir(join(outDir, name), { recursive: true });
        offset += TAR_BLOCK;
        continue;
      }
      // typeflag "0" (or legacy "\0") = regular file.
      pendingHeader = { name, size, written: 0, bodyStart: offset + TAR_BLOCK };
      offset += TAR_BLOCK;
      continue;
    }
    // We're in a body block for `pendingHeader`.
    const remaining = pendingHeader.size - pendingHeader.written;
    const blockAvailable = Math.min(TAR_BLOCK, buffer.length - offset);
    const take = Math.min(remaining, blockAvailable);
    if (take > 0) {
      const target = join(outDir, pendingHeader.name);
      // Ensure parent dir exists (ustar entries
      // are flat — subdirs come from their own "5"
      // entries; we still create parents defensively
      // because some producers omit the dir entry
      // for nested files).
      await mkdir(dirname(target), { recursive: true });
      // First write creates the file; subsequent
      // writes append.
      if (pendingHeader.written === 0) {
        await writeFile(target, buffer.subarray(offset, offset + take));
      } else {
        const existing = await readFile(target);
        await writeFile(target, Buffer.concat([existing, buffer.subarray(offset, offset + take)]));
      }
      pendingHeader.written += take;
    }
    offset += TAR_BLOCK;
    if (pendingHeader.written >= pendingHeader.size) {
      // Body complete. Pad to TAR_BLOCK boundary
      // (already aligned by the block reader) and
      // clear the pending header.
      pendingHeader = null;
    }
  }
  if (pendingHeader !== null) {
    fail(`tar archive truncated mid-file: ${pendingHeader.name} (${pendingHeader.written}/${pendingHeader.size} bytes)`);
  }
}

async function extractZip(archivePath, outDir) {
  if (platform === "win32") {
    // Quote the artifact + destination so paths with
    // spaces survive the PowerShell call. PowerShell
    // single-quoted strings do not interpret
    // backticks / $vars, which is exactly the
    // behaviour we want here.
    await spawnProcess(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${artifact}' -DestinationPath '${outDir}' -Force`
      ],
      "powershell Expand-Archive"
    );
    return;
  }
  await spawnProcess(
    "unzip",
    ["-q", "-o", archivePath, "-d", outDir],
    "unzip extraction"
  );
}

function spawnProcess(cmd, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", (error) => {
      reject(new Error(`${label} failed to start: ${error.message}`));
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(undefined);
      } else {
        reject(new Error(`${label} exited with code ${code ?? "null"}`));
      }
    });
  });
}

if (isTar) {
  await extractTarGz(artifact, extractDir);
} else {
  await extractZip(artifact, extractDir);
}

function verifyExtractedTree() {
  const canonical = [
    "dist/src/index.js",
    "dist/bin/agent-recall.js",
    "package.json"
  ];
  for (const rel of canonical) {
    // Node's `path.join` on Windows uses backslashes;
    // both forms are accepted by the file system, so
    // a literal forward-slash path resolves on every
    // platform. Using a literal keeps the cross-OS
    // check deterministic.
    const candidate = `${extractDir}/${rel}`;
    try {
      const s = statSync(candidate);
      if (!s.isFile()) {
        fail(`missing required file in extracted archive: ${candidate} (not a regular file)`);
      }
    } catch {
      fail(`missing required file in extracted archive: ${candidate}`);
    }
  }
}

verifyExtractedTree();
console.log(
  `extract-release-artifact: extracted ${artifact} -> ${extractDir} (platform=${platform})`
);
