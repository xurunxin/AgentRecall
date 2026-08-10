#!/usr/bin/env node
// scripts/archive.ts
//
// v1.1.6 follow-up C1 (issue #42, spec d67fc45,
// plan bfbd2cb): Node-native tar.gz (USTAR
// format through `zlib.createGzip`) + zip
// (defer to PowerShell `Compress-Archive` on
// Windows, `zip` on POSIX). The previous test
// path shell'd out to GNU `tar` and failed on
// Windows-latest (tar exit 2 on Windows temp
// paths; the cmd.exe `shell: true` flag was
// a v1.1.5 attempt that still didn't work).
// This module is dependency-free (Node 18+
// stdlib only): `node:zlib`, `node:fs`,
// `node:fs/promises`, `node:path`,
// `node:stream/promises`, `node:crypto`,
// `node:child_process`. Zero new npm deps.
//
// Interface:
//   archive(srcDir, destFile, "tar.gz") => { sha256, size_bytes }
//   archive(srcDir, destFile, "zip")    => { sha256, size_bytes }
//
// The `zip` format defers to the platform's
// packaging tool (`Compress-Archive` on
// Windows, `zip` on POSIX). The test
// (`test/release-gate/p3-extracted-artifact-
// lifecycle.test.ts`) previously skipped the
// tar.gz round-trip on Windows; that skip is
// removed in C1 because `archive()` is now
// platform-portable.

import { createHash } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

const execFile = promisify(execFileCb);

const TAR_BLOCK = 512;
const TAR_NAME_MAX = 100;
const TAR_LINKNAME_MAX = 100;
const ZERO = Buffer.alloc(TAR_BLOCK);

/**
 * Build a 512-byte USTAR tar header. Returns a
 * fresh buffer; checksum is computed over the
 * header bytes (with the chksum field set to 8
 * spaces, per the USTAR spec).
 *
 * Only regular files (typeflag "0") + dirs
 * (typeflag "5") are produced; the E2E
 * packaging only ships files + directories.
 * Symlinks, FIFOs, device nodes, etc. are out
 * of scope.
 */
function tarHeader(
  name: string,
  size: number,
  mode: number = 0o644,
  typeflag: "0" | "5" = "0",
  mtime: number = Math.floor(Date.now() / 1000)
): Buffer {
  // Name: ASCII, NUL-terminated, max 99 bytes
  // (the 100th byte is a NUL per USTAR). The
  // E2E packaging doesn't produce names >99
  // bytes; long names would need the USTAR
  // "prefix" extension which we don't ship.
  const nameBuf = Buffer.alloc(TAR_NAME_MAX);
  Buffer.from(name.slice(0, TAR_NAME_MAX - 1), "ascii").copy(nameBuf);
  const modeBuf = Buffer.from(mode.toString(8).padStart(7, "0") + "\0", "ascii");
  const uidBuf = Buffer.from("0000000\0", "ascii");
  const gidBuf = Buffer.from("0000000\0", "ascii");
  // size + mtime: octal, 11 digits, padded with
  // zero, followed by a SPACE (not NUL — that's
  // the GNU tar convention; the USTAR spec
  // allows NUL but most readers prefer SPACE).
  const sizeBuf = Buffer.from(size.toString(8).padStart(11, "0") + " ", "ascii");
  const mtimeBuf = Buffer.from(mtime.toString(8).padStart(11, "0") + " ", "ascii");
  // chksum: 6 octal digits + NUL + SPACE, the
  // field is initialised to 8 SPACES (0x20) for
  // the checksum sum.
  const chksumBuf = Buffer.from("        ", "ascii");
  const typeflagBuf = Buffer.from(typeflag, "ascii");
  const linkname = Buffer.alloc(TAR_LINKNAME_MAX);
  const magic = Buffer.from("ustar\0", "ascii");
  const version = Buffer.from("00", "ascii");
  const uname = Buffer.from("root\0", "ascii");
  const gname = Buffer.from("root\0", "ascii");
  const devmajor = Buffer.alloc(8);
  const devminor = Buffer.alloc(8);
  const prefix = Buffer.alloc(155);
  const pad = Buffer.alloc(12);

  const headerNoChksum = Buffer.concat([
    nameBuf, modeBuf, uidBuf, gidBuf, sizeBuf, mtimeBuf, chksumBuf, typeflagBuf,
    linkname, magic, version, uname, gname, devmajor, devminor, prefix, pad
  ]);
  // Sum the 512 bytes (with the chksum field =
  // 8 SPACES) and write the result back into
  // the chksum field as 6 octal digits + NUL +
  // SPACE.
  let sum = 0;
  for (let i = 0; i < headerNoChksum.length; i++) sum += headerNoChksum[i];
  const chksum = Buffer.from(sum.toString(8).padStart(6, "0") + "\0 ", "ascii");
  return Buffer.concat([
    headerNoChksum.subarray(0, 148),
    chksum,
    headerNoChksum.subarray(156)
  ]);
}

/**
 * Yield the tar entry (header + body) for
 * every file + dir under `srcDir`. The yield is
 * a `{ header, body }` pair where `body` is the
 * padded file content (already zero-padded to a
 * TAR_BLOCK boundary), or `null` for directory
 * entries. The caller concatenates header +
 * body buffers in order.
 */
async function* walkTar(srcDir: string): AsyncGenerator<{ header: Buffer; body: Buffer | null }> {
  const entries = await readdir(srcDir, { withFileTypes: true });
  // Sort entries to produce deterministic output
  // (helps test reproducibility; GNU tar
  // preserves directory order which is usually
  // inode-order, not lexicographic, but our
  // round-trip test only checks the
  // gzipped-archive size + sha256, not the
  // inner ordering).
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = join(srcDir, entry.name);
    const rel = relative(srcDir, full).split(sep).join("/");
    if (entry.isDirectory()) {
      yield { header: tarHeader(rel + "/", 0, 0o755, "5"), body: null };
      yield* walkTar(full);
    } else if (entry.isFile()) {
      const s = await stat(full);
      const file = await readFile(full);
      const header = tarHeader(rel, s.size);
      // Pad to TAR_BLOCK boundary. The body is
      // a single buffer (caller can stream; for
      // the E2E size the file is small).
      const padSize = (TAR_BLOCK - (file.length % TAR_BLOCK)) % TAR_BLOCK;
      const body = Buffer.concat([file, Buffer.alloc(padSize)]);
      yield { header, body };
    }
  }
}

export interface ArchiveResult {
  sha256: string;
  size_bytes: number;
}

export async function archive(
  srcDir: string,
  destFile: string,
  format: "tar.gz" | "zip"
): Promise<ArchiveResult> {
  if (format === "zip") {
    // Defer to the platform's packaging tool.
    // PowerShell `Compress-Archive` is the
    // production path on Windows; `zip` is the
    // POSIX path. The script under test
    // (`scripts/extract-release-artifact.mjs`)
    // only handles extraction; the round-trip
    // E2E test exercises both ends.
    if (process.platform === "win32") {
      // PowerShell on Windows interprets a
      // backslash-quoted path correctly. We do
      // NOT use `shell: true` here (that
      // re-introduces the v1.1.5 cmd.exe
      // wrapping bug; the args pass through
      // `CreateProcess` directly).
      const psScript = `Compress-Archive -Path '${srcDir}\\*' -DestinationPath '${destFile}' -Force`;
      await execFile("powershell.exe", ["-NoProfile", "-Command", psScript], {
        windowsHide: true
      });
    } else {
      // POSIX: `zip -r destFile .` from inside
      // `srcDir`. `-r` is recursive (preserves
      // subdirectory structure). The trailing
      // `.` is the source-path arg.
      await execFile("zip", ["-r", destFile, "."], { cwd: srcDir });
    }
  } else {
    // tar.gz: stream the tar through gzip. We
    // collect all tar bytes in memory (the
    // E2E staging dir is small; an
    // out-of-memory edge case is out of scope
    // for C1) then pipe the buffer through
    // gzip to the dest file. The collection
    // also lets us compute sha256 from the
    // tar stream (before gzip) AND the final
    // file sha256 (after gzip) — the
    // `ArchiveResult` is the FINAL file's
    // sha256 so the test's `recompute file
    // sha256 === expected` assertion holds.
    const tarChunks: Buffer[] = [];
    for await (const { header, body } of walkTar(srcDir)) {
      tarChunks.push(header);
      if (body !== null) tarChunks.push(body);
    }
    // Two zero blocks mark end-of-archive per
    // the USTAR spec.
    tarChunks.push(ZERO, ZERO);
    const tarBuf = Buffer.concat(tarChunks);

    // Stream through gzip into destFile.
    // `pipeline` from `node:stream/promises`
    // propagates the async iterator + the
    // gzip transform + the write stream and
    // rejects on any of the three failing.
    const fileStream = createWriteStream(destFile);
    const gzip = createGzip();
    const tarStream = bufferToStream(tarBuf);
    await pipeline(tarStream, gzip, fileStream);
  }
  // Compute sha256 + size_bytes of the final
  // file (after gzip for tar.gz, after
  // platform tool for zip). The result is
  // byte-stable regardless of which path
  // produced the archive.
  const finalBuf = await readFile(destFile);
  return {
    sha256: createHash("sha256").update(finalBuf).digest("hex"),
    size_bytes: finalBuf.length
  };
}

/**
 * Wrap a `Buffer` in a `Readable` stream so
 * `pipeline()` can consume it. Used for the
 * tar body above.
 */
function bufferToStream(buf: Buffer): ReadStream {
  // `Readable.from(buffer)` is the simple
  // version but we need a `ReadStream`-shaped
  // object for `pipeline`'s stream-chaining
  // typing. Use a passthrough from the
  // iterable.
  const { Readable } = require("node:stream") as typeof import("node:stream");
  return Readable.from(buf) as unknown as ReadStream;
}
