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

export function verifyChecksumAgainstArtifact(path, expected) {
  return createHash("sha256").update(readFileSync(path)).digest("hex") === expected;
}
function reject(code, detail) { const error = new Error(detail); error.code = code; throw error; }
function strings(value) { if (typeof value === "string") return [value]; if (Array.isArray(value)) return value.flatMap(strings); if (value && typeof value === "object") return Object.values(value).flatMap(strings); return []; }

export function verifyDocument(raw, evidencePath, stable = true) {
  if (Array.isArray(raw?.sha256_checksums) || raw?.sha256_checksums === null || typeof raw?.sha256_checksums !== "object") reject("CHECKSUM_TYPE_INVALID", "sha256_checksums must be an object");
  const suppliedPlatforms = [...(raw?.artifacts ?? []), ...(raw?.ci_jobs ?? []), raw?.release_workflow].filter(Boolean).map(x => x.platform);
  if (suppliedPlatforms.some(p => !CANONICAL_PLATFORMS.includes(p))) reject("PLATFORM_NOT_CANONICAL", "non-canonical platform token");
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
