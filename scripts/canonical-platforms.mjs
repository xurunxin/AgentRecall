export const CANONICAL_PLATFORMS = Object.freeze(["linux-x64", "darwin-x64", "win32-x64"]);

const aliases = new Map([
  ["linux-x64", "linux-x64"], ["ubuntu-latest", "linux-x64"],
  ["darwin-x64", "darwin-x64"], ["macos-latest", "darwin-x64"],
  ["win32-x64", "win32-x64"], ["windows-x64", "win32-x64"], ["windows-latest", "win32-x64"]
]);

export function canonicalPlatform(value) {
  return aliases.get(String(value).toLowerCase());
}
