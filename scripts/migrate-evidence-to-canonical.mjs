#!/usr/bin/env node
//
// scripts/migrate-evidence-to-canonical.mjs
//
// Stage 18 v1.1.2 / v1.1.3 (issue #28 / #34): the
// one-shot operator migration script that maps the
// legacy v1.1.2 `windows-x64` platform token to the
// v1.1.3 canonical `win32-x64` token in an existing
// evidence document. The v1.1.3 release-evidence
// contract (canonical platform vocabulary, fail-closed
// verifier) rejects documents that still carry
// `windows-x64`. This script writes a fresh
// `<source>.canonical.json` next to the source so the
// operator can diff the migrated copy before swapping
// it in.
//
// Usage:
//
//   node scripts/migrate-evidence-to-canonical.mjs <evidence.json>
//
// The script reads the source JSON, walks every
// `artifacts[].platform`, `ci_jobs[].platform`,
// `ci_runs[].platform`, and the top-level
// `release_workflow.platform` field, and rewrites
// `windows-x64` to `win32-x64`. Unknown tokens are
// left unchanged and a warning is logged to stderr
// so the operator can decide whether to also patch
// them.
//
// Exit codes:
//
//   0 — success (migrated document written).
//   1 — parse error / argument error / read error.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { canonicalPlatform } from "./canonical-platforms.mjs";

const LEGACY_ALIASES = new Map([
  ["windows-x64", "win32-x64"],
  ["win32-x64", "win32-x64"],
  ["linux-x64", "linux-x64"],
  ["darwin-x64", "darwin-x64"]
]);

function fail(message) {
  console.error(`migrate-evidence-to-canonical: ${message}`);
  process.exit(1);
}

function rewritePlatform(value) {
  if (typeof value !== "string") return value;
  const canonical = canonicalPlatform(value);
  if (canonical !== undefined) {
    return canonical;
  }
  const alias = LEGACY_ALIASES.get(value.toLowerCase());
  if (alias !== undefined) {
    return alias;
  }
  console.error(
    `migrate-evidence-to-canonical: WARN: unknown platform token ${JSON.stringify(value)}; left unchanged`
  );
  return value;
}

function walk(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => walk(entry));
  }
  if (value !== null && typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "platform" && typeof child === "string") {
        result[key] = rewritePlatform(child);
      } else {
        result[key] = walk(child);
      }
    }
    return result;
  }
  return value;
}

function main() {
  const sourceArg = process.argv[2];
  if (sourceArg === undefined || sourceArg.length === 0) {
    fail("usage: node scripts/migrate-evidence-to-canonical.mjs <evidence.json>");
  }
  let raw;
  try {
    raw = readFileSync(sourceArg, "utf8");
  } catch (error) {
    fail(`cannot read ${sourceArg}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`source is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const migrated = walk(parsed);
  const outputPath = join(dirname(sourceArg), `${sourceArg.split(/[/\\]/).pop()}.canonical.json`);
  writeFileSync(outputPath, `${JSON.stringify(migrated, null, 2)}\n`);
  console.log(`migrated evidence written to ${outputPath}`);
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
