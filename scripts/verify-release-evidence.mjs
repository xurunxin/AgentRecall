#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { CANONICAL_PLATFORMS } from "./canonical-platforms.mjs";

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().nonnegative();
const platform = z.enum(CANONICAL_PLATFORMS);
const job = z.object({ platform, os: z.string(), node: z.string(), job_url: z.string(), conclusion: z.enum(["success", "failure"]), duration_ms: count, head_sha: sha }).strict();
export const ReleaseEvidence = z.object({
  schema_version: z.literal("1.1.3"), version: z.string().regex(/^\d+\.\d+\.\d+$/), release_commit: sha,
  tag: z.string().regex(/^v\d+\.\d+\.\d+$/), candidate_sha: sha,
  subissues: z.array(z.object({ number: z.number().int(), state: z.literal("closed"), title: z.string() }).strict()),
  ci_jobs: z.array(job), release_workflow: job,
  artifacts: z.array(z.object({ platform, name: z.string().min(1), size_bytes: count, sha256: hash }).strict()),
  sha256_checksums: z.record(z.string(), hash),
  test_summary: z.object({ passed: count, failed: count, skipped: count, filtered: count, totals_from: z.enum(["actual", "constant"]) }).strict(),
  stress_summary: z.object({ process_count: count, operations: count, invariants_ok: count }).strict(),
  migration_summary: z.object({ sources_tested: z.array(z.string()), each_passed: z.boolean() }).strict(),
  known_non_blocking_limits: z.array(z.string())
}).strict();
/**
 * v1.1.6 follow-up A1 (Task 1): the v1.1.2-shape
 * evidence path (`LegacyReleaseEvidence`,
 * `verifyLegacyDocument()`) is REMOVED. The
 * rc-branch orchestrator now produces the v1.1.3
 * GATE-04 strict shape via
 * `release-evidence.mjs --fragments <dir>`, and
 * `ReleaseEvidence` (above) is the single source of
 * truth for what passes the gate.
 *
 * Stable-mode (`--stable`, the default) additionally
 * rejects any `local://` URL, any non-GitHub
 * `job_url`, and any `totals_from: "constant"`
 * test summary.
 */
const releaseArtifactHashesFile = z.object({
  schema_version: z.number(),
  candidate_sha: sha,
  generated_at: z.string(),
  artifacts: z.array(z.object({
    platform: z.string(),
    artifact_path: z.string(),
    sha256: hash,
    size_bytes: count,
    mtime: z.string()
  }).strict()).min(1)
}).strict();
function checkReleaseArtifactHashesSoft(doc) {
  // v1.1.6 follow-up A1 (Task 1): the rc-branch
  // orchestrator does not produce a
  // `release-artifact-hashes.json` (the file is
  // only written by the `verify-extracted-artifacts`
  // job in `release.yml` on the tag-driven path).
  // When the file is missing, the cross-check is
  // a no-op; when present, the cross-check emits
  // a `[MISMATCHED_PLATFORMS] WARNING:` log line
  // on mismatch and continues. The check becomes
  // a hard `reject()` in Task 12 (Phase 3 final
  // gate) once the tag path is in scope; for
  // Phase 1 it is intentionally soft to avoid
  // blocking the rc-branch gate on tag-only data.
  const path = process.env.RELEASE_ARTIFACT_HASHES_PATH;
  if (!path) return;
  let raw;
  try { raw = readFileSync(path, "utf8"); }
  catch { return; }
  let parsed;
  try { parsed = releaseArtifactHashesFile.parse(JSON.parse(raw)); }
  catch (error) { console.warn(`[MISMATCHED_PLATFORMS] WARNING: release-artifact-hashes.json at ${path} failed to parse: ${error.message ?? error}`); return; }
  const byPath = new Map(parsed.artifacts.map(a => [basename(a.artifact_path), a]));
  for (const artifact of doc.artifacts) {
    const entry = byPath.get(artifact.name);
    if (!entry) { console.warn(`[MISMATCHED_PLATFORMS] WARNING: ${artifact.name} missing from release-artifact-hashes.json (cross-check skipped)`); continue; }
    if (entry.sha256 !== artifact.sha256) console.warn(`[MISMATCHED_PLATFORMS] WARNING: ${artifact.name} expected ${entry.sha256} got ${artifact.sha256}`);
    if (entry.size_bytes !== artifact.size_bytes) console.warn(`[MISMATCHED_PLATFORMS] WARNING: ${artifact.name} expected size ${entry.size_bytes} got ${artifact.size_bytes}`);
  }
}

export function verifyChecksumAgainstArtifact(path, expected) {
  return createHash("sha256").update(readFileSync(path)).digest("hex") === expected;
}
function reject(code, detail) { const error = new Error(detail); error.code = code; throw error; }
function strings(value) { if (typeof value === "string") return [value]; if (Array.isArray(value)) return value.flatMap(strings); if (value && typeof value === "object") return Object.values(value).flatMap(strings); return []; }

export function verifyDocument(raw, evidencePath, stable = true) {
  if (Array.isArray(raw?.sha256_checksums) || raw?.sha256_checksums === null || typeof raw?.sha256_checksums !== "object") reject("CHECKSUM_TYPE_INVALID", "sha256_checksums must be an object");
  const suppliedPlatforms = [...(raw?.artifacts ?? []), ...(raw?.ci_jobs ?? []), raw?.release_workflow].filter(Boolean).map(x => x.platform);
  // v1.1.5 (rc-1.1.5-candidate gate): ignore
  // `undefined` platform entries (a defensive
  // check; the v1.1.3 strict schema requires
  // every ci_job / artifact to have a canonical
  // platform). A genuine non-canonical token
  // (e.g. `windows-x64` before migration,
  // `darwin-arm64`, `unknown`) still fails closed.
  if (suppliedPlatforms.some((p) => p !== undefined && !CANONICAL_PLATFORMS.includes(p))) reject("PLATFORM_NOT_CANONICAL", "non-canonical platform token");
  // v1.1.6 follow-up A1 (Task 1): the v1.1.5 legacy
  // shim (accept `schema_version: 1` or `"1.1.2"`
  // and route to `verifyLegacyDocument`) is REMOVED.
  // The rc-branch orchestrator emits the v1.1.3
  // GATE-04 strict shape via
  // `release-evidence.mjs --fragments <dir>`, and
  // `ReleaseEvidence` is the single source of truth
  // for what passes the gate.
  const parsed = ReleaseEvidence.safeParse(raw);
  if (!parsed.success) reject("SCHEMA_INVALID", parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  const doc = parsed.data;
  if (stable && strings(doc).some(s => s.includes("local://"))) reject("LOCAL_URL_FORBIDDEN", "local URL in stable evidence");
  if (stable && [...doc.ci_jobs, doc.release_workflow].some(j => !j.job_url.startsWith("https://github.com/"))) reject("MISSING_GITHUB_JOB_URL", "GitHub job URL required");
  if (doc.candidate_sha !== doc.release_commit) reject("CANDIDATE_SHA_MISMATCH", "candidate SHA differs from release commit");
  if ([...doc.ci_jobs, doc.release_workflow].some(j => j.duration_ms === 0)) reject("DURATION_PLACEHOLDER", "zero-duration job");
  if (stable && doc.test_summary.totals_from === "constant") reject("TEST_TOTALS_FROM_CONSTANT", "actual test totals required");
  if (doc.artifacts.length === 0) reject("EMPTY_ARTIFACTS", "artifact set is empty");
  if (new Set(doc.artifacts.map(a => a.name)).size !== doc.artifacts.length) reject("DUPLICATE_ARTIFACTS", "duplicate artifact names");
  if (new Set(doc.artifacts.map(a => a.platform)).size !== CANONICAL_PLATFORMS.length || CANONICAL_PLATFORMS.some(p => !doc.artifacts.some(a => a.platform === p))) reject("MISMATCHED_PLATFORMS", "exactly one artifact per canonical platform required");
  const keys = Object.keys(doc.sha256_checksums);
  if (keys.length !== doc.artifacts.length || doc.artifacts.some(a => doc.sha256_checksums[a.name] !== a.sha256)) reject("CHECKSUM_BYTES_MISMATCH", "checksum manifest differs from artifacts");
  for (const artifact of doc.artifacts) {
    const path = isAbsolute(artifact.name) ? artifact.name : join(dirname(evidencePath), artifact.name);
    if (!existsSync(path) || !verifyChecksumAgainstArtifact(path, artifact.sha256)) reject("CHECKSUM_BYTES_MISMATCH", `artifact bytes differ: ${artifact.name}`);
    if (readFileSync(path).byteLength !== artifact.size_bytes) reject("CHECKSUM_BYTES_MISMATCH", `artifact size differs: ${artifact.name}`);
  }
  // v1.1.6 follow-up A1 (Task 1): soft cross-check
  // against the tag's `release-artifact-hashes.json`
  // when the file is provided via
  // `RELEASE_ARTIFACT_HASHES_PATH`. On the rc-branch
  // the file is absent and the check is a no-op; on
  // the tag path (release.yml `verify-extracted-artifacts`
  // job) the file is present and mismatches emit
  // `[MISMATCHED_PLATFORMS] WARNING:` log lines
  // without failing the verifier. Task 12 (Phase 3
  // final gate) flips this to a hard `reject()`.
  checkReleaseArtifactHashesSoft(doc);
  return doc;
}

function argument(name) { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; }
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1"))) {
  try {
    const evidence = argument("--evidence") ?? process.argv.find((v, i) => i > 1 && !v.startsWith("--"));
    if (!evidence) reject("SCHEMA_INVALID", "usage: --evidence <path> [--stable|--dev]");
    if (process.argv.includes("--stable") && process.argv.includes("--dev")) reject("SCHEMA_INVALID", "choose one mode");
    verifyDocument(JSON.parse(readFileSync(evidence, "utf8")), evidence, !process.argv.includes("--dev"));
    console.log(JSON.stringify({ ok: true, mode: process.argv.includes("--dev") ? "dev" : "stable" }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code ?? "SCHEMA_INVALID", detail: error.message }));
    process.exitCode = 1;
  }
}
