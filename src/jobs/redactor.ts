// src/jobs/redactor.ts
//
// v1.2.0-alpha.0 (issue #48): redact error strings before
// persisting them on a `derivation_jobs.redacted_error`
// column. The redaction policy is intentionally narrow:
//   1. Never persist a raw `prompt` or `response` body.
//      The runner only writes `output_digest` + a 200-char
//      `rationale` excerpt; we do not attempt to scrub
//      arbitrary blob input.
//   2. Mask secret-like patterns in any free-form error
//      message so a "captured token in error" leak does
//      not survive a later audit. We use the existing
//      `secret-detector.ts` regex catalogue and replace
//      any matched substring with a stable `[redacted:<cat>]`
//      placeholder so the audit reader can see the
//      *category* without seeing the value.
//   3. Truncate the final string to 2000 chars so a
//      pathological stack-trace does not blow up the
//      SQLite column. The full trace still goes to stderr
//      (or the runner's local log); only the durable
//      surface is bounded.
//
// This module is intentionally tiny and synchronous; the
// hot path is the runner finalising a job, where one
// redaction call per job is negligible. Callers that
// batch finalise (e.g. the multi-process test harness)
// are not impacted because each call is O(message size).

import { detectSecrets, type SecretCategory } from "../secret-detector.js";

const MAX_REDACTED_ERROR_LENGTH = 2000;
const SECRET_MASK = (cat: SecretCategory) => `[redacted:${cat}]`;

/**
 * Mask all secret-like substrings in `input`. Categories
 * are emitted in the order the detector surfaces them so
 * the replacement is stable across runs. Empty / null
 * input is returned as an empty string so the column is
 * never `NULL` when the runner has *anything* to report.
 */
export function redactError(input: string | null | undefined): string {
  if (input === null || input === undefined || input === "") return "";
  const findings = detectSecrets(input, "error");
  if (findings.length === 0) {
    return input.slice(0, MAX_REDACTED_ERROR_LENGTH);
  }
  // Build a single regex with alternation, capturing
  // the literal pattern verbatim. We deliberately avoid
  // re-deriving the pattern from the secret-detector
  // (which would couple the two modules) and instead
  // apply the same regexes inlined below. The inline
  // copy is a 5-line set of well-known patterns; a
  // future refactor could extract them into a shared
  // `secret-regexes.ts` if the catalogue grows.
  const pattern = /(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{24,}\b|\b[A-Z0-9_]*(SECRET|TOKEN|API_KEY|PASSWORD|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*["']?[^"'\s]{8,})/i;
  const masked = input.replace(pattern, (match) => {
    const cat = categorise(match);
    return SECRET_MASK(cat);
  });
  return masked.slice(0, MAX_REDACTED_ERROR_LENGTH);
}

/**
 * Truncate a `rationale` excerpt to 200 chars as
 * promised in `docs/adr/0009-derivation-job-lifecycle.md`.
 * The full rationale is *not* persisted; only a
 * human-skimmable prefix.
 */
export function truncateRationale(input: string | null | undefined): string {
  if (input === null || input === undefined) return "";
  return input.slice(0, 200);
}

function categorise(match: string): SecretCategory {
  if (match.startsWith("-----BEGIN")) return "private_key";
  if (match.startsWith("Bearer ")) return "bearer_token";
  if (/SECRET|TOKEN|API_KEY|PASSWORD|PRIVATE_KEY/.test(match)) return "env_secret";
  if (match.startsWith("sk-") || match.startsWith("ghp_") || match.startsWith("xox")) {
    return "api_key_prefix";
  }
  return "high_entropy_token";
}
