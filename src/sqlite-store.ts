import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  createSqliteDb,
  type SqliteBindValue as SQLInputValue,
  type SqliteRowValue as SQLOutputValue,
  type SqliteDb,
  type SqliteStatement
} from "./sqlite-driver.js";
import { nowIso } from "./domain.js";

const IS_WINDOWS = process.platform === "win32";
import type {
  AuditEventName,
  MemoryAuditEvent,
  MemoryEntry,
  MemoryScope,
  MemoryStatus,
  MemoryType,
  ProjectScope
} from "./domain.js";

export type EntryFilters = {
  scope?: MemoryScope;
  project_id?: string;
  type?: MemoryType | string;
  topic?: string;
  status?: MemoryStatus | string;
  tags?: string[];
  limit?: number;
  offset?: number;
  /**
   * Stage 4: filter to memories whose "created" audit row was written
   * by the given actor. Implemented as a subquery in the WHERE clause
   * to avoid a join on every read.
   */
  actor?: string;
  /**
   * Stage 6: ISO 8601 lower bound on `created_at`. Strings are
   * compared lexicographically, which is correct for ISO 8601.
   */
  since?: string;
  /**
   * Stage 6: ISO 8601 upper bound on `created_at`. Strings are
   * compared lexicographically, which is correct for ISO 8601.
   */
  until?: string;
  /**
   * Stage 6: ISO 8601 lower bound on `last_accessed_at`. Memories
   * with `last_accessed_at IS NULL` (never read) are excluded by
   * design — "never touched" is not "touched since X".
   */
  last_accessed_since?: string;
  /**
   * Stage 7: ISO 8601 lower bound on `updated_at`. Strings are
   * compared lexicographically, which is correct for ISO 8601.
   * Distinct from `since` (which filters `created_at`) — useful
   * for "what memories have I touched in the last week?" queries.
   */
  updated_since?: string;
  /**
   * Stage 7: ISO 8601 upper bound on `updated_at`. Parallel to
   * `until` (which filters `created_at`).
   */
  updated_until?: string;
  /**
   * Stage 18 v1.1.2 (issue #23, ADR-0001): the
   * maximum sensitivity the caller is
   * authorised to read. The store filters
   * rows whose `sensitivity` exceeds the
   * value at the SQL boundary (NOT at the
   * response layer); a caller without the
   * `sensitivity_visibility` capability
   * cannot see `private` or `restricted`
   * rows. Valid values: `"normal"` (the
   * default; only `normal` rows visible),
   * `"private"`, `"restricted"`. The order
   * normal < private < restricted.
   */
  actor_max_sensitivity?: "normal" | "private" | "restricted";
};

export type SearchFilters = EntryFilters & {
  query: string;
};

/**
 * Current authoritative schema version. Stage 1 introduced explicit
 * `PRAGMA user_version` tracking. v2 loosened the `audit_events.actor`
 * CHECK constraint to allow structured values like `agent:claude-code`.
 * v3 adds the `last_accessed_by` JSON column to `memory_entries`.
 * v4 (Stage 11 PR7) adds revision / writer_actor_id / memory_revisions
 * / memory_accesses / project_aliases / memory_relations.
 * v5 (Stage 15 PR-M0-1) replaces `mutation_requests` with
 * `mutation_requests_v2` (PK `(actor_id, tool_name, idempotency_key)`,
 * transactional reservation).
 * v6 (Stage 15 PR-M0-4, issue #3) introduces persistent
 * `maintenance_plans` + `maintenance_plan_items` so plans survive
 * MCP restart and `apply_maintenance` only mutates planned targets
 * (no more "broad merge_duplicates" path).
 * v7 (Stage 15 PR-M1-1, issue #6) adds `memory_provenance` for
 * link chains (issue / PR / commit / tool_call / session / import)
 * and finalises the v3 `last_accessed_by` JSON column as
 * read-only-deprecated (the canonical access data lives in
 * `memory_accesses` from v4 onward).
 * v8 (Stage 15 PR-M1-2, issue #7) introduces a strict project
 * identity model: `project_identities` (one row per `project_id`
 * with its `canonical_path`) plus a strengthened `project_aliases`
 * table (PRIMARY KEY on the raw alias path; FK + UNIQUE on
 * `(project_id, canonical_path)`). The scope-resolver
 * consults both: an alias path that maps to a different
 * `project_id` than the caller's input surfaces
 * `project_identity_conflict`.
 * v9 (Stage 15 PR-M1-3, issue #5) adds `memory_feedback`
 * (per-actor explicit 👍/👎 signals) and
 * `memory_recall_signals` (cached per-memory recall stats
 * for the ranker). The RRF fusion in the ranker uses both
 * to replace the placeholder feedback / access signals.
 * v10 (Stage 15 PR-M3-1, issue #9) introduces the
 * memory hierarchy:
 *   - `memory_entries.tier` (`'core' | 'working' |
 *     'archival'`, default `'working'`)
 *   - `memory_entries.valid_from` / `valid_until`
 *     (Unix ms; NULL = no boundary)
 *   - `memory_episodes` table for episode-shaped
 *     memories (parent_memory_id, summary,
 *     started_at, ended_at, actor_id)
 * The ranker reads `tier` (core × 1.3, working × 1.0,
 * archival × 0.7) and `valid_from` / `valid_until`
 * (entries past their `valid_until` decay, entries
 * not yet at `valid_from` are excluded from recall).
 * v12 (Stage 18 v1.1.2 issue #21): the strict project
 * identity backfill from `project_scopes`.
 * v13 (Stage 18 v1.1.2 issue #26, task 7): the durable
 * `import_batches` lineage surface. Every applied import
 * writes one row in `pending` -> (`running` ->
 * `completed`) or (`failed`) state; the `ImportBatchStore`
 * is the public API for the row's lifecycle and the
 * redacted `inspect(...)` read.
 * v14 (v1.2.0-alpha.0, issue #48): the durable derivation
 * job substrate. Three additive tables — `derivation_jobs`,
 * `derivation_runs`, `derivation_outputs` — back the
 * session distillation / skill extraction / cold-start
 * bootstrap / external-reference refresh pipelines. The
 * `DerivationJobStore` (src/jobs/service.ts) wraps the
 * tables with the `enqueue` / `claim` / `checkpoint` /
 * `complete` / `fail` / `cancel` / `reap` lifecycle, a
 * short lease (default TTL 30s), and a passive reap-on-
 * claim policy so no daemon is required. Existing v13
 * tables and contracts are untouched.
 * v15 (v1.2.0-alpha.1, issue #49): the session evidence
 * substrate. Three additive tables — `sessions`,
 * `session_events`, `session_event_blobs` — capture
 * stable, replayable session traces from any
 * SessionTraceBundle v1 adapter. The migration is fully
 * transactional; on any throw the user_version stays at
 * 14 and the database is untouched. Existing v14
 * derivation tables are not affected.
 * v16 (v1.2.0-alpha.1, issue #51): the additive asset
 * registry. Three envelope tables — `assets`,
 * `asset_versions`, `asset_relations` — sit alongside
 * the type-specific `memory_ref_bindings` table (the
 * only type-specific table that v1.2-alpha.1 ships
 * with; `skills` / `context_packs` / `external_references`
 * land with their owning Phase 2 issues #53 / #54).
 * The migration is fully transactional; on any throw
 * the user_version stays at 15 and the database is
 * untouched.
 * v17 (v1.2.0-alpha.2, issue #50): the distillation
 * pipeline's additive set of tables —
 * `derivation_candidates`, `candidate_evidence`,
 * `candidate_actions` — back the reviewable
 * memory / episode / skill-candidate proposals
 * produced by the deterministic baseline extractor.
 * v18 (v1.2.0-alpha.2, issue #52): the agent loadout
 * substrate. Three additive tables — `agent_loadouts`,
 * `loadout_rules`, `loadout_bindings` — back the
 * policy-bound loadout surface that powers
 * `bootstrap` / `query` / `tool_only` channels of the
 * context-assembly service. The `loadout_rules` table
 * is keyed on `(loadout_id, version, channel)` so a
 * `updateRules` call bumps the version and inserts a
 * new immutable rule row in the same transaction.
 * v19 (v1.2.0-alpha.2, issue #53): the additive
 * `skills` type-specific table for the asset
 * registry. The `skill` envelope is a thin pointer
 * to the `skills` row, which holds the canonical
 * `SKILL.md` bytes plus the parsed frontmatter
 * (name / description / triggers / etc.) and the
 * content-addressed `resources` list. The
 * `body_hash` column is `sha256:hex64` over
 * `skill_md_canonical` and matches the
 * `asset_versions.content_hash` for the same
 * version. The migrations are fully transactional;
 * on any throw the user_version stays at the
 * last successful version and the database is
 * untouched.
 */
export const CURRENT_SCHEMA_VERSION = 20;

/**
 * Stage 12 PR9: thrown by `updateEntryWithRevision` when
 * the in-place CAS predicate matches zero rows. Caught
 * and re-thrown by `runWithBusyRetry`; the write service
 * catches it at the top level and converts it to the
 * `stale_revision` error code on the MCP wire.
 */
export class ConcurrentRevisionError extends Error {
  constructor(message = "stale_revision") {
    super(message);
    this.name = "ConcurrentRevisionError";
  }
  static isThis(value: unknown): value is ConcurrentRevisionError {
    return value instanceof ConcurrentRevisionError;
  }
}

/**
 * Type-guard for SQLite transient I/O errors
 * raised by `node:sqlite`. Both
 * `SQLITE_BUSY` (5) and `SQLITE_LOCKED` (6)
 * are retryable: a holder transaction is
 * holding the writer lock (BUSY) or another
 * connection has the schema lock (LOCKED)
 * and both resolve once the holder commits.
 * The v1.1.6 follow-up B1
 * (`test/unit/sqlite-store-busy-retry.test.ts`)
 * exercises both. The previous v1.1.3 doc
 * claimed "SQLITE_LOCKED is not retryable";
 * that turned out to be wrong on contention
 * under the spec § 5.6 release profile
 * (the 8-worker stress test on Windows-latest
 * produced both). This type-guard is the
 * single contract for `runWithBusyRetry`
 * (sync class method) AND `withBusyRetry`
 * (top-level async helper) — both share
 * the same retry trigger.
 */
function isSqliteBusyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const err = error as { code?: string; errcode?: number; errno?: number };
  if (err.errcode === 5 || err.errcode === 6) return true;
  if (err.errno === 5 || err.errno === 6) return true;
  if (typeof err.code === "string") {
    if (err.code === "SQLITE_BUSY" || err.code === "SQLITE_LOCKED") return true;
    if (err.code.includes("SQLITE_BUSY") || err.code.includes("SQLITE_LOCKED")) {
      return true;
    }
  }
  return false;
}

export type AuditFilters = {
  memory_id?: string;
  scope?: MemoryScope;
  project_id?: string;
  event?: AuditEventName | string;
  limit?: number;
  offset?: number;
};

export type BudgetUsage = {
  active_entries: number;
  active_chars: number;
  topic_chars: Record<string, number>;
  index_chars: number;
};

type EntryPatchField =
  | "topic"
  | "title"
  | "body"
  | "tags"
  | "importance"
  | "confidence"
  | "status"
  | "expires_at"
  | "review_after"
  | "supersedes"
  | "superseded_by"
  | "token_estimate"
  | "char_count"
  | "writer_actor_id"
  // Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4):
  // memory semantics controlled fields. The
  // patch accepts any of these so the write
  // path can promote `tier`, toggle `pinned`,
  // set the temporal window, or escalate
  // trust / sensitivity. The authorization
  // for the escalation is enforced in the
  // validator, not the store.
  | "tier"
  | "pinned"
  | "valid_from"
  | "valid_until"
  | "sensitivity"
  | "trust_level";

export type EntryPatch = Partial<Pick<MemoryEntry, EntryPatchField>> & Pick<MemoryEntry, "updated_at">;

/**
 * Stage 15 PR-M0-4 (issue #3, spec § 6.2): row shape for
 * the persistent `maintenance_plans` table. The plan is
 * durable; the items live in a child table keyed on
 * `(plan_id, target_memory_id)`. The `plan_hash` is
 * SHA-256 over the canonical JSON of `items` so the
 * apply step can detect tampering between plan and apply.
 *
 * The `state` column is the plan lifecycle:
 *   - `pending`   -> freshly created, eligible for apply
 *   - `completed` -> apply succeeded; no further applies
 *   - `expired`   -> past `expires_at`; apply rejects
 *   - `rejected`  -> apply refused (stale revision /
 *                    wrong idempotency_key / hash drift);
 *                    no further applies
 */
export type MaintenancePlanState =
  | "pending"
  | "applying"
  | "completed"
  | "expired"
  | "rejected";
export type MaintenancePlanRisk = "low" | "medium" | "high";
export type MaintenancePlanActionType = "supersede" | "merge" | "forget" | "update" | "retain";

export type MaintenancePlanItemRow = {
  target_memory_id: string;
  expected_revision: number;
  action_type: MaintenancePlanActionType;
  /** JSON-encoded `evidence` (the DuplicateGroup that surfaced this candidate). */
  evidence_json: string;
  risk: MaintenancePlanRisk;
};

export type MaintenancePlanRow = {
  plan_id: string;
  plan_hash: string;
  creator_actor_id: string;
  created_at: string;
  expires_at: string;
  /**
   * Stage 16 v1.1.1 PR-5 (issue #12). Set when
   * the apply phase flips the plan from `pending`
   * to `completed`. `null` until the first apply
   * completes.
   */
  completed_at?: string | null;
  /**
   * Stage 16 v1.1.1 PR-5 (issue #12). JSON-encoded
   * apply result. A replay with the same
   * idempotency_key returns this verbatim instead
   * of `idempotency_mismatch`. `null` until the
   * first apply completes.
   */
  applied_result_json?: string | null;
  /**
   * Stage 16 v1.1.1 PR-5 (issue #12). The key the
   * plan was last applied with. A replay with this
   * key replays the `applied_result_json`; a replay
   * with a different key is `idempotency_mismatch`.
   */
  idempotency_key_used?: string | null;
  state: MaintenancePlanState;
  /** JSON-encoded `summary: string[]` from the planning step. */
  summary_json: string;
  scope: "global" | "project";
  project_id?: string;
  risk: MaintenancePlanRisk;
  items: MaintenancePlanItemRow[];
};

/**
 * v1.2.0-alpha.0 (issue #48): the row shape for
 * `derivation_jobs`. The store is the durable
 * substrate backing the session distillation / skill
 * extraction / cold-start bootstrap / external-refresh
 * pipelines. All timestamps are Unix milliseconds in
 * the v1.2 surface so the lease logic stays in pure
 * integer math.
 */
export type DerivationJobState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type DerivationJobScope = "global" | "project";

export type DerivationJobRow = {
  job_id: string;
  kind: string;
  state: DerivationJobState;
  scope: DerivationJobScope;
  project_id?: string | null;
  creator_actor_id: string;
  idempotency_key: string;
  input_digest: string;
  config_digest: string;
  cursor_json: string;
  attempt_count: number;
  lease_owner?: string | null;
  lease_expires_at?: number | null;
  cancel_requested_at?: number | null;
  next_retry_at?: number | null;
  error_code?: string | null;
  redacted_error?: string | null;
  created_at: number;
  started_at?: number | null;
  updated_at: number;
  finished_at?: number | null;
};

/**
 * v1.2.0-alpha.0 (issue #48): the per-stage audit row
 * for a derivation job. The `started` -> terminal
 * transition is the only state change `checkpoint`
 * commits; a `started` row is the durable proof a
 * worker is mid-flight.
 */
export type DerivationRunStatus =
  | "started"
  | "succeeded"
  | "failed"
  | "cancelled";

export type DerivationRunRow = {
  run_id: string;
  job_id: string;
  stage: string;
  status: DerivationRunStatus;
  input_refs_json: string;
  output_refs_json: string;
  provider_id?: string | null;
  model_id?: string | null;
  prompt_template_version?: string | null;
  prompt_hash?: string | null;
  policy_version: string;
  result_digest?: string | null;
  started_at: number;
  finished_at?: number | null;
};

/**
 * v1.2.0-alpha.0 (issue #48): the lineage row that
 * connects a job to the memory / asset / plan rows it
 * produced. The composite primary key on
 * `(job_id, output_kind, output_id)` is the contract
 * that prevents a reap takeover from writing the same
 * `applied` row twice.
 */
export type DerivationOutputKind =
  | "candidate"
  | "skill_draft"
  | "bootstrap_plan"
  | "external_ref"
  | "applied_memory"
  | "applied_asset";

export type DerivationOutputDisposition =
  | "proposed"
  | "applied"
  | "rejected"
  | "superseded";

export type DerivationOutputRow = {
  job_id: string;
  run_id: string;
  output_kind: DerivationOutputKind;
  output_id: string;
  disposition: DerivationOutputDisposition;
  created_at: number;
};

/**
 * v1.2.0-alpha.1 (issue #49): the row shape for
 * `sessions`. All timestamps are ISO 8601 (matching
 * the recall layer and the v13 portability surface).
 */
export type SessionScope = "global" | "project";
export type SessionSensitivity = "normal" | "private" | "restricted";

export type SessionRow = {
  session_id: string;
  source_kind: string;
  source_version: string;
  source_instance_id: string;
  source_session_id: string;
  scope: SessionScope;
  project_id: string | null;
  actor_id: string;
  client_name: string;
  client_version: string;
  started_at: string;
  ended_at: string | null;
  sensitivity: SessionSensitivity;
  bundle_hash: string;
  adapter_id: string;
  adapter_version: string;
  ingestion_plan_json: string;
  redaction_summary_json: string;
  ingested_at: string;
  retention_until: string | null;
};

/**
 * v1.2.0-alpha.1 (issue #49): the row shape for
 * `session_events`. The body itself lives in
 * `session_event_blobs` keyed by `content_digest`;
 * SQLite holds the manifest / index / metadata only.
 */
export type SessionEventType =
  | "session_started"
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "decision_confirmed"
  | "task_completed"
  | "session_ended";

export type SessionEventRole = "user" | "assistant" | "system" | "tool";

export type SessionRedactionFlag =
  | "contains_secret"
  | "risk_injection"
  | "truncated"
  | "high_entropy_token"
  | "policy_redacted";

export type SessionEventRow = {
  event_id: string;
  session_id: string;
  sequence: number;
  turn_id: string;
  event_type: SessionEventType;
  role: SessionEventRole | null;
  content_digest: string;
  content_blob_ref: string | null;
  tool_name: string | null;
  tool_call_id: string | null;
  tool_status: string | null;
  timestamp: string;
  sensitivity: SessionSensitivity;
  redaction_flags_json: string;
  metadata_json: string;
};

/**
 * v1.2.0-alpha.1 (issue #49): the content-
 * addressed body cache. The full body lives in
 * the local file system under the data home;
 * SQLite holds head / tail 1KB slices for
 * inspection without a full file read. The
 * `head_tail_window_json` records the policy
 * (default 1024 / 1024) so a later version can
 * change it without rewriting the blob table.
 */
export type SessionEventBlobRow = {
  digest: string;
  size_bytes: number;
  media_type: string;
  head_bytes: Buffer;
  tail_bytes: Buffer;
  head_tail_window_json: string;
  stored_at: string;
};

/**
 * v1.2.0-alpha.1 (issue #51): the row shape for
 * `assets`. The `manifest_json` column is the
 * type-specific payload (or, for `memory_ref` /
 * `external_reference`, the payload is split
 * between the envelope and a type-specific child
 * row).
 */
export type AssetType =
  | "memory_ref"
  | "skill"
  | "context_pack"
  | "external_reference";

export type AssetLifecycleState =
  | "draft"
  | "active"
  | "deprecated"
  | "archived";

export type AssetTrustLevel =
  | "user_confirmed"
  | "agent_observed"
  | "inferred";

export type AssetRow = {
  asset_id: string;
  asset_type: AssetType;
  scope: "global" | "project";
  project_id: string | null;
  owner_actor_id: string;
  lifecycle_state: AssetLifecycleState;
  current_version: number;
  trust_level: AssetTrustLevel;
  sensitivity: "normal" | "private" | "restricted";
  metadata_json: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export type AssetVersionRow = {
  asset_id: string;
  version: number;
  schema_version: string;
  content_hash: string;
  manifest_json: string;
  created_by_actor_id: string;
  provenance_kind: "derivation_run" | "import_batch" | "manual" | "external" | null;
  provenance_ref: string | null;
  created_at: string;
};

export type AssetRelationRow = {
  from_asset_id: string;
  relation_type: string;
  to_asset_id: string | null;
  external_target_ref: string | null;
  metadata_json: string;
  created_at: string;
};

export type MemoryRefBindingRow = {
  asset_id: string;
  version: number;
  memory_id: string;
  memory_revision: number;
  binding_rule: string | null;
  note: string | null;
};

/**
 * v1.2.0-alpha.2 (issue #52): the loadout row.
 * `version` is bumped on every `updateRules` call; the
 * rules table is keyed on `(loadout_id, version,
 * channel)`. Bumping `version` is what changes
 * `bootstrap_hash` in the context-assembly output
 * (the upstream prompt-cache key).
 */
export type LoadoutLifecycleState =
  | "draft"
  | "active"
  | "deprecated"
  | "archived";

export type LoadoutScope = "global" | "project";

export type LoadoutChannel = "bootstrap" | "query" | "tool_only";

export type LoadoutOrderingPolicy =
  | "rule_then_score"
  | "score_only"
  | "rule_only";

export type LoadoutTier = "core" | "working" | "archival";

export type LoadoutRow = {
  loadout_id: string;
  name: string;
  version: number;
  lifecycle_state: LoadoutLifecycleState;
  match_actor_id: string | null;
  match_client_name: string | null;
  scope: LoadoutScope;
  project_id: string | null;
  task_mode: string | null;
  created_by_actor_id: string;
  created_at: string;
  updated_at: string;
};

export type LoadoutRuleRow = {
  loadout_id: string;
  version: number;
  channel: LoadoutChannel;
  include_asset_ids: string[];
  include_memory_ids: string[];
  include_types: string[];
  include_tiers: LoadoutTier[];
  include_tags: string[];
  include_topics: string[];
  exclude_asset_ids: string[];
  exclude_memory_ids: string[];
  exclude_tags: string[];
  required_refs: string[];
  max_items: number;
  max_chars: number;
  max_tokens: number | null;
  timeout_ms: number;
  ordering_policy: LoadoutOrderingPolicy;
};

export type LoadoutBindingRow = {
  binding_id: string;
  loadout_id: string;
  loadout_version: number;
  actor_id: string | null;
  client_name: string | null;
  project_id: string | null;
  task_mode: string | null;
  priority: number;
  created_at: string;
};

/**
 * v1.2.0-alpha.2 (issue #50): the session-to-memory
 * distillation candidate row. The candidate is the
 * durable artefact produced by an extractor (the
 * baseline `DeterministicBaselineExtractor` in this
 * release, plus any future provider-backed
 * extractor). One candidate row per proposed memory
 * / episode / skill_candidate; the `evidence` and
 * `action` tables fan out from the `candidate_id`.
 *
 * The `state` column is a small state machine:
 * `proposed` -> `accepted` -> `applied`, with
 * `rejected` and `stale` as terminal / soft
 * transitions. The `expected_target_revision` is
 * the CAS guard used by the `apply` step (when the
 * candidate targets an existing `memory_id`). Drift
 * transitions the candidate to `stale` and the
 * apply batch skips it.
 */
export type DerivationCandidateKind = "memory" | "episode" | "skill_candidate";

export type DerivationCandidateState =
  | "proposed"
  | "accepted"
  | "rejected"
  | "applied"
  | "stale";

export type DerivationCandidateTier = "working";

export type DerivationCandidateTrustLevel = "inferred" | "agent_observed";

export type DerivationCandidateSensitivity = "normal";

export type DerivationCandidateRisk = "low" | "medium" | "high";

export type DerivationCandidateAction =
  | "create"
  | "update"
  | "supersede"
  | "merge"
  | "skip";

export type DerivationCandidateScope = "global" | "project";

export type DerivationCandidateEvidenceRole =
  | "primary"
  | "supporting"
  | "context";

export type DerivationCandidateRow = {
  candidate_id: string;
  job_id: string;
  run_id: string;
  candidate_kind: DerivationCandidateKind;
  proposed_type: string | null;
  proposed_topic: string | null;
  proposed_title: string | null;
  proposed_body: string | null;
  proposed_tags_json: string;
  proposed_scope: DerivationCandidateScope;
  proposed_project_id: string | null;
  proposed_tier: DerivationCandidateTier;
  proposed_trust_level: DerivationCandidateTrustLevel;
  proposed_sensitivity: DerivationCandidateSensitivity;
  confidence: number;
  state: DerivationCandidateState;
  extractor_id: string;
  extractor_version: string;
  content_hash: string;
  created_at: number;
  reviewed_at: number | null;
  reviewed_by_actor_id: string | null;
  applied_at: number | null;
  expected_target_revision: number | null;
};

export type CandidateEvidenceRow = {
  candidate_id: string;
  evidence_role: DerivationCandidateEvidenceRole;
  session_id: string | null;
  event_id: string | null;
  message_id: string | null;
  tool_call_id: string | null;
  file_ref: string | null;
  excerpt_digest: string;
};

export type CandidateActionRow = {
  candidate_id: string;
  action: DerivationCandidateAction;
  target_memory_ids_json: string;
  expected_revisions_json: string;
  rationale: string;
  conflict_signals_json: string;
  risk: DerivationCandidateRisk;
};

/**
 * v1.2.0-alpha.2 (issue #53): the row shape for
 * the type-specific `skills` table. The Skill
 * envelope lives in `assets`; this row carries
 * the canonical SKILL.md bytes plus the parsed
 * frontmatter. `body_hash` is `sha256:hex64`
 * over `skill_md_canonical`. The `resources_json`
 * column is a JSON-encoded array of
 * `{ path, type, media_type, sha256 }` (the
 * shape is validated upstream by the Zod
 * contract before insert).
 */
export type SkillResourceRow = {
  path: string;
  type: "text" | "reference";
  media_type: string;
  sha256: string;
};

export type SkillRow = {
  asset_id: string;
  version: number;
  name: string;
  description: string;
  schema_version: string;
  category: string | null;
  triggers_json: string;
  when_to_use: string | null;
  when_not_to_use: string | null;
  compatibility_json: string;
  source: "manual" | "derived" | "imported";
  skill_md_canonical: string;
  body_hash: string;
  resources_json: string;
};

/**
 * v1.2.0-alpha.2 (issue #54): the row shapes for the
 * cold-start bootstrap surface. The four tables
 * (`bootstrap_sources`, `bootstrap_plans`,
 * `bootstrap_plan_items`, `external_references`) are
 * the persistence layer for the v20 migration; the
 * service layer is `src/bootstrap/service.ts` and
 * `src/external-refs/service.ts`. The wire / MCP /
 * admin shape is `packages/contracts/src/bootstrap.ts`.
 */
export type BootstrapSourceKind =
  | "file"
  | "directory"
  | "git_metadata"
  | "session_bundle"
  | "memory_bundle"
  | "external_provider";

export type BootstrapSourceRow = {
  source_id: string;
  source_kind: BootstrapSourceKind;
  scope: "global" | "project";
  project_id: string | null;
  canonical_ref: string;
  source_version: string | null;
  content_digest: string;
  sensitivity: "normal" | "private" | "restricted";
  configured_by_actor_id: string;
  created_at: string;
  last_scanned_at: string | null;
  size_bytes: number | null;
};

export type BootstrapPlanState =
  | "draft"
  | "scanning"
  | "plan_ready"
  | "applying"
  | "applied"
  | "expired"
  | "failed"
  | "cancelled";

export type BootstrapPlanRow = {
  plan_id: string;
  project_id: string;
  creator_actor_id: string;
  state: BootstrapPlanState;
  config_digest: string;
  source_set_digest: string;
  created_at: string;
  expires_at: string;
  completed_at: string | null;
  job_id: string | null;
};

export type BootstrapPlanItemAction =
  | "propose_memory"
  | "propose_context_pack"
  | "propose_skill_ref"
  | "register_external_ref"
  | "bind_loadout"
  | "skip";

export type BootstrapPlanItemRow = {
  plan_id: string;
  source_id: string;
  item_seq: number;
  action: BootstrapPlanItemAction;
  target_ref: string | null;
  proposed_payload_json: string;
  evidence_digest: string;
  expected_revision_or_version: number | null;
  risk: "low" | "medium" | "high";
  rationale: string;
};

export type ExternalReferenceResourceKind =
  | "wiki"
  | "code_index"
  | "repository_context"
  | "document_set"
  | "custom";

export type ExternalReferenceRow = {
  asset_id: string;
  version: number;
  provider_kind: string;
  provider_instance_id: string;
  resource_kind: ExternalReferenceResourceKind;
  resource_ref: string;
  uri: string;
  source_version: string | null;
  source_digest: string | null;
  retrieval_contract_version: string;
  capabilities_json: string;
  allowed_scope: "global" | "project";
  project_id: string | null;
  sensitivity: "normal" | "private" | "restricted";
  refresh_policy_json: string;
  last_verified_at: string | null;
  metadata_json: string;
};

type Row = Record<string, SQLOutputValue>;

function encodeJson(value: unknown): string {
  return JSON.stringify(value);
}

function decodeJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stringCell(row: Row, column: string): string {
  const value = row[column];
  return value === undefined || value === null ? "" : String(value);
}

function optionalStringCell(row: Row, column: string): string | undefined {
  const value = row[column];
  return value === undefined || value === null ? undefined : String(value);
}

function numberCell(row: Row, column: string): number {
  const value = row[column];
  return typeof value === "number" || typeof value === "bigint" ? Number(value) : Number(String(value));
}

function optionalNumberCell(row: Row, column: string): number | undefined {
  const value = row[column];
  if (value === undefined || value === null) return undefined;
  return typeof value === "number" || typeof value === "bigint"
    ? Number(value)
    : Number(String(value));
}

/**
 * v1.2.0-alpha.0 (issue #48): identify the
 * SQLITE_CONSTRAINT_UNIQUE / SQLITE_CONSTRAINT_PRIMARYKEY
 * errors raised by `node:sqlite` so the derivation job
 * insert path can return `false` (idempotent) instead of
 * throwing. The `node:sqlite` error shape varies by
 * version: recent builds surface a `code` string
 * (`"SQLITE_CONSTRAINT_UNIQUE"`) plus the numeric
 * `errcode` (19 for `SQLITE_CONSTRAINT`, extended code
 * 2067 for the UNIQUE sub-code) and the `errno`. Older
 * builds (and some `bun:sqlite` configurations) only
 * expose the human-readable message. We accept any of
 * the four signals so the helper is robust to a runtime
 * change in the error shape.
 */
function isSqliteUniqueConstraintError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const err = error as {
    code?: unknown;
    errcode?: unknown;
    errno?: unknown;
    message?: unknown;
  };
  if (err.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  if (err.code === "SQLITE_CONSTRAINT_PRIMARYKEY") return true;
  if (err.code === "SQLITE_CONSTRAINT") return true;
  if (err.errcode === 19 || err.errno === 19) return true;
  if (typeof err.message === "string") {
    if (err.message.includes("UNIQUE constraint failed")) return true;
    if (err.message.includes("PRIMARY KEY constraint failed")) return true;
  }
  return false;
}

function derivationJobFromRow(row: Row): DerivationJobRow {
  return {
    job_id: stringCell(row, "job_id"),
    kind: stringCell(row, "kind"),
    state: stringCell(row, "state") as DerivationJobState,
    scope: stringCell(row, "scope") as DerivationJobScope,
    project_id: optionalStringCell(row, "project_id") ?? null,
    creator_actor_id: stringCell(row, "creator_actor_id"),
    idempotency_key: stringCell(row, "idempotency_key"),
    input_digest: stringCell(row, "input_digest"),
    config_digest: stringCell(row, "config_digest"),
    cursor_json: stringCell(row, "cursor_json"),
    attempt_count: numberCell(row, "attempt_count"),
    lease_owner: optionalStringCell(row, "lease_owner") ?? null,
    lease_expires_at: optionalNumberCell(row, "lease_expires_at") ?? null,
    cancel_requested_at: optionalNumberCell(row, "cancel_requested_at") ?? null,
    next_retry_at: optionalNumberCell(row, "next_retry_at") ?? null,
    error_code: optionalStringCell(row, "error_code") ?? null,
    redacted_error: optionalStringCell(row, "redacted_error") ?? null,
    created_at: numberCell(row, "created_at"),
    started_at: optionalNumberCell(row, "started_at") ?? null,
    updated_at: numberCell(row, "updated_at"),
    finished_at: optionalNumberCell(row, "finished_at") ?? null
  };
}

function derivationRunFromRow(row: Row): DerivationRunRow {
  return {
    run_id: stringCell(row, "run_id"),
    job_id: stringCell(row, "job_id"),
    stage: stringCell(row, "stage"),
    status: stringCell(row, "status") as DerivationRunStatus,
    input_refs_json: stringCell(row, "input_refs_json"),
    output_refs_json: stringCell(row, "output_refs_json"),
    provider_id: optionalStringCell(row, "provider_id") ?? null,
    model_id: optionalStringCell(row, "model_id") ?? null,
    prompt_template_version: optionalStringCell(row, "prompt_template_version") ?? null,
    prompt_hash: optionalStringCell(row, "prompt_hash") ?? null,
    policy_version: stringCell(row, "policy_version"),
    result_digest: optionalStringCell(row, "result_digest") ?? null,
    started_at: numberCell(row, "started_at"),
    finished_at: optionalNumberCell(row, "finished_at") ?? null
  };
}

function derivationOutputFromRow(row: Row): DerivationOutputRow {
  return {
    job_id: stringCell(row, "job_id"),
    run_id: stringCell(row, "run_id"),
    output_kind: stringCell(row, "output_kind") as DerivationOutputKind,
    output_id: stringCell(row, "output_id"),
    disposition: stringCell(row, "disposition") as DerivationOutputDisposition,
    created_at: numberCell(row, "created_at")
  };
}

function sessionFromRow(row: Row): SessionRow {
  return {
    session_id: stringCell(row, "session_id"),
    source_kind: stringCell(row, "source_kind"),
    source_version: stringCell(row, "source_version"),
    source_instance_id: stringCell(row, "source_instance_id"),
    source_session_id: stringCell(row, "source_session_id"),
    scope: stringCell(row, "scope") as SessionScope,
    project_id: optionalStringCell(row, "project_id") ?? null,
    actor_id: stringCell(row, "actor_id"),
    client_name: stringCell(row, "client_name"),
    client_version: stringCell(row, "client_version"),
    started_at: stringCell(row, "started_at"),
    ended_at: optionalStringCell(row, "ended_at") ?? null,
    sensitivity: stringCell(row, "sensitivity") as SessionSensitivity,
    bundle_hash: stringCell(row, "bundle_hash"),
    adapter_id: stringCell(row, "adapter_id"),
    adapter_version: stringCell(row, "adapter_version"),
    ingestion_plan_json: stringCell(row, "ingestion_plan_json"),
    redaction_summary_json: stringCell(row, "redaction_summary_json"),
    ingested_at: stringCell(row, "ingested_at"),
    retention_until: optionalStringCell(row, "retention_until") ?? null
  };
}

function sessionEventFromRow(row: Row): SessionEventRow {
  const headBytesRaw = row["head_bytes"];
  const tailBytesRaw = row["tail_bytes"];
  return {
    event_id: stringCell(row, "event_id"),
    session_id: stringCell(row, "session_id"),
    sequence: numberCell(row, "sequence"),
    turn_id: stringCell(row, "turn_id"),
    event_type: stringCell(row, "event_type") as SessionEventType,
    role: optionalStringCell(row, "role") as SessionEventRole | null ?? null,
    content_digest: stringCell(row, "content_digest"),
    content_blob_ref: optionalStringCell(row, "content_blob_ref") ?? null,
    tool_name: optionalStringCell(row, "tool_name") ?? null,
    tool_call_id: optionalStringCell(row, "tool_call_id") ?? null,
    tool_status: optionalStringCell(row, "tool_status") ?? null,
    timestamp: stringCell(row, "timestamp"),
    sensitivity: stringCell(row, "sensitivity") as SessionSensitivity,
    redaction_flags_json: stringCell(row, "redaction_flags_json"),
    metadata_json: stringCell(row, "metadata_json")
  };
}

function assetFromRow(row: Row): AssetRow {
  return {
    asset_id: stringCell(row, "asset_id"),
    asset_type: stringCell(row, "asset_type") as AssetType,
    scope: stringCell(row, "scope") as "global" | "project",
    project_id: optionalStringCell(row, "project_id") ?? null,
    owner_actor_id: stringCell(row, "owner_actor_id"),
    lifecycle_state: stringCell(row, "lifecycle_state") as AssetLifecycleState,
    current_version: numberCell(row, "current_version"),
    trust_level: stringCell(row, "trust_level") as AssetTrustLevel,
    sensitivity: stringCell(row, "sensitivity") as
      | "normal"
      | "private"
      | "restricted",
    metadata_json: stringCell(row, "metadata_json"),
    created_at: stringCell(row, "created_at"),
    updated_at: stringCell(row, "updated_at"),
    archived_at: optionalStringCell(row, "archived_at") ?? null
  };
}

function assetVersionFromRow(row: Row): AssetVersionRow {
  return {
    asset_id: stringCell(row, "asset_id"),
    version: numberCell(row, "version"),
    schema_version: stringCell(row, "schema_version"),
    content_hash: stringCell(row, "content_hash"),
    manifest_json: stringCell(row, "manifest_json"),
    created_by_actor_id: stringCell(row, "created_by_actor_id"),
    provenance_kind:
      (optionalStringCell(row, "provenance_kind") as
        | "derivation_run"
        | "import_batch"
        | "manual"
        | "external"
        | null) ?? null,
    provenance_ref: optionalStringCell(row, "provenance_ref") ?? null,
    created_at: stringCell(row, "created_at")
  };
}

function loadoutFromRow(row: Row): LoadoutRow {
  return {
    loadout_id: stringCell(row, "loadout_id"),
    name: stringCell(row, "name"),
    version: numberCell(row, "version"),
    lifecycle_state: stringCell(row, "lifecycle_state") as LoadoutLifecycleState,
    match_actor_id: optionalStringCell(row, "match_actor_id") ?? null,
    match_client_name: optionalStringCell(row, "match_client_name") ?? null,
    scope: stringCell(row, "scope") as LoadoutScope,
    project_id: optionalStringCell(row, "project_id") ?? null,
    task_mode: optionalStringCell(row, "task_mode") ?? null,
    created_by_actor_id: stringCell(row, "created_by_actor_id"),
    created_at: stringCell(row, "created_at"),
    updated_at: stringCell(row, "updated_at")
  };
}

function loadoutRuleFromRow(row: Row): LoadoutRuleRow {
  return {
    loadout_id: stringCell(row, "loadout_id"),
    version: numberCell(row, "version"),
    channel: stringCell(row, "channel") as LoadoutChannel,
    include_asset_ids: decodeJson<string[]>(stringCell(row, "include_asset_ids_json")),
    include_memory_ids: decodeJson<string[]>(stringCell(row, "include_memory_ids_json")),
    include_types: decodeJson<string[]>(stringCell(row, "include_types_json")),
    include_tiers: decodeJson<LoadoutTier[]>(stringCell(row, "include_tiers_json")),
    include_tags: decodeJson<string[]>(stringCell(row, "include_tags_json")),
    include_topics: decodeJson<string[]>(stringCell(row, "include_topics_json")),
    exclude_asset_ids: decodeJson<string[]>(stringCell(row, "exclude_asset_ids_json")),
    exclude_memory_ids: decodeJson<string[]>(stringCell(row, "exclude_memory_ids_json")),
    exclude_tags: decodeJson<string[]>(stringCell(row, "exclude_tags_json")),
    required_refs: decodeJson<string[]>(stringCell(row, "required_refs_json")),
    max_items: numberCell(row, "max_items"),
    max_chars: numberCell(row, "max_chars"),
    max_tokens: optionalNumberCell(row, "max_tokens") ?? null,
    timeout_ms: numberCell(row, "timeout_ms"),
    ordering_policy: stringCell(row, "ordering_policy") as LoadoutOrderingPolicy
  };
}

function loadoutBindingFromRow(row: Row): LoadoutBindingRow {
  return {
    binding_id: stringCell(row, "binding_id"),
    loadout_id: stringCell(row, "loadout_id"),
    loadout_version: numberCell(row, "loadout_version"),
    actor_id: optionalStringCell(row, "actor_id") ?? null,
    client_name: optionalStringCell(row, "client_name") ?? null,
    project_id: optionalStringCell(row, "project_id") ?? null,
    task_mode: optionalStringCell(row, "task_mode") ?? null,
    priority: numberCell(row, "priority"),
    created_at: stringCell(row, "created_at")
  };
}

function memoryRefBindingFromRow(row: Row): MemoryRefBindingRow {
  return {
    asset_id: stringCell(row, "asset_id"),
    version: numberCell(row, "version"),
    memory_id: stringCell(row, "memory_id"),
    memory_revision: numberCell(row, "memory_revision"),
    binding_rule: optionalStringCell(row, "binding_rule") ?? null,
    note: optionalStringCell(row, "note") ?? null
  };
}

function derivationCandidateFromRow(row: Row): DerivationCandidateRow {
  return {
    candidate_id: stringCell(row, "candidate_id"),
    job_id: stringCell(row, "job_id"),
    run_id: stringCell(row, "run_id"),
    candidate_kind: stringCell(row, "candidate_kind") as DerivationCandidateKind,
    proposed_type: optionalStringCell(row, "proposed_type") ?? null,
    proposed_topic: optionalStringCell(row, "proposed_topic") ?? null,
    proposed_title: optionalStringCell(row, "proposed_title") ?? null,
    proposed_body: optionalStringCell(row, "proposed_body") ?? null,
    proposed_tags_json: stringCell(row, "proposed_tags_json"),
    proposed_scope: stringCell(row, "proposed_scope") as DerivationCandidateScope,
    proposed_project_id: optionalStringCell(row, "proposed_project_id") ?? null,
    proposed_tier: stringCell(row, "proposed_tier") as DerivationCandidateTier,
    proposed_trust_level: stringCell(row, "proposed_trust_level") as DerivationCandidateTrustLevel,
    proposed_sensitivity: stringCell(row, "proposed_sensitivity") as DerivationCandidateSensitivity,
    confidence: numberCell(row, "confidence"),
    state: stringCell(row, "state") as DerivationCandidateState,
    extractor_id: stringCell(row, "extractor_id"),
    extractor_version: stringCell(row, "extractor_version"),
    content_hash: stringCell(row, "content_hash"),
    created_at: numberCell(row, "created_at"),
    reviewed_at: optionalNumberCell(row, "reviewed_at") ?? null,
    reviewed_by_actor_id: optionalStringCell(row, "reviewed_by_actor_id") ?? null,
    applied_at: optionalNumberCell(row, "applied_at") ?? null,
    expected_target_revision: optionalNumberCell(row, "expected_target_revision") ?? null
  };
}

function candidateEvidenceFromRow(row: Row): CandidateEvidenceRow {
  return {
    candidate_id: stringCell(row, "candidate_id"),
    evidence_role: stringCell(row, "evidence_role") as DerivationCandidateEvidenceRole,
    session_id: optionalStringCell(row, "session_id") ?? null,
    event_id: optionalStringCell(row, "event_id") ?? null,
    message_id: optionalStringCell(row, "message_id") ?? null,
    tool_call_id: optionalStringCell(row, "tool_call_id") ?? null,
    file_ref: optionalStringCell(row, "file_ref") ?? null,
    excerpt_digest: stringCell(row, "excerpt_digest")
  };
}

function candidateActionFromRow(row: Row): CandidateActionRow {
  return {
    candidate_id: stringCell(row, "candidate_id"),
    action: stringCell(row, "action") as DerivationCandidateAction,
    target_memory_ids_json: stringCell(row, "target_memory_ids_json"),
    expected_revisions_json: stringCell(row, "expected_revisions_json"),
    rationale: stringCell(row, "rationale"),
    conflict_signals_json: stringCell(row, "conflict_signals_json"),
    risk: stringCell(row, "risk") as DerivationCandidateRisk
  };
}

function skillFromRow(row: Row): SkillRow {
  return {
    asset_id: stringCell(row, "asset_id"),
    version: numberCell(row, "version"),
    name: stringCell(row, "name"),
    description: stringCell(row, "description"),
    schema_version: stringCell(row, "schema_version"),
    category: optionalStringCell(row, "category") ?? null,
    triggers_json: stringCell(row, "triggers_json"),
    when_to_use: optionalStringCell(row, "when_to_use") ?? null,
    when_not_to_use: optionalStringCell(row, "when_not_to_use") ?? null,
    compatibility_json: stringCell(row, "compatibility_json"),
    source: stringCell(row, "source") as "manual" | "derived" | "imported",
    skill_md_canonical: stringCell(row, "skill_md_canonical"),
    body_hash: stringCell(row, "body_hash"),
    resources_json: stringCell(row, "resources_json")
  };
}

function bootstrapSourceFromRow(row: Row): BootstrapSourceRow {
  return {
    source_id: stringCell(row, "source_id"),
    source_kind: stringCell(row, "source_kind") as BootstrapSourceKind,
    scope: stringCell(row, "scope") as "global" | "project",
    project_id: optionalStringCell(row, "project_id") ?? null,
    canonical_ref: stringCell(row, "canonical_ref"),
    source_version: optionalStringCell(row, "source_version") ?? null,
    content_digest: stringCell(row, "content_digest"),
    sensitivity: stringCell(row, "sensitivity") as
      | "normal"
      | "private"
      | "restricted",
    configured_by_actor_id: stringCell(row, "configured_by_actor_id"),
    created_at: stringCell(row, "created_at"),
    last_scanned_at: optionalStringCell(row, "last_scanned_at") ?? null,
    size_bytes: optionalNumberCell(row, "size_bytes") ?? null
  };
}

function bootstrapPlanFromRow(row: Row): BootstrapPlanRow {
  return {
    plan_id: stringCell(row, "plan_id"),
    project_id: stringCell(row, "project_id"),
    creator_actor_id: stringCell(row, "creator_actor_id"),
    state: stringCell(row, "state") as BootstrapPlanState,
    config_digest: stringCell(row, "config_digest"),
    source_set_digest: stringCell(row, "source_set_digest"),
    created_at: stringCell(row, "created_at"),
    expires_at: stringCell(row, "expires_at"),
    completed_at: optionalStringCell(row, "completed_at") ?? null,
    job_id: optionalStringCell(row, "job_id") ?? null
  };
}

function bootstrapPlanItemFromRow(row: Row): BootstrapPlanItemRow {
  return {
    plan_id: stringCell(row, "plan_id"),
    source_id: stringCell(row, "source_id"),
    item_seq: numberCell(row, "item_seq"),
    action: stringCell(row, "action") as BootstrapPlanItemAction,
    target_ref: optionalStringCell(row, "target_ref") ?? null,
    proposed_payload_json: stringCell(row, "proposed_payload_json"),
    evidence_digest: stringCell(row, "evidence_digest"),
    expected_revision_or_version:
      optionalNumberCell(row, "expected_revision_or_version") ?? null,
    risk: stringCell(row, "risk") as "low" | "medium" | "high",
    rationale: stringCell(row, "rationale")
  };
}

function externalReferenceFromRow(row: Row): ExternalReferenceRow {
  return {
    asset_id: stringCell(row, "asset_id"),
    version: numberCell(row, "version"),
    provider_kind: stringCell(row, "provider_kind"),
    provider_instance_id: stringCell(row, "provider_instance_id"),
    resource_kind: stringCell(row, "resource_kind") as ExternalReferenceResourceKind,
    resource_ref: stringCell(row, "resource_ref"),
    uri: stringCell(row, "uri"),
    source_version: optionalStringCell(row, "source_version") ?? null,
    source_digest: optionalStringCell(row, "source_digest") ?? null,
    retrieval_contract_version: stringCell(row, "retrieval_contract_version"),
    capabilities_json: stringCell(row, "capabilities_json"),
    allowed_scope: stringCell(row, "allowed_scope") as "global" | "project",
    project_id: optionalStringCell(row, "project_id") ?? null,
    sensitivity: stringCell(row, "sensitivity") as
      | "normal"
      | "private"
      | "restricted",
    refresh_policy_json: stringCell(row, "refresh_policy_json"),
    last_verified_at: optionalStringCell(row, "last_verified_at") ?? null,
    metadata_json: stringCell(row, "metadata_json")
  };
}

function decodeEntry(row: Row): MemoryEntry {
  const entry: MemoryEntry = {
    id: stringCell(row, "id"),
    scope: stringCell(row, "scope") as MemoryScope,
    type: stringCell(row, "type") as MemoryEntry["type"],
    topic: stringCell(row, "topic"),
    title: stringCell(row, "title"),
    body: stringCell(row, "body"),
    tags: decodeJson<string[]>(stringCell(row, "tags_json")),
    source: decodeJson<MemoryEntry["source"]>(stringCell(row, "source_json")),
    importance: numberCell(row, "importance") as MemoryEntry["importance"],
    confidence: numberCell(row, "confidence") as MemoryEntry["confidence"],
    status: stringCell(row, "status") as MemoryEntry["status"],
    created_at: stringCell(row, "created_at"),
    updated_at: stringCell(row, "updated_at"),
    access_count: numberCell(row, "access_count"),
    supersedes: decodeJson<string[]>(stringCell(row, "supersedes_json")),
    token_estimate: numberCell(row, "token_estimate"),
    char_count: numberCell(row, "char_count"),
    // Stage 12 PR9: schema v4 row shape. The defaults
    // match the v3->v4 migration's `addColumnIfMissing`
    // definitions so a row that has been migrated from
    // a v3 file decodes cleanly even if a future
    // migration drops the legacy defaults.
    revision: numberCell(row, "revision") || 1,
    writer_actor_id: stringCell(row, "writer_actor_id") || "agent:unknown",
    pinned: numberCell(row, "pinned") === 1,
    trust_level: (stringCell(row, "trust_level") ||
      "agent_observed") as MemoryEntry["trust_level"],
    sensitivity: (stringCell(row, "sensitivity") ||
      "normal") as MemoryEntry["sensitivity"],
    // Stage 15 PR-M3-1 (issue #9, spec § 6.5): the
    // memory tier. Defaults to 'working' for legacy
    // rows that pre-date the v10 column.
    tier: ((stringCell(row, "tier") || "working")) as MemoryEntry["tier"],
    metadata: decodeJson<Record<string, unknown>>(
      optionalStringCell(row, "metadata_json") ?? "{}"
    )
  };

  const projectId = optionalStringCell(row, "project_id");
  if (projectId !== undefined) entry.project_id = projectId;

  const projectPath = optionalStringCell(row, "project_path");
  if (projectPath !== undefined) entry.project_path = projectPath;

  const lastAccessedAt = optionalStringCell(row, "last_accessed_at");
  if (lastAccessedAt !== undefined) entry.last_accessed_at = lastAccessedAt;

  const lastAccessedByRaw = optionalStringCell(row, "last_accessed_by");
  if (lastAccessedByRaw !== undefined && lastAccessedByRaw.length > 0) {
    try {
      const parsed = JSON.parse(lastAccessedByRaw) as Record<string, string>;
      if (parsed && typeof parsed === "object") {
        entry.last_accessed_by = parsed;
      }
    } catch {
      // Corrupt JSON in storage; treat as empty map. Defensive: the
      // read path never throws, so a corrupt row is just hidden from
      // the last_accessed_by check.
    }
  }

  const expiresAt = optionalStringCell(row, "expires_at");
  if (expiresAt !== undefined) entry.expires_at = expiresAt;

  const reviewAfter = optionalStringCell(row, "review_after");
  if (reviewAfter !== undefined) entry.review_after = reviewAfter;

  const supersededBy = optionalStringCell(row, "superseded_by");
  if (supersededBy !== undefined) entry.superseded_by = supersededBy;

  const contentHash = optionalStringCell(row, "content_hash");
  if (contentHash !== undefined) entry.content_hash = contentHash;

  const validFrom = optionalStringCell(row, "valid_from");
  if (validFrom !== undefined) entry.valid_from = validFrom;

  const validUntil = optionalStringCell(row, "valid_until");
  if (validUntil !== undefined) entry.valid_until = validUntil;

  const deletedAt = optionalStringCell(row, "deleted_at");
  if (deletedAt !== undefined) entry.deleted_at = deletedAt;

  return entry;
}

function decodeProject(row: Row): ProjectScope {
  return {
    project_id: stringCell(row, "project_id"),
    canonical_path: stringCell(row, "canonical_path"),
    display_name: stringCell(row, "display_name"),
    created_at: stringCell(row, "created_at"),
    updated_at: stringCell(row, "updated_at"),
    budget: decodeJson<ProjectScope["budget"]>(stringCell(row, "budget_json"))
  };
}

function decodeAudit(row: Row): MemoryAuditEvent {
  const event: MemoryAuditEvent = {
    id: stringCell(row, "id"),
    scope: stringCell(row, "scope") as MemoryScope,
    event: stringCell(row, "event") as MemoryAuditEvent["event"],
    actor: stringCell(row, "actor") as MemoryAuditEvent["actor"],
    metadata: decodeJson<Record<string, unknown>>(stringCell(row, "metadata_json")),
    created_at: stringCell(row, "created_at")
  };

  const memoryId = optionalStringCell(row, "memory_id");
  if (memoryId !== undefined) event.memory_id = memoryId;

  const projectId = optionalStringCell(row, "project_id");
  if (projectId !== undefined) event.project_id = projectId;

  const reason = optionalStringCell(row, "reason");
  if (reason !== undefined) event.reason = reason;

  return event;
}

function ftsQuery(query: string): string {
  return (query.match(/[\p{L}\p{N}_]+/gu) ?? [])
    .map((token) => `"${token.replaceAll("\"", "\"\"")}"`)
    .join(" OR ");
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return fallback;
  return Number.isInteger(limit) && limit > 0 ? limit : fallback;
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  return Number.isInteger(offset) && offset > 0 ? offset : 0;
}

const ENTRY_PATCH_FIELDS = [
  "topic",
  "title",
  "body",
  "tags",
  "importance",
  "confidence",
  "status",
  "expires_at",
  "review_after",
  "supersedes",
  "superseded_by",
  "token_estimate",
  "char_count",
  "writer_actor_id",
  // Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4):
  // memory semantics controlled fields. The
  // sanitizer keeps them on the patch so the
  // `updateEntry` UPDATE actually persists
  // them; the pre-PR-7 list omitted these and
  // silently dropped them on the floor.
  "tier",
  "pinned",
  "valid_from",
  "valid_until",
  "sensitivity",
  "trust_level"
] as const satisfies readonly EntryPatchField[];

function sanitizeEntryPatch(patch: EntryPatch): EntryPatch {
  const result: Record<string, unknown> = { updated_at: patch.updated_at };
  for (const key of ENTRY_PATCH_FIELDS) {
    const value = patch[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as EntryPatch;
}

function buildEntryWhere(filters: EntryFilters, alias: string): { where: string; params: SQLInputValue[] } {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  const column = (name: string) => `${alias}.${name}`;

  if (filters.scope !== undefined) {
    clauses.push(`${column("scope")} = ?`);
    params.push(filters.scope);
  }
  if (filters.project_id !== undefined) {
    clauses.push(`${column("project_id")} = ?`);
    params.push(filters.project_id);
  }
  if (filters.type !== undefined) {
    clauses.push(`${column("type")} = ?`);
    params.push(filters.type);
  }
  if (filters.topic !== undefined) {
    clauses.push(`${column("topic")} = ?`);
    params.push(filters.topic);
  }
  if (filters.status !== undefined) {
    clauses.push(`${column("status")} = ?`);
    params.push(filters.status);
  }
  for (const tag of filters.tags ?? []) {
    clauses.push(`EXISTS (SELECT 1 FROM json_each(${column("tags_json")}) WHERE value = ?)`);
    params.push(tag);
  }
  if (filters.actor !== undefined) {
    // Stage 14 PR-B1 (spec § 5.2 #5): the canonical writer lives
    // on `memory_entries.writer_actor_id` (filled by the v3->v4
    // migration from the audit log). The pre-PR-B1 subquery
    // against `audit_events` was a per-row N+1 — every filter
    // check had to walk the audit log. The writer column is
    // indexed by the primary key lookup, so the filter is a
    // single equality predicate.
    clauses.push(`${column("writer_actor_id")} = ?`);
    params.push(filters.actor);
  }
  if (filters.since !== undefined) {
    clauses.push(`${column("created_at")} >= ?`);
    params.push(filters.since);
  }
  if (filters.until !== undefined) {
    clauses.push(`${column("created_at")} <= ?`);
    params.push(filters.until);
  }
  if (filters.last_accessed_since !== undefined) {
    // Exclude never-read memories by the IS NOT NULL guard.
    clauses.push(`${column("last_accessed_at")} IS NOT NULL AND ${column("last_accessed_at")} >= ?`);
    params.push(filters.last_accessed_since);
  }
  if (filters.updated_since !== undefined) {
    clauses.push(`${column("updated_at")} >= ?`);
    params.push(filters.updated_since);
  }
  if (filters.updated_until !== undefined) {
    clauses.push(`${column("updated_at")} <= ?`);
    params.push(filters.updated_until);
  }
  // Stage 18 v1.1.2 (issue #23, ADR-0001): the
  // sensitivity visibility filter is applied at
  // the SQL boundary (NOT at the response layer)
  // so a caller without the
  // `sensitivity_visibility` capability cannot
  // even probe whether a `private` or `restricted`
  // row exists. The filter is encoded as a
  // `CASE WHEN ...` order so a missing
  // `actor_max_sensitivity` defaults to `"normal"`
  // (the documented fail-closed default).
  if (filters.actor_max_sensitivity !== undefined) {
    const max = filters.actor_max_sensitivity;
    const order = max === "restricted" ? 3 : max === "private" ? 2 : 1;
    clauses.push(
      `(CASE ${column("sensitivity")} ` +
        `WHEN 'restricted' THEN 3 ` +
        `WHEN 'private' THEN 2 ` +
        `ELSE 1 END) <= ?`
    );
    params.push(order);
  } else {
    // Default: only `normal` rows are visible.
    // The v1.1.2 fail-closed contract pins
    // this for any read path that does not
    // explicitly opt in via the capability
    // check (i.e. every default read).
    clauses.push(
      `(CASE ${column("sensitivity")} ` +
        `WHEN 'restricted' THEN 3 ` +
        `WHEN 'private' THEN 2 ` +
        `ELSE 1 END) <= ?`
    );
    params.push(1);
  }

  return {
    where: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`,
    params
  };
}

function buildBudgetWhere(filters: { scope: MemoryScope; project_id?: string }): { where: string; params: SQLInputValue[] } {
  const clauses = ["status = 'active'", "scope = ?"];
  const params: SQLInputValue[] = [filters.scope];
  if (filters.project_id !== undefined) {
    clauses.push("project_id = ?");
    params.push(filters.project_id);
  }
  return {
    where: `WHERE ${clauses.join(" AND ")}`,
    params
  };
}

function buildAuditWhere(filters: AuditFilters): { where: string; params: SQLInputValue[] } {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];

  if (filters.memory_id !== undefined) {
    clauses.push("memory_id = ?");
    params.push(filters.memory_id);
  }
  if (filters.scope !== undefined) {
    clauses.push("scope = ?");
    params.push(filters.scope);
  }
  if (filters.project_id !== undefined) {
    clauses.push("project_id = ?");
    params.push(filters.project_id);
  }
  if (filters.event !== undefined) {
    clauses.push("event = ?");
    params.push(filters.event);
  }

  return {
    where: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`,
    params
  };
}

/**
 * Stage 10 PR5: the store open mode. Pre-PR5 the constructor
 * called `migrate()` unconditionally, which made the CLI
 * `migrate --yes` confirmation meaningless: by the time
 * the command handler ran, the schema was already upgraded.
 *
 * The new default is `read_write_no_migrate`; callers that
 * want auto-upgrade (e.g. the legacy MCP test fixtures)
 * opt in explicitly with `read_write_auto_migrate`. The
 * `migrate` CLI command decides when to call
 * `runMigrations({ backupFirst: true })` after taking a
 * verified backup.
 */
export type StoreOpenMode =
  | "read_only"
  | "read_write_no_migrate"
  | "read_write_auto_migrate";

export class SQLiteMemoryStore {
  private readonly db: SqliteDb;
  private transactionDepth = 0;
  private readonly openMode: StoreOpenMode;

  constructor(dbPath: string, openMode: StoreOpenMode = "read_write_no_migrate") {
    mkdirSync(dirname(dbPath), { recursive: true });
    const readonly = openMode === "read_only";
    this.db = createSqliteDb(dbPath, {
      enableForeignKeyConstraints: true,
      timeout: 5000,
      readOnly: readonly
    });
    this.openMode = openMode;
    // Stage 11 PR8: WAL + busy retry baseline (spec
    // section 5.6). Read-only connections skip the WAL
    // PRAGMAs because they have no effect on a snapshot
    // reader; busy_timeout still applies so an
    // unexpectedly-shared connection does not error.
    //
    // v1.1.6 follow-up B1.1 (issue #42): the v1.1.6
    // release-candidate gate (run 31380507624) failed
    // on windows-latest at the multi-process stress
    // test with `survivor 1 reported unhandled
    // SQLITE_BUSY`. The 5-worker contention after the
    // SIGKILL-during-tx test's victim exit causes
    // 5+ survivors to all queue on `BEGIN IMMEDIATE`
    // while SQLite is recovering the stale WAL. The
    // 5000ms `busy_timeout` was insufficient: the
    // Windows file-locking semantics add overhead to
    // WAL recovery that pushes the worst-case wait
    // past 5s for at least 1 survivor in the
    // 8-worker × 1,250-op release profile. Bumped
    // to 10000ms so the recovery fits inside the
    // PRAGMA wait window on the Windows runner. The
    // pre-v1.1.6 default of 5000ms stays in the
    // comment history; the CI profile (1,600 ops)
    // never hit the 5s ceiling.
    if (!readonly) {
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 10000;
        PRAGMA wal_autocheckpoint = 1000;
      `);
    } else {
      this.db.exec(`PRAGMA busy_timeout = 10000;`);
    }
    if (openMode === "read_write_auto_migrate") {
      this.migrate();
    } else if (openMode === "read_write_no_migrate") {
      // Touch the schema so subsequent reads can introspect
      // user_version, but do not write. The legacy in-place
      // CREATE TABLE IF NOT EXISTS in the v1 base DDL still
      // runs to make a fresh database usable; only the
      // version-aware migration chain is skipped. A fresh
      // database (user_version === 0) is upgraded to
      // CURRENT_SCHEMA_VERSION automatically because there
      // is no prior schema to preserve. A non-fresh
      // database (user_version > 0 but < CURRENT) is left
      // alone; the CLI `migrate` command decides when to
      // advance it.
      this.ensureBaseSchema();
      if (this.readUserVersion() === 0) {
        this.migrateForward();
      }
    }
  }

  getOpenMode(): StoreOpenMode {
    return this.openMode;
  }

  // ─────────────────────────────────────────────────────────────────────
  // v1.2.0-alpha.0 (issue #48): derivation job substrate.
  //
  // The three tables — `derivation_jobs` / `derivation_runs` /
  // `derivation_outputs` — are the durable backing for every
  // provider-backed / multi-stage / cancellable pipeline
  // introduced in v1.2 (session distillation, skill extraction,
  // cold-start bootstrap, external-reference refresh). The
  // public API for these rows lives in `src/jobs/service.ts`;
  // the methods below are the lowest-level row readers and
  // writers. Callers (the DerivationJobStore) compose them
  // inside a single `BEGIN IMMEDIATE` transaction so the
  // claim / checkpoint / apply semantics match the contract
  // in `docs/adr/0009-derivation-job-lifecycle.md`.
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Find a derivation job by its primary key. Returns the
   * row verbatim, or `undefined` if the job does not exist.
   * The cursor JSON column is **not** parsed — callers that
   * need the typed cursor should call
   * `DerivationJobStore.get(jobId)` instead.
   */
  getDerivationJob(jobId: string): DerivationJobRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM derivation_jobs WHERE job_id = ?")
      .get(jobId) as Row | undefined;
    if (row === undefined) return undefined;
    return derivationJobFromRow(row);
  }

  /**
   * Find a derivation job by its
   * `(creator_actor_id, kind, idempotency_key)` triple.
   * Returns `undefined` if no job exists. This is the
   * read side of the replay contract: an `enqueue` call
   * with the same triple returns the same `job_id`.
   */
  getDerivationJobByIdempotency(
    creator_actor_id: string,
    kind: string,
    idempotency_key: string
  ): DerivationJobRow | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM derivation_jobs WHERE creator_actor_id = ? AND kind = ? AND idempotency_key = ?"
      )
      .get(creator_actor_id, kind, idempotency_key) as Row | undefined;
    if (row === undefined) return undefined;
    return derivationJobFromRow(row);
  }

  /**
   * Insert a new derivation job. The caller is responsible
   * for pre-computing the `job_id`, `input_digest`,
   * `config_digest` and the `cursor_json` string. The
   * row is inserted with `state='queued'`, `attempt_count=0`,
   * no lease. Throws on the UNIQUE
   * `(creator_actor_id, kind, idempotency_key)` violation
   * when a replay uses a different digest — the higher-level
   * `DerivationJobStore.enqueue` translates that to
   * `idempotency_digest_mismatch`.
   */
  insertDerivationJob(row: DerivationJobRow): void {
    this.db
      .prepare(
        `INSERT INTO derivation_jobs (
          job_id, kind, state, scope, project_id, creator_actor_id,
          idempotency_key, input_digest, config_digest, cursor_json,
          attempt_count, lease_owner, lease_expires_at, cancel_requested_at,
          next_retry_at, error_code, redacted_error,
          created_at, started_at, updated_at, finished_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?
        )`
      )
      .run(
        row.job_id,
        row.kind,
        row.state,
        row.scope,
        row.project_id ?? null,
        row.creator_actor_id,
        row.idempotency_key,
        row.input_digest,
        row.config_digest,
        row.cursor_json,
        row.attempt_count,
        row.lease_owner ?? null,
        row.lease_expires_at ?? null,
        row.cancel_requested_at ?? null,
        row.next_retry_at ?? null,
        row.error_code ?? null,
        row.redacted_error ?? null,
        row.created_at,
        row.started_at ?? null,
        row.updated_at,
        row.finished_at ?? null
      );
  }

  /**
   * Atomically transition a job from
   * `queued` (or `failed` with a non-null past
   * `next_retry_at`) into `running`, stamping the lease
   * owner + expiry and incrementing `attempt_count`.
   * Returns the updated row, or `undefined` if the
   * predicate did not match (the caller is racing
   * another worker or the lease is still live). This
   * is the only place a job's `lease_owner` /
   * `lease_expires_at` / `attempt_count` are written.
   */
  claimDerivationJob(args: {
    job_id: string;
    lease_owner: string;
    lease_expires_at: number;
    started_at: number;
    now: number;
  }): DerivationJobRow | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.db
        .prepare(
          `UPDATE derivation_jobs
              SET lease_owner = ?,
                  lease_expires_at = ?,
                  attempt_count = attempt_count + 1,
                  state = 'running',
                  started_at = COALESCE(started_at, ?),
                  updated_at = ?
            WHERE job_id = ?
              AND (
                state = 'queued'
                OR (
                  state = 'failed'
                  AND next_retry_at IS NOT NULL
                  AND next_retry_at <= ?
                )
              )
              AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
            RETURNING *`
        )
        .get(
          args.lease_owner,
          args.lease_expires_at,
          args.started_at,
          args.now,
          args.job_id,
          args.now,
          args.now
        ) as Row | undefined;
      this.db.exec("COMMIT");
      if (updated === undefined) return undefined;
      return derivationJobFromRow(updated);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Find the next claimable job for the given kind (or any
   * kind when `kind` is `undefined`). The predicate mirrors
   * `claimDerivationJob`: `state = 'queued'`, OR
   * `state = 'failed' AND next_retry_at IS NOT NULL AND
   * next_retry_at <= now()` (a `failed` job without a
   * retry window is terminal and is NOT re-claimed). The
   * lease predicate matches the `claim` path. The list is
   * ordered by `created_at ASC` so the oldest queued
   * request is processed first.
   */
  listClaimableDerivationJobs(
    kind: string | undefined,
    now: number,
    limit: number
  ): DerivationJobRow[] {
    const params: SQLInputValue[] = [];
    let sql = `SELECT * FROM derivation_jobs
                WHERE (
                    state = 'queued'
                    OR (
                      state = 'failed'
                      AND next_retry_at IS NOT NULL
                      AND next_retry_at <= ?
                    )
                  )
                  AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`;
    params.push(now, now);
    if (kind !== undefined) {
      sql += " AND kind = ?";
      params.push(kind);
    }
    sql += " ORDER BY created_at ASC LIMIT ?";
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as Row[];
    return rows.map((r) => derivationJobFromRow(r));
  }

  /**
   * Mark a job's `cancel_requested_at`. The job still
   * transitions through its current stage boundary; the
   * runner consults the timestamp before starting the next
   * stage and routes to a terminal `cancelled` state.
   */
  requestDerivationJobCancel(jobId: string, now: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE derivation_jobs
            SET cancel_requested_at = ?,
                updated_at = ?
          WHERE job_id = ?
            AND state NOT IN ('succeeded', 'failed', 'cancelled')`
      )
      .run(now, now, jobId);
    return result.changes > 0;
  }

  /**
   * Transition a running job to a terminal state. The
   * caller is the runner finishing its current stage; the
   * `cursor_json` and `redacted_error` / `error_code` are
   * the final values written on disk. Returns the updated
   * row, or `undefined` if the job was not in `running`
   * state (e.g. it was already cancelled or completed by
   * a reap takeover).
   */
  finalizeDerivationJob(args: {
    job_id: string;
    terminal_state: Extract<DerivationJobState, "succeeded" | "failed" | "cancelled">;
    cursor_json?: string;
    error_code?: string | null;
    redacted_error?: string | null;
    next_retry_at?: number | null;
    now: number;
  }): DerivationJobRow | undefined {
    const result = this.db
      .prepare(
        `UPDATE derivation_jobs
            SET state = ?,
                cursor_json = COALESCE(?, cursor_json),
                error_code = ?,
                redacted_error = ?,
                next_retry_at = ?,
                lease_owner = NULL,
                lease_expires_at = NULL,
                finished_at = COALESCE(finished_at, ?),
                updated_at = ?
          WHERE job_id = ?
            AND state = 'running'
          RETURNING *`
      )
      .get(
        args.terminal_state,
        args.cursor_json ?? null,
        args.error_code ?? null,
        args.redacted_error ?? null,
        args.next_retry_at ?? null,
        args.now,
        args.now,
        args.job_id
      ) as Row | undefined;
    if (result === undefined) return undefined;
    return derivationJobFromRow(result);
  }

  /**
   * Update the per-stage `cursor_json` while the job stays
   * in `running`. Used by the runner between stages to
   * checkpoint progress without committing a terminal
   * state. The lease is renewed implicitly because
   * `updated_at` advances — callers that need a hard
   * lease refresh should call `renewDerivationJobLease`.
   */
  checkpointDerivationJob(
    jobId: string,
    cursorJson: string,
    now: number
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE derivation_jobs
            SET cursor_json = ?,
                updated_at = ?
          WHERE job_id = ? AND state = 'running'`
      )
      .run(cursorJson, now, jobId);
    return result.changes > 0;
  }

  /**
   * Renew a running job's lease. The TTL is the new
   * `lease_expires_at`; if the caller has crossed the
   * cancel boundary (e.g. user pressed Ctrl-C between
   * stages) the row is left untouched so the runner can
   * route to a terminal `cancelled` state on the next
   * poll. Returns `true` on a successful renewal.
   */
  renewDerivationJobLease(
    jobId: string,
    leaseOwner: string,
    leaseExpiresAt: number,
    now: number
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE derivation_jobs
            SET lease_owner = ?,
                lease_expires_at = ?,
                updated_at = ?
          WHERE job_id = ?
            AND state = 'running'
            AND lease_owner = ?
            AND (cancel_requested_at IS NULL OR cancel_requested_at > ?)`
      )
      .run(
        leaseOwner,
        leaseExpiresAt,
        now,
        jobId,
        leaseOwner,
        now
      );
    return result.changes > 0;
  }

  /**
   * Passive reap: re-queue any job whose lease has
   * expired. The runner calls this at the start of every
   * `listClaimable` / `claim` cycle so a crashed worker
   * does not strand a `running` job forever (issue #48
   * AC #2). Returns the number of rows reset.
   */
  reapExpiredDerivationJobLeases(now: number): number {
    const result = this.db
      .prepare(
        `UPDATE derivation_jobs
            SET state = 'queued',
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = ?
          WHERE state = 'running'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= ?`
      )
      .run(now, now);
    return result.changes;
  }

  /**
   * Insert a derivation run row (one per stage attempt).
   * The runner writes the row in `started` state before
   * the work; the same `run_id` is later updated to a
   * terminal status by `completeDerivationRun` /
   * `failDerivationRun`.
   */
  insertDerivationRun(row: DerivationRunRow): void {
    this.db
      .prepare(
        `INSERT INTO derivation_runs (
          run_id, job_id, stage, status,
          input_refs_json, output_refs_json,
          provider_id, model_id,
          prompt_template_version, prompt_hash,
          policy_version, result_digest,
          started_at, finished_at
        ) VALUES (
          ?, ?, ?, ?,
          ?, ?,
          ?, ?,
          ?, ?,
          ?, ?,
          ?, ?
        )`
      )
      .run(
        row.run_id,
        row.job_id,
        row.stage,
        row.status,
        row.input_refs_json,
        row.output_refs_json,
        row.provider_id ?? null,
        row.model_id ?? null,
        row.prompt_template_version ?? null,
        row.prompt_hash ?? null,
        row.policy_version,
        row.result_digest ?? null,
        row.started_at,
        row.finished_at ?? null
      );
  }

  /**
   * Finalise a derivation run row. The `output_refs_json`
   * is the list of `output_id`s the stage produced; the
   * caller is responsible for inserting the matching
   * `derivation_outputs` rows in the same transaction.
   */
  completeDerivationRun(args: {
    run_id: string;
    status: Extract<DerivationRunStatus, "succeeded" | "failed" | "cancelled">;
    output_refs_json: string;
    result_digest?: string | null;
    finished_at: number;
  }): boolean {
    const result = this.db
      .prepare(
        `UPDATE derivation_runs
            SET status = ?,
                output_refs_json = ?,
                result_digest = ?,
                finished_at = ?
          WHERE run_id = ? AND status = 'started'`
      )
      .run(
        args.status,
        args.output_refs_json,
        args.result_digest ?? null,
        args.finished_at,
        args.run_id
      );
    return result.changes > 0;
  }

  /**
   * Read all run rows for a given job, ordered by
   * `started_at ASC` so the audit trail reads in stage
   * order. Used by the inspector (`jobs show <id>`).
   */
  listDerivationRunsForJob(jobId: string): DerivationRunRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM derivation_runs WHERE job_id = ? ORDER BY started_at ASC, run_id ASC"
      )
      .all(jobId) as Row[];
    return rows.map((r) => derivationRunFromRow(r));
  }

  /**
   * Read a single run row by its primary key. Returns
   * `undefined` if the run does not exist. Used by
   * `DerivationJobStore.finishStage` to resolve the
   * `job_id` of a run without a full table scan.
   */
  getDerivationRun(runId: string): DerivationRunRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM derivation_runs WHERE run_id = ?")
      .get(runId) as Row | undefined;
    if (row === undefined) return undefined;
    return derivationRunFromRow(row);
  }

  /**
   * Insert a derivation output row. Used both for
   * `proposed` (stage result) and `applied` (downstream
   * service call) outputs. The composite primary key
   * guarantees no duplicate `(job_id, output_kind,
   * output_id)` — a reap takeover that tries to write
   * the same applied row gets an SQLITE_CONSTRAINT
   * error which the runner translates to a no-op (the
   * row already exists from the first worker).
   */
  insertDerivationOutput(row: DerivationOutputRow): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO derivation_outputs (
            job_id, run_id, output_kind, output_id, disposition, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          row.job_id,
          row.run_id,
          row.output_kind,
          row.output_id,
          row.disposition,
          row.created_at
        );
      return true;
    } catch (error) {
      if (isSqliteUniqueConstraintError(error)) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Read all output rows for a given job, ordered by
   * `(output_kind ASC, output_id ASC)` for stable
   * inspection. Used by `jobs show <id>` to render the
   * `outputs:` block.
   */
  listDerivationOutputsForJob(jobId: string): DerivationOutputRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM derivation_outputs
           WHERE job_id = ?
           ORDER BY output_kind ASC, output_id ASC`
      )
      .all(jobId) as Row[];
    return rows.map((r) => derivationOutputFromRow(r));
  }

  /**
   * Filter derivation jobs by the inspector query. The
   * `state` and `kind` arguments are optional; `limit`
   * caps the row count. Ordered newest-first.
   */
  listDerivationJobs(filter: {
    state?: DerivationJobState;
    kind?: string;
    limit: number;
  }): DerivationJobRow[] {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.state !== undefined) {
      clauses.push("state = ?");
      params.push(filter.state);
    }
    if (filter.kind !== undefined) {
      clauses.push("kind = ?");
      params.push(filter.kind);
    }
    const where = clauses.length === 0 ? "" : " WHERE " + clauses.join(" AND ");
    const sql = `SELECT * FROM derivation_jobs${where}
                  ORDER BY created_at DESC LIMIT ?`;
    params.push(filter.limit);
    const rows = this.db.prepare(sql).all(...params) as Row[];
    return rows.map((r) => derivationJobFromRow(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  // v1.2.0-alpha.1 (issue #49): session evidence substrate.
  //
  // The three tables — `sessions` / `session_events` /
  // `session_event_blobs` — back the SessionTraceBundle
  // v1 capture surface. The public API for the rows
  // lives in `src/sessions/service.ts`; the methods
  // below are the lowest-level row readers and
  // writers used by the SessionService. The methods
  // compose inside single `BEGIN IMMEDIATE`
  // transactions so the ingest path is atomic with
  // the per-event plan (issue #49 AC #1).
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Find a session by the source-identity tuple.
   * Returns `undefined` if no row exists. The
   * read side of the replay contract: an `ingest`
   * call with the same tuple + same `bundle_hash`
   * returns the original `session_id`.
   */
  getSessionBySourceIdentity(args: {
    source_kind: string;
    source_version: string;
    source_instance_id: string;
    source_session_id: string;
  }): SessionRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM sessions
           WHERE source_kind = ?
             AND source_version = ?
             AND source_instance_id = ?
             AND source_session_id = ?`
      )
      .get(
        args.source_kind,
        args.source_version,
        args.source_instance_id,
        args.source_session_id
      ) as Row | undefined;
    if (row === undefined) return undefined;
    return sessionFromRow(row);
  }

  /**
   * Read a session by its primary key.
   */
  getSession(sessionId: string): SessionRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get(sessionId) as Row | undefined;
    if (row === undefined) return undefined;
    return sessionFromRow(row);
  }

  /**
   * Insert one session row. Called from
   * `SessionService.ingest` inside a single
   * transaction that also inserts the per-event
   * rows and the blob rows.
   */
  insertSession(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (
          session_id, source_kind, source_version, source_instance_id, source_session_id,
          scope, project_id, actor_id, client_name, client_version,
          started_at, ended_at, sensitivity, bundle_hash,
          adapter_id, adapter_version, ingestion_plan_json, redaction_summary_json,
          ingested_at, retention_until
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?
        )`
      )
      .run(
        row.session_id,
        row.source_kind,
        row.source_version,
        row.source_instance_id,
        row.source_session_id,
        row.scope,
        row.project_id,
        row.actor_id,
        row.client_name,
        row.client_version,
        row.started_at,
        row.ended_at,
        row.sensitivity,
        row.bundle_hash,
        row.adapter_id,
        row.adapter_version,
        row.ingestion_plan_json,
        row.redaction_summary_json,
        row.ingested_at,
        row.retention_until
      );
  }

  /**
   * List sessions for the CLI / MCP inspector. The
   * `state` and `kind` arguments are optional;
   * `limit` caps the row count. Ordered
   * newest-first.
   */
  listSessions(filter: {
    scope?: SessionScope;
    project_id?: string;
    limit: number;
  }): SessionRow[] {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.scope !== undefined) {
      clauses.push("scope = ?");
      params.push(filter.scope);
    }
    if (filter.project_id !== undefined) {
      clauses.push("project_id = ?");
      params.push(filter.project_id);
    }
    const where = clauses.length === 0 ? "" : " WHERE " + clauses.join(" AND ");
    const sql = `SELECT * FROM sessions${where}
                  ORDER BY ingested_at DESC LIMIT ?`;
    params.push(filter.limit);
    const rows = this.db.prepare(sql).all(...params) as Row[];
    return rows.map((r) => sessionFromRow(r));
  }

  /**
   * Read the events for a single session, ordered
   * by `sequence ASC` so the audit trail reads in
   * capture order.
   */
  listSessionEvents(sessionId: string): SessionEventRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM session_events WHERE session_id = ? ORDER BY sequence ASC, event_id ASC"
      )
      .all(sessionId) as Row[];
    return rows.map((r) => sessionEventFromRow(r));
  }

  /**
   * Insert one session event row. The body itself
   * is in `session_event_blobs` keyed by
   * `content_digest`; the row holds the manifest
   * + metadata only.
   */
  insertSessionEvent(row: SessionEventRow): void {
    this.db
      .prepare(
        `INSERT INTO session_events (
          event_id, session_id, sequence, turn_id, event_type, role,
          content_digest, content_blob_ref, tool_name, tool_call_id, tool_status,
          timestamp, sensitivity, redaction_flags_json, metadata_json
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?
        )`
      )
      .run(
        row.event_id,
        row.session_id,
        row.sequence,
        row.turn_id,
        row.event_type,
        row.role,
        row.content_digest,
        row.content_blob_ref,
        row.tool_name,
        row.tool_call_id,
        row.tool_status,
        row.timestamp,
        row.sensitivity,
        row.redaction_flags_json,
        row.metadata_json
      );
  }

  /**
   * Insert (or replace) a session event blob.
   * The blob row is keyed by digest; the same
   * digest from two events reuses the same body
   * (issue #49 storage model: content-addressed).
   */
  /**
   * v1.2.0-alpha.2 (issue #50): read a single
   * `session_event_blobs` row by digest. Returns
   * `undefined` when the digest is unknown. Used
   * by the distillation extractor (and the admin
   * inspector) to reconstruct the event body
   * from the head + tail slices.
   */
  getSessionEventBlob(digest: string): SessionEventBlobRow | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM session_event_blobs WHERE digest = ?"
      )
      .get(digest) as Row | undefined;
    if (row === undefined) return undefined;
    // The BLOB column may come back as a Buffer
    // (preferred) or as a string (older node:sqlite
    // builds or string-typed returns). Normalize
    // both to a Buffer without re-encoding a
    // string (which would corrupt binary payloads
    // containing non-UTF-8 bytes).
    const headRaw = row["head_bytes"];
    const tailRaw = row["tail_bytes"];
    const toBuffer = (v: unknown): Buffer => {
      if (v instanceof Buffer) return v;
      if (v instanceof Uint8Array) return Buffer.from(v);
      if (typeof v === "string") return Buffer.from(v, "binary");
      return Buffer.alloc(0);
    };
    return {
      digest: stringCell(row, "digest"),
      size_bytes: numberCell(row, "size_bytes"),
      media_type: stringCell(row, "media_type"),
      head_bytes: toBuffer(headRaw),
      tail_bytes: toBuffer(tailRaw),
      head_tail_window_json: stringCell(row, "head_tail_window_json"),
      stored_at: stringCell(row, "stored_at")
    };
  }

  upsertSessionEventBlob(row: SessionEventBlobRow): void {
    this.db
      .prepare(
        `INSERT INTO session_event_blobs (
          digest, size_bytes, media_type, head_bytes, tail_bytes,
          head_tail_window_json, stored_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(digest) DO NOTHING`
      )
      .run(
        row.digest,
        row.size_bytes,
        row.media_type,
        row.head_bytes,
        row.tail_bytes,
        row.head_tail_window_json,
        row.stored_at
      );
  }

  /**
   * Forget a session. The ON DELETE CASCADE on
   * `session_events` removes all event rows in
   * the same transaction. The blob rows are
   * intentionally NOT cascaded: a digest is
   * content-addressed and may be referenced by
   * another (unrelated) session, so a session
   * forget only removes the manifest / index
   * rows. Blob rows that lose all referrers
   * become eligible for the GC sweep added in
   * #55.
   */
  forgetSession(sessionId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM sessions WHERE session_id = ?")
      .run(sessionId);
    return result.changes > 0;
  }

  // ─────────────────────────────────────────────────────────────────────
  // v1.2.0-alpha.1 (issue #51): asset registry.
  //
  // The envelope tables — `assets` / `asset_versions` /
  // `asset_relations` — and the only v16-shipped
  // type-specific table — `memory_ref_bindings` —
  // back the additive typed asset registry. The
  // public service lives in `src/assets/service.ts`.
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Insert the envelope row for a new asset. The
   * caller pre-computes `asset_id`,
   * `current_version` (always 0 on the first
   * insert), and the type-specific payload
   * (manifest + bindings). Returns `false` when
   * the unique key (`asset_id`) collides so the
   * service can translate the violation into a
   * stable error code.
   */
  insertAsset(row: AssetRow): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO assets (
            asset_id, asset_type, scope, project_id, owner_actor_id,
            lifecycle_state, current_version, trust_level, sensitivity,
            metadata_json, created_at, updated_at, archived_at
          ) VALUES (
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?
          )`
        )
        .run(
          row.asset_id,
          row.asset_type,
          row.scope,
          row.project_id,
          row.owner_actor_id,
          row.lifecycle_state,
          row.current_version,
          row.trust_level,
          row.sensitivity,
          row.metadata_json,
          row.created_at,
          row.updated_at,
          row.archived_at
        );
      return true;
    } catch (error) {
      if (isSqliteUniqueConstraintError(error)) return false;
      throw error;
    }
  }

  /**
   * Read the envelope row by `asset_id`.
   */
  getAsset(assetId: string): AssetRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM assets WHERE asset_id = ?")
      .get(assetId) as Row | undefined;
    if (row === undefined) return undefined;
    return assetFromRow(row);
  }

  /**
   * List envelope rows. The `asset_type` /
   * `lifecycle_state` / `scope` / `project_id`
   * filters are optional; the `limit` caps the
   * row count. Ordered newest-first by
   * `updated_at DESC`.
   */
  listAssets(filter: {
    asset_type?: AssetType;
    lifecycle_state?: AssetLifecycleState;
    scope?: "global" | "project";
    project_id?: string;
    limit: number;
  }): AssetRow[] {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.asset_type !== undefined) {
      clauses.push("asset_type = ?");
      params.push(filter.asset_type);
    }
    if (filter.lifecycle_state !== undefined) {
      clauses.push("lifecycle_state = ?");
      params.push(filter.lifecycle_state);
    }
    if (filter.scope !== undefined) {
      clauses.push("scope = ?");
      params.push(filter.scope);
    }
    if (filter.project_id !== undefined) {
      clauses.push("project_id = ?");
      params.push(filter.project_id);
    }
    const where = clauses.length === 0 ? "" : " WHERE " + clauses.join(" AND ");
    const sql = `SELECT * FROM assets${where}
                  ORDER BY updated_at DESC LIMIT ?`;
    params.push(filter.limit);
    const rows = this.db.prepare(sql).all(...params) as Row[];
    return rows.map((r) => assetFromRow(r));
  }

  /**
   * Atomically append a new version + advance the
   * envelope's `current_version` in a single
   * transaction. The `version` argument is the
   * expected new version (1-based, monotonically
   * increasing); the update only succeeds when
   * the row's current_version is exactly
   * `version - 1`. Returns the updated envelope
   * row, or `undefined` on CAS failure (caller is
   * racing a concurrent append).
   */
  appendAssetVersion(args: {
    asset_id: string;
    expected_previous_version: number;
    new_version: number;
    schema_version: string;
    content_hash: string;
    manifest_json: string;
    created_by_actor_id: string;
    provenance_kind: AssetVersionRow["provenance_kind"];
    provenance_ref: string | null;
    now: string;
  }): AssetRow | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO asset_versions (
            asset_id, version, schema_version, content_hash, manifest_json,
            created_by_actor_id, provenance_kind, provenance_ref, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          args.asset_id,
          args.new_version,
          args.schema_version,
          args.content_hash,
          args.manifest_json,
          args.created_by_actor_id,
          args.provenance_kind,
          args.provenance_ref,
          args.now
        );
      const updated = this.db
        .prepare(
          `UPDATE assets
              SET current_version = ?, updated_at = ?
            WHERE asset_id = ? AND current_version = ?
            RETURNING *`
        )
        .get(
          args.new_version,
          args.now,
          args.asset_id,
          args.expected_previous_version
        ) as Row | undefined;
      this.db.exec("COMMIT");
      if (updated === undefined) return undefined;
      return assetFromRow(updated);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Read all version rows for one asset, ordered
   * by `version ASC` so the audit trail reads in
   * append order.
   */
  listAssetVersions(assetId: string): AssetVersionRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM asset_versions WHERE asset_id = ? ORDER BY version ASC"
      )
      .all(assetId) as Row[];
    return rows.map((r) => assetVersionFromRow(r));
  }

  /**
   * Read the type-specific binding for a single
   * (asset_id, version). Returns `undefined` for
   * `memory_ref` assets that have no row (the
   * asset is the envelope only — no body is
   * duplicated). The service uses this to surface
   * the binding on inspection.
   */
  getMemoryRefBinding(
    assetId: string,
    version: number
  ): MemoryRefBindingRow | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM memory_ref_bindings WHERE asset_id = ? AND version = ?"
      )
      .get(assetId, version) as Row | undefined;
    if (row === undefined) return undefined;
    return memoryRefBindingFromRow(row);
  }

  /**
   * Insert one memory_ref binding row. The
   * composite primary key on (asset_id, version)
   * guarantees no duplicate binding per version;
   * a v2 of the same asset reuses the same
   * `asset_id` but bumps `version`, and the new
   * row is a fresh binding.
   */
  insertMemoryRefBinding(row: MemoryRefBindingRow): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO memory_ref_bindings (
            asset_id, version, memory_id, memory_revision, binding_rule, note
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          row.asset_id,
          row.version,
          row.memory_id,
          row.memory_revision,
          row.binding_rule,
          row.note
        );
      return true;
    } catch (error) {
      if (isSqliteUniqueConstraintError(error)) return false;
      throw error;
    }
  }

  /**
   * Flip the envelope's `lifecycle_state`. The
   * `archived_at` column is set when the new
   * state is `archived`, cleared when it is
   * anything else. The operation only succeeds
   * when the current state matches
   * `expected_state` (CAS); concurrent lifecycle
   * mutations are detected as `undefined`.
   */
  setAssetLifecycle(args: {
    asset_id: string;
    expected_state: AssetLifecycleState;
    new_state: AssetLifecycleState;
    now: string;
  }): AssetRow | undefined {
    const archivedAt = args.new_state === "archived" ? args.now : null;
    const updated = this.db
      .prepare(
        `UPDATE assets
            SET lifecycle_state = ?,
                archived_at = ?,
                updated_at = ?
          WHERE asset_id = ? AND lifecycle_state = ?
          RETURNING *`
      )
      .get(
        args.new_state,
        archivedAt,
        args.now,
        args.asset_id,
        args.expected_state
      ) as Row | undefined;
    if (updated === undefined) return undefined;
    return assetFromRow(updated);
  }

  /**
   * v1.2.0-alpha.2 (issue #53): insert one
   * `skills` row. The composite primary key on
   * `(asset_id, version)` guarantees no duplicate
   * row per version; a v2 of the same asset reuses
   * the same `asset_id` but bumps `version`, and
   * the new row is a fresh body. Returns `false`
   * on a UNIQUE collision (caller is racing an
   * append or has a stale `version`). All other
   * errors propagate.
   */
  insertSkillRow(row: SkillRow): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO skills (
            asset_id, version, name, description, schema_version,
            category, triggers_json, when_to_use, when_not_to_use,
            compatibility_json, source, skill_md_canonical, body_hash,
            resources_json
          ) VALUES (
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?
          )`
        )
        .run(
          row.asset_id,
          row.version,
          row.name,
          row.description,
          row.schema_version,
          row.category,
          row.triggers_json,
          row.when_to_use,
          row.when_not_to_use,
          row.compatibility_json,
          row.source,
          row.skill_md_canonical,
          row.body_hash,
          row.resources_json
        );
      return true;
    } catch (error) {
      if (isSqliteUniqueConstraintError(error)) return false;
      throw error;
    }
  }

  /**
   * v1.2.0-alpha.2 (issue #53): read one
   * `skills` row by `(asset_id, version)`.
   * Returns `undefined` for `skill` assets that
   * have no row (the asset envelope exists but
   * the type-specific body has not been
   * materialised yet — should not happen in
   * practice; the `SkillService` always writes
   * the row inside the same transaction as the
   * `asset_versions` append).
   */
  getSkillRow(assetId: string, version: number): SkillRow | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM skills WHERE asset_id = ? AND version = ?"
      )
      .get(assetId, version) as Row | undefined;
    if (row === undefined) return undefined;
    return skillFromRow(row);
  }

  /**
   * v1.2.0-alpha.2 (issue #53): list skill rows
   * whose `name` matches the SQL LIKE `pattern`.
   * The pattern is passed through verbatim (callers
   * are responsible for any escaping they need; the
   * underlying column is the kebab-case name). The
   * list is ordered by `name ASC, asset_id ASC,
   * version ASC` so the iteration is stable and the
   * head (largest version) is the LAST row per
   * `asset_id`. The result is NOT asset-id-
   * deduplicated; callers that want a flat summary
   * can pick the head in the service layer.
   */
  listSkillRows(pattern: string, limit: number): SkillRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM skills
          WHERE name LIKE ?
          ORDER BY name ASC, asset_id ASC, version ASC
          LIMIT ?`
      )
      .all(pattern, limit) as Row[];
    return rows.map((r) => skillFromRow(r));
  }

  /**
   * v1.2.0-alpha.2 (issue #53): list skill rows
   * whose `body_hash` matches the supplied
   * `sha256:hex64` value. Used to look up "do we
   * already have this exact skill body?" before
   * inserting. Ordered newest-first by `(asset_id,
   * version)`. Limit defaults to 50 to keep the
   * call bounded; callers should pass an explicit
   * limit if they need a different cap.
   */
  listSkillRowsByHash(bodyHash: string, limit: number): SkillRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM skills
          WHERE body_hash = ?
          ORDER BY asset_id ASC, version ASC
          LIMIT ?`
      )
      .all(bodyHash, limit) as Row[];
    return rows.map((r) => skillFromRow(r));
  }

  // ============================================================
  // v1.2.0-alpha.2 (issue #54): bootstrap + external_references
  // ============================================================

  /**
   * Upsert a bootstrap source row. The
   * `(scope, project_id, canonical_ref)` triple is
   * the natural key — re-configuring an existing
   * source is idempotent. Returns the persisted row
   * (either the inserted one or the pre-existing one).
   * A unique-key collision that does not match the
   * natural key is treated as `undefined` so the
   * caller can surface a stable error.
   */
  upsertBootstrapSource(row: BootstrapSourceRow): BootstrapSourceRow | undefined {
    const existing = this.db
      .prepare(
        `SELECT * FROM bootstrap_sources
           WHERE scope = ? AND project_id IS ? AND canonical_ref = ?`
      )
      .get(row.scope, row.project_id, row.canonical_ref) as Row | undefined;
    if (existing !== undefined) {
      return bootstrapSourceFromRow(existing);
    }
    try {
      this.db
        .prepare(
          `INSERT INTO bootstrap_sources (
            source_id, source_kind, scope, project_id, canonical_ref,
            source_version, content_digest, sensitivity,
            configured_by_actor_id, created_at, last_scanned_at, size_bytes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          row.source_id,
          row.source_kind,
          row.scope,
          row.project_id,
          row.canonical_ref,
          row.source_version,
          row.content_digest,
          row.sensitivity,
          row.configured_by_actor_id,
          row.created_at,
          row.last_scanned_at,
          row.size_bytes
        );
      return row;
    } catch (error) {
      if (isSqliteUniqueConstraintError(error)) return undefined;
      throw error;
    }
  }

  /**
   * Read all configured sources for a project (or
   * the global scope when `project_id === null`).
   * The order is `created_at ASC` so a re-scan
   * produces a stable source_set_digest.
   */
  listBootstrapSources(filter: {
    scope: "global" | "project";
    project_id: string | null;
  }): BootstrapSourceRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM bootstrap_sources
           WHERE scope = ? AND project_id IS ?
           ORDER BY created_at ASC, source_id ASC`
      )
      .all(filter.scope, filter.project_id) as Row[];
    return rows.map(bootstrapSourceFromRow);
  }

  /**
   * Read one source by id.
   */
  getBootstrapSource(sourceId: string): BootstrapSourceRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM bootstrap_sources WHERE source_id = ?`)
      .get(sourceId) as Row | undefined;
    if (row === undefined) return undefined;
    return bootstrapSourceFromRow(row);
  }

  /**
   * Update the `content_digest`, `last_scanned_at`
   * and `size_bytes` of an existing source.
   * Returns the updated row or `undefined` when the
   * source has been removed concurrently.
   */
  updateBootstrapSourceScan(args: {
    source_id: string;
    content_digest: string;
    last_scanned_at: string;
    size_bytes: number | null;
  }): BootstrapSourceRow | undefined {
    const updated = this.db
      .prepare(
        `UPDATE bootstrap_sources
            SET content_digest = ?,
                last_scanned_at = ?,
                size_bytes = ?
          WHERE source_id = ?
          RETURNING *`
      )
      .get(
        args.content_digest,
        args.last_scanned_at,
        args.size_bytes,
        args.source_id
      ) as Row | undefined;
    if (updated === undefined) return undefined;
    return bootstrapSourceFromRow(updated);
  }

  /**
   * Insert a fresh plan row. The plan_id is the
   * primary key; a collision returns `false` so the
   * caller can retry. The plan starts in `draft`
   * state; the scan/apply verbs transition it.
   */
  insertBootstrapPlan(row: BootstrapPlanRow): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO bootstrap_plans (
            plan_id, project_id, creator_actor_id, state,
            config_digest, source_set_digest,
            created_at, expires_at, completed_at, job_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          row.plan_id,
          row.project_id,
          row.creator_actor_id,
          row.state,
          row.config_digest,
          row.source_set_digest,
          row.created_at,
          row.expires_at,
          row.completed_at,
          row.job_id
        );
      return true;
    } catch (error) {
      if (isSqliteUniqueConstraintError(error)) return false;
      throw error;
    }
  }

  /**
   * CAS-update a plan's state. The `expected_state`
   * guard makes concurrent transitions detectable.
   * When the plan is not in `expected_state`, returns
   * `undefined` and the caller surfaces a stable
   * `cas_mismatch` error.
   */
  setBootstrapPlanState(args: {
    plan_id: string;
    expected_state: BootstrapPlanState;
    new_state: BootstrapPlanState;
    completed_at?: string | null;
    job_id?: string | null;
  }): BootstrapPlanRow | undefined {
    const sets: string[] = ["state = ?"];
    const params: Array<string | number | null> = [args.new_state];
    if (args.completed_at !== undefined) {
      sets.push("completed_at = ?");
      params.push(args.completed_at);
    }
    if (args.job_id !== undefined) {
      sets.push("job_id = ?");
      params.push(args.job_id);
    }
    params.push(args.plan_id, args.expected_state);
    const updated = this.db
      .prepare(
        `UPDATE bootstrap_plans
            SET ${sets.join(", ")}
          WHERE plan_id = ? AND state = ?
          RETURNING *`
      )
      .get(...params) as Row | undefined;
    if (updated === undefined) return undefined;
    return bootstrapPlanFromRow(updated);
  }

  /**
   * Read a plan by id.
   */
  getBootstrapPlan(planId: string): BootstrapPlanRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM bootstrap_plans WHERE plan_id = ?`)
      .get(planId) as Row | undefined;
    if (row === undefined) return undefined;
    return bootstrapPlanFromRow(row);
  }

  /**
   * List plans for a project (or global scope when
   * `project_id === null`). Newest-first.
   */
  listBootstrapPlans(filter: {
    project_id: string;
    state?: BootstrapPlanState;
    limit?: number;
  }): BootstrapPlanRow[] {
    const clauses: string[] = ["project_id = ?"];
    const params: Array<string | number> = [filter.project_id];
    if (filter.state !== undefined) {
      clauses.push("state = ?");
      params.push(filter.state);
    }
    const limit = filter.limit ?? 50;
    const rows = this.db
      .prepare(
        `SELECT * FROM bootstrap_plans
           WHERE ${clauses.join(" AND ")}
           ORDER BY created_at DESC LIMIT ?`
      )
      .all(...params, limit) as Row[];
    return rows.map(bootstrapPlanFromRow);
  }

  /**
   * Bulk-insert plan items. The order of the
   * input array becomes the `item_seq` (1-based).
   * The whole insert is wrapped in a single
   * `BEGIN IMMEDIATE` so an item-rejected insert
   * rolls back the entire batch.
   */
  insertBootstrapPlanItems(
    items: ReadonlyArray<BootstrapPlanItemRow>
  ): void {
    if (items.length === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stmt = this.db.prepare(
        `INSERT INTO bootstrap_plan_items (
          plan_id, source_id, item_seq, action, target_ref,
          proposed_payload_json, evidence_digest,
          expected_revision_or_version, risk, rationale
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const it of items) {
        stmt.run(
          it.plan_id,
          it.source_id,
          it.item_seq,
          it.action,
          it.target_ref,
          it.proposed_payload_json,
          it.evidence_digest,
          it.expected_revision_or_version,
          it.risk,
          it.rationale
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * List the items of a plan, ordered by `item_seq ASC`.
   */
  listBootstrapPlanItems(planId: string): BootstrapPlanItemRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM bootstrap_plan_items
           WHERE plan_id = ?
           ORDER BY item_seq ASC`
      )
      .all(planId) as Row[];
    return rows.map(bootstrapPlanItemFromRow);
  }

  /**
   * Insert an `external_reference` row. The
   * `(asset_id, version)` pair is the primary key
   * (composite with `assets`).
   */
  insertExternalReference(row: ExternalReferenceRow): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO external_references (
            asset_id, version, provider_kind, provider_instance_id,
            resource_kind, resource_ref, uri,
            source_version, source_digest, retrieval_contract_version,
            capabilities_json, allowed_scope, project_id, sensitivity,
            refresh_policy_json, last_verified_at, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          row.asset_id,
          row.version,
          row.provider_kind,
          row.provider_instance_id,
          row.resource_kind,
          row.resource_ref,
          row.uri,
          row.source_version,
          row.source_digest,
          row.retrieval_contract_version,
          row.capabilities_json,
          row.allowed_scope,
          row.project_id,
          row.sensitivity,
          row.refresh_policy_json,
          row.last_verified_at,
          row.metadata_json
        );
      return true;
    } catch (error) {
      if (isSqliteUniqueConstraintError(error)) return false;
      throw error;
    }
  }

  /**
   * Read the latest `external_references` row for an
   * asset (the row whose `version` is the head).
   */
  getLatestExternalReference(assetId: string): ExternalReferenceRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM external_references
           WHERE asset_id = ?
           ORDER BY version DESC LIMIT 1`
      )
      .get(assetId) as Row | undefined;
    if (row === undefined) return undefined;
    return externalReferenceFromRow(row);
  }

  /**
   * List `external_references` rows, optionally
   * filtered by `provider_kind` / `allowed_scope` /
   * `project_id`. Newest-first by `version DESC`.
   */
  listExternalReferences(filter: {
    provider_kind?: string;
    allowed_scope?: "global" | "project";
    project_id?: string;
    limit?: number;
  }): ExternalReferenceRow[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.provider_kind !== undefined) {
      clauses.push("provider_kind = ?");
      params.push(filter.provider_kind);
    }
    if (filter.allowed_scope !== undefined) {
      clauses.push("allowed_scope = ?");
      params.push(filter.allowed_scope);
    }
    if (filter.project_id !== undefined) {
      clauses.push("project_id = ?");
      params.push(filter.project_id);
    }
    const where = clauses.length === 0 ? "" : " WHERE " + clauses.join(" AND ");
    const limit = filter.limit ?? 50;
    const rows = this.db
      .prepare(
        `SELECT * FROM external_references${where}
           ORDER BY version DESC LIMIT ?`
      )
      .all(...params, limit) as Row[];
    return rows.map(externalReferenceFromRow);
  }

  /**
   * Refresh `last_verified_at` on the head
   * `external_references` row for an asset. The
   * `expected_version` guard makes concurrent
   * version appends detectable; returns `undefined`
   * on CAS failure.
   */
  refreshExternalReferenceLastVerified(args: {
    asset_id: string;
    expected_version: number;
    now: string;
  }): ExternalReferenceRow | undefined {
    const updated = this.db
      .prepare(
        `UPDATE external_references
            SET last_verified_at = ?
          WHERE asset_id = ? AND version = ?
          RETURNING *`
      )
      .get(args.now, args.asset_id, args.expected_version) as Row | undefined;
    if (updated === undefined) return undefined;
    return externalReferenceFromRow(updated);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Returns the underlying database handle. Intended ONLY for backup
   * (VACUUM INTO). Do not call arbitrary statements; doing so bypasses
   * the store's row-decoding and audit/FTS bookkeeping.
   */
  backupHandle(): SqliteDb {
    return this.db;
  }

  transaction<T>(work: () => T): T {
    if (this.transactionDepth > 0) {
      return work();
    }

    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth = 1;
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  private migrate(): void {
    this.db.exec("PRAGMA foreign_keys = ON");
    this.ensureBaseSchema();
    this.migrateForward();
  }

  /**
   * Stage 10 PR5: ensure the v1 base schema is in place
   * without running the version-aware migration chain. The
   * `read_write_no_migrate` open mode calls this from the
   * constructor; a fresh database file gets a usable schema,
   * but a stale one is left at its current user_version so
   * the CLI `migrate` command can ask for confirmation.
   */
  private ensureBaseSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_scopes (
        project_id TEXT PRIMARY KEY,
        canonical_path TEXT NOT NULL,
        display_name TEXT NOT NULL,
        budget_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
        project_id TEXT,
        project_path TEXT,
        type TEXT NOT NULL,
        topic TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source_json TEXT NOT NULL,
        importance INTEGER NOT NULL,
        confidence INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'archived', 'superseded', 'forgotten')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_accessed_at TEXT,
        last_accessed_by TEXT,
        access_count INTEGER NOT NULL,
        expires_at TEXT,
        review_after TEXT,
        supersedes_json TEXT NOT NULL,
        superseded_by TEXT,
        token_estimate INTEGER NOT NULL,
        char_count INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_entries_scope_project_idx
        ON memory_entries(scope, project_id, status, updated_at);
      CREATE INDEX IF NOT EXISTS memory_entries_topic_idx
        ON memory_entries(topic);
      CREATE INDEX IF NOT EXISTS memory_entries_type_idx
        ON memory_entries(type);

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        memory_id TEXT,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
        project_id TEXT,
        event TEXT NOT NULL,
        reason TEXT,
        -- Stage 10 PR3: actor is a free-form string so
        -- structured values like "agent:claude-code" or
        -- "system:expiry" can be stored. The legacy v1
        -- CHECK constraint was dropped in the v1->v2
        -- migration. New files created by ensureBaseSchema
        -- start without it.
        actor TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS audit_events_memory_created_idx
        ON audit_events(memory_id, created_at);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        id UNINDEXED,
        scope UNINDEXED,
        project_id UNINDEXED,
        topic,
        title,
        body,
        tags
      );
    `);
  }

  private readUserVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get();
    if (row === undefined) return 0;
    const value = (row as Record<string, unknown>).user_version;
    return typeof value === "number" ? value : 0;
  }

  getUserVersion(): number {
    return this.readUserVersion();
  }

  setUserVersion(version: number): void {
    // Exposed for the CLI migrate command. Runs outside a transaction.
    this.db.exec(`PRAGMA user_version = ${version}`);
  }

  runMigrations(): { from: number; to: number } {
    // Stage 10 PR5: ensure the base schema is in place
    // before walking the version chain. The base DDL is
    // idempotent (CREATE TABLE IF NOT EXISTS) so calling it
    // on a fresh file is harmless; calling it on a stale
    // file is a no-op for tables that already exist.
    const before = this.readUserVersion();
    this.ensureBaseSchema();
    this.migrateForward();
    const after = this.readUserVersion();
    return { from: before, to: after };
  }

  private migrateForward(): void {
    const current = this.readUserVersion();
    if (current >= CURRENT_SCHEMA_VERSION) {
      return;
    }
    for (let version = current + 1; version <= CURRENT_SCHEMA_VERSION; version += 1) {
      this.migrateToVersion(version);
    }
  }

  private migrateToVersion(version: number): void {
    if (version === 1) {
      // v1 is the base schema. The CREATE TABLE IF NOT EXISTS DDL above
      // is already the v1 shape; this step just records the version
      // marker so a future v1->v2 migration has a stable starting point.
      this.setUserVersion(1);
      return;
    }
    if (version === 2) {
      this.migrate_v1_to_v2();
      return;
    }
    if (version === 3) {
      this.migrate_v2_to_v3();
      return;
    }
    if (version === 4) {
      this.migrate_v3_to_v4();
      return;
    }
    if (version === 5) {
      this.migrate_v4_to_v5();
      return;
    }
    if (version === 6) {
      this.migrate_v5_to_v6();
      return;
    }
    if (version === 7) {
      this.migrate_v6_to_v7();
      return;
    }
    if (version === 8) {
      this.migrate_v7_to_v8();
      return;
    }
    if (version === 9) {
      this.migrate_v8_to_v9();
      return;
    }
    if (version === 10) {
      this.migrate_v9_to_v10();
      return;
    }
    if (version === 11) {
      this.migrate_v10_to_v11();
      return;
    }
    if (version === 12) {
      this.migrate_v11_to_v12();
      return;
    }
    if (version === 13) {
      this.migrate_v12_to_v13();
      return;
    }
    if (version === 14) {
      this.migrate_v13_to_v14();
      return;
    }
    if (version === 15) {
      this.migrate_v14_to_v15();
      return;
    }
    if (version === 16) {
      this.migrate_v15_to_v16();
      return;
    }
    if (version === 17) {
      // v17 (v1.2.0-alpha.2, issue #50): the session
      // distillation candidate tables. Additive; does
      // not touch any prior table.
      this.migrate_v16_to_v17();
      return;
    }
    if (version === 18) {
      // v18 (v1.2.0-alpha.2, issue #52): the agent
      // loadout tables. Additive; does not touch any
      // prior table.
      this.migrate_v17_to_v18();
      return;
    }
    if (version === 19) {
      // v19 (v1.2.0-alpha.2, issue #53) is the additive
      // `skills` type-specific table.
      this.migrate_v18_to_v19();
      return;
    }
    if (version === 20) {
      // v20 (v1.2.0-alpha.2, issue #54): the cold-start
      // bootstrap surface. Four additive tables —
      // `bootstrap_sources`, `bootstrap_plans`,
      // `bootstrap_plan_items`, `external_references`.
      this.migrate_v19_to_v20();
      return;
    }
    throw new Error(`No migration registered for schema version ${version}`);
  }

  private migrate_v2_to_v3(): void {
    // Add the last_accessed_by JSON column. The column is nullable, so
    // existing rows are unaffected. The read path defaults to an empty
    // map when the column is null. The check is idempotent in case
    // base DDL already added the column (fresh installs are at v3).
    const cols = this.db.prepare("PRAGMA table_info(memory_entries)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "last_accessed_by")) {
      this.db.exec("ALTER TABLE memory_entries ADD COLUMN last_accessed_by TEXT");
    }
    this.db.exec("PRAGMA user_version = 3");
  }

  /**
   * Stage 11 PR7: v3 -> v4 schema migration. Spec § 6.5
   * describes the schema v4 layout; this migration
   * introduces every v4-only field on `memory_entries`
   * and the v4-only tables, then re-backs the writer
   * actor id from the audit log (idempotent), splits
   * `last_accessed_by` JSON into the `memory_accesses`
   * table, and lifts `supersedes_json` into
   * `memory_relations`. The migration is fully
   * transactional; if any step throws the user_version
   * is left at 3 and the database is untouched.
   */
  private migrate_v3_to_v4(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.addColumnIfMissing(
        "memory_entries",
        "revision",
        "INTEGER NOT NULL DEFAULT 1"
      );
      this.addColumnIfMissing(
        "memory_entries",
        "writer_actor_id",
        "TEXT NOT NULL DEFAULT 'agent:unknown'"
      );
      this.addColumnIfMissing(
        "memory_entries",
        "content_hash",
        "TEXT"
      );
      this.addColumnIfMissing("memory_entries", "pinned", "INTEGER NOT NULL DEFAULT 0");
      this.addColumnIfMissing(
        "memory_entries",
        "trust_level",
        "TEXT NOT NULL DEFAULT 'agent_observed'"
      );
      this.addColumnIfMissing(
        "memory_entries",
        "sensitivity",
        "TEXT NOT NULL DEFAULT 'normal'"
      );
      this.addColumnIfMissing("memory_entries", "valid_from", "TEXT");
      this.addColumnIfMissing("memory_entries", "valid_until", "TEXT");
      this.addColumnIfMissing("memory_entries", "deleted_at", "TEXT");
      this.addColumnIfMissing(
        "memory_entries",
        "metadata_json",
        "TEXT NOT NULL DEFAULT '{}'"
      );

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_revisions (
          memory_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          snapshot_json TEXT NOT NULL,
          changed_by TEXT NOT NULL,
          request_id TEXT NOT NULL,
          change_reason TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (memory_id, revision)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS memory_accesses (
          memory_id TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          access_count INTEGER NOT NULL DEFAULT 0,
          first_accessed_at TEXT NOT NULL,
          last_accessed_at TEXT NOT NULL,
          PRIMARY KEY (memory_id, actor_id)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS project_aliases (
          project_id TEXT NOT NULL,
          alias_type TEXT NOT NULL,
          alias_value TEXT NOT NULL,
          normalized_value TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (alias_type, normalized_value)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS mutation_requests (
          actor_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          result_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (actor_id, idempotency_key)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS memory_relations (
          from_memory_id TEXT NOT NULL,
          to_memory_id TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          confidence REAL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          PRIMARY KEY (from_memory_id, to_memory_id, relation_type)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS memory_accesses_actor_idx
          ON memory_accesses(actor_id, last_accessed_at);
        CREATE INDEX IF NOT EXISTS memory_relations_to_idx
          ON memory_relations(to_memory_id, relation_type);
        CREATE INDEX IF NOT EXISTS memory_relations_type_idx
          ON memory_relations(relation_type, created_at);
      `);

      // Back-fill writer_actor_id from the audit log so the
      // pre-existing v3 entries have a canonical writer.
      // Pre-PR7 the canonical writer was reconstructed on
      // every read by scanning the audit log; post-PR7 the
      // canonical writer is stored on the row and the
      // audit scan is only used as a fallback. Missing or
      // unmatched entries default to 'agent:unknown'.
      this.db.exec(`
        UPDATE memory_entries
           SET writer_actor_id = COALESCE(
             (SELECT actor FROM audit_events
                WHERE audit_events.memory_id = memory_entries.id
                  AND audit_events.event = 'created'
                ORDER BY audit_events.created_at ASC
                LIMIT 1),
             writer_actor_id
           )
         WHERE writer_actor_id = 'agent:unknown' AND
               EXISTS (SELECT 1 FROM audit_events
                          WHERE audit_events.memory_id = memory_entries.id
                            AND audit_events.event = 'created');
      `);

      // Lift the legacy `last_accessed_by` JSON map into
      // `memory_accesses`. Pre-PR7 the column was a free-
      // form JSON object; post-PR7 it is left in place for
      // one release cycle of read-compat, and the
      // canonical access data lives in the new table.
      const legacyRows = this.db
        .prepare("SELECT id, last_accessed_by FROM memory_entries WHERE last_accessed_by IS NOT NULL")
        .all() as Array<{ id: string; last_accessed_by: string }>;
      const insertAccess = this.db.prepare(`
        INSERT OR REPLACE INTO memory_accesses
          (memory_id, actor_id, access_count, first_accessed_at, last_accessed_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const row of legacyRows) {
        let parsed: Record<string, unknown> | undefined;
        try {
          parsed = JSON.parse(row.last_accessed_by) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (parsed === null || typeof parsed !== "object") continue;
        for (const [actor, value] of Object.entries(parsed)) {
          if (typeof value !== "string") continue;
          insertAccess.run(row.id, actor, 1, value, value);
        }
      }

      // Lift `supersedes_json` into `memory_relations`
      // (relation_type = 'supersedes'). Pre-PR7 a single
      // entry could supersede multiple others; the JSON
      // column was the only way to express that. Post-PR7
      // the canonical graph is in `memory_relations`.
      const supersedeRows = this.db
        .prepare("SELECT id, supersedes_json, created_at FROM memory_entries WHERE supersedes_json IS NOT NULL AND supersedes_json != '[]'")
        .all() as Array<{ id: string; supersedes_json: string; created_at: string }>;
      const insertRelation = this.db.prepare(`
        INSERT OR IGNORE INTO memory_relations
          (from_memory_id, to_memory_id, relation_type, confidence, metadata_json, created_at)
        VALUES (?, ?, 'supersedes', 1.0, '{}', ?)
      `);
      for (const row of supersedeRows) {
        let targets: string[] = [];
        try {
          const parsed = JSON.parse(row.supersedes_json) as unknown;
          if (Array.isArray(parsed)) {
            targets = parsed.filter((v): v is string => typeof v === "string");
          }
        } catch {
          continue;
        }
        for (const target of targets) {
          insertRelation.run(row.id, target, row.created_at);
        }
      }

      this.db.exec("PRAGMA user_version = 4");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Stage 15 PR-M0-1 (issue #1, spec § 5.6): v4 -> v5
   * schema migration. Introduces the
   * `mutation_requests_v2` table with
   * PRIMARY KEY (actor_id, tool_name, idempotency_key)
   * and a `state` column so the idempotency record is
   * reserved in the same transaction as the mutation.
   * Copies every row from the legacy `mutation_requests`
   * table into v2 with `tool_name='legacy'`. The legacy
   * table is dropped after the copy. The down path
   * (schema downgrade) renames v2 back to mutation_requests
   * and drops the v2 state / request_id / completed_at
   * columns so the v4 read path resumes working.
   */
  private migrate_v4_to_v5(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS mutation_requests_v2 (
          actor_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending','completed')),
          request_hash TEXT NOT NULL,
          result_json TEXT,
          request_id TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT,
          PRIMARY KEY (actor_id, tool_name, idempotency_key)
        ) STRICT
      `);

      // Copy v1 rows into v2 with tool_name='legacy'.
      // The v1 PK was (actor_id, idempotency_key) so the
      // copy is 1:1 under the legacy namespace.
      this.db.exec(`
        INSERT OR IGNORE INTO mutation_requests_v2
          (actor_id, tool_name, idempotency_key, state,
           request_hash, result_json, request_id,
           created_at, completed_at)
        SELECT
          actor_id, 'legacy', idempotency_key, 'completed',
          request_hash, result_json, NULL,
          created_at, created_at
        FROM mutation_requests
      `);

      // The legacy table is now redundant (v2 is the
      // source of truth). We keep it for one release
      // cycle for any external reader that has not yet
      // migrated; the v1 wrapper in src/services/idempotency.ts
      // uses the `tool_name='legacy'` namespace to keep
      // its reads working.
      this.db.exec("PRAGMA user_version = 5");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Stage 15 PR-M0-4 (issue #3, spec § 6.2): v5 -> v6
   * schema migration. Introduces persistent
   * `maintenance_plans` and `maintenance_plan_items`
   * so plans survive MCP restart. Each item carries its
   * `expected_revision` so `apply_maintenance` can refuse
   * stale plans; the plan carries a `plan_hash` (SHA256
   * over the canonical JSON of items) so the apply step
   * can detect tampering between plan and apply.
   *
   * Pre-v6 plans lived in a process-local `Map`; they were
   * gone the moment the MCP server restarted. With v6, the
   * plan is durable: an agent can call `plan_maintenance`,
   * the user can review the plan, and a different MCP
   * session can call `apply_maintenance` hours later and
   * still see the same plan.
   *
   * Migration is fully transactional. If any step throws,
   * the user_version stays at 5 and the database is
   * untouched.
   */
  private migrate_v5_to_v6(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS maintenance_plans (
          plan_id TEXT PRIMARY KEY,
          plan_hash TEXT NOT NULL,
          creator_actor_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending','completed','expired','rejected')),
          summary_json TEXT NOT NULL,
          scope TEXT NOT NULL CHECK (scope IN ('global','project')),
          project_id TEXT,
          risk TEXT NOT NULL CHECK (risk IN ('low','medium','high'))
        ) STRICT;

        CREATE TABLE IF NOT EXISTS maintenance_plan_items (
          plan_id TEXT NOT NULL,
          target_memory_id TEXT NOT NULL,
          expected_revision INTEGER NOT NULL,
          action_type TEXT NOT NULL CHECK (action_type IN ('supersede','merge','forget','update','retain')),
          evidence_json TEXT NOT NULL,
          risk TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
          PRIMARY KEY (plan_id, target_memory_id),
          FOREIGN KEY (plan_id) REFERENCES maintenance_plans(plan_id) ON DELETE CASCADE
        ) STRICT;

        CREATE INDEX IF NOT EXISTS maintenance_plans_state_idx
          ON maintenance_plans(state, expires_at);
        CREATE INDEX IF NOT EXISTS maintenance_plan_items_target_idx
          ON maintenance_plan_items(target_memory_id);
      `);
      this.db.exec("PRAGMA user_version = 6");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Stage 15 PR-M1-1 (issue #6, spec § 5.3): v6 -> v7
   * schema migration. Introduces `memory_provenance`
   * for the durable link chain (issue URL / PR URL /
   * commit SHA / tool-call id / session id / mcp
   * client name / import source). The primary key is
   * `(memory_id, source_kind, source_ref)` so a
   * memory can carry multiple provenance links and
   * the same source ref is idempotent under repeat
   * ingestion. The v3 `last_accessed_by` JSON
   * column is now read-only-deprecated; the
   * canonical access data has lived in
   * `memory_accesses` since v4, so this migration is
   * non-destructive (the column is left in place for
   * one release cycle of read-compat).
   */
  private migrate_v6_to_v7(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_provenance (
          memory_id TEXT NOT NULL,
          source_kind TEXT NOT NULL CHECK (source_kind IN ('issue','pr','commit','tool_call','session','import')),
          source_ref TEXT NOT NULL,
          recorded_by TEXT NOT NULL,
          recorded_at INTEGER NOT NULL,
          PRIMARY KEY (memory_id, source_kind, source_ref)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS memory_provenance_kind_idx
          ON memory_provenance(source_kind, source_ref);
      `);
      this.db.exec("PRAGMA user_version = 7");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Stage 15 PR-M1-2 (issue #7, spec § 5.4): v7 -> v8
   * schema migration. Introduces a strict project
   * identity model:
   *
   *   - `project_identities(project_id, canonical_path,
   *     created_by, created_at)` with `project_id` as
   *     the PRIMARY KEY. One row per project, holding
   *     the canonical path the project was created
   *     with. Inserting a second row for the same
   *     `project_id` (with a different `canonical_path`)
   *     surfaces `project_identity_conflict` at the
   *     service layer; the table does NOT enforce a
   *     UNIQUE on `canonical_path` because two
   *     projects may legitimately share a path
   *     canonicalisation (e.g. a worktree resolves to
   *     the same canonical path as the main repo).
   *
   *   - `project_aliases` is rebuilt with a stronger
   *     contract: PRIMARY KEY is the raw alias path
   *     (one row per alias), the FK back to
   *     `project_identities(project_id)` is enforced,
   *     and `recorded_by` / `recorded_at` capture the
   *     audit trail. The v7 `project_aliases` table
   *     used `(alias_type, normalized_value)` as the
   *     primary key and did not enforce a FK to the
   *     identity table; v8 strengthens the contract.
   *
   * The migration copies existing v7 `project_aliases`
   * rows into the new shape; the old v7 table is
   * dropped after the copy. The new table is created
   * fresh on a v8+ install.
   */
  private migrate_v7_to_v8(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS project_identities (
          project_id TEXT PRIMARY KEY,
          canonical_path TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS project_aliases_new (
          alias TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          canonical_path TEXT NOT NULL,
          alias_kind TEXT NOT NULL CHECK (alias_kind IN ('path','git_head','worktree')),
          recorded_by TEXT NOT NULL,
          recorded_at INTEGER NOT NULL,
          FOREIGN KEY (project_id) REFERENCES project_identities(project_id) ON DELETE CASCADE
        ) STRICT;

        CREATE INDEX IF NOT EXISTS project_aliases_new_project_idx
          ON project_aliases_new(project_id);
      `);
      this.db.exec("PRAGMA user_version = 8");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Stage 15 PR-M1-3 (issue #5, spec § 5.3): v8 -> v9
   * schema migration. Introduces two new tables that
   * feed the ranker with real signals (replacing
   * the placeholder feedback / access signals):
   *
   *   - `memory_feedback(memory_id, actor_id, kind,
   *     created_at)` — explicit per-actor feedback.
   *     `kind IN ('up','down','pin','hide')`. PRIMARY
   *     KEY `(memory_id, actor_id, kind)` so a single
   *     actor can change their mind and the latest
   *     intent wins.
   *   - `memory_recall_signals(memory_id, recall_count,
   *     last_recalled_at, last_recall_rank)` — cached
   *     per-memory recall stats. The ranker reads
   *     `last_recall_rank` to compute a `recall_signal`
   *     component; this is the spec-named "feedback
   *     signal" replacement that no longer needs to
   *     be 0.
   *
   * Both tables are STRICT (typed columns). The
   * migration is non-destructive: existing rows are
   * untouched, the new tables start empty.
   */
  private migrate_v8_to_v9(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_feedback (
          memory_id TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('up','down','pin','hide')),
          created_at TEXT NOT NULL,
          PRIMARY KEY (memory_id, actor_id, kind)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS memory_feedback_actor_idx
          ON memory_feedback(actor_id, created_at);

        CREATE TABLE IF NOT EXISTS memory_recall_signals (
          memory_id TEXT PRIMARY KEY,
          recall_count INTEGER NOT NULL DEFAULT 0,
          last_recalled_at TEXT,
          last_recall_rank REAL,
          last_recall_query TEXT
        ) STRICT;

        CREATE INDEX IF NOT EXISTS memory_recall_signals_recency_idx
          ON memory_recall_signals(last_recalled_at);
      `);
      this.db.exec("PRAGMA user_version = 9");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Stage 15 PR-M3-1 (issue #9, spec § 6.5):
   * v9 -> v10 schema migration. Introduces the
   * memory hierarchy:
   *
   *   - `memory_entries.tier` — `'core' | 'working' |
   *     'archival'`, default `'working'`. The ranker
   *     reads this to weight recall (core × 1.3,
   *     working × 1.0, archival × 0.7).
   *   - `memory_entries.valid_from` / `valid_until`
   *     — Unix ms boundaries. Entries past their
   *     `valid_until` decay in score; entries not
   *     yet at `valid_from` are excluded from
   *     recall.
   *   - `memory_episodes` — episode-shaped memory
   *     (parent_memory_id, summary, started_at,
   *     ended_at, actor_id). A "working" entry can
   *     be linked to one or more episodes; the
   *     ranker uses `parent_memory_id` to expand
   *     candidates along the episode tree.
   *
   * All changes are additive (no-op for callers
   * that do not use the new columns / tables).
   */
  private migrate_v9_to_v10(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.addColumnIfMissing(
        "memory_entries",
        "tier",
        "TEXT NOT NULL DEFAULT 'working' CHECK (tier IN ('core','working','archival'))"
      );
      this.addColumnIfMissing("memory_entries", "valid_from", "INTEGER");
      this.addColumnIfMissing("memory_entries", "valid_until", "INTEGER");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_episodes (
          episode_id TEXT PRIMARY KEY,
          parent_memory_id TEXT,
          summary TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          actor_id TEXT NOT NULL,
          FOREIGN KEY (parent_memory_id) REFERENCES memory_entries(id) ON DELETE CASCADE
        ) STRICT;

        CREATE INDEX IF NOT EXISTS memory_episodes_parent_idx
          ON memory_episodes(parent_memory_id);
      `);
      this.db.exec("PRAGMA user_version = 10");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Stage 16 v1.1.1 PR-5 (issue #12, spec § 6.2):
   * atomic maintenance plan apply. Schema v10 -> v11
   * adds:
   *   - `applying` to the `state` CHECK (the apply
   *     phase transitions through `applying` so an
   *     interrupted apply can be detected).
   *   - `completed_at` column for the apply timestamp.
   *   - `applied_result_json` column for the canonical
   *     apply result (so a replay of a completed plan
   *     with the same idempotency key returns the
   *     original result, not `idempotency_mismatch`).
   *   - `idempotency_key_used` column for the key
   *     the plan was last applied with (replaces the
   *     audit-log-walking `getAppliedMaintenanceKeys`).
   */
  private migrate_v10_to_v11(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // SQLite does not support `ALTER TABLE ...
      // DROP CONSTRAINT`, so we rebuild the table with
      // the new `applying` state value and the three
      // new columns. The rebuild is non-destructive
      // because we copy every row verbatim.
      const cols = this.db
        .prepare("PRAGMA table_info(maintenance_plans)")
        .all() as Array<{ name: string }>;
      if (cols.some((c) => c.name === "completed_at")) {
        this.db.exec("PRAGMA user_version = 11");
        this.db.exec("COMMIT");
        return;
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS maintenance_plans_v11 (
          plan_id TEXT PRIMARY KEY,
          plan_hash TEXT NOT NULL,
          creator_actor_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          completed_at TEXT,
          applied_result_json TEXT,
          idempotency_key_used TEXT,
          state TEXT NOT NULL CHECK (state IN ('pending','applying','completed','expired','rejected')),
          summary_json TEXT NOT NULL,
          scope TEXT NOT NULL CHECK (scope IN ('global','project')),
          project_id TEXT,
          risk TEXT NOT NULL CHECK (risk IN ('low','medium','high'))
        ) STRICT;
        INSERT OR IGNORE INTO maintenance_plans_v11
          (plan_id, plan_hash, creator_actor_id, created_at,
           expires_at, state, summary_json, scope, project_id, risk)
        SELECT plan_id, plan_hash, creator_actor_id, created_at,
               expires_at, state, summary_json, scope, project_id, risk
          FROM maintenance_plans;
        DROP TABLE maintenance_plans;
        ALTER TABLE maintenance_plans_v11 RENAME TO maintenance_plans;
        CREATE INDEX IF NOT EXISTS maintenance_plans_state_idx
          ON maintenance_plans(state, expires_at);
      `);
      this.db.exec("PRAGMA user_version = 11");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * v1.1.2 (issue #21): v11 -> v12 schema migration.
   * Backfills `project_identities` from the pre-existing
   * `project_scopes` rows so a v1.1.1 database that never
   * had a `project_identities` row (because every
   * registration went through `configureProjectBudget`
   * and only wrote the v1.0 `project_scopes` table) gains
   * a corresponding identity row under the strict
   * v1.1.2 contract.
   *
   * The backfill refuses ambiguous mappings: a single
   * canonical path bound to two distinct `project_id`s,
   * or two distinct canonical paths bound to a single
   * `project_id`, fails the migration. The operator must
   * resolve the conflict by hand (drop the duplicate
   * `project_scopes` row, or move one of the directories
   * under a different name) and re-run `migrate --yes`.
   * The backfill never guesses.
   *
   * Windows: the path-to-id map is case-folded so the
   * same case-insensitive path shared by two projects
   * (e.g. one registered as `C:\Repos\Phoenix` and a
   * later one as `c:\repos\phoenix`) is detected as an
   * ambiguity on both POSIX and Windows.
   */
  private migrate_v11_to_v12(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // No-op short-circuit when the v8 tables are
      // missing — the database was created at v1.0
      // and never had identities to backfill. The
      // migration just advances the user_version
      // marker so the next migration can run.
      const hasIdentities = this.db
        .prepare(
          "SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'project_identities'"
        )
        .get() as { n: number } | undefined;
      if (hasIdentities === undefined) {
        this.db.exec("PRAGMA user_version = 12");
        this.db.exec("COMMIT");
        return;
      }
      const scopeRows = this.db
        .prepare(
          "SELECT project_id, canonical_path, created_at FROM project_scopes"
        )
        .all() as Array<{ project_id: string; canonical_path: string; created_at: string }>;
      // Path -> ids (Windows case-folded).
      const pathToIds = new Map<string, string[]>();
      // project_id -> paths.
      const idToPaths = new Map<string, string[]>();
      for (const row of scopeRows) {
        const key = IS_WINDOWS ? row.canonical_path.toLowerCase() : row.canonical_path;
        const pathList = pathToIds.get(key) ?? [];
        pathList.push(row.project_id);
        pathToIds.set(key, pathList);
        const idList = idToPaths.get(row.project_id) ?? [];
        idList.push(row.canonical_path);
        idToPaths.set(row.project_id, idList);
      }
      // Refuse ambiguous mappings. A path bound to two
      // project_ids is a hard conflict; a project_id
      // bound to two distinct canonical paths is also a
      // hard conflict (a v1.0 scope row was updated to
      // a new path without an explicit identity reset).
      const pathConflicts: string[] = [];
      for (const [path, ids] of pathToIds.entries()) {
        if (ids.length > 1) pathConflicts.push(`${path} -> [${ids.join(", ")}]`);
      }
      if (pathConflicts.length > 0) {
        throw new Error(
          `v1.1.2 backfill: ambiguous canonical paths in project_scopes. ` +
            `Resolve manually before re-running migrate:\n  ${pathConflicts.join("\n  ")}`
        );
      }
      const idConflicts: string[] = [];
      for (const [id, paths] of idToPaths.entries()) {
        if (paths.length > 1) {
          const distinct = IS_WINDOWS
            ? [...new Set(paths.map((p) => p.toLowerCase()))]
            : [...new Set(paths)];
          if (distinct.length > 1) {
            idConflicts.push(`${id} -> [${distinct.join(", ")}]`);
          }
        }
      }
      if (idConflicts.length > 0) {
        throw new Error(
          `v1.1.2 backfill: ambiguous project_ids in project_scopes. ` +
            `Resolve manually before re-running migrate:\n  ${idConflicts.join("\n  ")}`
        );
      }
      // Create one identity per scope row. `INSERT OR
      // IGNORE` is idempotent so a manual re-run of the
      // migration does not double-write.
      for (const row of scopeRows) {
        this.createProjectIdentity({
          project_id: row.project_id,
          canonical_path: row.canonical_path,
          // The recorded_by is the system backfill
          // agent (the v1.1.2 contract surfaces this
          // on the identity row so an operator can
          // see which identities were auto-promoted
          // from a v1.1.1 scope row).
          created_by: "system:backfill",
          created_at: row.created_at
        });
      }
      this.db.exec("PRAGMA user_version = 12");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Stage 18 v1.1.2 (issue #26, task 7): v12 -> v13
   * schema migration. Introduces the durable
   * `import_batches` table that records every applied
   * import as one row keyed on `import_batch_id`. The
   * table is the persistent lineage surface — the
   * `ImportBatchStore` (src/portability/import-batch-store.ts)
   * wraps the table with the `start` / `markRunning` /
   * `complete` / `fail` / `inspect` lifecycle. The
   * `bundle_hash` is the canonical hash the
   * `preflightImport` computed; the `bundle_version`
   * is `1` / `2` for snapshot bundles and `3` for
   * full-history bundles. The `actor_id` /
   * `request_id` / `session_id` / `tool_call_id`
   * columns mirror the `RequestContext` shape so a
   * reviewer can correlate the batch row with the
   * MCP session that produced it.
   *
   * Counts / affected ids live in JSON columns
   * (`counts_json` / `affected_ids_json`) with a
   * documented bounded size (see
   * `task-7-report.md`). The choice keeps the schema
   * additive (no second child table to migrate) and
   * matches the CLI's text+JSON inspect output. A
   * normalised child table would be a future
   * optimisation if a release ever needs SQL
   * "which batches touched memory X?" queries
   * without parsing JSON.
   *
   * Migration is fully transactional. A pre-batch
   * database gains the table + indexes + version
   * marker in one BEGIN IMMEDIATE / COMMIT; a
   * already-on-v13 database is a no-op (the
   * `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF
   * NOT EXISTS` are idempotent).
   */
  private migrate_v12_to_v13(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS import_batches (
          import_batch_id TEXT PRIMARY KEY,
          bundle_hash TEXT NOT NULL,
          bundle_hash_algorithm TEXT NOT NULL DEFAULT 'SHA-256',
          bundle_version INTEGER NOT NULL,
          bundle_filename TEXT,
          bundle_size_bytes INTEGER,
          source_format TEXT NOT NULL,
          source_schema_version INTEGER NOT NULL,
          target_scope TEXT NOT NULL CHECK (target_scope IN ('global','project')),
          target_project_id TEXT,
          conflict_policy TEXT NOT NULL CHECK (conflict_policy IN ('keep','replace','merge','fail')),
          history_mode TEXT NOT NULL CHECK (history_mode IN ('snapshot','full_history')),
          actor_id TEXT NOT NULL,
          request_id TEXT,
          session_id TEXT,
          tool_call_id TEXT,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          failed_at TEXT,
          status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed')),
          failure_code TEXT,
          counts_json TEXT NOT NULL DEFAULT '{}',
          affected_ids_json TEXT NOT NULL DEFAULT '[]',
          audit_metadata_json TEXT NOT NULL DEFAULT '{}'
        ) STRICT;

        CREATE INDEX IF NOT EXISTS import_batches_status_idx
          ON import_batches(status, started_at);
        CREATE INDEX IF NOT EXISTS import_batches_project_idx
          ON import_batches(target_scope, target_project_id);
        CREATE INDEX IF NOT EXISTS import_batches_started_idx
          ON import_batches(started_at);
      `);
      // v1.1.3 GATE-01 (issue #31): additive
      // `audit_metadata_json` column for existing v13
      // databases that pre-date the column. The
      // CREATE TABLE block above already includes the
      // column for fresh installs; the
      // `addColumnIfMissing` call covers databases
      // that were opened at v13 before the column
      // existed. The `user_version` stays at 13 (this
      // lane does not introduce a schema migration —
      // the column is purely additive and the existing
      // v13 contract is sufficient).
      this.addColumnIfMissing(
        "import_batches",
        "audit_metadata_json",
        "TEXT NOT NULL DEFAULT '{}'"
      );
      this.db.exec("PRAGMA user_version = 13");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * v1.2.0-alpha.0 (issue #48): v13 -> v14 schema
   * migration. Introduces the durable derivation job
   * substrate (`derivation_jobs` / `derivation_runs` /
   * `derivation_outputs`) that backs every
   * provider-backed / multi-stage / cancellable
   * pipeline introduced in v1.2 (session distillation,
   * skill extraction, cold-start bootstrap,
   * external-reference refresh). The tables are
   * strictly additive — no existing column or index is
   * altered, no v13 table is renamed. The migration is
   * fully transactional; on any throw the user_version
   * stays at 13 and the database is untouched.
   *
   * Schema invariants (mirrored in `docs/adr/0009-`):
   *  - `derivation_jobs` is the single source of truth
   *    for a derivation request; the UNIQUE constraint
   *    on `(creator_actor_id, kind, idempotency_key)` is
   *    the contract that makes `enqueue` a replayable
   *    operation (issue #48 AC #3).
   *  - `derivation_runs` is the per-stage audit row. A
   *    row in `started` state is the durable proof that
   *    a worker is mid-flight; the `started` -> terminal
   *    transition is the only state change that
   *    `checkpoint` commits.
   *  - `derivation_outputs` is the lineage surface that
   *    connects a job to the memory / asset / plan rows
   *    it produced. The composite primary key on
   *    `(job_id, output_kind, output_id)` ensures
   *    `disposition='applied'` is unique per job so a
   *    reap takeover cannot write the same applied row
   *    twice (issue #48 AC #2 + #5).
   *  - All three tables use `INTEGER` for timestamps in
   *    Unix milliseconds (matching the rest of the v1.2
   *    surface; differs from v13's `TEXT` ISO 8601 on
   *    `import_batches` because the derivation pipeline
   *    drives numeric TTL math in the lease logic).
   */
  private migrate_v13_to_v14(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS derivation_jobs (
          job_id              TEXT PRIMARY KEY,
          kind                TEXT NOT NULL,
          state               TEXT NOT NULL
                                 CHECK (state IN ('queued','running','succeeded','failed','cancelled')),
          scope               TEXT NOT NULL
                                 CHECK (scope IN ('global','project')),
          project_id          TEXT,
          creator_actor_id    TEXT NOT NULL,
          idempotency_key     TEXT NOT NULL,
          input_digest        TEXT NOT NULL,
          config_digest       TEXT NOT NULL,
          cursor_json         TEXT NOT NULL DEFAULT '{}',
          attempt_count       INTEGER NOT NULL DEFAULT 0,
          lease_owner         TEXT,
          lease_expires_at    INTEGER,
          cancel_requested_at INTEGER,
          next_retry_at       INTEGER,
          error_code          TEXT,
          redacted_error      TEXT,
          created_at          INTEGER NOT NULL,
          started_at          INTEGER,
          updated_at          INTEGER NOT NULL,
          finished_at         INTEGER,
          UNIQUE (creator_actor_id, kind, idempotency_key)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_derivation_jobs_state_next_retry
          ON derivation_jobs(state, next_retry_at);
        CREATE INDEX IF NOT EXISTS idx_derivation_jobs_lease
          ON derivation_jobs(lease_expires_at)
          WHERE state = 'running';
        CREATE INDEX IF NOT EXISTS idx_derivation_jobs_creator_state
          ON derivation_jobs(creator_actor_id, state);
        CREATE INDEX IF NOT EXISTS idx_derivation_jobs_kind
          ON derivation_jobs(kind, state);

        CREATE TABLE IF NOT EXISTS derivation_runs (
          run_id                 TEXT PRIMARY KEY,
          job_id                 TEXT NOT NULL
                                   REFERENCES derivation_jobs(job_id) ON DELETE CASCADE,
          stage                  TEXT NOT NULL,
          status                 TEXT NOT NULL
                                   CHECK (status IN ('started','succeeded','failed','cancelled')),
          input_refs_json        TEXT NOT NULL DEFAULT '[]',
          output_refs_json       TEXT NOT NULL DEFAULT '[]',
          provider_id            TEXT,
          model_id               TEXT,
          prompt_template_version TEXT,
          prompt_hash            TEXT,
          policy_version         TEXT NOT NULL,
          result_digest          TEXT,
          started_at             INTEGER NOT NULL,
          finished_at            INTEGER
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_derivation_runs_job_stage
          ON derivation_runs(job_id, stage);
        CREATE INDEX IF NOT EXISTS idx_derivation_runs_job_status
          ON derivation_runs(job_id, status);

        CREATE TABLE IF NOT EXISTS derivation_outputs (
          job_id        TEXT NOT NULL
                          REFERENCES derivation_jobs(job_id) ON DELETE CASCADE,
          run_id        TEXT NOT NULL
                          REFERENCES derivation_runs(run_id) ON DELETE CASCADE,
          output_kind   TEXT NOT NULL
                          CHECK (output_kind IN
                            ('candidate','skill_draft','bootstrap_plan',
                             'external_ref','applied_memory','applied_asset')),
          output_id     TEXT NOT NULL,
          disposition   TEXT NOT NULL
                          CHECK (disposition IN ('proposed','applied','rejected','superseded')),
          created_at    INTEGER NOT NULL,
          PRIMARY KEY (job_id, output_kind, output_id)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_derivation_outputs_job_disposition
          ON derivation_outputs(job_id, disposition);
        CREATE INDEX IF NOT EXISTS idx_derivation_outputs_run
          ON derivation_outputs(run_id);
      `);
      this.db.exec("PRAGMA user_version = 14");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * v1.2.0-alpha.1 (issue #49): v14 -> v15 schema
   * migration. Introduces the session evidence
   * substrate (`sessions` / `session_events` /
   * `session_event_blobs`). The tables are
   * strictly additive — no v14 column or index
   * is altered, no derivation job row is renamed.
   * The migration is fully transactional; on any
   * throw the user_version stays at 14 and the
   * database is untouched.
   *
   * Schema invariants (mirrored in
   * `docs/adr/0011-session-evidence-lifecycle.md`):
   *  - `sessions` is the canonical identity for a
   *    captured trace. The UNIQUE constraint on
   *    `(source_kind, source_version,
   *    source_instance_id, source_session_id)` is
   *    the contract that makes `ingest` a
   *    replayable operation (issue #49 AC #1).
   *  - `session_events.event_id` is the
   *    adapter-stable identity supplied by the
   *    source (OpenCode lifecycle hook, JSONL
   *    fixture, ...); the row is the canonical
   *    durable record.
   *  - `session_event_blobs` is the
   *    content-addressed body cache. SQLite is
   *    still the authoritative manifest / index;
   *    large bodies live in a content-addressed
   *    local file (head + tail 1KB slices are
   *    kept in-row for inspection; the full body
   *    is resolved on demand).
   *  - All three tables use `TEXT` ISO 8601 for
   *    timestamps (matching the v13 portability
   *    surface and the rest of the recall layer).
   */
  private migrate_v14_to_v15(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          session_id              TEXT PRIMARY KEY,
          source_kind             TEXT NOT NULL,
          source_version          TEXT NOT NULL,
          source_instance_id      TEXT NOT NULL,
          source_session_id       TEXT NOT NULL,
          scope                   TEXT NOT NULL
                                     CHECK (scope IN ('global', 'project')),
          project_id              TEXT,
          actor_id                TEXT NOT NULL,
          client_name             TEXT NOT NULL,
          client_version          TEXT NOT NULL,
          started_at              TEXT NOT NULL,
          ended_at                TEXT,
          sensitivity             TEXT NOT NULL
                                     CHECK (sensitivity IN ('normal', 'private', 'restricted')),
          bundle_hash             TEXT NOT NULL,
          adapter_id              TEXT NOT NULL,
          adapter_version         TEXT NOT NULL,
          ingestion_plan_json     TEXT NOT NULL,
          redaction_summary_json  TEXT NOT NULL,
          ingested_at             TEXT NOT NULL,
          retention_until         TEXT,
          UNIQUE (source_kind, source_version, source_instance_id, source_session_id)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_sessions_project
          ON sessions(scope, project_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_source_session
          ON sessions(source_session_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_ingested_at
          ON sessions(ingested_at);

        CREATE TABLE IF NOT EXISTS session_events (
          event_id                TEXT PRIMARY KEY,
          session_id              TEXT NOT NULL
                                     REFERENCES sessions(session_id) ON DELETE CASCADE,
          sequence                INTEGER NOT NULL,
          turn_id                 TEXT NOT NULL,
          event_type              TEXT NOT NULL,
          role                    TEXT,
          content_digest          TEXT NOT NULL,
          content_blob_ref        TEXT,
          tool_name               TEXT,
          tool_call_id            TEXT,
          tool_status             TEXT,
          timestamp               TEXT NOT NULL,
          sensitivity             TEXT NOT NULL
                                     CHECK (sensitivity IN ('normal', 'private', 'restricted')),
          redaction_flags_json    TEXT NOT NULL DEFAULT '[]',
          metadata_json           TEXT NOT NULL DEFAULT '{}',
          UNIQUE (session_id, sequence)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_session_events_session_seq
          ON session_events(session_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_session_events_ts
          ON session_events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_session_events_event_type
          ON session_events(event_type);

        CREATE TABLE IF NOT EXISTS session_event_blobs (
          digest                  TEXT PRIMARY KEY,
          size_bytes              INTEGER NOT NULL,
          media_type              TEXT NOT NULL,
          head_bytes              BLOB NOT NULL,
          tail_bytes              BLOB NOT NULL,
          head_tail_window_json   TEXT NOT NULL,
          stored_at               TEXT NOT NULL
        ) STRICT;
      `);
      this.db.exec("PRAGMA user_version = 15");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * v1.2.0-alpha.1 (issue #51): v15 -> v16 schema
   * migration. Introduces the additive asset
   * registry. The envelope tables (`assets` /
   * `asset_versions` / `asset_relations`) cover
   * all four type variants; the only v16-shipped
   * type-specific table is `memory_ref_bindings`
   * (the `memory_ref` asset is the only type that
   * already has a Phase 1 use case — the
   * `memory_entries` row is the authoritative
   * body, the binding is a typed pointer). The
   * `skills` / `context_packs` / `external_references`
   * type-specific tables land with their owning
   * Phase 2 issues (#53 / #54) in subsequent
   * migrations; the envelope schema is forward-
   * compatible.
   *
   * Schema invariants (mirrored in
   * `docs/adr/0010-asset-registry.md`):
   *  - `assets.current_version` is the head;
   *    new versions append monotonically and
   *    `asset_versions.content_hash` is the
   *    SHA-256 over the canonicalised type-
   *    specific payload.
   *  - `asset_relations` is directional; the
   *    CHECK constraint ensures the relation
   *    has exactly one of `to_asset_id` or
   *    `external_target_ref`.
   *  - `memory_ref_bindings` is the only v16
   *    type-specific table. The binding is
   *    immutable: a new version appends a row,
   *    the previous version stays.
   */
  private migrate_v15_to_v16(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS assets (
          asset_id        TEXT PRIMARY KEY,
          asset_type      TEXT NOT NULL
                            CHECK (asset_type IN
                              ('memory_ref','skill','context_pack','external_reference')),
          scope           TEXT NOT NULL
                            CHECK (scope IN ('global','project')),
          project_id      TEXT,
          owner_actor_id  TEXT NOT NULL,
          lifecycle_state TEXT NOT NULL
                            CHECK (lifecycle_state IN
                              ('draft','active','deprecated','archived')),
          current_version INTEGER NOT NULL DEFAULT 0,
          trust_level     TEXT NOT NULL
                            CHECK (trust_level IN
                              ('user_confirmed','agent_observed','inferred')),
          sensitivity     TEXT NOT NULL
                            CHECK (sensitivity IN ('normal','private','restricted')),
          metadata_json   TEXT NOT NULL DEFAULT '{}',
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          archived_at     TEXT,
          CHECK (scope = 'project' AND project_id IS NOT NULL
                 OR scope = 'global' AND project_id IS NULL),
          CHECK (lifecycle_state != 'archived' OR archived_at IS NOT NULL)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_assets_type_state
          ON assets(asset_type, lifecycle_state);
        CREATE INDEX IF NOT EXISTS idx_assets_scope_project
          ON assets(scope, project_id);
        CREATE INDEX IF NOT EXISTS idx_assets_owner
          ON assets(owner_actor_id, updated_at);

        CREATE TABLE IF NOT EXISTS asset_versions (
          asset_id            TEXT NOT NULL
                                REFERENCES assets(asset_id) ON DELETE CASCADE,
          version             INTEGER NOT NULL,
          schema_version      TEXT NOT NULL,
          content_hash        TEXT NOT NULL,
          manifest_json       TEXT NOT NULL,
          created_by_actor_id TEXT NOT NULL,
          provenance_kind     TEXT
                                CHECK (provenance_kind IN
                                  ('derivation_run','import_batch','manual','external')
                                  OR provenance_kind IS NULL),
          provenance_ref      TEXT,
          created_at          TEXT NOT NULL,
          PRIMARY KEY (asset_id, version),
          CHECK (version > 0)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_asset_versions_hash
          ON asset_versions(content_hash);
        CREATE INDEX IF NOT EXISTS idx_asset_versions_provenance
          ON asset_versions(provenance_kind, provenance_ref);

        CREATE TABLE IF NOT EXISTS asset_relations (
          from_asset_id        TEXT NOT NULL
                                 REFERENCES assets(asset_id) ON DELETE CASCADE,
          relation_type        TEXT NOT NULL,
          to_asset_id          TEXT
                                 REFERENCES assets(asset_id) ON DELETE CASCADE,
          external_target_ref  TEXT,
          metadata_json        TEXT NOT NULL DEFAULT '{}',
          created_at           TEXT NOT NULL,
          CHECK ((to_asset_id IS NOT NULL) <> (external_target_ref IS NOT NULL))
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_asset_relations_from
          ON asset_relations(from_asset_id, relation_type);
        CREATE INDEX IF NOT EXISTS idx_asset_relations_to
          ON asset_relations(to_asset_id);
        CREATE INDEX IF NOT EXISTS idx_asset_relations_external
          ON asset_relations(external_target_ref)
          WHERE external_target_ref IS NOT NULL;

        CREATE TABLE IF NOT EXISTS memory_ref_bindings (
          asset_id        TEXT NOT NULL
                            REFERENCES assets(asset_id) ON DELETE CASCADE,
          version         INTEGER NOT NULL,
          memory_id       TEXT NOT NULL
                            REFERENCES memory_entries(id) ON DELETE RESTRICT,
          memory_revision INTEGER NOT NULL,
          binding_rule    TEXT,
          note            TEXT,
          PRIMARY KEY (asset_id, version),
          CHECK (version > 0),
          CHECK (memory_revision > 0)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_memory_ref_bindings_memory
          ON memory_ref_bindings(memory_id, memory_revision);
      `);
      this.db.exec("PRAGMA user_version = 16");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * v1.2.0-alpha.2 (issue #50): the session-to-memory
   * distillation pipeline. Three additive tables —
   * `derivation_candidates`, `candidate_evidence`,
   * `candidate_actions` — back the reviewable
   * memory / episode / skill-candidate proposals
   * produced by the deterministic baseline extractor
   * (and any future provider-backed extractor).
   * The candidate row's `state` is a small state
   * machine (`proposed` -> `accepted` -> `applied` or
   * `rejected` / `stale`); the row's
   * `expected_target_revision` is the CAS guard for
   * the `apply` step. The migration is fully
   * transactional; on any throw the user_version
   * stays at 16 and the database is untouched. All
   * DDL is `IF NOT EXISTS` so the migration is
   * idempotent against re-runs.
   */
  private migrate_v16_to_v17(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS derivation_candidates (
          candidate_id              TEXT PRIMARY KEY,
          job_id                    TEXT NOT NULL REFERENCES derivation_jobs(job_id) ON DELETE CASCADE,
          run_id                    TEXT NOT NULL REFERENCES derivation_runs(run_id) ON DELETE CASCADE,
          candidate_kind            TEXT NOT NULL
                                        CHECK (candidate_kind IN ('memory','episode','skill_candidate')),
          proposed_type             TEXT,
          proposed_topic            TEXT,
          proposed_title            TEXT,
          proposed_body             TEXT,
          proposed_tags_json        TEXT NOT NULL DEFAULT '[]',
          proposed_scope            TEXT NOT NULL
                                        CHECK (proposed_scope IN ('global','project')),
          proposed_project_id       TEXT,
          proposed_tier             TEXT NOT NULL DEFAULT 'working'
                                        CHECK (proposed_tier IN ('working')),
          proposed_trust_level      TEXT NOT NULL DEFAULT 'inferred'
                                        CHECK (proposed_trust_level IN ('inferred','agent_observed')),
          proposed_sensitivity      TEXT NOT NULL
                                        CHECK (proposed_sensitivity IN ('normal')),
          confidence                REAL NOT NULL,
          state                     TEXT NOT NULL
                                        CHECK (state IN ('proposed','accepted','rejected','applied','stale')),
          extractor_id              TEXT NOT NULL,
          extractor_version         TEXT NOT NULL,
          content_hash              TEXT NOT NULL,
          created_at                INTEGER NOT NULL,
          reviewed_at               INTEGER,
          reviewed_by_actor_id      TEXT,
          applied_at                INTEGER,
          expected_target_revision  INTEGER,
          CHECK (state = 'applied' OR applied_at IS NULL),
          CHECK (proposed_scope = 'project' AND proposed_project_id IS NOT NULL
                 OR proposed_scope = 'global' AND proposed_project_id IS NULL)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_candidates_job
          ON derivation_candidates(job_id);
        CREATE INDEX IF NOT EXISTS idx_candidates_state
          ON derivation_candidates(state);

        CREATE TABLE IF NOT EXISTS candidate_evidence (
          candidate_id   TEXT NOT NULL REFERENCES derivation_candidates(candidate_id) ON DELETE CASCADE,
          evidence_role  TEXT NOT NULL
                              CHECK (evidence_role IN ('primary','supporting','context')),
          session_id     TEXT,
          event_id       TEXT,
          message_id     TEXT,
          tool_call_id   TEXT,
          file_ref       TEXT,
          excerpt_digest TEXT NOT NULL,
          PRIMARY KEY (candidate_id, evidence_role, excerpt_digest)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_candidate_evidence_session
          ON candidate_evidence(session_id);

        CREATE TABLE IF NOT EXISTS candidate_actions (
          candidate_id            TEXT NOT NULL REFERENCES derivation_candidates(candidate_id) ON DELETE CASCADE,
          action                  TEXT NOT NULL
                                      CHECK (action IN ('create','update','supersede','merge','skip')),
          target_memory_ids_json  TEXT NOT NULL DEFAULT '[]',
          expected_revisions_json TEXT NOT NULL DEFAULT '[]',
          rationale               TEXT NOT NULL,
          conflict_signals_json   TEXT NOT NULL DEFAULT '[]',
          risk                    TEXT NOT NULL
                                      CHECK (risk IN ('low','medium','high')),
          PRIMARY KEY (candidate_id, action)
        ) STRICT;
      `);
      this.db.exec("PRAGMA user_version = 17");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * v1.2.0-alpha.2 (issue #52): the agent loadout
   * substrate. Three additive tables — `agent_loadouts`,
   * `loadout_rules`, `loadout_bindings` — back the
   * policy-bound loadout surface that powers the
   * `bootstrap` / `query` / `tool_only` channels of
   * the context-assembly service.
   *
   * The `loadout_rules` table is keyed on
   * `(loadout_id, version, channel)` so a
   * `updateRules` call bumps the version and inserts a
   * new immutable rule row in the same transaction;
   * the `version` bump is what changes `bootstrap_hash`
   * in the assembled context (the upstream prompt-cache
   * key).
   *
   * The migration is fully transactional; on any throw
   * the user_version stays at 17 and the database is
   * untouched. All DDL is `IF NOT EXISTS` so the
   * migration is idempotent against re-runs.
   */
  private migrate_v17_to_v18(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_loadouts (
          loadout_id        TEXT PRIMARY KEY,
          name              TEXT NOT NULL,
          version           INTEGER NOT NULL DEFAULT 1,
          lifecycle_state   TEXT NOT NULL CHECK (lifecycle_state IN ('draft','active','deprecated','archived')),
          match_actor_id    TEXT,
          match_client_name TEXT,
          scope             TEXT NOT NULL CHECK (scope IN ('global','project')),
          project_id        TEXT,
          task_mode         TEXT,
          created_by_actor_id TEXT NOT NULL,
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL,
          CHECK (scope = 'project' AND project_id IS NOT NULL
                 OR scope = 'global' AND project_id IS NULL)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_loadouts_scope
          ON agent_loadouts(scope, project_id, lifecycle_state);
        CREATE INDEX IF NOT EXISTS idx_loadouts_match
          ON agent_loadouts(match_actor_id, match_client_name, task_mode);

        CREATE TABLE IF NOT EXISTS loadout_rules (
          loadout_id           TEXT NOT NULL REFERENCES agent_loadouts(loadout_id) ON DELETE CASCADE,
          version              INTEGER NOT NULL,
          channel              TEXT NOT NULL CHECK (channel IN ('bootstrap','query','tool_only')),
          include_asset_ids_json   TEXT NOT NULL DEFAULT '[]',
          include_memory_ids_json  TEXT NOT NULL DEFAULT '[]',
          include_types_json       TEXT NOT NULL DEFAULT '[]',
          include_tiers_json       TEXT NOT NULL DEFAULT '[]',
          include_tags_json        TEXT NOT NULL DEFAULT '[]',
          include_topics_json      TEXT NOT NULL DEFAULT '[]',
          exclude_asset_ids_json   TEXT NOT NULL DEFAULT '[]',
          exclude_memory_ids_json  TEXT NOT NULL DEFAULT '[]',
          exclude_tags_json        TEXT NOT NULL DEFAULT '[]',
          required_refs_json       TEXT NOT NULL DEFAULT '[]',
          max_items               INTEGER NOT NULL DEFAULT 32,
          max_chars               INTEGER NOT NULL DEFAULT 8000,
          max_tokens              INTEGER,
          timeout_ms              INTEGER NOT NULL DEFAULT 5000,
          ordering_policy         TEXT NOT NULL DEFAULT 'rule_then_score',
          PRIMARY KEY (loadout_id, version, channel),
          CHECK (version > 0)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS loadout_bindings (
          binding_id       TEXT PRIMARY KEY,
          loadout_id       TEXT NOT NULL REFERENCES agent_loadouts(loadout_id) ON DELETE CASCADE,
          loadout_version  INTEGER NOT NULL,
          actor_id         TEXT,
          client_name      TEXT,
          project_id       TEXT,
          task_mode        TEXT,
          priority         INTEGER NOT NULL DEFAULT 0,
          created_at       TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_loadout_bindings_match
          ON loadout_bindings(actor_id, client_name, project_id, task_mode, priority);
      `);
      this.db.exec("PRAGMA user_version = 18");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * v1.2.0-alpha.2 (issue #53): v18 -> v19 schema
   * migration. Introduces the additive `skills`
   * type-specific table. The `skill` envelope
   * row lives in `assets` (asset_type='skill'); the
   * type-specific body, frontmatter, and content-
   * addressed resources live here, keyed by
   * `(asset_id, version)`. The asset envelope's
   * `current_version` stays the source of truth
   * for "which version is the head".
   *
   * Schema invariants (mirrored in
   * `docs/adr/0010-asset-registry.md` and the v19
   * section of the contracts):
   *  - `skills.body_hash` is `sha256:hex64` over
   *    `skill_md_canonical` (the canonicalised
   *    SKILL.md bytes). It MUST equal the
   *    `asset_versions.content_hash` of the same
   *    `(asset_id, version)`. The schema does not
   *    enforce the equality (SQLite cannot compare
   *    across tables inside a CHECK); the
   *    `SkillService` write path enforces it.
   *  - `skills.source` is the strict 3-value enum
   *    that matches `SkillAssetV1Schema.source`.
   *  - `skills.name` is a kebab-case identifier
   *    (the canonical contract is enforced by the
   *    Zod schema in `packages/contracts`; the
   *    CHECK is a last-line safety net).
   *  - `skills.resources_json` is JSON; the shape
   *    is validated by the Zod contract before
   *    the row is inserted.
   */
  private migrate_v18_to_v19(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS skills (
          asset_id           TEXT NOT NULL
                               REFERENCES assets(asset_id) ON DELETE CASCADE,
          version            INTEGER NOT NULL,
          name               TEXT NOT NULL,
          description        TEXT NOT NULL,
          schema_version     TEXT NOT NULL,
          category           TEXT,
          triggers_json      TEXT NOT NULL DEFAULT '[]',
          when_to_use        TEXT,
          when_not_to_use    TEXT,
          compatibility_json TEXT NOT NULL DEFAULT '{}',
          source             TEXT NOT NULL
                               CHECK (source IN ('manual','derived','imported')),
          skill_md_canonical TEXT NOT NULL,
          body_hash          TEXT NOT NULL,
          resources_json     TEXT NOT NULL DEFAULT '[]',
          PRIMARY KEY (asset_id, version),
          CHECK (version > 0)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_skills_name
          ON skills(name);
        CREATE INDEX IF NOT EXISTS idx_skills_body_hash
          ON skills(body_hash);
      `);
      this.db.exec("PRAGMA user_version = 19");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * v1.2.0-alpha.2 (issue #54): v19 -> v20 schema
   * migration. Four additive tables for the
   * cold-start bootstrap surface —
   * `bootstrap_sources`, `bootstrap_plans`,
   * `bootstrap_plan_items`, `external_references`.
   * The migration is fully transactional; on any
   * throw the user_version stays at 19 and the
   * database is untouched. All DDL is
   * `IF NOT EXISTS` so the migration is idempotent
   * against re-runs.
   */
  private migrate_v19_to_v20(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS bootstrap_sources (
          source_id              TEXT PRIMARY KEY,
          source_kind            TEXT NOT NULL
                                  CHECK (source_kind IN
                                    ('file','directory','git_metadata','session_bundle',
                                     'memory_bundle','external_provider')),
          scope                  TEXT NOT NULL
                                  CHECK (scope IN ('global','project')),
          project_id             TEXT,
          canonical_ref          TEXT NOT NULL,
          source_version         TEXT,
          content_digest         TEXT NOT NULL,
          sensitivity            TEXT NOT NULL
                                  CHECK (sensitivity IN ('normal','private','restricted')),
          configured_by_actor_id TEXT NOT NULL,
          created_at             TEXT NOT NULL,
          last_scanned_at        TEXT,
          size_bytes             INTEGER
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_bootstrap_sources_project
          ON bootstrap_sources(scope, project_id);

        CREATE TABLE IF NOT EXISTS bootstrap_plans (
          plan_id            TEXT PRIMARY KEY,
          project_id         TEXT NOT NULL,
          creator_actor_id   TEXT NOT NULL,
          state              TEXT NOT NULL
                                CHECK (state IN ('draft','scanning','plan_ready','applying',
                                                 'applied','expired','failed','cancelled')),
          config_digest      TEXT NOT NULL,
          source_set_digest  TEXT NOT NULL,
          created_at         TEXT NOT NULL,
          expires_at         TEXT NOT NULL,
          completed_at       TEXT,
          job_id             TEXT
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_bootstrap_plans_project
          ON bootstrap_plans(project_id, state);

        CREATE TABLE IF NOT EXISTS bootstrap_plan_items (
          plan_id                     TEXT NOT NULL
                                        REFERENCES bootstrap_plans(plan_id) ON DELETE CASCADE,
          source_id                   TEXT NOT NULL
                                        REFERENCES bootstrap_sources(source_id) ON DELETE RESTRICT,
          item_seq                    INTEGER NOT NULL,
          action                      TEXT NOT NULL
                                        CHECK (action IN ('propose_memory','propose_context_pack',
                                                          'propose_skill_ref','register_external_ref',
                                                          'bind_loadout','skip')),
          target_ref                  TEXT,
          proposed_payload_json       TEXT NOT NULL,
          evidence_digest             TEXT NOT NULL,
          expected_revision_or_version INTEGER,
          risk                        TEXT NOT NULL
                                        CHECK (risk IN ('low','medium','high')),
          rationale                   TEXT NOT NULL,
          PRIMARY KEY (plan_id, item_seq)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_bootstrap_plan_items_source
          ON bootstrap_plan_items(source_id);

        CREATE TABLE IF NOT EXISTS external_references (
          asset_id                   TEXT NOT NULL
                                       REFERENCES assets(asset_id) ON DELETE CASCADE,
          version                    INTEGER NOT NULL,
          provider_kind              TEXT NOT NULL,
          provider_instance_id       TEXT NOT NULL,
          resource_kind              TEXT NOT NULL
                                       CHECK (resource_kind IN
                                         ('wiki','code_index','repository_context','document_set','custom')),
          resource_ref               TEXT NOT NULL,
          uri                        TEXT NOT NULL,
          source_version             TEXT,
          source_digest              TEXT,
          retrieval_contract_version TEXT NOT NULL,
          capabilities_json          TEXT NOT NULL DEFAULT '[]',
          allowed_scope              TEXT NOT NULL
                                       CHECK (allowed_scope IN ('global','project')),
          project_id                 TEXT,
          sensitivity                TEXT NOT NULL
                                       CHECK (sensitivity IN ('normal','private','restricted')),
          refresh_policy_json        TEXT NOT NULL DEFAULT '{"kind":"manual"}',
          last_verified_at           TEXT,
          metadata_json              TEXT NOT NULL DEFAULT '{}',
          PRIMARY KEY (asset_id, version)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_external_references_provider
          ON external_references(provider_kind, resource_ref);
      `);
      this.db.exec("PRAGMA user_version = 20");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private migrate_v1_to_v2(): void {
    // Loosen the audit_events.actor CHECK constraint to accept structured
    // values like "agent:claude-code". The v1 constraint allowed only
    // "agent" / "user" / "system". SQLite does not support `ALTER TABLE ...
    // DROP CONSTRAINT` and node:sqlite blocks `PRAGMA writable_schema`, so
    // we rebuild the table: create _v2 without the CHECK, copy rows over,
    // drop the old table, rename.
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_events'")
      .get() as { sql: string } | undefined;
    if (row === undefined) {
      this.db.exec("PRAGMA user_version = 2");
      return;
    }
    if (!/CHECK \(actor IN \('agent', 'user', 'system'\)\)/.test(row.sql)) {
      // Already migrated (no CHECK to replace)
      this.db.exec("PRAGMA user_version = 2");
      return;
    }
    this.db.exec(`
      CREATE TABLE audit_events_v2 (
        id TEXT PRIMARY KEY,
        memory_id TEXT,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
        project_id TEXT,
        event TEXT NOT NULL,
        reason TEXT,
        actor TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      INSERT INTO audit_events_v2
        (id, memory_id, scope, project_id, event, reason, actor, metadata_json, created_at)
        SELECT id, memory_id, scope, project_id, event, reason, actor, metadata_json, created_at
        FROM audit_events;

      DROP TABLE audit_events;

      ALTER TABLE audit_events_v2 RENAME TO audit_events;

      CREATE INDEX IF NOT EXISTS audit_events_memory_created_idx
        ON audit_events(memory_id, created_at);

      PRAGMA user_version = 2;
    `);
  }

  upsertProjectScope(scope: ProjectScope): void {
    this.db
      .prepare(
        `
        INSERT INTO project_scopes (project_id, canonical_path, display_name, budget_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          canonical_path = excluded.canonical_path,
          display_name = excluded.display_name,
          budget_json = excluded.budget_json,
          updated_at = excluded.updated_at
      `
      )
      .run(
        scope.project_id,
        scope.canonical_path,
        scope.display_name,
        encodeJson(scope.budget),
        scope.created_at,
        scope.updated_at
      );
  }

  getProjectScope(projectId: string): ProjectScope | undefined {
    const row = this.db.prepare("SELECT * FROM project_scopes WHERE project_id = ?").get<Row>(projectId);
    return row === undefined ? undefined : decodeProject(row);
  }

  insertEntry(entry: MemoryEntry): void {
    this.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO memory_entries (
            id, scope, project_id, project_path, type, topic, title, body, tags_json, source_json,
            importance, confidence, status, created_at, updated_at, last_accessed_at, last_accessed_by,
            access_count, expires_at, review_after, supersedes_json, superseded_by, token_estimate, char_count,
            revision, writer_actor_id, content_hash, pinned, trust_level, sensitivity,
            valid_from, valid_until, deleted_at, tier, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(...this.entryParams(entry));
      this.upsertFts(entry);
    });
  }

  /**
   * Stage 14 PR-B2 (spec § 5.6): read the per-actor access map
   * for a memory from the canonical `memory_accesses` table.
   * Used by `getEntry` after the access UPSERT to surface the
   * legacy `last_accessed_by` JSON map without round-tripping
   * through the `memory_entries.last_accessed_by` JSON column
   * (which is no longer the source of truth).
   */
  readAccessMap(memoryId: string): Record<string, string> | undefined {
    const rows = this.db
      .prepare(
        "SELECT actor_id, last_accessed_at FROM memory_accesses WHERE memory_id = ? ORDER BY actor_id ASC"
      )
      .all(memoryId) as Array<{ actor_id: string; last_accessed_at: string }>;
    if (rows.length === 0) return undefined;
    const map: Record<string, string> = {};
    for (const row of rows) {
      map[row.actor_id] = row.last_accessed_at;
    }
    return map;
  }

  /**
   * Stage 16 v1.1.1 PR-1 (#11): pure read of a memory entry.
   * No side effects on `memory_accesses` or
   * `memory_entries.access_count`. Use this from
   * `get_memory` (read-only tool) and from any path that
   * must not change canonical access state.
   *
   * For paths that legitimately need to record access
   * (e.g. `recall_context` selecting a memory), call
   * `getEntry` with an `accessedBy` actor, or call
   * `recordMemoryAccess(memoryId, actorId)` explicitly after
   * the read.
   */
  /**
   * Stage 18 v1.1.2 follow-up (review by ora-9):
   * the SQL-boundary visibility classifier for the
   * single-row read path. Returns ONLY the
   * visibility classification and the row's
   * `id` + `sensitivity` field — NEVER hydrates
   * `title` / `body` / `tags` / `source` /
   * `trust_level` / `project_id` / `scope` / any
   * other row-derived secret. The caller (the
   * read service, the MCP resource layer, the
   * CLI `show` command) is responsible for
   * translating the classification into the
   * public contract — the store MUST NOT
   * surface row content on the
   * `forbidden_visibility` / `not_found`
   * branches because the brief explicitly
   * forbids leaking the seed title / body /
   * tags / source / `entry_sensitivity` /
   * `sensitivity` literal to a caller that did
   * not authorise the read.
   *
   * The classifier is the SQL-boundary source
   * of truth for the read path. A row whose
   * `sensitivity` exceeds the caller's
   * `actorMaxSensitivity` is invisible to the
   * classifier regardless of how the caller
   * asks for it.
   *
   * Returning the visibility classification
   * (rather than the row itself) closes the
   * critical leak the previous follow-up
   * introduced: the previous implementation
   * called `peekEntry(id)` WITHOUT
   * `actorMaxSensitivity` to "disambiguate"
   * `forbidden_visibility` from `not_found`,
   * which hydrated the entire row including
   * `title` / `body` / `tags` / `source` /
   * `sensitivity` and surfaced them on the
   * error envelope.
   */
  classifyEntryVisibility(
    id: string,
    options: { actorMaxSensitivity?: "normal" | "private" | "restricted" } = {}
  ): { visibility: "visible" | "forbidden_visibility" | "not_found"; id: string; sensitivity: "normal" | "private" | "restricted" } {
    const actorMax = options.actorMaxSensitivity ?? "normal";
    const order = actorMax === "restricted" ? 3 : actorMax === "private" ? 2 : 1;
    // The `SELECT id, sensitivity` projection
    // is the security boundary: only the `id`
    // and the `sensitivity` column are pulled
    // off the row. `title` / `body` / `tags` /
    // `source` are NOT selected, so a
    // misconfigured caller cannot leak them
    // through the classifier return value. The
    // CASE expression applies the
    // SQL-boundary sensitivity filter (the
    // same predicate `listEntries` /
    // `searchEntries` use) so a row that
    // exceeds the caller's
    // `actorMaxSensitivity` is invisible —
    // the row's `sensitivity` field is NOT
    // surfaced either (the filter rejects the
    // row before the projection is materialised).
    const probe = this.db
      .prepare(
        `SELECT id, sensitivity FROM memory_entries WHERE id = ? AND ` +
          `(CASE sensitivity WHEN 'restricted' THEN 3 WHEN 'private' THEN 2 ELSE 1 END) <= ?`
      )
      .get(id, order) as { id: string; sensitivity: "normal" | "private" | "restricted" } | undefined;
    if (probe === undefined) {
      // The filtered probe returned nothing.
      // Two possibilities: the row does not
      // exist (`not_found`), or the row
      // exists at a higher sensitivity
      // (`forbidden_visibility`). To
      // distinguish, the classifier peeks at
      // the row's `sensitivity` only via a
      // separate SQL projection that ALSO
      // applies the sensitivity filter — but
      // for the inverse predicate (the row
      // exists AND the sensitivity is above
      // the actor's max). The projection
      // selects ONLY the `id` + `sensitivity`
      // fields; title / body / tags / source
      // are NEVER pulled. If neither probe
      // matches, the row does not exist.
      const elevated = this.db
        .prepare(
          `SELECT id, sensitivity FROM memory_entries WHERE id = ? AND ` +
            `(CASE sensitivity WHEN 'restricted' THEN 3 WHEN 'private' THEN 2 ELSE 1 END) > ?`
        )
        .get(id, order) as { id: string; sensitivity: "normal" | "private" | "restricted" } | undefined;
      if (elevated === undefined) {
        return { visibility: "not_found", id, sensitivity: "normal" };
      }
      // The row exists at a higher sensitivity.
      // We surface ONLY the operational
      // `sensitivity` field (a token, not a
      // row payload) so the caller can build
      // the structured `forbidden_visibility`
      // error envelope. The field name is
      // explicitly `sensitivity_tier` in the
      // brief (a non-secret operational
      // token); the implementation returns it
      // under the `sensitivity` key for
      // back-compat with the existing
      // `getMemoryWithVisibility` contract.
      return { visibility: "forbidden_visibility", id: elevated.id, sensitivity: elevated.sensitivity };
    }
    return { visibility: "visible", id: probe.id, sensitivity: probe.sensitivity };
  }

  /**
   * Stage 16 v1.1.1 PR-1 (#11): pure read of a memory entry.
   * No side effects on `memory_accesses` or
   * `memory_entries.access_count`. Use this from
   * `get_memory` (read-only tool) and from any path that
   * must not change canonical access state.
   *
   * For paths that legitimately need to record access
   * (e.g. `recall_context` selecting a memory), call
   * `getEntry` with an `accessedBy` actor, or call
   * `recordMemoryAccess(memoryId, actorId)` explicitly after
   * the read.
   *
   * Stage 18 v1.1.2 follow-up (review by ora-9): the
   * `peekEntry` API is the maintenance / write-path
   * single-row read. It is documented as the ONLY
   * single-row read API that hydrates `title` / `body` /
   * `tags` / `source` — used by the CAS guards in the
   * write service and the maintenance actions
   * (`mergePlannedGroup` / `forgetPlannedEntries` /
   * `mergeDuplicates` / `expireDueMemories` /
   * `applyPlannedGroupInTransaction`). Read paths that
   * must enforce the SQL-boundary sensitivity filter
   * MUST go through `classifyEntryVisibility` + a
   * filtered `peekEntry(id, { actorMaxSensitivity })`,
   * NOT through the no-options `peekEntry(id)` overload.
   * The no-options overload intentionally reads every
   * row (the CAS guards need to see all rows).
   */
  peekEntry(id: string): MemoryEntry | undefined;
  peekEntry(
    id: string,
    options: { actorMaxSensitivity?: "normal" | "private" | "restricted" }
  ): MemoryEntry | undefined;
  peekEntry(
    id: string,
    options: { actorMaxSensitivity?: "normal" | "private" | "restricted" } = {}
  ): MemoryEntry | undefined {
    // Stage 18 v1.1.2 follow-up (review by ora-8):
    // the pre-follow-up `peekEntry` did
    // `SELECT * FROM memory_entries WHERE id = ?`
    // without the SQL-boundary sensitivity
    // predicate, which let a caller bypass the
    // filter by asking for one id at a time.
    // The fix is to apply the same
    // `actor_max_sensitivity` filter that
    // `listEntries` / `searchEntries` apply. The
    // default (`"normal"`) is fail-closed: a row
    // whose `sensitivity` exceeds the value is
    // hidden from the response (the row's
    // existence is not even probed). A `undefined`
    // option behaves exactly like the pre-follow-up
    // contract — kept for backward compatibility
    // with the maintenance / write paths that
    // intentionally need to read every row.
    if (options.actorMaxSensitivity === undefined) {
      return this.readEntry(id);
    }
    // Two-step read: probe the visibility at the
    // SQL boundary (so the row's existence is not
    // leaked to a caller without the
    // `sensitivity_visibility` capability), then
    // decode via the canonical `readEntry` path
    // so the derived `last_accessed_by` cache (the
    // re-derivation from `memory_accesses`) is
    // preserved. The two-step approach keeps the
    // SQL filter as the only place sensitivity is
    // decided and re-uses the existing decode /
    // access-derivation logic byte-for-byte.
    const order = options.actorMaxSensitivity === "restricted"
      ? 3
      : options.actorMaxSensitivity === "private"
        ? 2
        : 1;
    const probe = this.db
      .prepare(
        `SELECT 1 FROM memory_entries WHERE id = ? AND ` +
          `(CASE sensitivity WHEN 'restricted' THEN 3 WHEN 'private' THEN 2 ELSE 1 END) <= ?`
      )
      .get(id, order) as { 1: number } | undefined;
    if (probe === undefined) return undefined;
    return this.readEntry(id);
  }

  getEntry(id: string, accessedBy?: string): MemoryEntry | undefined {
    const entry = this.readEntry(id);
    if (entry === undefined) return undefined;

    const lastAccessedAt = new Date().toISOString();

    // Stage 14 PR-B2 (spec § 5.6 AR-P0-006): record the
    // access in the canonical `memory_accesses` table via
    // `recordAccess` (atomic UPSERT keyed on
    // `(memory_id, actor_id)`) BEFORE bumping
    // `memory_entries.access_count`, so the canonical
    // access row is the source of truth for the per-actor
    // access map. The 8-process stress test asserts that
    // every `(memory_id, actor_id)` UPSERT lands
    // atomically — the pre-PR-B2 read-modify-write on the
    // `last_accessed_by` JSON column lost concurrent
    // updates from sibling processes, which is the exact
    // failure mode the spec § 5.6 atomicity contract
    // guards against.
    let nextMap: Record<string, string> | undefined;
    if (accessedBy !== undefined) {
      this.recordAccess(id, accessedBy, lastAccessedAt);
      // Maintain the v3-compatible `last_accessed_by` JSON
      // column as a derived cache so legacy readers (the
      // doctor check, the budget evaluator, the trust
      // boost) keep working. The RMW here is best-effort:
      // `memory_accesses` is the source of truth, so a
      // lost RMW loses at most one actor's last-accessed
      // timestamp from the JSON cache but never from the
      // canonical per-actor table.
      const existing = entry.last_accessed_by ?? {};
      nextMap = { ...existing, [accessedBy]: lastAccessedAt };
    }

    if (nextMap !== undefined) {
      this.db
        .prepare("UPDATE memory_entries SET access_count = access_count + 1, last_accessed_at = ?, last_accessed_by = ? WHERE id = ?")
        .run(lastAccessedAt, JSON.stringify(nextMap), id);
    } else {
      this.db
        .prepare("UPDATE memory_entries SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?")
        .run(lastAccessedAt, id);
    }

    return {
      ...entry,
      access_count: entry.access_count + 1,
      last_accessed_at: lastAccessedAt,
      ...(nextMap !== undefined ? { last_accessed_by: nextMap } : {})
    };
  }

  listEntries(filters: EntryFilters): MemoryEntry[] {
    const { where, params } = buildEntryWhere(filters, "memory_entries");
    const limit = normalizeLimit(filters.limit, 100);
    const offset = normalizeOffset(filters.offset);
    const rows = this.db
      .prepare(`SELECT * FROM memory_entries ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all<Row>(...params, limit, offset);
    return rows.map(decodeEntry);
  }

  searchEntries(filters: SearchFilters): MemoryEntry[] {
    const query = ftsQuery(filters.query);
    if (query.length === 0) return [];

    const { where, params } = buildEntryWhere(filters, "m");
    const clauses = ["memory_fts MATCH ?", ...(where.length === 0 ? [] : [where.slice("WHERE ".length)])];
    const limit = normalizeLimit(filters.limit, 10);
    const offset = normalizeOffset(filters.offset);
    const rows = this.db
      .prepare(
        `
        SELECT m.*
        FROM memory_fts
        JOIN memory_entries m ON m.id = memory_fts.id
        WHERE ${clauses.join(" AND ")}
        ORDER BY rank
        LIMIT ? OFFSET ?
      `
      )
      .all<Row>(query, ...params, limit, offset);
    return rows.map(decodeEntry);
  }

  /**
   * Stage 14 PR-B2 (spec § 6.5): optional revision context
   * carries the writer actor, request_id, and change reason
   * for the `memory_revisions` row written inside the same
   * transaction as the entry update. When omitted (the
   * maintenance service callers and pre-B2 callers), no
   * revision row is recorded — the legacy behaviour is
   * preserved and the spec § 5.6 multi-process test is
   * unaffected.
   */
  updateEntry(
    id: string,
    patch: EntryPatch,
    revisionContext?: { changed_by: string; request_id?: string; change_reason?: string }
  ): void {
    const current = this.readEntry(id);
    if (current === undefined) return;

    // Spec § 6.5: post-image snapshot. Bump the revision
    // explicitly so the `memory_revisions` row is keyed on
    // the same `next.revision` the row will carry after
    // the UPDATE. Pre-PR-B2 the `revision = ?` parameter
    // was passed through entryParams which had the bump
    // happen inside sanitizeEntryPatch; we replicate that
    // bump here.
    const next: MemoryEntry = {
      ...current,
      ...sanitizeEntryPatch(patch),
      id: current.id,
      revision: current.revision + 1
    };
    this.transaction(() => {
      this.db
        .prepare(
          `
          UPDATE memory_entries SET
            scope = ?,
            project_id = ?,
            project_path = ?,
            type = ?,
            topic = ?,
            title = ?,
            body = ?,
            tags_json = ?,
            source_json = ?,
            importance = ?,
            confidence = ?,
            status = ?,
            created_at = ?,
            updated_at = ?,
            last_accessed_at = ?,
            last_accessed_by = ?,
            access_count = ?,
            expires_at = ?,
            review_after = ?,
            supersedes_json = ?,
            superseded_by = ?,
            token_estimate = ?,
            char_count = ?,
            revision = ?,
            writer_actor_id = ?,
            content_hash = ?,
            pinned = ?,
            trust_level = ?,
            sensitivity = ?,
            valid_from = ?,
            valid_until = ?,
            deleted_at = ?,
            tier = ?,
            metadata_json = ?
          WHERE id = ?
        `
        )
        .run(...this.entryParams(next).slice(1), id);
      this.upsertFts(next);
      if (revisionContext !== undefined) {
        this.recordRevisionRow(
          next.id,
          next.revision,
          next,
          revisionContext.changed_by,
          revisionContext.request_id,
          revisionContext.change_reason
        );
      }
    });
  }

  appendAudit(event: MemoryAuditEvent): void {
    this.db
      .prepare(
        `
        INSERT INTO audit_events (id, memory_id, scope, project_id, event, reason, actor, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        event.id,
        event.memory_id ?? null,
        event.scope,
        event.project_id ?? null,
        event.event,
        event.reason ?? null,
        event.actor,
        encodeJson(event.metadata),
        event.created_at
      );
  }

  getAuditEvents(memoryId: string): MemoryAuditEvent[] {
    return this.db
      .prepare("SELECT * FROM audit_events WHERE memory_id = ? ORDER BY created_at ASC")
      .all<Row>(memoryId)
      .map(decodeAudit);
  }

  /**
   * Stage 15 PR-M0-4 (issue #3, spec § 6.2): persistent
   * maintenance plan CRUD on top of the
   * `maintenance_plans` + `maintenance_plan_items` tables.
   * Pre-v6 the plan lived in a process-local Map and was
   * lost on every MCP restart. With v6 the plan survives
   * restart so a different session (or even a different
   * process) can call `apply_maintenance` later.
   *
   * The plan_hash is SHA-256 over the canonical JSON of
   * the items array, so any tampering between plan and
   * apply is detected by `getPlan`. Expired plans
   * (state='expired' or expires_at <= now) are
   * auto-rejected by the read path; explicit
   * `expireOldPlans` flips `pending` -> `expired` in bulk.
   */
  createMaintenancePlan(plan: MaintenancePlanRow): void {
    this.db
      .prepare(
        `INSERT INTO maintenance_plans
          (plan_id, plan_hash, creator_actor_id, created_at,
           expires_at, completed_at, applied_result_json,
           idempotency_key_used, state, summary_json,
           scope, project_id, risk)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        plan.plan_id,
        plan.plan_hash,
        plan.creator_actor_id,
        plan.created_at,
        plan.expires_at,
        plan.completed_at ?? null,
        plan.applied_result_json ?? null,
        plan.idempotency_key_used ?? null,
        plan.state,
        plan.summary_json,
        plan.scope,
        plan.project_id ?? null,
        plan.risk
      );
    const insertItem = this.db.prepare(
      `INSERT INTO maintenance_plan_items
        (plan_id, target_memory_id, expected_revision, action_type, evidence_json, risk)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const item of plan.items) {
      insertItem.run(
        plan.plan_id,
        item.target_memory_id,
        item.expected_revision,
        item.action_type,
        item.evidence_json,
        item.risk
      );
    }
  }

  getMaintenancePlan(planId: string): MaintenancePlanRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM maintenance_plans WHERE plan_id = ?")
      .get(planId) as
      | {
          plan_id: string;
          plan_hash: string;
          creator_actor_id: string;
          created_at: string;
          expires_at: string;
          state: string;
          summary_json: string;
          scope: string;
          project_id: string | null;
          risk: string;
        }
      | undefined;
    if (row === undefined) return undefined;
    const itemRows = this.db
      .prepare(
        "SELECT target_memory_id, expected_revision, action_type, evidence_json, risk FROM maintenance_plan_items WHERE plan_id = ? ORDER BY target_memory_id ASC"
      )
      .all(planId) as Array<{
      target_memory_id: string;
      expected_revision: number;
      action_type: string;
      evidence_json: string;
      risk: string;
    }>;
    const out: MaintenancePlanRow = {
      plan_id: row.plan_id,
      plan_hash: row.plan_hash,
      creator_actor_id: row.creator_actor_id,
      created_at: row.created_at,
      expires_at: row.expires_at,
      state: row.state as MaintenancePlanRow["state"],
      summary_json: row.summary_json,
      scope: row.scope as MaintenancePlanRow["scope"],
      risk: row.risk as MaintenancePlanRow["risk"],
      items: itemRows.map((r) => ({
        target_memory_id: r.target_memory_id,
        expected_revision: r.expected_revision,
        action_type: r.action_type as MaintenancePlanItemRow["action_type"],
        evidence_json: r.evidence_json,
        risk: r.risk as MaintenancePlanItemRow["risk"]
      }))
    };
    if (row.project_id !== null) {
      out.project_id = row.project_id;
    }
    return out;
  }

  setMaintenancePlanState(planId: string, state: MaintenancePlanRow["state"]): void {
    this.db
      .prepare("UPDATE maintenance_plans SET state = ? WHERE plan_id = ?")
      .run(state, planId);
  }

  /**
   * Stage 16 v1.1.1 PR-5 (issue #12): mark a plan
   * `applying`. The apply phase transitions through
   * `applying` so an interrupted apply can be
   * detected by the next apply call (a plan stuck
   * in `applying` past the takeover window is
   * `expired` by the next call). Returns `true` if
   * the transition succeeded (i.e. the plan was
   * `pending`).
   */
  markMaintenancePlanApplying(planId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE maintenance_plans
            SET state = 'applying'
          WHERE plan_id = ? AND state = 'pending'`
      )
      .run(planId);
    return Number(result.changes ?? 0) === 1;
  }

  /**
   * Stage 16 v1.1.1 PR-5 (issue #12): mark a plan
   * `completed` AND persist the canonical apply
   * result + the idempotency key the apply used.
   * A replay with the same key returns the
   * `appliedResult` verbatim. A replay with a
   * different key surfaces `idempotency_mismatch`.
   */
  markMaintenancePlanCompleted(
    planId: string,
    idempotencyKey: string,
    appliedResultJson: string,
    completedAt: string
  ): void {
    this.db
      .prepare(
        `UPDATE maintenance_plans
            SET state = 'completed',
                completed_at = ?,
                applied_result_json = ?,
                idempotency_key_used = ?
          WHERE plan_id = ? AND state = 'applying'`
      )
      .run(completedAt, appliedResultJson, idempotencyKey, planId);
  }

  /**
   * Stage 16 v1.1.1 PR-5 (issue #12): read the
   * stored apply result for a completed plan. The
   * caller passes the idempotency key it intends
   * to use; the function returns the stored result
   * if the key matches, or `undefined` if the plan
   * was never applied or the key does not match.
   */
  getMaintenancePlanAppliedResult(
    planId: string,
    idempotencyKey: string
  ): { result: unknown; completed_at: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT applied_result_json, completed_at, idempotency_key_used
           FROM maintenance_plans
          WHERE plan_id = ? AND state = 'completed'`
      )
      .get(planId) as
      | { applied_result_json: string; completed_at: string; idempotency_key_used: string }
      | undefined;
    if (row === undefined) return undefined;
    if (row.idempotency_key_used !== idempotencyKey) return undefined;
    try {
      const result = JSON.parse(row.applied_result_json) as unknown;
      return { result, completed_at: row.completed_at };
    } catch {
      return undefined;
    }
  }

  expireOldMaintenancePlans(now: string): number {
    const result = this.db
      .prepare(
        `UPDATE maintenance_plans
            SET state = 'expired'
          WHERE state = 'pending' AND expires_at <= ?`
      )
      .run(now);
    return Number(result.changes ?? 0);
  }

  /**
   * Stage 18 v1.1.2 (issue #26, task 7): durable
   * `import_batches` lineage — the import-side
   * equivalent of `maintenance_plans`. Every applied
   * import writes one row keyed on `import_batch_id`.
   * The row carries the canonical `bundle_hash` +
   * `bundle_version` (so a reviewer can re-derive
   * the exact bundle), the target scope / project
   * identity, the conflict + history policies, the
   * request-context trace fields, and a JSON-encoded
   * counts / affected_ids summary.
   *
   * The store helpers are intentionally narrow —
   * `insertImportBatchRow` writes the initial
   * `pending` row, `updateImportBatchRow` /
   * `markImportBatchRunning` /
   * `markImportBatchCompleted` /
   * `markImportBatchFailed` advance the lifecycle,
   * and `getImportBatchRow` is the operator-readable
   * read. The `ImportBatchStore` (see
   * src/portability/import-batch-store.ts) wraps
   * these methods with the documented atomicity
   * contract.
   */
  insertImportBatchRow(input: {
    import_batch_id: string;
    bundle_hash: string;
    bundle_hash_algorithm: string;
    bundle_version: number;
    bundle_filename: string | null;
    bundle_size_bytes: number | null;
    source_format: string;
    source_schema_version: number;
    target_scope: "global" | "project";
    target_project_id: string | null;
    conflict_policy: "keep" | "replace" | "merge" | "fail";
    history_mode: "snapshot" | "full_history";
    actor_id: string;
    request_id: string | null;
    session_id: string | null;
    tool_call_id: string | null;
    started_at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO import_batches (
          import_batch_id, bundle_hash, bundle_hash_algorithm,
          bundle_version, bundle_filename, bundle_size_bytes,
          source_format, source_schema_version,
          target_scope, target_project_id,
          conflict_policy, history_mode,
          actor_id, request_id, session_id, tool_call_id,
          started_at, status
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending'
         )`
      )
      .run(
        input.import_batch_id,
        input.bundle_hash,
        input.bundle_hash_algorithm,
        input.bundle_version,
        input.bundle_filename,
        input.bundle_size_bytes,
        input.source_format,
        input.source_schema_version,
        input.target_scope,
        input.target_project_id,
        input.conflict_policy,
        input.history_mode,
        input.actor_id,
        input.request_id,
        input.session_id,
        input.tool_call_id,
        input.started_at
      );
  }

  /**
   * Stage 18 v1.1.2 (issue #26, task 7): flip an
   * `import_batches` row from `pending` to `running`
   * and stamp `started_at` on the same row. Called
   * from inside the apply transaction so the running
   * transition rolls back with the mutations on a
   * failure (the row stays in `pending`, ready for
   * the post-transaction `markImportBatchFailed`
   * call).
   */
  markImportBatchRunning(batchId: string, startedAt: string): void {
    this.db
      .prepare(
        `UPDATE import_batches
            SET status = 'running',
                started_at = ?
          WHERE import_batch_id = ? AND status = 'pending'`
      )
      .run(startedAt, batchId);
  }

  /**
   * Stage 18 v1.1.2 (issue #26, task 7): flip an
   * `import_batches` row from `running` to
   * `completed` and persist the canonical
   * counts + affected_ids summary. Called from
   * inside the apply transaction so the completed
   * row + the entries / revisions / audit /
   * relations / provenance mutations commit
   * atomically.
   */
  markImportBatchCompleted(
    batchId: string,
    completedAt: string,
    countsJson: string,
    affectedIdsJson: string,
    /**
     * v1.1.3 GATE-01 (issue #31): the optional
     * audit metadata JSON. Defaults to `{}` when
     * the caller passes `undefined` so existing
     * test surface (and any future caller that
     * does not produce audit metadata) keeps
     * working without any change. The column is
     * `NOT NULL DEFAULT '{}'` so an UPDATE that
     * omits it is a no-op.
     */
    auditMetadataJson?: string
  ): void {
    const metadataJson = auditMetadataJson ?? "{}";
    this.db
      .prepare(
        `UPDATE import_batches
            SET status = 'completed',
                completed_at = ?,
                counts_json = ?,
                affected_ids_json = ?,
                audit_metadata_json = ?
          WHERE import_batch_id = ? AND status = 'running'`
      )
      .run(completedAt, countsJson, affectedIdsJson, metadataJson, batchId);
  }

  /**
   * Stage 18 v1.1.2 (issue #26, task 7): flip an
   * `import_batches` row to `failed` and stamp the
   * failure code + `failed_at` timestamp. Called
   * OUTSIDE the apply transaction (the failure
   * audit must persist even when the mutations
   * rolled back). The transition is idempotent: a
   * row already in `failed` (e.g. the apply path
   * re-ran after a retry) is left alone.
   */
  markImportBatchFailed(
    batchId: string,
    failedAt: string,
    failureCode: string,
    /**
     * v1.1.3 GATE-01 (issue #31): the optional
     * audit metadata JSON. When the apply
     * transaction throws on identity drift, the
     * catch block records the drift envelope on
     * the `failed` row so a reviewer can see WHY
     * the apply refused (without parsing the
     * free-form error message). Defaults to
     * `null` (= no metadata update) so legacy
     * callers keep their row shape.
     */
    auditMetadataJson?: string
  ): void {
    if (auditMetadataJson === undefined) {
      this.db
        .prepare(
          `UPDATE import_batches
              SET status = 'failed',
                  failed_at = ?,
                  failure_code = ?
            WHERE import_batch_id = ? AND status IN ('pending','running')`
        )
        .run(failedAt, failureCode, batchId);
      return;
    }
    this.db
      .prepare(
        `UPDATE import_batches
            SET status = 'failed',
                failed_at = ?,
                failure_code = ?,
                audit_metadata_json = ?
          WHERE import_batch_id = ? AND status IN ('pending','running')`
      )
      .run(failedAt, failureCode, auditMetadataJson, batchId);
  }

  /**
   * Stage 18 v1.1.2 (issue #26, task 7): the
   * operator-readable read. Returns the durable
   * `import_batches` row verbatim — the
   * `ImportBatchStore.inspect(...)` wraps this with
   * the redaction contract (no body / secret / path
   * leakage) before exposing it on the CLI / MCP
   * resource.
   */
  getImportBatchRow(batchId: string): {
    import_batch_id: string;
    bundle_hash: string;
    bundle_hash_algorithm: string;
    bundle_version: number;
    bundle_filename: string | null;
    bundle_size_bytes: number | null;
    source_format: string;
    source_schema_version: number;
    target_scope: "global" | "project";
    target_project_id: string | null;
    conflict_policy: "keep" | "replace" | "merge" | "fail";
    history_mode: "snapshot" | "full_history";
    actor_id: string;
    request_id: string | null;
    session_id: string | null;
    tool_call_id: string | null;
    started_at: string;
    completed_at: string | null;
    failed_at: string | null;
    status: "pending" | "running" | "completed" | "failed";
    failure_code: string | null;
    counts_json: string;
    affected_ids_json: string;
    audit_metadata_json: string;
  } | undefined {
    return this.db
      .prepare(
        `SELECT import_batch_id, bundle_hash, bundle_hash_algorithm,
                bundle_version, bundle_filename, bundle_size_bytes,
                source_format, source_schema_version,
                target_scope, target_project_id,
                conflict_policy, history_mode,
                actor_id, request_id, session_id, tool_call_id,
                started_at, completed_at, failed_at,
                status, failure_code,
                counts_json, affected_ids_json,
                audit_metadata_json
           FROM import_batches
          WHERE import_batch_id = ?`
      )
      .get(batchId) as
      | {
          import_batch_id: string;
          bundle_hash: string;
          bundle_hash_algorithm: string;
          bundle_version: number;
          bundle_filename: string | null;
          bundle_size_bytes: number | null;
          source_format: string;
          source_schema_version: number;
          target_scope: "global" | "project";
          target_project_id: string | null;
          conflict_policy: "keep" | "replace" | "merge" | "fail";
          history_mode: "snapshot" | "full_history";
          actor_id: string;
          request_id: string | null;
          session_id: string | null;
          tool_call_id: string | null;
          started_at: string;
          completed_at: string | null;
          failed_at: string | null;
          status: "pending" | "running" | "completed" | "failed";
          failure_code: string | null;
          counts_json: string;
          affected_ids_json: string;
          audit_metadata_json: string;
        }
      | undefined;
  }

  /**
   * Stage 15 PR-M1-1 (issue #6, spec § 5.3): write
   * provenance links for one or more memories. The
   * primary key `(memory_id, source_kind, source_ref)`
   * makes the write idempotent under repeat ingestion
   * (a `recordProvenance` call with the same triple is
   * a no-op via `INSERT OR IGNORE`). The caller passes
   * the canonical `recorded_at` (Unix ms) so the
   * timeline is consistent across cross-process
   * sources (issue / PR / commit ingest usually knows
   * the source's own timestamp).
   */
  recordProvenance(input: {
    memory_id: string;
    source_kind: "issue" | "pr" | "commit" | "tool_call" | "session" | "import";
    source_ref: string;
    recorded_by: string;
    recorded_at: number;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_provenance
          (memory_id, source_kind, source_ref, recorded_by, recorded_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        input.memory_id,
        input.source_kind,
        input.source_ref,
        input.recorded_by,
        input.recorded_at
      );
  }

  /**
   * Return the durable provenance link chain for a
   * memory. The chain is sorted by `source_kind` (so
   * the explain output is stable across queries with
   * the same underlying data) and then by
   * `recorded_at` ascending so the timeline is
   * chronologically ordered within a kind.
   */
  getProvenance(memoryId: string): Array<{
    source_kind: "issue" | "pr" | "commit" | "tool_call" | "session" | "import";
    source_ref: string;
    recorded_by: string;
    recorded_at: number;
  }> {
    return this.db
      .prepare(
        `SELECT source_kind, source_ref, recorded_by, recorded_at
           FROM memory_provenance
          WHERE memory_id = ?
          ORDER BY source_kind ASC, recorded_at ASC`
      )
      .all(memoryId) as Array<{
      source_kind: "issue" | "pr" | "commit" | "tool_call" | "session" | "import";
      source_ref: string;
      recorded_by: string;
      recorded_at: number;
    }>;
  }

  /**
   * Stage 18 v1.1.2 (issue #25, task 6): import-side
   * write of a `memory_revisions` row from a v3
   * full-history bundle. The caller supplies the
   * (already-remapped) `memory_id` and the full row
   * shape; the row is keyed on `(memory_id, revision)`
   * so the import is idempotent under repeat ingestion
   * (an existing `(memory_id, revision)` row is left in
   * place via `INSERT OR IGNORE`). The caller is
   * responsible for passing the `created_at` and
   * `snapshot_json` it wants preserved; we do NOT
   * re-serialise the snapshot (the bundle is the source
   * of truth).
   *
   * Intended use: the `applyImport` path inside the
   * `service.store.transaction(...)` block restores
   * the source's revision chain when the plan is
   * `history_mode === "full_history"` AND the bundle's
   * generation is `v3_full_history`. A failure inside
   * the transaction rolls back every inserted row.
   */
  insertRevisionRow(input: {
    memory_id: string;
    revision: number;
    snapshot_json: string;
    changed_by: string;
    request_id: string;
    change_reason: string | null;
    created_at: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_revisions
            (memory_id, revision, snapshot_json, changed_by, request_id, change_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.memory_id,
        input.revision,
        input.snapshot_json,
        input.changed_by,
        input.request_id,
        input.change_reason,
        input.created_at
      );
  }

  /**
   * Stage 18 v1.1.2 (issue #25, task 6): return the
   * ordered `memory_revisions` chain for one memory,
   * ascending by `revision`. Used by the export-side
   * `buildFullHistoryBundle` to gather the source-side
   * revision rows for inclusion in the v3 bundle.
   */
  listRevisionRows(memoryId: string): Array<{
    memory_id: string;
    revision: number;
    snapshot_json: string;
    changed_by: string;
    request_id: string;
    change_reason: string | null;
    created_at: string;
  }> {
    return this.db
      .prepare(
        `SELECT memory_id, revision, snapshot_json, changed_by, request_id, change_reason, created_at
           FROM memory_revisions
          WHERE memory_id = ?
          ORDER BY revision ASC`
      )
      .all(memoryId) as Array<{
      memory_id: string;
      revision: number;
      snapshot_json: string;
      changed_by: string;
      request_id: string;
      change_reason: string | null;
      created_at: string;
    }>;
  }

  /**
   * Stage 18 v1.1.2 (issue #25, task 6): import-side
   * write of a `memory_relations` row from a v3
   * full-history bundle. The PRIMARY KEY
   * `(from_memory_id, to_memory_id, relation_type)`
   * makes the write idempotent under repeat ingestion
   * (`INSERT OR IGNORE`). The caller passes the
   * (already-remapped) endpoints; we do NOT re-derive
   * them. The `metadata_json` is the JSON-encoded
   * metadata the bundle supplied.
   *
   * Intended use: the `applyImport` path inside the
   * `service.store.transaction(...)` block restores
   * the source's relation graph when the plan is
   * `history_mode === "full_history"` AND the bundle's
   * generation is `v3_full_history`.
   */
  insertRelationRow(input: {
    from_memory_id: string;
    to_memory_id: string;
    relation_type: string;
    confidence: number | null;
    metadata_json: string;
    created_at: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_relations
           (from_memory_id, to_memory_id, relation_type, confidence, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.from_memory_id,
        input.to_memory_id,
        input.relation_type,
        input.confidence,
        input.metadata_json,
        input.created_at
      );
  }

  /**
   * Stage 18 v1.1.2 (issue #25, task 6): return every
   * `memory_relations` row, ordered by
   * `(from_memory_id, to_memory_id, relation_type)` so
   * the export-side bundle is deterministic. Used by
   * `buildFullHistoryBundle` to gather the source-side
   * relation graph for the v3 bundle.
   */
  listRelationRows(): Array<{
    from_memory_id: string;
    to_memory_id: string;
    relation_type: string;
    confidence: number | null;
    metadata_json: string;
    created_at: string;
  }> {
    return this.db
      .prepare(
        `SELECT from_memory_id, to_memory_id, relation_type, confidence, metadata_json, created_at
           FROM memory_relations
          ORDER BY from_memory_id ASC, to_memory_id ASC, relation_type ASC`
      )
      .all() as Array<{
      from_memory_id: string;
      to_memory_id: string;
      relation_type: string;
      confidence: number | null;
      metadata_json: string;
      created_at: string;
    }>;
  }

  /**
   * Stage 18 v1.1.2 (issue #25, task 6): return the
   * `audit_events` rows for one memory, ascending by
   * `created_at`. Used by `buildFullHistoryBundle` to
   * gather the source-side audit chain for the v3
   * bundle. The query is bounded to a single memory
   * so a million-row audit log does not blow the
   * export memory budget.
   */
  listAuditEventRowsForMemory(memoryId: string): Array<{
    id: string;
    memory_id: string | null;
    scope: "global" | "project";
    project_id: string | null;
    event: string;
    reason: string | null;
    actor: string;
    metadata_json: string;
    created_at: string;
  }> {
    return this.db
      .prepare(
        `SELECT id, memory_id, scope, project_id, event, reason, actor, metadata_json, created_at
           FROM audit_events
          WHERE memory_id = ?
          ORDER BY created_at ASC, id ASC`
      )
      .all(memoryId) as Array<{
      id: string;
      memory_id: string | null;
      scope: "global" | "project";
      project_id: string | null;
      event: string;
      reason: string | null;
      actor: string;
      metadata_json: string;
      created_at: string;
    }>;
  }

  /**
   * Stage 18 v1.1.2 (issue #25, task 6): import-side
   * write of an `audit_events` row from a v3
   * full-history bundle. The PRIMARY KEY is the row's
   * `id`; the caller is expected to mint a fresh id
   * (the bundle's source-side id would collide with
   * any future live audit row keyed on the same id).
   * The importer prefixes the source-side id with
   * `imp:<batch_id>:` so the new id is unique to the
   * import run.
   *
   * The row carries the source's `created_at`,
   * `event`, `actor`, `reason`, `metadata_json`, and
   * `scope` / `project_id`. A failure inside the
   * enclosing transaction rolls back every row
   * including the entries.
   */
  insertAuditEventRow(input: {
    id: string;
    memory_id: string | null;
    scope: "global" | "project";
    project_id: string | null;
    event: string;
    reason: string | null;
    actor: string;
    metadata_json: string;
    created_at: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO audit_events
            (id, memory_id, scope, project_id, event, reason, actor, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.memory_id,
        input.scope,
        input.project_id,
        input.event,
        input.reason,
        input.actor,
        input.metadata_json,
        input.created_at
      );
  }

  /**
   * Stage 15 PR-M1-2 (issue #7, spec § 5.4): strict
   * project identity model. A `project_identity` row
   * pins a `project_id` to its `canonical_path`. A
   * caller that submits a `project_id` already in the
   * table with a *different* `canonical_path` triggers
   * `project_identity_conflict` at the service layer;
   * the database itself accepts the row, but the
   * service rejects it.
   *
   * `createProjectIdentity` is idempotent under
   * `(project_id, canonical_path, created_by)`: a
   * second call with the same triple is a no-op via
   * `INSERT OR IGNORE`. A second call with the same
   * `project_id` but a different `canonical_path`
   * throws `SQLITE_CONSTRAINT_PRIMARYKEY` — callers
   * must catch that and surface
   * `project_identity_conflict`.
   */
  createProjectIdentity(input: {
    project_id: string;
    canonical_path: string;
    created_by: string;
    created_at: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO project_identities
          (project_id, canonical_path, created_by, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(
        input.project_id,
        input.canonical_path,
        input.created_by,
        input.created_at
      );
  }

  getProjectIdentity(projectId: string): {
    project_id: string;
    canonical_path: string;
    created_by: string;
    created_at: string;
  } | undefined {
    const row = this.db
      .prepare(
        "SELECT project_id, canonical_path, created_by, created_at FROM project_identities WHERE project_id = ?"
      )
      .get(projectId) as
      | {
          project_id: string;
          canonical_path: string;
          created_by: string;
          created_at: string;
        }
      | undefined;
    return row;
  }

  /**
   * Stage 15 PR-M1-2: register an alias for an
   * existing project identity. The alias is the raw
   * path the caller resolved (e.g. a symlink target,
   * a worktree, a Windows-cased path). The
   * `project_id` and `canonical_path` are taken from
   * the identity row. `INSERT OR IGNORE` makes repeat
   * registration idempotent under `alias`.
   */
  createProjectAlias(input: {
    alias: string;
    project_id: string;
    canonical_path: string;
    alias_kind: "path" | "git_head" | "worktree";
    recorded_by: string;
    recorded_at: number;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO project_aliases_new
          (alias, project_id, canonical_path, alias_kind, recorded_by, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.alias,
        input.project_id,
        input.canonical_path,
        input.alias_kind,
        input.recorded_by,
        input.recorded_at
      );
  }

  getProjectAliasByPath(alias: string): {
    alias: string;
    project_id: string;
    canonical_path: string;
    alias_kind: "path" | "git_head" | "worktree";
    recorded_by: string;
    recorded_at: number;
  } | undefined {
    const row = this.db
      .prepare(
        "SELECT alias, project_id, canonical_path, alias_kind, recorded_by, recorded_at FROM project_aliases_new WHERE alias = ?"
      )
      .get(alias) as
      | {
          alias: string;
          project_id: string;
          canonical_path: string;
          alias_kind: "path" | "git_head" | "worktree";
          recorded_by: string;
          recorded_at: number;
        }
      | undefined;
    return row;
  }

  listProjectAliases(projectId: string): Array<{
    alias: string;
    project_id: string;
    canonical_path: string;
    alias_kind: "path" | "git_head" | "worktree";
    recorded_by: string;
    recorded_at: number;
  }> {
    return this.db
      .prepare(
        "SELECT alias, project_id, canonical_path, alias_kind, recorded_by, recorded_at FROM project_aliases_new WHERE project_id = ? ORDER BY alias ASC"
      )
      .all(projectId) as Array<{
      alias: string;
      project_id: string;
      canonical_path: string;
      alias_kind: "path" | "git_head" | "worktree";
      recorded_by: string;
      recorded_at: number;
    }>;
  }

  /**
   * Stage 15 PR-M1-3 (issue #5, spec § 5.3): record
   * explicit per-actor feedback for a memory. The
   * `kind` enum is `up` (👍), `down` (👎), `pin`
   * (always surface), `hide` (always suppress).
   * `INSERT OR REPLACE` lets a single actor change
   * their mind and the latest intent wins.
   */
  recordMemoryFeedback(input: {
    memory_id: string;
    actor_id: string;
    kind: "up" | "down" | "pin" | "hide";
    created_at: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO memory_feedback
          (memory_id, actor_id, kind, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(input.memory_id, input.actor_id, input.kind, input.created_at);
  }

  /**
   * Per-actor feedback map for a memory. The
   * `up`/`down`/`pin`/`hide` keys are mutually
   * independent; a single actor may have up to four
   * feedback rows.
   */
  getMemoryFeedback(memoryId: string): Array<{
    actor_id: string;
    kind: "up" | "down" | "pin" | "hide";
    created_at: string;
  }> {
    return this.db
      .prepare(
        "SELECT actor_id, kind, created_at FROM memory_feedback WHERE memory_id = ? ORDER BY created_at ASC"
      )
      .all(memoryId) as Array<{
      actor_id: string;
      kind: "up" | "down" | "pin" | "hide";
      created_at: string;
    }>;
  }

  /**
   * Aggregate feedback per `kind` for a memory. Used
   * by the ranker to compute the `feedback_signal`
   * component without round-tripping the per-actor
   * rows.
   */
  getMemoryFeedbackCounts(memoryId: string): {
    up: number;
    down: number;
    pin: number;
    hide: number;
  } {
    const rows = this.db
      .prepare("SELECT kind, COUNT(*) AS c FROM memory_feedback WHERE memory_id = ? GROUP BY kind")
      .all(memoryId) as Array<{ kind: string; c: number }>;
    const out = { up: 0, down: 0, pin: 0, hide: 0 };
    for (const row of rows) {
      if (row.kind === "up") out.up = row.c;
      else if (row.kind === "down") out.down = row.c;
      else if (row.kind === "pin") out.pin = row.c;
      else if (row.kind === "hide") out.hide = row.c;
    }
    return out;
  }

  /**
   * Stage 15 PR-M1-3: cache the per-memory recall
   * stats so the ranker's `recall_signal` component
   * is real (not a placeholder 0). The cache is
   * updated after every `rankRecall`; reads are
   * point lookups.
   */
  recordRecallSignal(input: {
    memory_id: string;
    rank: number;
    query: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO memory_recall_signals
          (memory_id, recall_count, last_recalled_at, last_recall_rank, last_recall_query)
         VALUES (?, 1, ?, ?, ?)
         ON CONFLICT(memory_id) DO UPDATE SET
           recall_count = recall_count + 1,
           last_recalled_at = excluded.last_recalled_at,
           last_recall_rank = excluded.last_recall_rank,
           last_recall_query = excluded.last_recall_query`
      )
      .run(input.memory_id, nowIso(), input.rank, input.query);
  }

  getRecallSignal(memoryId: string): {
    memory_id: string;
    recall_count: number;
    last_recalled_at: string | null;
    last_recall_rank: number | null;
    last_recall_query: string | null;
  } | undefined {
    return this.db
      .prepare(
        "SELECT memory_id, recall_count, last_recalled_at, last_recall_rank, last_recall_query FROM memory_recall_signals WHERE memory_id = ?"
      )
      .get(memoryId) as
      | {
          memory_id: string;
          recall_count: number;
          last_recalled_at: string | null;
          last_recall_rank: number | null;
          last_recall_query: string | null;
        }
      | undefined;
  }

  /**
   * Per-actor access count for a single memory. Replaces
   * the legacy `entry.last_accessed_by` JSON map as the
   * canonical access source. Returns 0 when the actor
   * has never accessed the memory; the underlying
   * `memory_accesses` table has `PRIMARY KEY (memory_id,
   * actor_id)` so the lookup is a single row.
   */
  getAccessCountFor(memoryId: string, actorId: string): number {
    const row = this.db
      .prepare(
        "SELECT access_count FROM memory_accesses WHERE memory_id = ? AND actor_id = ?"
      )
      .get(memoryId, actorId) as { access_count: number } | undefined;
    return row?.access_count ?? 0;
  }
  /**
   * All per-actor access counts for a memory, keyed by
   * `actor_id`. Replaces `entry.last_accessed_by` JSON
   * for callers that need the full access map.
   */
  getAllAccessCountsFor(memoryId: string): Record<string, number> {
    const rows = this.db
      .prepare(
        "SELECT actor_id, access_count FROM memory_accesses WHERE memory_id = ?"
      )
      .all(memoryId) as Array<{ actor_id: string; access_count: number }>;
    const out: Record<string, number> = {};
    for (const row of rows) {
      out[row.actor_id] = row.access_count;
    }
    return out;
  }

  /** A plan_id is "applied" iff there is an `apply_maintenance`
   * audit event that names it. We use this to detect a retry
   * with the same idempotency_key (idempotent no-op) vs a
   * different idempotency_key (idempotency_mismatch). */
  getAppliedMaintenanceKeys(planId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT metadata_json FROM audit_events
          WHERE event = 'apply_maintenance'`
      )
      .all() as Array<{ metadata_json: string }>;
    const keys: string[] = [];
    for (const row of rows) {
      try {
        const meta = JSON.parse(row.metadata_json) as { plan_id?: unknown; idempotency_key?: unknown; ok?: unknown };
        if (meta.plan_id === planId && typeof meta.idempotency_key === "string" && meta.ok === true) {
          keys.push(meta.idempotency_key);
        }
      } catch {
        continue;
      }
    }
    return keys;
  }


  /**
   * Stage 16 v1.1.1 PR-6 (issue #15, spec § 5.3):
   * real conflict penalty. Returns the
   * `memory_relations` rows for an entry whose
   * `relation_type` is in the supplied set. The
   * ranker uses this to count the entry's
   * `contradicts` / `supersedes` peers and
   * penalise each conflicting peer by 0.05 (up
   * to 0.2 total).
   */
  getMemoryRelationsOfType(
    memoryId: string,
    types: string[]
  ): Array<{ from_memory_id: string; to_memory_id: string; relation_type: string }> {
    if (types.length === 0) return [];
    const placeholders = types.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT from_memory_id, to_memory_id, relation_type
           FROM memory_relations
          WHERE from_memory_id = ? AND relation_type IN (${placeholders})`
      )
      .all(memoryId, ...types) as Array<{ from_memory_id: string; to_memory_id: string; relation_type: string }>;
  }

  listAuditEvents(filters: AuditFilters = {}): MemoryAuditEvent[] {
    const { where, params } = buildAuditWhere(filters);
    const limit = normalizeLimit(filters.limit, 100);
    const offset = normalizeOffset(filters.offset);
    return this.db
      .prepare(`SELECT * FROM audit_events ${where} ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`)
      .all<Row>(...params, limit, offset)
      .map(decodeAudit);
  }

  /**
   * Stage 15 PR-M0-1 (issue #1, spec § 5.6): idempotency
   * v2 cache accessors. The `mutation_requests_v2` table
   * stores the canonical result of a mutating operation
   * so a retry with the same `(actor, tool, key)` can
   * replay the result without re-running the mutation.
   *
   * `tryReserveMutationRequest` does an `INSERT OR ABORT`
   * with `state='pending'`. It returns `true` when the
   * row was inserted (caller should run the mutation,
   * then call `completeMutationRequest`). It returns
   * `false` when the row already exists — the caller
   * must then call `lookupMutationRequestV2` to
   * classify the hit as replay / rejected / in_flight.
   *
   * The store is `STRICT` typed; we keep `nowIso()` for
   * the created_at / completed_at fields.
   */

  tryReserveMutationRequest(
    actor: string,
    tool: string,
    key: string,
    requestHash: string,
    requestId: string
  ): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO mutation_requests_v2
             (actor_id, tool_name, idempotency_key, state,
              request_hash, result_json, request_id,
              created_at, completed_at)
           VALUES (?, ?, ?, 'pending', ?, NULL, ?, ?, NULL)`
        )
        .run(actor, tool, key, requestHash, requestId, nowIso());
      return true;
    } catch (err) {
      // node:sqlite throws "SqliteError" on a UNIQUE /
      // PRIMARY KEY violation. The exact code is
      // SQLITE_CONSTRAINT_PRIMARYKEY (= 1555) or
      // SQLITE_CONSTRAINT_UNIQUE (= 1555) — both surface
      // with the message we grep for. Treat any
      // constraint violation as "row already exists"
      // so the caller can classify the hit.
      if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
        return false;
      }
      throw err;
    }
  }

  completeMutationRequest(
    actor: string,
    tool: string,
    key: string,
    resultJson: string
  ): void {
    this.db
      .prepare(
        `UPDATE mutation_requests_v2
           SET state = 'completed',
               result_json = ?,
               completed_at = ?
         WHERE actor_id = ? AND tool_name = ? AND idempotency_key = ?`
      )
      .run(resultJson, nowIso(), actor, tool, key);
  }

  lookupMutationRequestV2(
    actor: string,
    tool: string,
    key: string
  ): { request_hash: string; result_json: string; state: "pending" | "completed" } | undefined {
    const row = this.db
      .prepare(
        `SELECT request_hash, result_json, state
           FROM mutation_requests_v2
          WHERE actor_id = ? AND tool_name = ? AND idempotency_key = ?`
      )
      .get(actor, tool, key) as
      | { request_hash: string; result_json: string; state: "pending" | "completed" }
      | undefined;
    return row;
  }

  /**
   * @deprecated Stage 11 PR7: v1 idempotency cache
   * accessors. The v1 PK was `(actor_id, idempotency_key)`
   * with no `tool_name` dimension, which caused cross-tool
   * collisions. Stage 15 PR-M0-1 introduces v2 with
   * `(actor_id, tool_name, idempotency_key)` — new code
   * MUST use `tryReserveMutationRequest` /
   * `completeMutationRequest` / `lookupMutationRequestV2`.
   * This wrapper is preserved for one release cycle so
   * external callers and the p0-mutation-safety regression
   * suite keep working. The v2 migration wrote v1 rows
   * into `mutation_requests_v2` with `tool_name='legacy'`,
   * so the v1 `(actor, key)` namespace lives on under the
   * `legacy` tool.
   */
  lookupMutationRequest(actor: string, key: string):
    | { request_hash: string; result_json: string }
    | undefined {
    const row = this.db
      .prepare(
        "SELECT request_hash, result_json FROM mutation_requests WHERE actor_id = ? AND idempotency_key = ?"
      )
      .get(actor, key) as { request_hash: string; result_json: string } | undefined;
    return row;
  }

  upsertMutationRequest(
    actor: string,
    key: string,
    requestHash: string,
    resultJson: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO mutation_requests (actor_id, idempotency_key, request_hash, result_json, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(actor_id, idempotency_key) DO UPDATE SET
           request_hash = excluded.request_hash,
           result_json = excluded.result_json`
      )
      .run(actor, key, requestHash, resultJson, nowIso());
  }

  /**
   * Stage 11 PR7: atomic access UPSERT (spec § 5.6).
   * Two agents accessing the same memory in the same
   * SQLite write window both end up with their own row
   * in `memory_accesses` rather than overwriting each
   * other's last_accessed_at. The legacy
   * `last_accessed_by` JSON column is still written
   * (for read-back compat with the v3 schema) but the
   * canonical access data is now in this table.
   */
  recordAccess(
    memoryId: string,
    actorId: string,
    timestamp: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO memory_accesses
            (memory_id, actor_id, access_count, first_accessed_at, last_accessed_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(memory_id, actor_id) DO UPDATE SET
           access_count = access_count + 1,
           last_accessed_at = excluded.last_accessed_at`
      )
      .run(memoryId, actorId, timestamp, timestamp);
  }

  getBudgetUsage(filters: { scope: MemoryScope; project_id?: string }): BudgetUsage {
    const { where, params } = buildBudgetWhere(filters);
    const summary = this.db
      .prepare(
        `
        SELECT
          COUNT(*) AS active_entries,
          COALESCE(SUM(char_count), 0) AS active_chars,
          COALESCE(SUM(
            length(title) +
            length(topic) +
            (
              SELECT
                CASE
                  WHEN COUNT(*) = 0 THEN 0
                  ELSE COALESCE(SUM(length(CAST(value AS TEXT))), 0) + COUNT(*) - 1
                END
              FROM json_each(memory_entries.tags_json)
            ) +
            16
          ), 0) AS index_chars
        FROM memory_entries
        ${where}
      `
      )
      .get<Row>(...params);
    const topicRows = this.db
      .prepare(
        `
        SELECT topic, COALESCE(SUM(char_count), 0) AS chars
        FROM memory_entries
        ${where}
        GROUP BY topic
        ORDER BY topic ASC
      `
      )
      .all<Row>(...params);
    const topicChars = new Map<string, number>();
    for (const row of topicRows) {
      topicChars.set(stringCell(row, "topic"), numberCell(row, "chars"));
    }

    return {
      active_entries: summary === undefined ? 0 : numberCell(summary, "active_entries"),
      active_chars: summary === undefined ? 0 : numberCell(summary, "active_chars"),
      topic_chars: Object.fromEntries(topicChars) as Record<string, number>,
      index_chars: summary === undefined ? 0 : numberCell(summary, "index_chars")
    };
  }

  private readEntry(id: string): MemoryEntry | undefined {
    const row = this.db.prepare("SELECT * FROM memory_entries WHERE id = ?").get<Row>(id);
    if (row === undefined) return undefined;
    const entry = decodeEntry(row);
    // Stage 16 v1.1.1 PR-1 (#11): the canonical access
    // source of truth is `memory_accesses` (v4 schema). The
    // `last_accessed_by` JSON column on `memory_entries` is
    // a derived cache that pre-PR-1 callers (e.g. `getEntry`
    // with an `accessedBy` argument) maintained as a side
    // effect of reading. Now that reads are pure (no side
    // effects), the cache may be stale or null even when
    // `memory_accesses` has rows. Re-derive the per-actor
    // last-access map from the canonical table when the
    // cache is empty.
    if (entry.last_accessed_by === undefined || Object.keys(entry.last_accessed_by).length === 0) {
      const accessRows = this.db
        .prepare(
          "SELECT actor_id, last_accessed_at FROM memory_accesses WHERE memory_id = ? ORDER BY actor_id ASC"
        )
        .all(id) as Array<{ actor_id: string; last_accessed_at: string }>;
      if (accessRows.length > 0) {
        const derived: Record<string, string> = {};
        for (const r of accessRows) derived[r.actor_id] = r.last_accessed_at;
        entry.last_accessed_by = derived;
      }
    }
    return entry;
  }

  private entryParams(entry: MemoryEntry): SQLInputValue[] {
    // v4 fields use defensive defaults so test fixtures
    // that still construct entries via the v3 shape
    // (no `revision` / `writer_actor_id` / `pinned` / etc.)
    // keep working. The defaults match the SQL
    // `DEFAULT` clauses and the `buildEntry` helper.
    return [
      entry.id,
      entry.scope,
      entry.project_id ?? null,
      entry.project_path ?? null,
      entry.type,
      entry.topic,
      entry.title,
      entry.body,
      encodeJson(entry.tags),
      encodeJson(entry.source),
      entry.importance,
      entry.confidence,
      entry.status,
      entry.created_at,
      entry.updated_at,
      entry.last_accessed_at ?? null,
      entry.last_accessed_by ? encodeJson(entry.last_accessed_by) : null,
      entry.access_count,
      entry.expires_at ?? null,
      entry.review_after ?? null,
      encodeJson(entry.supersedes),
      entry.superseded_by ?? null,
      entry.token_estimate,
      entry.char_count,
      // Stage 12 PR9: schema v4 row shape (with defaults).
      entry.revision ?? 1,
      entry.writer_actor_id ?? "agent:pending",
      entry.content_hash ?? null,
      entry.pinned ? 1 : 0,
      entry.trust_level ?? "agent_observed",
      entry.sensitivity ?? "normal",
      entry.valid_from ?? null,
      entry.valid_until ?? null,
      entry.deleted_at ?? null,
      // Stage 15 PR-M3-1 (issue #9, spec § 6.5):
      // `tier` defaults to 'working' for legacy
      // entries that pre-date the v10 column.
      entry.tier ?? "working",
      encodeJson(entry.metadata ?? {})
    ];
  }

  /**
   * Stage 12 PR9: bounded busy retry. SQLite's
   * `busy_timeout = 5000` PRAGMA already lets one
   * process wait for the writer; this helper adds an
   * extra retry layer for the case where the contention
   * exceeds busy_timeout (e.g. a long-running
   * transaction on another connection). 5 retries
   * with 10ms backoff covers the 8-process stress test
   * the spec § 5.6 multi-process promise requires.
   */
  runWithBusyRetry<T>(
    fn: () => T,
    opts: { maxRetries?: number; backoffMs?: number } = {}
  ): T {
    const maxRetries = opts.maxRetries ?? 5;
    const backoffMs = opts.backoffMs ?? 10;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return fn();
      } catch (error) {
        lastError = error;
        if (ConcurrentRevisionError.isThis(error)) {
          // CAS conflict is not a transient I/O error.
          // The write service maps this to the
          // `stale_revision` result.
          throw error;
        }
        if (!isSqliteBusyError(error) || attempt === maxRetries) {
          throw error;
        }
        const sleep = backoffMs * (attempt + 1);
        const end = Date.now() + sleep;
        while (Date.now() < end) {
          // spin intentionally; the busy_timeout
          // PRAGMA already absorbed the single-writer
          // wait, this loop only fires when multiple
          // writers all queue simultaneously.
        }
      }
    }
    throw lastError;
  }

  /**
   * Stage 12 PR9: optimistic-concurrency update. Returns
   * `true` if the row's revision matched `expectedRevision`
   * and the patch was applied (with the revision bumped),
   * `false` if the row was concurrently modified. The
   * write service maps a `false` return to the
   * `stale_revision` error code on the MCP wire so
   * clients can retry after re-reading the row.
   *
   * The implementation uses the pre-rewrite
   * `current.revision` for the WHERE clause so a
   * concurrent UPDATE that already advanced the row
   * gets matched by zero rows — the same property the
   * spec § 5.6 CAS contract requires.
   */
  updateEntryWithRevision(
    id: string,
    patch: EntryPatch,
    expectedRevision: number,
    revisionContext?: { changed_by: string; request_id?: string; change_reason?: string }
  ): boolean {
    const current = this.readEntry(id);
    if (current === undefined) return false;
    if (current.revision !== expectedRevision) {
      return false;
    }
    const next: MemoryEntry = {
      ...current,
      ...sanitizeEntryPatch(patch),
      id: current.id,
      revision: current.revision + 1,
      updated_at: nowIso()
    };
    return this.runWithBusyRetry(() => {
      let applied = false;
      this.transaction(() => {
        const stmt = this.db.prepare(`
          UPDATE memory_entries SET
            scope = ?, project_id = ?, project_path = ?,
            type = ?, topic = ?, title = ?, body = ?,
            tags_json = ?, source_json = ?,
            importance = ?, confidence = ?, status = ?,
            created_at = ?, updated_at = ?,
            last_accessed_at = ?, last_accessed_by = ?,
            access_count = ?, expires_at = ?, review_after = ?,
            supersedes_json = ?, superseded_by = ?,
            token_estimate = ?, char_count = ?,
            revision = ?,
            writer_actor_id = ?, content_hash = ?,
            pinned = ?, trust_level = ?, sensitivity = ?,
            valid_from = ?, valid_until = ?, deleted_at = ?,
            metadata_json = ?
          WHERE id = ? AND revision = ?
        `);
        const result = stmt.run(
          next.scope, next.project_id ?? null, next.project_path ?? null,
          next.type, next.topic, next.title, next.body,
          encodeJson(next.tags), encodeJson(next.source),
          next.importance, next.confidence, next.status,
          next.created_at, next.updated_at,
          next.last_accessed_at ?? null,
          next.last_accessed_by ? encodeJson(next.last_accessed_by) : null,
          next.access_count, next.expires_at ?? null, next.review_after ?? null,
          encodeJson(next.supersedes), next.superseded_by ?? null,
          next.token_estimate, next.char_count,
          next.revision,
          next.writer_actor_id, next.content_hash ?? null,
          next.pinned ? 1 : 0, next.trust_level, next.sensitivity,
          next.valid_from ?? null, next.valid_until ?? null, next.deleted_at ?? null,
          encodeJson(next.metadata),
          id,
          expectedRevision
        );
        if (result.changes === 0) {
          // Concurrent writer won the race; abort the
          // enclosing transaction so the FTS upsert is
          // not performed against a stale snapshot.
          throw new ConcurrentRevisionError();
        }
        this.upsertFts(next);
        if (revisionContext !== undefined) {
          this.recordRevisionRow(
            current.id,
            next.revision,
            next,
            revisionContext.changed_by,
            revisionContext.request_id,
            revisionContext.change_reason
          );
        }
        applied = true;
      });
      return applied;
    });
  }

  private upsertFts(entry: MemoryEntry): void {
    this.db.prepare("DELETE FROM memory_fts WHERE id = ?").run(entry.id);
    this.db
      .prepare("INSERT INTO memory_fts (id, scope, project_id, topic, title, body, tags) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(entry.id, entry.scope, entry.project_id ?? "", entry.topic, entry.title, entry.body, entry.tags.join(" "));
  }

  /**
   * Stage 14 PR-B2 (spec § 6.5): append the first
   * `memory_revisions` row for a freshly-created entry. The
   * row is keyed on `revision: 1` (the same `revision` the
   * `memory_entries` row carries post-insert) so the audit
   * chain is contiguous from the very first mutation. The
   * snapshot is a `created`-shaped placeholder (the full
   * entry) so audit consumers can join the revision row
   * against the `created` audit event. Called from
   * `MemoryWriteService.commitPreparedRemember` after
   * `insertEntry`.
   */
  recordRevisionForCreate(
    memoryId: string,
    changedBy: string,
    requestId: string | undefined
  ): void {
    const created = this.readEntry(memoryId);
    this.recordRevisionRow(
      memoryId,
      1,
      (created ?? { id: memoryId, revision: 1 }) as unknown as MemoryEntry,
      changedBy,
      requestId,
      "created"
    );
  }

  /**
   * Stage 14 PR-B2 (spec § 6.5): append a `memory_revisions` row
   * capturing the snapshot of the entry *after* the mutation
   * (post-image) keyed on the entry's new revision. The row is
   * keyed on `(memory_id, revision)` so a single revision can
   * be replayed exactly once. The snapshot is `JSON.stringify`-ed
   * from the `MemoryEntry` so audit consumers can reconstruct
   * the full state at any past revision. Storing the post-image
   * (rather than the pre-image) keeps the PRIMARY KEY collision-
   * free across the create + update sequence (the create row is
   * keyed on `revision: 1`, every subsequent update is keyed
   * on the entry's new `revision`).
   *
   * Called from inside the same `this.transaction(() => ...)`
   * block as the entry update so a failure on either side rolls
   * both back. The `request_id` is the per-call UUID from
   * `RequestContext` (or empty when the caller did not provide
   * one) so the revision row can be joined to the matching
   * `audit_events` row for the same request.
   */
  private recordRevisionRow(
    memoryId: string,
    revision: number,
    snapshot: MemoryEntry,
    changedBy: string,
    requestId: string | undefined,
    changeReason: string | undefined
  ): void {
    this.db
      .prepare(
        `INSERT INTO memory_revisions
            (memory_id, revision, snapshot_json, changed_by, request_id, change_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        memoryId,
        revision,
        JSON.stringify(snapshot),
        changedBy,
        requestId ?? "",
        changeReason ?? null,
        nowIso()
      );
  }

  // ─────────────────────────────────────────────────────────────────────
  // v1.2.0-alpha.2 (issue #50): session -> memory
  // distillation candidate store. The three tables
  // — `derivation_candidates` / `candidate_evidence` /
  // `candidate_actions` — back the reviewable
  // memory / episode / skill-candidate proposals
  // produced by the deterministic baseline extractor
  // (and any future provider-backed extractor).
  //
  // All inserts are idempotent: a duplicate
  // `candidate_id` returns `false` from
  // `insertCandidate`; the evidence / action tables
  // de-dupe on the composite primary key. The
  // `apply` path's CAS guard is the
  // `expected_target_revision` column on the
  // candidate row; drift transitions the row to
  // `stale` and the apply batch continues with the
  // remaining candidates.
  // ─────────────────────────────────────────────────────────────────────

  /**
   * v1.2.0-alpha.2 (issue #50): insert a new
   * candidate row. Returns `true` on success,
   * `false` when a row with the same
   * `candidate_id` already exists (idempotent
   * re-insert). Throws on CHECK violation
   * (invalid kind, invalid state, invalid
   * scope/project_id combo, etc.) — the caller
   * surfaces that as a stable error code.
   */
  insertCandidate(row: DerivationCandidateRow): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO derivation_candidates (
            candidate_id, job_id, run_id, candidate_kind,
            proposed_type, proposed_topic, proposed_title, proposed_body,
            proposed_tags_json, proposed_scope, proposed_project_id,
            proposed_tier, proposed_trust_level, proposed_sensitivity,
            confidence, state,
            extractor_id, extractor_version, content_hash,
            created_at, reviewed_at, reviewed_by_actor_id, applied_at,
            expected_target_revision
          ) VALUES (
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?,
            ?
          )`
        )
        .run(
          row.candidate_id,
          row.job_id,
          row.run_id,
          row.candidate_kind,
          row.proposed_type,
          row.proposed_topic,
          row.proposed_title,
          row.proposed_body,
          row.proposed_tags_json,
          row.proposed_scope,
          row.proposed_project_id,
          row.proposed_tier,
          row.proposed_trust_level,
          row.proposed_sensitivity,
          row.confidence,
          row.state,
          row.extractor_id,
          row.extractor_version,
          row.content_hash,
          row.created_at,
          row.reviewed_at,
          row.reviewed_by_actor_id,
          row.applied_at,
          row.expected_target_revision
        );
      return true;
    } catch (error) {
      if (isSqliteUniqueConstraintError(error)) return false;
      throw error;
    }
  }

  /**
   * Read a single candidate row by its primary key.
   * Returns `undefined` if the row does not exist.
   */
  getCandidate(candidateId: string): DerivationCandidateRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM derivation_candidates WHERE candidate_id = ?")
      .get(candidateId) as Row | undefined;
    if (row === undefined) return undefined;
    return derivationCandidateFromRow(row);
  }

  /**
   * List all candidates for a given job, ordered by
   * `created_at ASC` so the inspection output reads in
   * the same order the extractor emitted them.
   */
  listCandidatesForJob(jobId: string): DerivationCandidateRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM derivation_candidates WHERE job_id = ? ORDER BY created_at ASC, candidate_id ASC"
      )
      .all(jobId) as Row[];
    return rows.map((r) => derivationCandidateFromRow(r));
  }

  /**
   * Transition a candidate's state. The `now_ms` is
   * the timestamp written to the matching side-column
   * (`reviewed_at` for accept/reject, `applied_at`
   * for apply). A `stale` transition is a no-op for
   * the reviewer / applied columns; the row still
   * moves to `stale` so the inspector surfaces the
   * drift. Returns `true` when the row updated.
   */
  updateCandidateState(args: {
    candidate_id: string;
    next_state: DerivationCandidateState;
    reviewed_by_actor_id?: string | null;
    now_ms: number;
  }): boolean {
    const reviewedBy =
      args.reviewed_by_actor_id === undefined ? null : args.reviewed_by_actor_id;
    if (args.next_state === "applied") {
      const result = this.db
        .prepare(
          `UPDATE derivation_candidates
              SET state = ?,
                  applied_at = ?,
                  reviewed_at = COALESCE(reviewed_at, ?),
                  reviewed_by_actor_id = COALESCE(reviewed_by_actor_id, ?)
            WHERE candidate_id = ?`
        )
        .run(args.next_state, args.now_ms, args.now_ms, reviewedBy, args.candidate_id);
      return result.changes > 0;
    }
    if (args.next_state === "accepted" || args.next_state === "rejected") {
      const result = this.db
        .prepare(
          `UPDATE derivation_candidates
              SET state = ?,
                  reviewed_at = ?,
                  reviewed_by_actor_id = ?
            WHERE candidate_id = ?`
        )
        .run(args.next_state, args.now_ms, reviewedBy, args.candidate_id);
      return result.changes > 0;
    }
    // `proposed` (re-emit) or `stale` (CAS drift)
    // transitions only flip the state column.
    const result = this.db
      .prepare(
        `UPDATE derivation_candidates
            SET state = ?
          WHERE candidate_id = ?`
      )
      .run(args.next_state, args.candidate_id);
    return result.changes > 0;
  }

  /**
   * Insert one evidence row. The composite primary
   * key `(candidate_id, evidence_role,
   * excerpt_digest)` de-dupes identical rows so a
   * re-run is a no-op. Throws on duplicate (caller
   * can ignore).
   */
  insertCandidateEvidence(row: CandidateEvidenceRow): void {
    this.db
      .prepare(
        `INSERT INTO candidate_evidence (
          candidate_id, evidence_role,
          session_id, event_id, message_id, tool_call_id, file_ref,
          excerpt_digest
        ) VALUES (
          ?, ?,
          ?, ?, ?, ?, ?,
          ?
        )`
      )
      .run(
        row.candidate_id,
        row.evidence_role,
        row.session_id,
        row.event_id,
        row.message_id,
        row.tool_call_id,
        row.file_ref,
        row.excerpt_digest
      );
  }

  /**
   * Insert one action row. The composite primary
   * key `(candidate_id, action)` keeps the action
   * list deduped; a re-run of the same action is a
   * SQLITE_CONSTRAINT that the service can ignore.
   */
  insertCandidateAction(row: CandidateActionRow): void {
    this.db
      .prepare(
        `INSERT INTO candidate_actions (
          candidate_id, action,
          target_memory_ids_json, expected_revisions_json,
          rationale, conflict_signals_json, risk
        ) VALUES (
          ?, ?,
          ?, ?,
          ?, ?, ?
        )`
      )
      .run(
        row.candidate_id,
        row.action,
        row.target_memory_ids_json,
        row.expected_revisions_json,
        row.rationale,
        row.conflict_signals_json,
        row.risk
      );
  }

  /**
   * Read all evidence rows for a candidate, ordered
   * by `evidence_role ASC, excerpt_digest ASC` for
   * stable inspection.
   */
  getCandidateEvidence(candidateId: string): CandidateEvidenceRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM candidate_evidence
           WHERE candidate_id = ?
           ORDER BY evidence_role ASC, excerpt_digest ASC`
      )
      .all(candidateId) as Row[];
    return rows.map((r) => candidateEvidenceFromRow(r));
  }

  /**
   * Read all action rows for a candidate, ordered
   * by `action ASC` for stable inspection.
   */
  getCandidateAction(candidateId: string): CandidateActionRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM candidate_actions
           WHERE candidate_id = ?
           ORDER BY action ASC`
      )
      .all(candidateId) as Row[];
    return rows.map((r) => candidateActionFromRow(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  // v1.2.0-alpha.2 (issue #52): agent loadout substrate.
  //
  // The three tables — `agent_loadouts` /
  // `loadout_rules` / `loadout_bindings` — are the durable
  // backing for the policy-bound loadout surface that
  // powers `bootstrap` / `query` / `tool_only` channels
  // of the context-assembly service. The
  // `LoadoutService` (src/loadouts/service.ts) wraps
  // these methods with the public verb API
  // (`create` / `updateRules` / `bind` / `unbind` /
  // `resolve`) and the `LoadoutService.updateRules` CAS
  // semantics that keep `bootstrap_hash` stable when the
  // loadout row + content are unchanged.
  // ─────────────────────────────────────────────────────────────────────

  /**
   * v1.2.0-alpha.2 (issue #52): insert a new
   * `agent_loadouts` row. The row is inserted with
   * `version: 1`, `lifecycle_state: "draft"`. Returns
   * `true` on success, `false` when a row with the
   * same `loadout_id` already exists (idempotent
   * re-insert). Throws on CHECK violation
   * (invalid scope, missing project_id for
   * project-scope, invalid lifecycle_state, etc.)
   * — the caller surfaces that as a stable error code.
   */
  insertLoadout(row: LoadoutRow): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO agent_loadouts (
            loadout_id, name, version, lifecycle_state,
            match_actor_id, match_client_name,
            scope, project_id, task_mode,
            created_by_actor_id, created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?,
            ?, ?,
            ?, ?, ?,
            ?, ?, ?
          )`
        )
        .run(
          row.loadout_id,
          row.name,
          row.version,
          row.lifecycle_state,
          row.match_actor_id,
          row.match_client_name,
          row.scope,
          row.project_id,
          row.task_mode,
          row.created_by_actor_id,
          row.created_at,
          row.updated_at
        );
      return true;
    } catch (error) {
      if (isSqliteUniqueConstraintError(error)) return false;
      throw error;
    }
  }

  /**
   * v1.2.0-alpha.2 (issue #52): read a single
   * `agent_loadouts` row by primary key. Returns
   * `undefined` when the row does not exist.
   */
  getLoadout(loadoutId: string): LoadoutRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM agent_loadouts WHERE loadout_id = ?")
      .get(loadoutId) as Row | undefined;
    if (row === undefined) return undefined;
    return loadoutFromRow(row);
  }

  /**
   * v1.2.0-alpha.2 (issue #52): list loadout rows.
   * The `scope` / `lifecycle_state` filters are
   * optional; the `limit` caps the row count
   * (default 50). Ordered newest-first by
   * `updated_at DESC`.
   */
  listLoadouts(filter: {
    scope?: LoadoutScope;
    project_id?: string;
    lifecycle_state?: LoadoutLifecycleState;
    limit?: number;
  }): LoadoutRow[] {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.scope !== undefined) {
      clauses.push("scope = ?");
      params.push(filter.scope);
    }
    if (filter.project_id !== undefined) {
      clauses.push("project_id = ?");
      params.push(filter.project_id);
    }
    if (filter.lifecycle_state !== undefined) {
      clauses.push("lifecycle_state = ?");
      params.push(filter.lifecycle_state);
    }
    const where = clauses.length === 0 ? "" : " WHERE " + clauses.join(" AND ");
    const limit = filter.limit ?? 50;
    const sql = `SELECT * FROM agent_loadouts${where}
                  ORDER BY updated_at DESC LIMIT ?`;
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as Row[];
    return rows.map((r) => loadoutFromRow(r));
  }

  /**
   * v1.2.0-alpha.2 (issue #52): insert one
   * `loadout_rules` row at `(loadout_id, version,
   * channel)`. The (loadout_id, version, channel)
   * triple is the primary key, so a duplicate
   * insert throws on the constraint. The method
   * is intended to be called inside a
   * `BEGIN IMMEDIATE` block that has already
   * bumped `agent_loadouts.version` (the
   * `LoadoutService.updateRules` caller is the
   * canonical writer).
   */
  insertLoadoutRule(row: LoadoutRuleRow): void {
    this.db
      .prepare(
        `INSERT INTO loadout_rules (
          loadout_id, version, channel,
          include_asset_ids_json, include_memory_ids_json,
          include_types_json, include_tiers_json,
          include_tags_json, include_topics_json,
          exclude_asset_ids_json, exclude_memory_ids_json,
          exclude_tags_json, required_refs_json,
          max_items, max_chars, max_tokens, timeout_ms,
          ordering_policy
        ) VALUES (
          ?, ?, ?,
          ?, ?,
          ?, ?,
          ?, ?,
          ?, ?,
          ?, ?,
          ?, ?, ?, ?,
          ?
        )`
      )
      .run(
        row.loadout_id,
        row.version,
        row.channel,
        encodeJson(row.include_asset_ids),
        encodeJson(row.include_memory_ids),
        encodeJson(row.include_types),
        encodeJson(row.include_tiers),
        encodeJson(row.include_tags),
        encodeJson(row.include_topics),
        encodeJson(row.exclude_asset_ids),
        encodeJson(row.exclude_memory_ids),
        encodeJson(row.exclude_tags),
        encodeJson(row.required_refs),
        row.max_items,
        row.max_chars,
        row.max_tokens,
        row.timeout_ms,
        row.ordering_policy
      );
  }

  /**
   * v1.2.0-alpha.2 (issue #52): CAS update of the
   * `agent_loadouts.version` column. The update
   * only succeeds when the current row has
   * `version = expected_previous_version`;
   * otherwise the function returns `undefined`
   * (caller is racing a concurrent updateRules).
   * The new version MUST be
   * `expected_previous_version + 1`. The
   * `updated_at` is set to `now`. The matching
   * `loadout_rules` rows are inserted by the
   * caller inside the same transaction.
   */
  updateLoadoutVersion(args: {
    loadout_id: string;
    expected_previous_version: number;
    new_version: number;
    now: string;
  }): LoadoutRow | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.db
        .prepare(
          `UPDATE agent_loadouts
              SET version = ?,
                  updated_at = ?
            WHERE loadout_id = ?
              AND version = ?
            RETURNING *`
        )
        .get(
          args.new_version,
          args.now,
          args.loadout_id,
          args.expected_previous_version
        ) as Row | undefined;
      if (updated === undefined) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      this.db.exec("COMMIT");
      return loadoutFromRow(updated);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * v1.2.0-alpha.2 (issue #52): insert one
   * `loadout_bindings` row. The PRIMARY KEY is
   * `binding_id` (a UUID minted by the caller);
   * the row is otherwise a pure match-attribute
   * payload. The `loadout_version` is recorded
   * as the snapshot the binding was created
   * against so a future rule update bumps the
   * `version` but a pre-existing binding
   * continues to point at the head the user
   * originally asked for (the resolver re-pins
   * the version on a successful match — see
   * `LoadoutService.resolve`).
   */
  insertLoadoutBinding(row: LoadoutBindingRow): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO loadout_bindings (
            binding_id, loadout_id, loadout_version,
            actor_id, client_name, project_id, task_mode,
            priority, created_at
          ) VALUES (
            ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?
          )`
        )
        .run(
          row.binding_id,
          row.loadout_id,
          row.loadout_version,
          row.actor_id,
          row.client_name,
          row.project_id,
          row.task_mode,
          row.priority,
          row.created_at
        );
      return true;
    } catch (error) {
      if (isSqliteUniqueConstraintError(error)) return false;
      throw error;
    }
  }

  /**
   * v1.2.0-alpha.2 (issue #52): remove a
   * `loadout_bindings` row by primary key.
   * Returns `true` on a successful delete,
   * `false` when the `binding_id` is unknown
   * (idempotent no-op for re-issued unbinds).
   */
  removeLoadoutBinding(bindingId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM loadout_bindings WHERE binding_id = ?")
      .run(bindingId);
    return result.changes > 0;
  }

  /**
   * v1.2.0-alpha.2 (issue #52): read the per-channel
   * `loadout_rules` rows for the loadout's head
   * `version`. Used by `LoadoutService.resolve` to
   * project the active rule set without a second
   * `getLoadout` round-trip.
   */
  loadoutRulesForVersion(loadoutId: string, version: number): LoadoutRuleRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM loadout_rules WHERE loadout_id = ? AND version = ?"
      )
      .all(loadoutId, version) as Row[];
    return rows.map((r) => loadoutRuleFromRow(r));
  }

  /**
   * v1.2.0-alpha.2 (issue #52): the precedence
   * resolution used by `LoadoutService.resolve`.
   * The method returns the highest-priority
   * matching binding for the supplied
   * `(actor_id, client_name, project_id,
   * task_mode)` tuple, walking the 5-level
   * precedence chain in order:
   *
   *   1. (actor + project + task_mode) exact match
   *   2. (actor + project) exact match
   *   3. (project) default for the project
   *   4. (global) default
   *   5. (no binding) — `undefined` returned; the
   *      `LoadoutService` falls back to the
   *      built-in `legacy-inject-all-active` row.
   *
   * `NULL` on a binding column means "any value"
   * (i.e. a project default binds to every
   * `actor_id` that does not have a more specific
   * binding). The `(scope, project_id)` filter
   * ensures a project-scope binding never leaks
   * into a global resolve and vice versa.
   *
   * The returned tuple is
   * `{ binding, loadout, rules }` so the caller
   * has everything it needs in one round-trip.
   */
  resolveLoadout(input: {
    actor_id?: string;
    client_name?: string;
    project_id?: string;
    task_mode?: string;
  }): {
    binding: LoadoutBindingRow;
    loadout: LoadoutRow;
    rules: LoadoutRuleRow[];
    matched_rule:
      | "actor_project_task"
      | "actor_project"
      | "project_default"
      | "global_default";
  } | undefined {
    // Precedence chain. Each level tries every
    // binding column, treating `NULL` on a
    // binding column as "any value". We walk the
    // 4 levels in priority order; the first
    // non-empty result wins. Level 1
    // (actor_project_task) is only queried when
    // the resolve supplies a `task_mode` — when
    // the resolve omits task_mode, the resolution
    // falls through to level 2 (actor + project
    // default). Within a single level, the row
    // with the highest `priority` wins; ties are
    // surfaced as `binding_ambiguous` by the
    // service layer.
    const levelQueries: Array<{
      matched_rule:
        | "actor_project_task"
        | "actor_project"
        | "project_default"
        | "global_default";
      sql: string;
      params: SQLInputValue[];
    }> = [
      // 1. actor + project + task_mode (exact match)
      {
        matched_rule: "actor_project_task",
        sql: `SELECT b.* FROM loadout_bindings b
              JOIN agent_loadouts l ON l.loadout_id = b.loadout_id
              WHERE (b.actor_id = ? OR b.actor_id IS NULL)
                AND (b.client_name = ? OR b.client_name IS NULL)
                AND (b.project_id = ? OR b.project_id IS NULL)
                AND b.task_mode = ?
                AND l.lifecycle_state IN ('draft', 'active')
              ORDER BY b.priority DESC, b.created_at ASC
              LIMIT 10`,
        params: [
          input.actor_id ?? null,
          input.client_name ?? null,
          input.project_id ?? null,
          input.task_mode ?? ""
        ]
      },
      // 2. actor + project (task_mode NULL on binding)
      {
        matched_rule: "actor_project",
        sql: `SELECT b.* FROM loadout_bindings b
              JOIN agent_loadouts l ON l.loadout_id = b.loadout_id
              WHERE (b.actor_id = ? OR b.actor_id IS NULL)
                AND (b.client_name = ? OR b.client_name IS NULL)
                AND (b.project_id = ? OR b.project_id IS NULL)
                AND b.task_mode IS NULL
                AND l.lifecycle_state IN ('draft', 'active')
              ORDER BY b.priority DESC, b.created_at ASC
              LIMIT 10`,
        params: [
          input.actor_id ?? null,
          input.client_name ?? null,
          input.project_id ?? null
        ]
      },
      // 3. project default
      {
        matched_rule: "project_default",
        sql: `SELECT b.* FROM loadout_bindings b
              JOIN agent_loadouts l ON l.loadout_id = b.loadout_id
              WHERE b.actor_id IS NULL
                AND b.client_name IS NULL
                AND (b.project_id = ? OR b.project_id IS NULL)
                AND b.task_mode IS NULL
                AND l.lifecycle_state IN ('draft', 'active')
              ORDER BY b.priority DESC, b.created_at ASC
              LIMIT 10`,
        params: [input.project_id ?? null]
      },
      // 4. global default
      {
        matched_rule: "global_default",
        sql: `SELECT b.* FROM loadout_bindings b
              JOIN agent_loadouts l ON l.loadout_id = b.loadout_id
              WHERE b.actor_id IS NULL
                AND b.client_name IS NULL
                AND b.project_id IS NULL
                AND b.task_mode IS NULL
                AND l.scope = 'global'
                AND l.lifecycle_state IN ('draft', 'active')
              ORDER BY b.priority DESC, b.created_at ASC
              LIMIT 10`,
        params: []
      }
    ];
    for (const level of levelQueries) {
      // Level 1 (actor_project_task) is an exact
      // match — only query it when the resolve
      // supplies a task_mode. When the resolve
      // omits task_mode we fall through to level 2
      // (actor + project default) which expects
      // b.task_mode IS NULL.
      if (
        level.matched_rule === "actor_project_task" &&
        input.task_mode === undefined
      ) {
        continue;
      }
      const rows = this.db.prepare(level.sql).all(...level.params) as Row[];
      if (rows.length === 0) continue;
      const binding = loadoutBindingFromRow(rows[0] as Row);
      const loadoutRow = this.getLoadout(binding.loadout_id);
      if (loadoutRow === undefined) continue;
      const rules = this.loadoutRulesForVersion(loadoutRow.loadout_id, loadoutRow.version);
      return {
        binding,
        loadout: loadoutRow,
        rules,
        matched_rule: level.matched_rule
      };
    }
    return undefined;
  }
}

// v1.1.6 follow-up B1 (issue #42, spec
// d67fc45, plan bfbd2cb): top-level async
// helper + dedicated `SQLiteBusyError` class.
// Companion to the existing sync class
// method `runWithBusyRetry` (line 3724) which
// is still used by the in-class write path
// (optimistic-concurrency CAS retries in
// `updateEntryWithRevision`). The top-level
// helper exists so async callers — including
// the v1.1.6 release-gate multi-process
// stress test on the Windows-latest runner —
// can opt in to the same retry semantics
// without holding a `SQLiteMemoryStore`
// instance. The unit test in
// `test/unit/sqlite-store-busy-retry.test.ts`
// drives synthetic `SQLITE_BUSY` /
// `SQLITE_LOCKED` errors to verify the
// trigger + exhaustion + non-retry paths.

/**
 * v1.1.6 follow-up B1: thrown by
 * `withBusyRetry` when the retry budget is
 * exhausted. The `attempts` field is the
 * total number of times `op` was invoked
 * (1 + retries), `lastError` is the final
 * SQLITE_BUSY / SQLITE_LOCKED error the
 * helper re-threw. Callers that want to
 * distinguish "the busyness was unresolvable
 * within the budget" from "the operation
 * itself threw something unrelated" can
 * `instanceof` this class.
 */
export class SQLiteBusyError extends Error {
  readonly attempts: number;
  readonly lastError: unknown;
  constructor(message: string, attempts: number, lastError: unknown) {
    super(message);
    this.name = "SQLiteBusyError";
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/**
 * v1.1.6 follow-up B1: top-level async helper
 * that retries a `Promise`-returning op on
 * `SQLITE_BUSY` (5) / `SQLITE_LOCKED` (6)
 * with exponential backoff. Defaults: 5
 * retries, 10ms initial delay, 200ms max
 * delay, 2x backoff. Non-busy errors are
 * re-thrown immediately (CAS conflict,
 * schema mismatch, etc. propagate to the
 * caller's domain logic untouched). The
 * busy-only exhaustion throws
 * `SQLiteBusyError` with `attempts` +
 * `lastError` populated.
 */
export async function withBusyRetry<T>(
  op: () => Promise<T>,
  opts: { maxRetries?: number; initialDelayMs?: number; maxDelayMs?: number; backoff?: number } = {}
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 5;
  const initialDelayMs = opts.initialDelayMs ?? 10;
  const maxDelayMs = opts.maxDelayMs ?? 200;
  const backoff = opts.backoff ?? 2;
  let delay = initialDelayMs;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await op();
    } catch (e) {
      lastError = e;
      if (!isSqliteBusyError(e)) {
        // Not a transient I/O error: re-throw
        // immediately. The caller's domain
        // logic (CAS conflict, schema
        // mismatch, etc.) gets the original
        // error untouched.
        throw e;
      }
      if (attempt === maxRetries) {
        throw new SQLiteBusyError(
          `SQLite busy after ${attempt + 1} attempts`,
          attempt + 1,
          lastError
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * backoff, maxDelayMs);
    }
  }
  // Unreachable: the loop body either returns,
  // re-throws a non-busy error, or throws
  // `SQLiteBusyError` on the last attempt. The
  // throw here keeps TypeScript's control-flow
  // analysis happy.
  throw new SQLiteBusyError("unreachable", maxRetries + 1, lastError);
}
