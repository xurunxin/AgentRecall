// patch-windows-subsystem.mjs
//
// Post-build PE subsystem patcher for the bun --compile binary.
//
// bun's --windows-hide-console flag is documented to "prevent a
// Command prompt from opening alongside the executable", but as
// of bun 1.3.14 it does NOT actually flip the PE subsystem field
// from IMAGE_SUBSYSTEM_WINDOWS_CUI (3) to IMAGE_SUBSYSTEM_WINDOWS_GUI
// (2).  We verify post-build and, if the subsystem is still
// CONSOLE, we patch the byte in place.
//
// The PE subsystem is a 2-byte little-endian field at offset
// 0x5C from the start of the PE Optional Header.  The PE header
// itself is located at the file offset stored in the 4-byte
// little-endian value at file offset 0x3C (the "e_lfanew" field
// of the DOS header).
//
// Reference: https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
//
// Why this matters: a CONSOLE-subsystem process, when launched
// by Task Scheduler / RunKey / Startup folder on a session that
// has no controlling terminal, still gets a fresh console
// allocated by csrss.exe and a brief CMD window flashes open.
// A WINDOWS-subsystem process never gets that allocation.  The
// bridge's stderr (where the env-load line, request logs, and
// errors go) is still written to the redirected file; it's just
// not visible as a window.
//
// We ONLY patch on Windows; on linux/darwin the PE format
// doesn't exist and bun's --target emits an ELF / Mach-O.
//
// Idempotent: if the binary is already WINDOWS subsystem (e.g.
// a future bun version starts doing this itself), this script
// is a no-op.

import { readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:process";

if (platform !== "win32") {
  console.log("patch-windows-subsystem: skipping (non-Windows host)");
  process.exit(0);
}

const exePath = process.argv[2];
if (!exePath) {
  console.error("patch-windows-subsystem: usage: patch-windows-subsystem.mjs <exe-path>");
  process.exit(2);
}

const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3;

const buf = Buffer.from(readFileSync(exePath));

// DOS header: e_lfanew at 0x3C
if (buf.toString("ascii", 0, 2) !== "MZ") {
  console.error(`patch-windows-subsystem: ${exePath} is not a PE file (no MZ header)`);
  process.exit(1);
}
const peOffset = buf.readUInt32LE(0x3C);
if (peOffset <= 0 || peOffset + 24 > buf.length) {
  console.error(`patch-windows-subsystem: invalid PE header offset ${peOffset}`);
  process.exit(1);
}
// PE signature "PE\0\0" at peOffset
if (buf.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
  console.error(`patch-windows-subsystem: PE signature not found at offset ${peOffset}`);
  process.exit(1);
}
// Optional Header starts at peOffset + 24.  The Magic field
// (2 bytes) tells us whether this is PE32 (0x10B) or PE32+
// (0x20B), and the Subsystem field lives at a different offset
// in each:
//   PE32   (32-bit):  Subsystem at +0x5C from Optional Header
//   PE32+  (64-bit):  Subsystem at +0x44 from Optional Header
// Reference: https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
const optHeaderStart = peOffset + 24;
const magic = buf.readUInt16LE(optHeaderStart);
let subsysOffset;
if (magic === 0x10b) {
  subsysOffset = optHeaderStart + 0x5c;
} else if (magic === 0x20b) {
  subsysOffset = optHeaderStart + 0x44;
} else {
  console.error(
    `patch-windows-subsystem: unexpected PE optional header magic 0x${magic.toString(16)}; ` +
    `expected PE32 (0x10b) or PE32+ (0x20b).  Refusing to patch.`
  );
  process.exit(1);
}
if (subsysOffset + 2 > buf.length) {
  console.error(`patch-windows-subsystem: subsystem offset ${subsysOffset} out of range`);
  process.exit(1);
}
const currentSubsys = buf.readUInt16LE(subsysOffset);
if (currentSubsys === IMAGE_SUBSYSTEM_WINDOWS_GUI) {
  console.log(
    `patch-windows-subsystem: ${exePath} is already WINDOWS subsystem (2); nothing to do`
  );
  process.exit(0);
}
if (currentSubsys !== IMAGE_SUBSYSTEM_WINDOWS_CUI) {
  console.error(
    `patch-windows-subsystem: unexpected subsystem value ${currentSubsys} at offset ${subsysOffset}; ` +
    `expected CONSOLE (3) or GUI (2).  Refusing to patch.`
  );
  process.exit(1);
}

// Flip the subsystem byte in place and write back.  We rewrite
// the whole file (not in-place byte patch) so the file's mtime
// updates and downstream tooling that depends on mtime (e.g.
// the build's MANIFEST.json) sees a fresh hash.
buf.writeUInt16LE(IMAGE_SUBSYSTEM_WINDOWS_GUI, subsysOffset);
writeFileSync(exePath, buf);
console.log(
  `patch-windows-subsystem: ${exePath} subsystem CUI(3) -> GUI(2) at offset 0x${subsysOffset.toString(16)}`
);
