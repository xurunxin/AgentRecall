import {
  MEMORY_SCOPES,
  SOURCE_KINDS,
  computeEntrySize,
  err,
  isMemoryType,
  ok,
  type Confidence,
  type Importance,
  type MemoryScope,
  type MemorySource,
  type MemoryStatus,
  type MemoryType,
  type Result
} from "./domain.js";
import { detectSecrets, type SecretFinding } from "./secret-detector.js";

type ValidationError = "invalid_schema" | "secret_detected" | "invalid_state" | "unauthorized";
type WritableStatus = Extract<MemoryStatus, "active" | "archived">;

/**
 * Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4): the
 * memory semantics controlled fields are exposed
 * through `RememberInput` and `UpdateInput`. The MCP
 * tools (PR-7) forward them end-to-end. The validator
 * accepts the field set; the write service applies
 * the authorization policy and temporal-window
 * enforcement. The split keeps the validator a
 * pure data-shape check and the service the policy
 * gate.
 */
export const MEMORY_TIERS = ["core", "working", "archival"] as const;
export const MEMORY_SENSITIVITIES = ["normal", "private", "restricted"] as const;
export const MEMORY_TRUST_LEVELS = ["user_confirmed", "agent_observed", "inferred", "imported"] as const;

export type MemoryTier = (typeof MEMORY_TIERS)[number];
export type MemorySensitivity = (typeof MEMORY_SENSITIVITIES)[number];
export type MemoryTrustLevel = (typeof MEMORY_TRUST_LEVELS)[number];

export type RememberInput = {
  scope: MemoryScope;
  project_id?: string;
  project_path?: string;
  type: MemoryType;
  topic: string;
  title: string;
  body: string;
  tags?: string[];
  source: MemorySource;
  importance: Importance;
  confidence: Confidence;
  status?: WritableStatus;
  expires_at?: string;
  review_after?: string;
  supersedes?: string[];
  /**
   * Stage 2 forced-confirm flag. When a duplicate candidate is detected
   * on title or body, the write is rejected unless this is explicitly
   * set to `true`. The rejected payload includes the matching memory
   * ids so the agent can decide whether to confirm, merge, or cancel.
   */
  confirm_write?: boolean;
  /**
   * Stage 14 PR-B2 (spec § 5.6): optional idempotency key. When
   * set, a retry of the same request body replays the original
   * result without re-running the mutation. A retry with a
   * different body under the same key surfaces
   * `idempotency_key_reuse` so the caller can detect a
   * client-side bug.
   */
  idempotency_key?: string;
  /**
   * Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4):
   * memory tier. Default `'working'` when omitted.
   * The ranker weights `tier` (core × 1.3, working
   * × 1.0, archival × 0.7).
   */
  tier?: MemoryTier;
  /**
   * Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4):
   * pinned memories are not auto-decayed by the
   * `stale_penalty` component. Defaults to `false`.
   */
  pinned?: boolean;
  /**
   * Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4):
   * ISO 8601 timestamp. The memory is not surfaced
   * in `search_memories` / `recall_context` before
   * this time. Optional; absent = always eligible.
   */
  valid_from?: string;
  /**
   * Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4):
   * ISO 8601 timestamp. After this time the memory
   * is excluded from candidates (the documented
   * temporal policy: expired entries do not appear
   * in recall results).
   */
  valid_until?: string;
  /**
   * Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4):
   * sensitivity tier. `'restricted'` requires the
   * caller to pass an actor with the `restricted:read`
   * capability (enforced at the service layer, not
   * the validator). Default `'normal'` for agent
   * writes.
   */
  sensitivity?: MemorySensitivity;
    /**
     * Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4)
     * + Stage 18 v1.1.2 (issue #23, ADR-0001): the
     * `trust_level` field. The `'user_confirmed'`
     * value is a privileged transition; v1.1.2
     * removes the legacy `user_confirmed: true`
     * gate and replaces it with the operator-side
     * `CapabilityStore.authorize(...)` check (see
     * `src/admin/capability.ts`). The validator
     * still accepts the field; the service performs
     * the authorization decision.
     */
    trust_level?: MemoryTrustLevel;
    /**
     * Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4):
     * trusted-user confirmation. Stage 18 v1.1.2
     * (issue #23, ADR-0001) keeps the field for
     * backward compatibility but the v1.1.2 contract
     * documents it as a HINT, not authorization
     * evidence. The server-side `CapabilityStore` is
     * the only thing that authorises a `user_confirmed`
     * trust tier or a `restricted` sensitivity. The
     * flag is preserved so existing MCP clients keep
     * parsing their payloads; the validator accepts
     * it without gating on it.
     */
    user_confirmed?: boolean;
    /**
     * Stage 18 v1.1.2 (issue #23, ADR-0001): the
     * operator capability token. Optional on the
     * wire; the validator extracts the value when
     * present. The service calls
     * `CapabilityStore.authorize(...)` on the
     * `trust_promotion` and `sensitivity_restricted`
     * capability types before accepting the
     * privileged write. The token is NEVER logged
     * or surfaced in error messages.
     */
    capability?: string;
  };

export type ValidatedRememberInput = {
  scope: MemoryScope;
  project_id?: string;
  project_path?: string;
  type: MemoryType;
  topic: string;
  title: string;
  body: string;
  tags: string[];
  source: MemorySource;
  importance: Importance;
  confidence: Confidence;
  status: WritableStatus;
  expires_at?: string;
  review_after?: string;
  supersedes: string[];
  token_estimate: number;
  char_count: number;
  tier: MemoryTier;
  pinned: boolean;
  valid_from?: string;
  valid_until?: string;
  sensitivity: MemorySensitivity;
  trust_level: MemoryTrustLevel;
  /**
   * Stage 18 v1.1.2 (issue #23, ADR-0001): the
   * operator capability token. Optional. The
   * service calls `CapabilityStore.authorize(...)`
   * on the relevant capability type when a
   * privileged transition is requested.
   */
  capability?: string;
};

export type UpdateInput = Partial<
  Pick<
    ValidatedRememberInput,
    | "topic"
    | "title"
    | "body"
    | "tags"
    | "importance"
    | "confidence"
    | "status"
    | "expires_at"
    | "review_after"
    | "tier"
    | "pinned"
    | "valid_from"
    | "valid_until"
    | "sensitivity"
    | "trust_level"
  >
> & {
  /**
   * Stage 12 PR9: optimistic-concurrency control (spec
   * § 5.6). When set, the writer applies the patch only
   * if the row's `revision` matches `expected_revision`;
   * otherwise it returns `stale_revision` to the caller
   * so they can re-read and retry.
   */
  expected_revision?: number;
  /**
   * Stage 14 PR-B2 (spec § 5.6): optional idempotency key.
   * Same semantics as on `RememberInput`.
   */
  idempotency_key?: string;
    /**
     * Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4)
     * + Stage 18 v1.1.2 (issue #23, ADR-0001):
     * trusted-user confirmation. Stage 18 keeps the
     * field for backward compatibility but the
     * v1.1.2 contract documents it as a HINT, not
     * authorization evidence. The server-side
     * `CapabilityStore` is the only thing that
     * authorises a `user_confirmed` trust tier or
     * a `restricted` sensitivity.
     */
    user_confirmed?: boolean;
    /**
     * Stage 18 v1.1.2 (issue #23, ADR-0001): the
     * operator capability token. Optional on the
     * wire; the validator extracts the value when
     * present. The service calls
     * `CapabilityStore.authorize(...)` on the
     * `trust_promotion` and `sensitivity_restricted`
     * capability types before accepting the
     * privileged update.
     */
    capability?: string;
  };

export type ValidatedUpdateInput = UpdateInput;

const WRITABLE_STATUSES = ["active", "archived"] as const;
const MUTABLE_UPDATE_FIELDS = new Set([
  "topic",
  "title",
  "body",
  "tags",
  "importance",
  "confidence",
  "status",
  "expires_at",
  "review_after",
  "tier",
  "pinned",
  "valid_from",
  "valid_until",
  "sensitivity",
  "trust_level",
  "expected_revision",
  // Stage 14 PR-B2 (spec § 5.6): idempotency_key is
  // allowed on the update payload (it is a control
  // field, not a memory field) but it is not propagated
  // to the entry row; `validateUpdateInput` only
  // validates the keys are allowed, not that they
  // produce entry changes. `idempotency_key` is read
  // by the write service's `checkIdempotency` helper
  // before any state change.
  "idempotency_key",
  // Stage 16 v1.1.1 PR-7 (#17): the trusted-user
  // confirmation flag. Like `idempotency_key` it is
  // a control field, not a memory field; the write
  // service reads it to gate the trust_level /
  // sensitivity escalation policy.
  "user_confirmed"
]);

export function validateRememberInput(input: unknown): Result<ValidatedRememberInput, ValidationError> {
  if (!isRecord(input)) {
    return invalidSchema(["input"]);
  }

  const issues: string[] = [];
  const scope = parseScope(input.scope, issues);
  const projectId = parseOptionalNonEmptyString(input, "project_id", issues);
  const projectPath = parseOptionalNonEmptyString(input, "project_path", issues);
  const type = parseMemoryType(input.type, issues);
  const topic = parseRequiredString(input, "topic", issues);
  const title = parseRequiredString(input, "title", issues);
  const body = parseRequiredString(input, "body", issues);
  const tags = parseTags(input.tags, issues);
  const source = parseSource(input.source, issues);
  const importance = parseRating(input.importance, "importance", issues);
  const confidence = parseRating(input.confidence, "confidence", issues);
  const status = input.status === undefined ? "active" : parseWritableStatus(input.status, issues);
  const expiresAt = parseOptionalNonEmptyString(input, "expires_at", issues);
  const reviewAfter = parseOptionalNonEmptyString(input, "review_after", issues);
  const supersedes = parseStringList(input.supersedes, "supersedes", issues, []);
  const tier = input.tier === undefined ? "working" : parseTier(input.tier, issues);
  const pinned = parsePinned(input.pinned, issues) ?? false;
  const validFrom = parseOptionalTimestamp(input, "valid_from", issues);
  const validUntil = parseOptionalTimestamp(input, "valid_until", issues);
  const sensitivity = input.sensitivity === undefined ? "normal" : parseSensitivity(input.sensitivity, issues);
  const trustLevel = input.trust_level === undefined ? "agent_observed" : parseTrustLevel(input.trust_level, issues);
  const userConfirmed = parseUserConfirmed(input.user_confirmed, issues) ?? false;
  const capability = parseCapability(input.capability, issues);

  if (scope === "project" && projectId === undefined && projectPath === undefined) {
    issues.push("project_id");
    issues.push("project_path");
  }

  if (
    issues.length > 0 ||
    scope === undefined ||
    type === undefined ||
    topic === undefined ||
    title === undefined ||
    body === undefined ||
    tags === undefined ||
    source === undefined ||
    importance === undefined ||
    confidence === undefined ||
    status === undefined ||
    supersedes === undefined ||
    tier === undefined ||
    sensitivity === undefined ||
    trustLevel === undefined ||
    userConfirmed === undefined
  ) {
    return invalidSchema(issues);
  }

  // Temporal-window sanity: valid_from must be <= valid_until
  // when both are supplied. The MCP client is free to set
  // either, but a backwards window is unambiguously a
  // configuration bug — reject it as `invalid_state` so the
  // caller can fix the input rather than produce a memory
  // that is never eligible for recall.
  if (validFrom !== undefined && validUntil !== undefined) {
    if (Date.parse(validFrom) > Date.parse(validUntil)) {
      return err(
        "invalid_state",
        "valid_from must be earlier than or equal to valid_until.",
        { valid_from: validFrom, valid_until: validUntil }
      );
    }
  }

  // Trust-level authorization (Stage 18 v1.1.2
  // issue #23, ADR-0001): the validator no longer
  // gates on the `user_confirmed: true` flag.
  // The flag is preserved for backward
  // compatibility (older clients keep parsing) but
  // the v1.1.2 contract documents it as a HINT,
  // not authorization evidence. The actual
  // authorization is the `CapabilityStore.authorize
  // (capability, requestContext)` call performed by
  // the service layer against the
  // `trust_promotion` capability type. The
  // validator's only policy at this level is to
  // parse the input correctly; the service
  // returns `unauthorized` when the capability is
  // missing or does not match.

  const secretFindings = findSecrets({ title, body, tags });
  if (secretFindings.length > 0) {
    return secretDetected(secretFindings);
  }

  const size = computeEntrySize(title, body, tags);

  return ok({
    scope,
    ...(projectId !== undefined ? { project_id: projectId } : {}),
    ...(projectPath !== undefined ? { project_path: projectPath } : {}),
    type,
    topic,
    title,
    body,
    tags,
    source,
    importance,
    confidence,
    status,
    ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
    ...(reviewAfter !== undefined ? { review_after: reviewAfter } : {}),
    supersedes,
    ...size,
    tier,
    pinned,
    ...(validFrom !== undefined ? { valid_from: validFrom } : {}),
    ...(validUntil !== undefined ? { valid_until: validUntil } : {}),
    sensitivity,
    trust_level: trustLevel,
    ...(capability !== undefined ? { capability } : {})
  });
}

export function validateUpdateInput(input: unknown): Result<ValidatedUpdateInput, ValidationError> {
  if (!isRecord(input)) {
    return invalidSchema(["input"]);
  }

  const issues: string[] = [];
  for (const field of Object.keys(input)) {
    if (!MUTABLE_UPDATE_FIELDS.has(field)) {
      issues.push(field);
    }
  }

  const value: ValidatedUpdateInput = {};
  const secretInputs: { title?: string; body?: string; tags?: string[] } = {};

  if ("topic" in input) {
    const topic = parseRequiredString(input, "topic", issues);
    if (topic !== undefined) value.topic = topic;
  }
  if ("title" in input) {
    const title = parseRequiredString(input, "title", issues);
    if (title !== undefined) {
      value.title = title;
      secretInputs.title = title;
    }
  }
  if ("body" in input) {
    const body = parseRequiredString(input, "body", issues);
    if (body !== undefined) {
      value.body = body;
      secretInputs.body = body;
    }
  }
  if ("tags" in input) {
    const tags = parseTags(input.tags, issues);
    if (tags !== undefined) {
      value.tags = tags;
      secretInputs.tags = tags;
    }
  }
  if ("importance" in input) {
    const importance = parseRating(input.importance, "importance", issues);
    if (importance !== undefined) value.importance = importance;
  }
  if ("confidence" in input) {
    const confidence = parseRating(input.confidence, "confidence", issues);
    if (confidence !== undefined) value.confidence = confidence;
  }
  if ("status" in input) {
    const status = parseWritableStatus(input.status, issues);
    if (status !== undefined) value.status = status;
  }
  if ("expires_at" in input) {
    const expiresAt = parseOptionalNonEmptyString(input, "expires_at", issues);
    if (expiresAt !== undefined) value.expires_at = expiresAt;
  }
  if ("review_after" in input) {
    const reviewAfter = parseOptionalNonEmptyString(input, "review_after", issues);
    if (reviewAfter !== undefined) value.review_after = reviewAfter;
  }
  // Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4):
  // memory semantics controlled fields. The
  // authorization policy is enforced below; the
  // per-field parsers reject garbage values first.
  if ("tier" in input) {
    const tier = parseTier(input.tier, issues);
    if (tier !== undefined) value.tier = tier;
  }
  if ("pinned" in input) {
    const pinned = parsePinned(input.pinned, issues);
    if (pinned !== undefined) value.pinned = pinned;
  }
  if ("valid_from" in input) {
    const validFrom = parseOptionalTimestamp(input, "valid_from", issues);
    if (validFrom !== undefined) value.valid_from = validFrom;
  }
  if ("valid_until" in input) {
    const validUntil = parseOptionalTimestamp(input, "valid_until", issues);
    if (validUntil !== undefined) value.valid_until = validUntil;
  }
  if ("sensitivity" in input) {
    const sensitivity = parseSensitivity(input.sensitivity, issues);
    if (sensitivity !== undefined) value.sensitivity = sensitivity;
  }
  if ("trust_level" in input) {
    const trustLevel = parseTrustLevel(input.trust_level, issues);
    if (trustLevel !== undefined) value.trust_level = trustLevel;
  }
  if ("user_confirmed" in input) {
    const userConfirmed = parseUserConfirmed(input.user_confirmed, issues);
    if (userConfirmed !== undefined) value.user_confirmed = userConfirmed;
  }
  if ("capability" in input) {
    const capability = parseCapability(input.capability, issues);
    if (capability !== undefined) value.capability = capability;
  }
  // Stage 12 PR9: optimistic-concurrency control. The
  // validator keeps `expected_revision` in the validated
  // shape so the write service can route the write
  // through `updateEntryWithRevision`. Without this
  // copy, the CAS branch in `updateMemory` is never
  // reached and the optimistic-concurrency contract
  // silently degrades to a non-CAS overwrite.
  if ("expected_revision" in input) {
    if (typeof input.expected_revision === "number" && Number.isInteger(input.expected_revision) && input.expected_revision >= 0) {
      value.expected_revision = input.expected_revision;
    } else {
      issues.push("expected_revision");
    }
  }
  if (issues.length > 0) {
    return invalidSchema(issues);
  }

  // Stage 18 v1.1.2 (issue #23, ADR-0001): the
  // validator no longer gates on the
  // `user_confirmed: true` flag. The flag is a HINT;
  // authorization is performed by the service layer's
  // `CapabilityStore.authorize(...)` call. The
  // validator's only policy at this level is to parse
  // the input correctly; the service returns
  // `unauthorized` when the capability is missing or
  // does not match the on-disk token.

  const secretFindings = findSecrets(secretInputs);
  if (secretFindings.length > 0) {
    return secretDetected(secretFindings);
  }

  return ok(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseScope(value: unknown, issues: string[]): MemoryScope | undefined {
  if (typeof value === "string" && (MEMORY_SCOPES as readonly string[]).includes(value)) {
    return value as MemoryScope;
  }
  issues.push("scope");
  return undefined;
}

function parseMemoryType(value: unknown, issues: string[]): MemoryType | undefined {
  if (typeof value === "string" && isMemoryType(value)) {
    return value;
  }
  issues.push("type");
  return undefined;
}

function parseSource(value: unknown, issues: string[]): MemorySource | undefined {
  if (!isRecord(value)) {
    issues.push("source");
    return undefined;
  }

  if (typeof value.kind !== "string" || !(SOURCE_KINDS as readonly string[]).includes(value.kind)) {
    issues.push("source.kind");
    return undefined;
  }

  const ref = parseOptionalNonEmptyString(value, "ref", issues);
  return ref === undefined ? { kind: value.kind as MemorySource["kind"] } : { kind: value.kind as MemorySource["kind"], ref };
}

function parseRequiredString(record: Record<string, unknown>, field: string, issues: string[]): string | undefined {
  const value = record[field];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  issues.push(field);
  return undefined;
}

function parseOptionalNonEmptyString(
  record: Record<string, unknown>,
  field: string,
  issues: string[]
): string | undefined {
  if (!(field in record) || record[field] === undefined) {
    return undefined;
  }

  const value = record[field];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  issues.push(field);
  return undefined;
}

function parseTags(value: unknown, issues: string[]): string[] | undefined {
  return parseStringList(value, "tags", issues, []);
}

function parseStringList(
  value: unknown,
  field: string,
  issues: string[],
  defaultValue: string[] | undefined
): string[] | undefined {
  if (value === undefined) {
    return defaultValue;
  }

  if (!Array.isArray(value)) {
    issues.push(field);
    return undefined;
  }

  const strings = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string") {
      issues.push(`${field}.${index}`);
      continue;
    }

    const trimmed = item.trim();
    if (trimmed.length > 0) {
      strings.add(trimmed);
    }
  }

  return [...strings].sort();
}

function parseRating(value: unknown, field: string, issues: string[]): Importance | Confidence | undefined {
  if (Number.isInteger(value) && typeof value === "number" && value >= 1 && value <= 5) {
    return value as Importance | Confidence;
  }
  issues.push(field);
  return undefined;
}

function parseWritableStatus(value: unknown, issues: string[]): WritableStatus | undefined {
  if (typeof value === "string" && (WRITABLE_STATUSES as readonly string[]).includes(value)) {
    return value as WritableStatus;
  }
  issues.push("status");
  return undefined;
}

function parseTier(value: unknown, issues: string[]): MemoryTier | undefined {
  if (typeof value === "string" && (MEMORY_TIERS as readonly string[]).includes(value)) {
    return value as MemoryTier;
  }
  issues.push("tier");
  return undefined;
}

function parseSensitivity(value: unknown, issues: string[]): MemorySensitivity | undefined {
  if (typeof value === "string" && (MEMORY_SENSITIVITIES as readonly string[]).includes(value)) {
    return value as MemorySensitivity;
  }
  issues.push("sensitivity");
  return undefined;
}

function parseTrustLevel(value: unknown, issues: string[]): MemoryTrustLevel | undefined {
  if (typeof value === "string" && (MEMORY_TRUST_LEVELS as readonly string[]).includes(value)) {
    return value as MemoryTrustLevel;
  }
  issues.push("trust_level");
  return undefined;
}

function parsePinned(value: unknown, issues: string[]): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  issues.push("pinned");
  return undefined;
}

function parseUserConfirmed(value: unknown, issues: string[]): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  issues.push("user_confirmed");
  return undefined;
}

/**
 * Stage 18 v1.1.2 (issue #23, ADR-0001): the
 * operator capability token. The validator
 * enforces the canonical token shape (64 hex
 * chars) and rejects anything else so the
 * service can compare the value with a
 * constant-time check against the on-disk
 * token. The validator does NOT compare the
 * value against the on-disk token itself —
 * the `CapabilityStore.authorize(...)` call
 * is the only authoritative comparison. A
 * missing / malformed capability is
 * tolerated (the value is just absent from
 * the validated shape) so the service can
 * surface the stable `unauthorized` error
 * with the specific `capability_missing`
 * reason.
 */
function parseCapability(value: unknown, issues: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    issues.push("capability");
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (!/^[0-9a-f]{64}$/.test(trimmed)) {
    issues.push("capability");
    return undefined;
  }
  return trimmed;
}

function parseOptionalTimestamp(
  record: Record<string, unknown>,
  field: string,
  issues: string[]
): string | undefined {
  if (!(field in record) || record[field] === undefined) {
    return undefined;
  }
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(field);
    return undefined;
  }
  // Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4): the
  // value must be a real ISO 8601 timestamp; `Date.parse`
  // is the cheapest portable check. We don't enforce
  // a specific format (date-only vs full datetime)
  // because the rest of the codebase already accepts
  // both, but a non-parseable string is unambiguously
  // a bug.
  if (Number.isNaN(Date.parse(value))) {
    issues.push(field);
    return undefined;
  }
  return value;
}

function findSecrets(input: { title?: string; body?: string; tags?: string[] }): SecretFinding[] {
  return [
    ...(input.title === undefined ? [] : detectSecrets(input.title, "title")),
    ...(input.body === undefined ? [] : detectSecrets(input.body, "body")),
    ...(input.tags ?? []).flatMap((tag) => detectSecrets(tag, "tags"))
  ];
}

function invalidSchema(fields: string[]): Result<never, "invalid_schema"> {
  return err("invalid_schema", "Input does not match the memory write schema.", { fields: [...new Set(fields)].sort() });
}

function secretDetected(findings: SecretFinding[]): Result<never, "secret_detected"> {
  return err("secret_detected", "Potential secret detected; memory was not stored.", { findings });
}
