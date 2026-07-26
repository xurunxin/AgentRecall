import { randomBytes } from "node:crypto";

export const MEMORY_TYPES = [
  "preference",
  "procedure",
  "fact",
  "decision",
  "lesson",
  "debugging",
  "constraint"
] as const;

export const MEMORY_STATUSES = ["active", "archived", "superseded", "forgotten"] as const;
export const MEMORY_SCOPES = ["global", "project"] as const;
export const SOURCE_KINDS = ["user", "agent", "tool", "file", "command", "external"] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type Importance = 1 | 2 | 3 | 4 | 5;
export type Confidence = 1 | 2 | 3 | 4 | 5;

export type MemoryBudget = {
  max_active_entries: number;
  max_total_chars: number;
  max_topic_chars?: number;
  max_index_chars: number;
};

export const DEFAULT_GLOBAL_BUDGET: MemoryBudget = {
  max_active_entries: 500,
  max_total_chars: 250_000,
  max_index_chars: 25_000
};

export const DEFAULT_PROJECT_BUDGET: MemoryBudget = {
  max_active_entries: 300,
  max_total_chars: 150_000,
  max_topic_chars: 30_000,
  max_index_chars: 25_000
};

export type MemorySource = {
  kind: SourceKind;
  ref?: string;
};

/** Normalized persisted memory shape; optional write input fields are normalized before storage. */
export type MemoryEntry = {
  id: string;
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
  status: MemoryStatus;
  created_at: string;
  updated_at: string;
  last_accessed_at?: string;
  last_accessed_by?: Record<string, string>;
  access_count: number;
  expires_at?: string;
  review_after?: string;
  supersedes: string[];
  superseded_by?: string;
  token_estimate: number;
  char_count: number;
  /**
   * Stage 12 PR9: schema v4 row shape. The CAS update
   * path (spec § 5.6) writes
   * `WHERE id = ? AND revision = ?` and bumps
   * `revision = revision + 1`. New rows start at
   * revision 1. The v3->v4 migration back-fills revision
   * to 1 for pre-existing rows.
   */
  revision: number;
  writer_actor_id: string;
  content_hash?: string;
  pinned: boolean;
  trust_level: "user_confirmed" | "agent_observed" | "inferred" | "imported";
  sensitivity: "normal" | "private" | "restricted";
  /**
   * Stage 15 PR-M3-1 (issue #9, spec § 6.5): the
   * memory tier. Default `'working'`. The ranker
   * reads this to weight recall:
   *   - `'core'`     — pinned, high-value, weighted × 1.3
   *   - `'working'`  — current tasks, weighted × 1.0
   *   - `'archival'` — historical knowledge, weighted × 0.7
   */
  tier: "core" | "working" | "archival";
  /** ISO 8601 timestamp; entries not yet at this time are excluded from recall. */
  valid_from?: string;
  /** ISO 8601 timestamp; entries past this time decay in score. */
  valid_until?: string;
  deleted_at?: string;
  metadata: Record<string, unknown>;
};

export type ProjectScope = {
  project_id: string;
  canonical_path: string;
  display_name: string;
  created_at: string;
  updated_at: string;
  budget: MemoryBudget;
};

export type AuditEventName =
  | "created"
  | "updated"
  | "archived"
  | "superseded"
  | "forgotten"
  | "write_rejected"
  | "maintenance_run"
  | "markdown_exported"
  | "backup_created"
  | "backup_verified"
  | "restore_completed"
  | "plan_maintenance"
  | "apply_maintenance";

export type MemoryAuditEvent = {
  id: string;
  memory_id?: string;
  scope: MemoryScope;
  project_id?: string;
  event: AuditEventName;
  reason?: string;
  /**
   * Stage 10 PR3: actor is now a free-form string. The legacy
   * `agent` / `user` / `system` values are still produced (and
   * read) for backward compatibility, but new writes from
   * service code use the structured `kind:name` form
   * (e.g. `agent:claude-code`, `system:expiry`). The v1 → v2
   * migration already relaxed the SQLite CHECK constraint to
   * accept any TEXT, so structured values pass the schema.
   * Use `parseActor` from `./actor.js` to recover the kind
   * and name components.
   */
  actor: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type Result<T, E extends string = string> =
  | { ok: true; value: T }
  | { ok: false; error: E; message: string; details?: Record<string, unknown> };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E extends string>(
  error: E,
  message: string,
  details?: Record<string, unknown>
): Result<never, E> {
  return details === undefined ? { ok: false, error, message } : { ok: false, error, message, details };
}

export function isMemoryType(value: string): value is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(value);
}

export function isMemoryStatus(value: string): value is MemoryStatus {
  return (MEMORY_STATUSES as readonly string[]).includes(value);
}

export function nowIso(date = new Date()): string {
  return date.toISOString();
}

export function createMemoryId(): string {
  return `mem_${randomBytes(12).toString("hex")}`;
}

export function createAuditId(): string {
  return `aud_${randomBytes(12).toString("hex")}`;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function computeEntrySize(title: string, body: string, tags: string[]): { char_count: number; token_estimate: number } {
  const char_count = title.length + body.length + tags.join(" ").length;
  return { char_count, token_estimate: estimateTokens(`${title}\n${body}\n${tags.join(" ")}`) };
}
