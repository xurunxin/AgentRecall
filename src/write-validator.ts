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

type ValidationError = "invalid_schema" | "secret_detected";
type WritableStatus = Extract<MemoryStatus, "active" | "archived">;

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
  >
>;

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
  "review_after"
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
    supersedes === undefined
  ) {
    return invalidSchema(issues);
  }

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
    ...size
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
  if (issues.length > 0) {
    return invalidSchema(issues);
  }

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
