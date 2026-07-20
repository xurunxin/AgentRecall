// src/tools/risk-detector.ts
//
// Stage 12 PR9 (spec § 6.6): detect prompt-injection style
// patterns inside recalled memory bodies and flag them as
// `unsafe_content`. The flag is advisory: callers can choose
// to downweight, surface only a summary, or drop the entry
// entirely. We never silently strip or rewrite memory bodies —
// the caller's framing header (§ 6.6) is the trust boundary,
// not this detector.
//
// Design constraints:
//   - Pure, no I/O. Each call scans a string in O(n) and
//     returns a `RiskReport`.
//   - Conservative: prefer false-negatives over false-
//     positives. Pattern sets are intentionally narrow; we
//     only flag text that *clearly* tries to redirect the
//     agent (e.g. "ignore previous instructions") or to
//     exfiltrate secrets.
//   - Locale-aware: the high-risk patterns we care about are
//     almost always in English, so we match in a case-
//     insensitive way across the body. We do not translate
//     or match CJK at the phrase level — that would
//     generate too much noise; instead, the framing header
//     instructs the model to treat any CJK content with the
//     same caution.
//   - Stable: the matched pattern ids (e.g. `prompt_override`)
//     are public; clients may key on them for filtering.

export type RiskKind =
  | "prompt_override"
  | "credential_exfil"
  | "security_relax"
  | "tool_redirection";

export interface RiskReport {
  /** `true` if any pattern matched. */
  readonly unsafe_content: boolean;
  /** The kinds that matched, deduped, in first-match order. */
  readonly kinds: readonly RiskKind[];
  /**
   * Stable, machine-readable short reason keyed on the
   * matched kind, e.g. `prompt_override:ignore_previous`.
   * Empty when `unsafe_content` is false.
   */
  readonly reasons: readonly string[];
  /**
   * The actual matched substrings, capped at 120 chars each,
   * for debugging. Never include surrounding context that
   * could itself be malicious.
   */
  readonly matches: readonly string[];
}

interface CompiledPattern {
  readonly id: string;
  readonly kind: RiskKind;
  /** Compiled RegExp. Use `g` flag. */
  readonly re: RegExp;
  /**
   * Optional minimum match length below which the match is
   * rejected (avoids matching acronyms or short tokens).
   */
  readonly minLength: number;
}

const PATTERNS: readonly CompiledPattern[] = [
  // 1. "Ignore previous instructions" / "disregard prior rules"
  {
    id: "ignore_previous",
    kind: "prompt_override",
    re: /ignore\s+(?:all\s+|any\s+|every\s+|the\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|rules?|prompts?|directives?|guidance)/gi,
    minLength: 0
  },
  {
    id: "disregard_system",
    kind: "prompt_override",
    re: /disregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|system|earlier)\s+(?:instructions?|rules?|prompts?|directives?)/gi,
    minLength: 0
  },
  {
    id: "forget_everything",
    kind: "prompt_override",
    re: /forget\s+(?:everything|all|what\s+i\s+said|prior\s+context|previous\s+rules?)/gi,
    minLength: 0
  },
  {
    id: "new_instructions",
    kind: "prompt_override",
    re: /(?:your\s+)?new\s+(?:instructions?|rules?|directives?)\s+(?:are|follow)/gi,
    minLength: 0
  },
  {
    id: "you_are_now",
    kind: "prompt_override",
    re: /you\s+are\s+now\s+(?:a|an|the)\s+\w+\s+(?:that|who|whose)\s+(?:must|should|will)/gi,
    minLength: 0
  },
  {
    id: "do_not_mention",
    kind: "prompt_override",
    re: /do\s+not\s+(?:reveal|mention|disclose|tell\s+(?:the\s+user|anyone))\s+(?:that|this|these)/gi,
    minLength: 0
  },
  // 2. Credential / secret exfiltration
  {
    id: "send_api_key",
    kind: "credential_exfil",
    re: /(?:send|post|upload|exfiltrate|transmit)\s+(?:the\s+|my\s+|your\s+)?(?:api[_\s\-]?key|secret|token|password|credential)s?\s+to/gi,
    minLength: 0
  },
  {
    id: "print_env",
    kind: "credential_exfil",
    re: /(?:print|dump|show|reveal|leak)\s+(?:the\s+)?(?:contents?\s+of\s+)?(?:process\.env|environment(?:\s+variables?)?|\$ENV|\.env)/gi,
    minLength: 0
  },
  {
    id: "read_credential_file",
    kind: "credential_exfil",
    re: /(?:read|cat|open|fetch)\s+~?\/?(?:\.ssh|\.aws|\.npmrc|\.netrc|id_rsa|credentials?)/gi,
    minLength: 0
  },
  // 3. Security relaxation
  {
    id: "disable_safety",
    kind: "security_relax",
    re: /(?:disable|turn\s+off|remove|bypass|skip)\s+(?:all\s+)?(?:safety|security|guard(?:s|rails?)|content\s+filter|moderation|confirmation)/gi,
    minLength: 0
  },
  {
    id: "no_restrictions",
    kind: "security_relax",
    re: /(?:act|behave|operate)\s+(?:as\s+if\s+)?(?:there\s+are\s+no|without\s+any)\s+(?:restrictions?|rules?|limitations?)/gi,
    minLength: 0
  },
  // 4. Tool redirection / privilege escalation
  {
    id: "run_shell",
    kind: "tool_redirection",
    re: /(?:run|execute|invoke|call)\s+(?:the\s+|a\s+)?(?:shell|bash|cmd|powershell|system\s+call)\s+(?:command\s+)?:/gi,
    minLength: 0
  },
  {
    id: "tool_override",
    kind: "tool_redirection",
    re: /override\s+(?:the\s+|your\s+)?(?:default\s+)?tools?\s+and\s+(?:use|call|invoke)\s+\w+\s+instead/gi,
    minLength: 0
  }
];

const EMPTY: RiskReport = Object.freeze({
  unsafe_content: false,
  kinds: Object.freeze([]),
  reasons: Object.freeze([]),
  matches: Object.freeze([])
});

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

/**
 * Scan a single string for high-risk patterns. Returns a
 * `RiskReport` describing what matched. The order of
 * `kinds` / `reasons` is the first-seen order across the
 * patterns array.
 */
export function detectRisks(input: string): RiskReport {
  if (typeof input !== "string" || input.length === 0) return EMPTY;

  const kinds: RiskKind[] = [];
  const reasons: string[] = [];
  const matches: string[] = [];

  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0;
    const found = pattern.re.exec(input);
    if (found === null) continue;
    if (found[0].length < pattern.minLength) continue;
    if (matches.length < 6) {
      matches.push(truncate(found[0], 120));
    }
    if (!kinds.includes(pattern.kind)) kinds.push(pattern.kind);
    reasons.push(`${pattern.kind}:${pattern.id}`);
  }

  if (kinds.length === 0) return EMPTY;
  return Object.freeze({
    unsafe_content: true,
    kinds: Object.freeze(kinds),
    reasons: Object.freeze(reasons),
    matches: Object.freeze(matches)
  });
}

/**
 * Scan multiple fields in a single pass, useful for memory
 * entries where title/topic/body should be considered
 * together. The returned report is the union of all fields.
 */
export function detectRisksInEntry(input: {
  title?: string;
  topic?: string;
  body?: string;
  tags?: readonly string[];
}): RiskReport {
  const fields: string[] = [];
  if (typeof input.title === "string") fields.push(input.title);
  if (typeof input.topic === "string") fields.push(input.topic);
  if (typeof input.body === "string") fields.push(input.body);
  if (Array.isArray(input.tags)) fields.push(...input.tags.filter((t) => typeof t === "string"));

  const kinds: RiskKind[] = [];
  const reasons: string[] = [];
  const matches: string[] = [];

  for (const value of fields) {
    const report = detectRisks(value);
    for (const k of report.kinds) {
      if (!kinds.includes(k)) kinds.push(k);
    }
    reasons.push(...report.reasons);
    matches.push(...report.matches);
  }

  if (kinds.length === 0) return EMPTY;
  return Object.freeze({
    unsafe_content: true,
    kinds: Object.freeze(kinds),
    reasons: Object.freeze(reasons),
    matches: Object.freeze(matches.slice(0, 6))
  });
}
