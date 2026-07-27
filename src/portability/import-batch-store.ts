// src/portability/import-batch-store.ts
//
// Stage 18 v1.1.2 (issue #26, task 7): the durable
// lineage surface for the import path. Every applied
// import writes one row in the `import_batches` table
// keyed on `import_batch_id`; the lifecycle is:
//
//   pending -> running -> completed
//          \-> failed
//
// The transitions are split between the apply
// transaction (so `completed` commits atomically with
// the mutations) and a post-transaction failure handler
// (so a `failed` row persists even when the mutations
// rolled back). The contract:
//   - `start(input)` -> writes `pending`. Called OUTSIDE
//     the apply transaction (after a successful
//     preflight, before `applyImport`).
//   - `markRunning(batchId)` -> writes `running` +
//     `started_at`. Called INSIDE the apply transaction.
//   - `complete(batchId, counts, affectedIds)` -> writes
//     `completed` + `completed_at` + the canonical
//     counts/affected_ids summary. Called INSIDE the
//     apply transaction so it commits atomically with
//     the entries / revisions / audit / relations /
//     provenance rows.
//   - `fail(batchId, code)` -> writes `failed` +
//     `failed_at` + `failure_code`. Called OUTSIDE the
//     apply transaction when the apply throws.
//
// The `inspect(batchId)` read returns the redacted
// operator-readable record (no memory bodies, no
// secret literals, no raw filesystem paths, no
// operator capability token). The CLI
// (`agent-recall import inspect <batch_id> [--json]`)
// and the MCP resource
// (`memory://imports/{batch_id}`) both route through
// this surface.

import type { SQLiteMemoryStore } from "../sqlite-store.js";
import { nowIso } from "../domain.js";

export type ImportBatchStatus = "pending" | "running" | "completed" | "failed";
export type ImportBatchConflictPolicy = "keep" | "replace" | "merge" | "fail";
export type ImportBatchHistoryMode = "snapshot" | "full_history";
export type ImportBatchScope = "global" | "project";

export type ImportBatchStartInput = {
  /** The preflight-minted import batch id (UUIDv4). */
  import_batch_id: string;
  /** Canonical SHA-256 over the normalised bundle. */
  bundle_hash: string;
  /** Hash algorithm label; defaults to `"SHA-256"`. */
  bundle_hash_algorithm?: string;
  /** `1` / `2` for snapshot bundles, `3` for full-history bundles. */
  bundle_version: number;
  /** Bundle filename (the export scope directory name). */
  bundle_filename?: string | null;
  /** Cumulative size of the bundle's tracked files. */
  bundle_size_bytes?: number | null;
  /** Source format label (`"json"` for the v1.1.x bundles). */
  source_format: string;
  /** Source-side `user_version` recorded in the manifest. */
  source_schema_version: number;
  /** Target scope the import applies to. */
  target_scope: ImportBatchScope;
  /** Target `project_id` when `target_scope === "project"`. */
  target_project_id?: string | null;
  /** Conflict policy chosen for this import. */
  conflict_policy: ImportBatchConflictPolicy;
  /** History mode chosen for this import. */
  history_mode: ImportBatchHistoryMode;
  /** Operator actor (MCP / CLI / programmatic caller). */
  actor_id: string;
  /** Optional MCP / CLI request id (correlation key). */
  request_id?: string | null;
  /** Optional MCP session id (lifecycle correlation). */
  session_id?: string | null;
  /** Optional MCP tool call id (per-call JSON-RPC id). */
  tool_call_id?: string | null;
};

/**
 * The canonical counts summary recorded on the
 * `completed` row. The shape is stable across the
 * CLI / MCP resource; a future release can extend
 * it with new fields (e.g. `audit_events`) without
 * breaking the redacted read.
 */
export type ImportBatchCounts = {
  inserts: number;
  replacements: number;
  merges: number;
  skipped: number;
  failed: number;
  total_affected: number;
  /** v1.1.2 (issue #25): full-history restore counts. */
  revisions?: number;
  audit_events?: number;
  relations?: number;
  provenance?: number;
};

/**
 * The redacted operator-readable record. The
 * `ImportBatchStore.inspect(...)` read returns this
 * shape (never the raw `import_batches` row): the
 * JSON columns are decoded, the affected_ids list is
 * surfaced as a plain array, and the redaction
 * contract guarantees no memory body / secret literal
 * / raw filesystem path / capability token is on the
 * payload.
 */
export type ImportBatchRow = {
  import_batch_id: string;
  bundle_hash: string;
  bundle_hash_algorithm: string;
  bundle_version: number;
  bundle_filename: string | null;
  bundle_size_bytes: number | null;
  source_format: string;
  source_schema_version: number;
  target_scope: ImportBatchScope;
  target_project_id: string | null;
  conflict_policy: ImportBatchConflictPolicy;
  history_mode: ImportBatchHistoryMode;
  actor_id: string;
  request_id: string | null;
  session_id: string | null;
  tool_call_id: string | null;
  started_at: string;
  completed_at: string | null;
  failed_at: string | null;
  status: ImportBatchStatus;
  failure_code: string | null;
  counts: ImportBatchCounts;
  affected_ids: string[];
};

const DEFAULT_COUNTS: ImportBatchCounts = {
  inserts: 0,
  replacements: 0,
  merges: 0,
  skipped: 0,
  failed: 0,
  total_affected: 0
};

/**
 * Stage 18 v1.1.2 (issue #26, task 7): the wrapper
 * over `SQLiteMemoryStore` for the `import_batches`
 * table. The wrapper enforces the lifecycle contract
 * (one `start`, at most one `markRunning`, one
 * `complete` / `fail`) and surfaces the redacted
 * `inspect(...)` read for the CLI / MCP resource.
 */
export class ImportBatchStore {
  constructor(private readonly store: SQLiteMemoryStore) {}

  /**
   * Allocate a `pending` row. Called OUTSIDE the apply
   * transaction so the `pending` row is durable before
   * any mutation begins; the apply transaction then
   * calls `markRunning` / `complete` so the final state
   * commits atomically with the mutations.
   *
   * A preflight rejection never reaches this code path
   * (the brief places `start` after preflight), so a
   * preflight failure does NOT leave a batch row at
   * all. A `fail(batchId, "preflight_failed")` would
   * never find a row to update — the CLI surfaces the
   * preflight error directly.
   */
  start(input: ImportBatchStartInput): void {
    this.store.insertImportBatchRow({
      import_batch_id: input.import_batch_id,
      bundle_hash: input.bundle_hash,
      bundle_hash_algorithm: input.bundle_hash_algorithm ?? "SHA-256",
      bundle_version: input.bundle_version,
      bundle_filename: input.bundle_filename ?? null,
      bundle_size_bytes: input.bundle_size_bytes ?? null,
      source_format: input.source_format,
      source_schema_version: input.source_schema_version,
      target_scope: input.target_scope,
      target_project_id: input.target_project_id ?? null,
      conflict_policy: input.conflict_policy,
      history_mode: input.history_mode,
      actor_id: input.actor_id,
      request_id: input.request_id ?? null,
      session_id: input.session_id ?? null,
      tool_call_id: input.tool_call_id ?? null,
      started_at: nowIso()
    });
  }

  /**
   * Flip a `pending` row to `running`. Called from
   * inside the apply transaction so a failing apply
   * rolls the `running` transition back along with the
   * entries / revisions / audit / relations /
   * provenance rows. The post-transaction failure
   * handler then calls `fail(...)` to mark the row
   * `failed`.
   */
  markRunning(batchId: string): void {
    this.store.markImportBatchRunning(batchId, nowIso());
  }

  /**
   * Flip a `running` row to `completed` and persist the
   * canonical counts + affected_ids summary. Called
   * INSIDE the apply transaction so the `completed`
   * state commits atomically with the mutations — a
   * failed apply NEVER leaves a `completed` row.
   *
   * The `counts` object is JSON-encoded into the
   * `counts_json` column (see
   * `ImportBatchCounts`). The `affectedIds` list is
   * JSON-encoded into `affected_ids_json`; the brief's
   * bounded-size contract caps the list at the
   * import's actual mutation count (no artificial
   * limit). The list is the canonical "which memory
   * ids did this batch touch?" surface; an inspector
   * can grep the JSON for any memory id without
   * round-tripping through the import's per-entry
   * metadata.
   */
  complete(batchId: string, counts: ImportBatchCounts, affectedIds: string[]): void {
    const normalised = normaliseCounts(counts);
    this.store.markImportBatchCompleted(
      batchId,
      nowIso(),
      JSON.stringify(normalised),
      JSON.stringify(affectedIds)
    );
  }

  /**
   * Flip the row to `failed` with the documented
   * `failure_code`. Called OUTSIDE the apply
   * transaction (the failure audit must persist even
   * when the mutations rolled back). The transition is
   * idempotent: a row already in `failed` is left
   * alone (no further status change is needed; a retry
   * would mint a new `import_batch_id`).
   */
  fail(batchId: string, failureCode: string): void {
    this.store.markImportBatchFailed(batchId, nowIso(), failureCode);
  }

  /**
   * The redacted operator-readable read. Returns
   * `undefined` when the batch id is unknown so the CLI
   * / MCP resource can surface a structured
   * `not_found` error. The returned record decodes the
   * `counts_json` + `affected_ids_json` columns into
   * the documented `ImportBatchCounts` + `string[]`
   * shapes, but otherwise exposes the durable fields
   * verbatim — the columns themselves are redacted at
   * the schema level (no body / secret / path /
   * capability fields are stored on the row).
   */
  inspect(batchId: string): ImportBatchRow | undefined {
    const row = this.store.getImportBatchRow(batchId);
    if (row === undefined) return undefined;
    const counts = parseCounts(row.counts_json);
    const affectedIds = parseAffectedIds(row.affected_ids_json);
    return {
      import_batch_id: row.import_batch_id,
      bundle_hash: row.bundle_hash,
      bundle_hash_algorithm: row.bundle_hash_algorithm,
      bundle_version: row.bundle_version,
      bundle_filename: row.bundle_filename,
      bundle_size_bytes: row.bundle_size_bytes,
      source_format: row.source_format,
      source_schema_version: row.source_schema_version,
      target_scope: row.target_scope,
      target_project_id: row.target_project_id,
      conflict_policy: row.conflict_policy,
      history_mode: row.history_mode,
      actor_id: row.actor_id,
      request_id: row.request_id,
      session_id: row.session_id,
      tool_call_id: row.tool_call_id,
      started_at: row.started_at,
      completed_at: row.completed_at,
      failed_at: row.failed_at,
      status: row.status,
      failure_code: row.failure_code,
      counts,
      affected_ids: affectedIds
    };
  }
}

function normaliseCounts(input: ImportBatchCounts): ImportBatchCounts {
  // The schema stores `counts_json` as a stable JSON
  // object so a future release can add fields without
  // a migration. The normaliser clamps each numeric
  // field to a non-negative integer; a missing field
  // defaults to zero so an older reader that did not
  // record `audit_events` / `relations` / `provenance`
  // still decodes cleanly.
  return {
    inserts: clampCount(input.inserts),
    replacements: clampCount(input.replacements),
    merges: clampCount(input.merges),
    skipped: clampCount(input.skipped),
    failed: clampCount(input.failed),
    total_affected: clampCount(input.total_affected),
    ...(input.revisions !== undefined ? { revisions: clampCount(input.revisions) } : {}),
    ...(input.audit_events !== undefined ? { audit_events: clampCount(input.audit_events) } : {}),
    ...(input.relations !== undefined ? { relations: clampCount(input.relations) } : {}),
    ...(input.provenance !== undefined ? { provenance: clampCount(input.provenance) } : {})
  };
}

function clampCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  return Math.trunc(value);
}

function parseCounts(json: string): ImportBatchCounts {
  if (json.trim().length === 0) return { ...DEFAULT_COUNTS };
  try {
    const parsed = JSON.parse(json) as Partial<ImportBatchCounts>;
    return normaliseCounts({
      inserts: parsed.inserts ?? 0,
      replacements: parsed.replacements ?? 0,
      merges: parsed.merges ?? 0,
      skipped: parsed.skipped ?? 0,
      failed: parsed.failed ?? 0,
      total_affected: parsed.total_affected ?? 0,
      ...(parsed.revisions !== undefined ? { revisions: parsed.revisions } : {}),
      ...(parsed.audit_events !== undefined ? { audit_events: parsed.audit_events } : {}),
      ...(parsed.relations !== undefined ? { relations: parsed.relations } : {}),
      ...(parsed.provenance !== undefined ? { provenance: parsed.provenance } : {})
    });
  } catch {
    return { ...DEFAULT_COUNTS };
  }
}

function parseAffectedIds(json: string): string[] {
  if (json.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}