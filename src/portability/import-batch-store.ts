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
 * v1.1.3 GATE-01 (issue #31): the audit metadata
 * envelope recorded on every applied batch. The apply
 * phase threads a per-batch summary (currently the
 * identity-revalidation outcome; future lanes may add
 * more keys without breaking the shape). The shape is
 * additive: every key is optional and a missing key
 * means "not applicable / not recorded".
 */
export type ImportBatchAuditMetadata = {
  /**
   * The identity-revalidation result captured by
   * `applyImport`'s in-transaction re-validation
   * step (see `src/portability/importer.ts`). A
   * clean apply records `outcome: "ok"` with an
   * empty conflicts array; a forced-drift apply
   * records `outcome: "drift"` BEFORE the rollback
   * (the metadata is attached via the
   * `complete(...)` call's `auditMetadata`
   * argument; a failed apply that throws before
   * `complete(...)` is reached never records this
   * key — the failure audit lives in the
   * `failure_code` column).
   */
  identity_revalidation?: {
    outcome: "ok" | "drift";
    conflicts: Array<{
      project_id: string;
      expected_path: string;
      observed_path: string | "absent";
    }>;
  };
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
  /**
   * v1.1.3 GATE-01 (issue #31): the decoded
   * audit-metadata envelope. The default `{}`
   * decodes to an empty object so the
   * `inspect(...)` contract stays backwards
   * compatible (the field is optional on the
   * type and empty `{}` decodes cleanly).
   */
  audit_metadata: ImportBatchAuditMetadata;
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
   *
   * v1.1.3 GATE-01 (issue #31): the optional
   * `auditMetadata` argument is JSON-encoded into
   * `audit_metadata_json`. The current caller
   * (`applyImport`) threads the identity
   * revalidation outcome; future lanes may add
   * more keys without breaking the shape. A
   * missing / undefined `auditMetadata` defaults
   * to `{}` so the legacy callers (and tests
   * that exercise the basic lifecycle without
   * audit metadata) keep working unchanged.
   */
  complete(
    batchId: string,
    counts: ImportBatchCounts,
    affectedIds: string[],
    /**
     * v1.1.3 GATE-01 (issue #31): the audit
     * metadata envelope recorded on the
     * `completed` row. When the apply transaction
     * records an identity-revalidation outcome,
     * the metadata surfaces it; an empty object
     * is the default.
     */
    auditMetadata?: ImportBatchAuditMetadata
  ): void {
    const normalised = normaliseCounts(counts);
    const metadataJson = JSON.stringify(auditMetadata ?? {});
    this.store.markImportBatchCompleted(
      batchId,
      nowIso(),
      JSON.stringify(normalised),
      JSON.stringify(affectedIds),
      metadataJson
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
   *
   * v1.1.3 GATE-01 (issue #31): the optional
   * `auditMetadata` is recorded on the `failed` row
   * so a reviewer can see WHY the apply refused
   * (the identity drift envelope, for example). The
   * metadata persists even when the mutations rolled
   * back — it lives on the `failed` row, which is
   * the canonical failure surface.
   */
  fail(batchId: string, failureCode: string, auditMetadata?: ImportBatchAuditMetadata): void {
    const metadataJson = auditMetadata === undefined ? undefined : JSON.stringify(auditMetadata);
    this.store.markImportBatchFailed(batchId, nowIso(), failureCode, metadataJson);
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
    // v1.1.3 GATE-01 (issue #31): decode the
    // `audit_metadata_json` column. The column
    // defaults to `'{}'` (set by the schema +
    // `addColumnIfMissing`), so a missing /
    // malformed payload decodes to an empty
    // envelope — never to a `null` field on the
    // inspect record.
    const auditMetadata = parseAuditMetadata(row.audit_metadata_json ?? "{}");
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
      affected_ids: affectedIds,
      audit_metadata: auditMetadata
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

/**
 * v1.1.3 GATE-01 (issue #31): decode the
 * `audit_metadata_json` column. The decoder is
 * deliberately permissive: a missing / malformed
 * payload decodes to `{}` so the `inspect(...)`
 * contract stays backwards compatible (the field
 * is on the record but empty when nothing was
 * recorded). A present-but-malformed payload
 * silently decodes to an empty envelope so a
 * downstream consumer doesn't crash on the legacy
 * rows that pre-date this lane.
 */
function parseAuditMetadata(json: string): ImportBatchAuditMetadata {
  if (json.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    const irCandidate = record["identity_revalidation"];
    if (
      irCandidate === undefined ||
      irCandidate === null ||
      typeof irCandidate !== "object" ||
      Array.isArray(irCandidate)
    ) {
      return {};
    }
    const ir = irCandidate as Record<string, unknown>;
    const outcome = ir["outcome"];
    if (outcome !== "ok" && outcome !== "drift") return {};
    const conflictsRaw = ir["conflicts"];
    if (!Array.isArray(conflictsRaw)) {
      return { identity_revalidation: { outcome, conflicts: [] } };
    }
    type Conflict = {
      project_id: string;
      expected_path: string;
      observed_path: string | "absent";
    };
    const conflicts: Conflict[] = [];
    for (const conflict of conflictsRaw) {
      if (conflict === null || typeof conflict !== "object" || Array.isArray(conflict)) continue;
      const c = conflict as Record<string, unknown>;
      if (
        typeof c["project_id"] !== "string" ||
        typeof c["expected_path"] !== "string" ||
        (typeof c["observed_path"] !== "string" && c["observed_path"] !== "absent")
      ) {
        continue;
      }
      conflicts.push({
        project_id: c["project_id"],
        expected_path: c["expected_path"],
        observed_path: c["observed_path"]
      });
    }
    return { identity_revalidation: { outcome, conflicts } };
  } catch {
    return {};
  }
}