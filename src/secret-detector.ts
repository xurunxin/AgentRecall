export type SecretCategory = "private_key" | "bearer_token" | "env_secret" | "api_key_prefix" | "high_entropy_token";

export type SecretFinding = {
  category: SecretCategory;
  field: string;
};

/**
 * Stage 14 PR-C (spec § 9.1): a hand-maintained release
 * marker the doctor `secret_policy_version` check
 * compares against the expected version. Bump the
 * constant when the regex catalogue above changes in a
 * way that could re-classify previously-accepted text.
 */
export const SECRET_POLICY_VERSION = "v1";

const API_KEY_PREFIXES = /\b(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}\b/i;
const ENV_SECRET = /\b[A-Z0-9_]*(SECRET|TOKEN|API_KEY|PASSWORD|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*["']?[^"'\s]{8,}/i;
const HIGH_ENTROPY = /\b[A-Za-z0-9+/=_-]{40,}\b/;

export function detectSecrets(text: string, field = "body"): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const hasEnvSecret = ENV_SECRET.test(text);
  if (PRIVATE_KEY.test(text)) findings.push({ category: "private_key", field });
  if (BEARER_TOKEN.test(text)) findings.push({ category: "bearer_token", field });
  if (hasEnvSecret) findings.push({ category: "env_secret", field });
  if (!hasEnvSecret && API_KEY_PREFIXES.test(text)) findings.push({ category: "api_key_prefix", field });
  if (HIGH_ENTROPY.test(text) && /\b(token|secret|key|password|authorization)\b/i.test(text)) {
    findings.push({ category: "high_entropy_token", field });
  }
  return findings;
}
