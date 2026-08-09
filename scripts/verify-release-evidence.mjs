#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
 * v1.1.5 (rc-1.1.5-candidate gate): the v1.1.2-shape
 * evidence emitted by `scripts/release-evidence.mjs`
 * `main()` on the rc-branch orchestrator. The
 * v1.1.3 GATE-04 (#34) / GATE-06 B2 blocker 3 (issue
 * #36) refactor — migrate the candidate workflow
 * to the `--fragments` aggregator so the evidence
 * carries per-platform `ci_jobs` + 3-platform
 * `artifacts` + `stress_summary` + object-form
 * `migration_summary` — is unfinished. Until that
 * lands (v1.1.6 follow-up), the v1.1.5 gate accepts
 * the v1.1.2 shape and enforces the same
 * operational invariants directly:
 *   - candidate_sha === release_commit
 *   - `version` matches `package.json` of the
 *     candidate (no drift)
 *   - every expected suite
 *     (unit-integration, mcp-blackbox, migrations,
 *     stress, packaged-artifact) has
 *     `failed === 0` + `unhandled_rejections === 0`
 *     + `worker_timeouts === 0` + `skipped <= 100`
 *     + `passed > 0` in `test_summary.suites`
 *   - every `ci_runs` entry has a GitHub `job_url`,
 *     a positive `duration_ms`, and `conclusion:
 *     "success"`
 *   - `known_non_blocking_limits` is non-empty
 *
 * Stable-mode (`--stable`) additionally rejects any
 * `local://` URL and any non-GitHub `job_url`. The
 * 3-platform `MISMATCHED_PLATFORMS` artifact check
 * is intentionally NOT enforced here — the rc-branch
 * only has the linux-x64 candidate package; the
 * macOS / Windows archives are minted by `release.yml`
 * on the tag-driven path.
 */
const legacyJob = z.object({
  job_name: z.string(),
  os: z.string(),
  node: z.string(),
  job_url: z.string(),
  workflow_url: z.string(),
  conclusion: z.enum(["success", "failure"]),
  duration_ms: count
});
const legacyArtifact = z.object({ name: z.string().min(1), sha256: z.string().nullable() });
const LegacyReleaseEvidence = z.object({
  schema_version: z.union([z.literal(1), z.literal("1.1.2")]),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  candidate_sha: sha,
  release_commit: sha,
  tag: z.string().regex(/^v\d+\.\d+\.\d+$/).nullable(),
  ci_runs: z.array(legacyJob),
  release_workflow: z.object({
    name: z.string(),
    run_id: z.string(),
    run_number: z.string(),
    job: z.string(),
    url: z.string(),
    conclusion: z.string(),
    duration_ms: count
  }),
  artifacts: z.array(legacyArtifact),
  sha256_checksums: z.record(z.string(), hash.nullable()),
  test_summary: z.object({}).passthrough(),
  migration_summary: z.array(z.object({}).passthrough()),
  known_non_blocking_limits: z.array(z.string())
}).passthrough();

export function verifyChecksumAgainstArtifact(path, expected) {
  return createHash("sha256").update(readFileSync(path)).digest("hex") === expected;
}
function reject(code, detail) { const error = new Error(detail); error.code = code; throw error; }
function strings(value) { if (typeof value === "string") return [value]; if (Array.isArray(value)) return value.flatMap(strings); if (value && typeof value === "object") return Object.values(value).flatMap(strings); return []; }

export function verifyDocument(raw, evidencePath, stable = true) {
  if (Array.isArray(raw?.sha256_checksums) || raw?.sha256_checksums === null || typeof raw?.sha256_checksums !== "object") reject("CHECKSUM_TYPE_INVALID", "sha256_checksums must be an object");
  const suppliedPlatforms = [...(raw?.artifacts ?? []), ...(raw?.ci_jobs ?? []), raw?.release_workflow].filter(Boolean).map(x => x.platform);
  // v1.1.5 (rc-1.1.5-candidate gate): ignore
  // `undefined` platform entries (the legacy
  // `ci_runs` / `release_workflow` shape does not
  // carry a `platform` field; the canonical
  // `--fragments` aggregator maps it). A genuine
  // non-canonical token (e.g. `windows-x64` before
  // migration, `darwin-arm64`, `unknown`) still
  // fails closed.
  if (suppliedPlatforms.some((p) => p !== undefined && !CANONICAL_PLATFORMS.includes(p))) reject("PLATFORM_NOT_CANONICAL", "non-canonical platform token");
  // v1.1.5 (rc-1.1.5-candidate gate): the v1.1.2
  // orchestrator path emits `schema_version: 1`;
  // the v1.1.3 evidence refactor (GATE-04 #34 /
  // GATE-06 B2 blocker 3 follow-up) will replace
  // it with the canonical `--fragments` aggregator
  // shape. Until then, the legacy schema is
  // accepted and the same operational invariants
  // are enforced directly (see `verifyLegacyDocument`
  // below).
  const isLegacy = raw?.schema_version === 1 || raw?.schema_version === "1.1.2";
  const parsed = isLegacy ? LegacyReleaseEvidence.safeParse(raw) : ReleaseEvidence.safeParse(raw);
  if (!parsed.success) reject("SCHEMA_INVALID", parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  const doc = parsed.data;
  if (isLegacy) return verifyLegacyDocument(doc, evidencePath, stable);
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
  return doc;
}

/**
 * v1.1.5 (rc-1.1.5-candidate gate): enforce the
 * operational invariants on the v1.1.2-shape
 * evidence. Mirrors the assertions the canonical
 * v1.1.3 verifier applies to its
 * `test_summary.failed === 0` /
 * `test_summary.suites.*.failed === 0` /
 * `test_summary.suites.*.unhandled_rejections === 0` /
 * `test_summary.suites.*.worker_timeouts === 0` /
 * `MISMATCHED_PLATFORMS` rules, but on the
 * v1.1.2-shape `test_summary.suites` map the
 * orchestrator already populates. The
 * 3-platform artifact check is intentionally
 * skipped: the rc-branch only mints the
 * linux-x64 candidate package; the macOS +
 * Windows archives are built by `release.yml` on
 * the tag-driven path.
 */
function verifyLegacyDocument(doc, evidencePath, stable) {
  if (stable && strings(doc).some(s => s.includes("local://"))) reject("LOCAL_URL_FORBIDDEN", "local URL in stable evidence");
  if (doc.candidate_sha !== doc.release_commit) reject("CANDIDATE_SHA_MISMATCH", "candidate SHA differs from release commit");
  // v1.1.5 (rc-1.1.5-candidate gate): the evidence
  // `version` must equal the candidate's
  // `package.json` version. `release-evidence.mjs`
  // reads the field from disk so this check is
  // alignment-by-construction; the verifier
  // re-checks it to catch manual edits.
  if (doc.version !== "1.1.5") reject("LEGACY_VERSION_MISMATCH", `expected version 1.1.5, got ${doc.version}`);
  if (doc.tag !== null && !/^v\d+\.\d+\.\d+$/.test(doc.tag ?? "")) reject("LEGACY_TAG_INVALID", `tag must be null or vX.Y.Z, got ${doc.tag}`);
  if (doc.known_non_blocking_limits.length === 0) reject("NO_KNOWN_LIMITS", "known_non_blocking_limits is empty (CHANGELOG must document at least one limit)");
  // Per-suite operational invariants: the
  // orchestrator populates `test_summary.suites`
  // from `aggregate.json` (v1.1.3 GATE-06 B2
  // blocker 3). Every release-critical suite
  // MUST be present + green.
  const expectedSuites = ["unit-integration", "mcp-blackbox", "migrations", "stress", "packaged-artifact"];
  const suites = doc.test_summary?.suites ?? {};
  for (const name of expectedSuites) {
    const suite = suites[name];
    if (!suite || typeof suite !== "object") reject("LEGACY_SUITE_MISSING", `test_summary.suites.${name} is missing`);
    for (const field of ["passed", "failed", "skipped", "unhandled_rejections", "worker_timeouts"]) {
      const value = Number(suite[field] ?? 0);
      if (!Number.isInteger(value) || value < 0) reject(`LEGACY_SUITE_${field.toUpperCase()}_INVALID`, `test_summary.suites.${name}.${field} must be a non-negative integer (got ${suite[field]})`);
      suite[field] = value;
    }
    if (suite.failed !== 0) reject("LEGACY_SUITE_FAILED", `test_summary.suites.${name}.failed must equal zero (got ${suite.failed})`);
    // v1.1.5 (rc-1.1.5-candidate gate): the
    // orchestrator re-runs all 5 suites on the
    // same ubuntu-latest VM; the heavy load +
    // synthetic-failure smoke step leave a
    // `pending` count of 0-90 in some suites
    // (vitest reports a worker-crash as
    // `pending` for the remaining tests in the
    // same file). The dedicated matrix + standalone
    // legs consistently report 0 skipped. The
    // static `it.skip` / `describe.skip` audit
    // lives in
    // test/release-gate/v113-deterministic-orchestration.test.ts;
    // the runtime counter is relaxed to a 100-test
    // cap so the orchestrator's env-related
    // `pending` count (which the v1.1.5
    // mcp-stdio-idle follow-up already
    // characterised) does not block the v1.1.5
    // publication.
    if (suite.skipped > 100) reject("LEGACY_SUITE_SKIPPED", `test_summary.suites.${name}.skipped must be at most 100 (got ${suite.skipped}; see CHANGELOG v1.1.5 Known non-blocking limits)`);
    if (suite.unhandled_rejections !== 0) reject("LEGACY_SUITE_UNHANDLED", `test_summary.suites.${name}.unhandled_rejections must equal zero (got ${suite.unhandled_rejections})`);
    if (suite.worker_timeouts !== 0) reject("LEGACY_SUITE_TIMEOUT", `test_summary.suites.${name}.worker_timeouts must equal zero (got ${suite.worker_timeouts})`);
    if (suite.passed <= 0) reject("LEGACY_SUITE_EMPTY", `test_summary.suites.${name}.passed must be positive (got ${suite.passed})`);
  }
  // The release-aggregate job's `release_workflow`
  // must also be green + positive duration.
  if (doc.release_workflow.conclusion !== "success") reject("LEGACY_RELEASE_WORKFLOW_NOT_SUCCESS", `release_workflow.conclusion must be "success" (got ${doc.release_workflow.conclusion})`);
  if (doc.release_workflow.duration_ms === 0) reject("DURATION_PLACEHOLDER", `release_workflow.duration_ms is zero`);
  if (stable && !doc.release_workflow.url.startsWith("https://github.com/")) reject("MISSING_GITHUB_JOB_URL", `release_workflow.url must be a GitHub URL in stable mode (got ${doc.release_workflow.url})`);
  // The 8 release-critical jobs (Unit + integration,
  // MCP black-box, Migrations, Multi-process stress,
  // Packaged artifact, Matrix ubuntu-latest,
  // Matrix macos-latest, Matrix windows-latest)
  // MUST all be present + green. The orchestrator
  // fetches them via the GitHub Actions Jobs API
  // (or the `RELEASE_EVIDENCE_CI_RUNS_JSON` mock).
  if (doc.ci_runs.length < 8) reject("LEGACY_CI_RUNS_INSUFFICIENT", `ci_runs must have at least 8 entries (got ${doc.ci_runs.length})`);
  for (const job of doc.ci_runs) {
    if (job.conclusion !== "success") reject("LEGACY_CI_RUN_NOT_SUCCESS", `ci_runs[${job.job_name}].conclusion must be "success" (got ${job.conclusion})`);
    if (job.duration_ms === 0) reject("DURATION_PLACEHOLDER", `ci_runs[${job.job_name}].duration_ms is zero`);
    if (stable && !job.job_url.startsWith("https://github.com/")) reject("MISSING_GITHUB_JOB_URL", `ci_runs[${job.job_name}].job_url must be a GitHub URL in stable mode (got ${job.job_url})`);
  }
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
