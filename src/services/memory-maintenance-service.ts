// src/services/memory-maintenance-service.ts
//
// Stage 9: the maintenance path of MemoryService, extracted
// into its own service. Owns: maintainMemories (the public
// switch), and the per-action implementations
// (findDuplicatesChunked, mergeDuplicates, rebuildMarkdownIndex,
// expireDueMemories, archiveLowValueMemories, vacuumFts).
//
// The maintenance path is the most stateful: it scans the
// whole entries table, runs the bucketed inverted index,
// emits audit events, and (for some actions) calls
// `maybeBackup` to snapshot the store after a successful
// mutation. All of that lives here so the read and write
// services stay focused.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { SIMILARITY_THRESHOLD, textSimilarity, tokenizeForSimilarity } from "../text-similarity.js";
import {
  activeEntriesForScope,
  allEntriesForScope,
  appendAudit,
  assertProjectScope,
  compareLowValueCandidates,
  compareText,
  duplicateFingerprint,
  isDue,
  normalizeDuplicateText,
  usageForScope
} from "./memory-service-helpers.js";
import type { ResolvedReadScope } from "./memory-read-service.js";
import type { BudgetUsage, SQLiteMemoryStore } from "../sqlite-store.js";
import { nowIso, type MemoryAuditEvent, type MemoryEntry, type MemoryScope } from "../domain.js";
import { MarkdownExporter } from "../markdown-exporter.js";
import { runBackup, verifyBackup } from "../backup.js";
import { resolveMemoryScope, type ProjectIdentityResolver } from "../scope-resolver.js";
import { createHash } from "node:crypto";
import type { RequestContext } from "../request-context.js";
import {
  type AuthorizationDecision,
  type SensitivityLevel
} from "./auth-context.js";

export type MaintenanceAction =
  | "archive_low_value"
  | "expire_due"
  | "rebuild_markdown_index"
  | "vacuum_fts"
  | "find_duplicates"
  | "merge_duplicates";

export type DuplicateGroup = {
  reason: "same_title_and_body" | "same_title" | "same_body" | "similar_title_and_body";
  fingerprint: string;
  memory_ids: string[];
  titles: string[];
  details?: { similarity?: number };
};

export type MaintainMemoriesInput = {
  action: MaintenanceAction;
  scope: MemoryScope;
  project_id?: string;
  project_path?: string;
  batch_size?: number;
  onProgress?: (processed: number, total: number) => void;
  dry_run?: boolean;
  strategy?: "keep_first" | "keep_newest";
};

export type MaintainMemoriesResult = {
  action: MaintenanceAction;
  changed: number;
  details: unknown;
};

export type MaintenanceContext = {
  store: SQLiteMemoryStore;
  defaultActor: string;
  /**
   * Stage 16 v1.1.1 PR-2 (#14): the project identity
   * resolver. Maintenance paths use `register` mode
   * (a `project_path` may create an identity on the
   * first ever maintenance call for that repo).
   */
  identityResolver: ProjectIdentityResolver;
  dataHome?: string;
  exporter?: MarkdownExporter;
  /** Returns a MarkdownExporter (shared with read side via a factory). */
  resolveExporter: () => MarkdownExporter;
  /**
   * v1.1.3 GATE-03 (issue #33): the canonical
   * authorization decision. Maintenance helpers
   * consult this before scanning the entries
   * table so a Core / Extended caller never sees
   * restricted rows in the cleanup-candidate or
   * duplicate-group scan. The decision is the
   * single source of truth — downstream code
   * never reads `actorMaxSensitivity` as a
   * separate string.
   */
  authorization?: AuthorizationDecision;
};

export class MemoryMaintenanceService {
  constructor(private readonly ctx: MaintenanceContext) {}

  /**
   * v1.1.3 GATE-03 (issue #33): the maintenance
   * surface's view of the SQL-boundary sensitivity
   * filter. Returns `"normal"` by default (the
   * fail-closed contract) and lifts to the
   * canonical decision's value when one is
   * supplied. Legacy callers (test fixtures
   * predating the v1.1.3 split) get `"normal"`
   * because the maintenance service was previously
   * unrestricted on the read side.
   */
  private maxSensitivity(): SensitivityLevel {
    return this.ctx.authorization?.max_sensitivity ?? "normal";
  }

  maintainMemories(input: MaintainMemoriesInput, ctx?: RequestContext): MaintainMemoriesResult {
    if (input.batch_size !== undefined) {
      if (input.batch_size < 50 || input.batch_size > 5000 || !Number.isInteger(input.batch_size)) {
        throw new Error(
          `maintain_memories batch_size must be an integer in [50, 5000], got ${input.batch_size}`
        );
      }
    }
    // Stage 10 PR2: route every maintenance call through the
    // single ProjectIdentityResolver. Pre-PR2 the maintenance
    // service had its own private `resolveScope` that copied
    // only `project_id` and silently dropped `project_path`,
    // causing project_path-only inputs to fall through to a
    // cross-project "scope=project" filter.
    const resolved = this.ctx.identityResolver.resolve(
      {
        scope: input.scope,
        ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
        ...(input.project_path !== undefined ? { project_path: input.project_path } : {})
      },
      "register"
    );
    if (!resolved.ok) {
      return {
        action: input.action,
        changed: 0,
        details: { error: resolved.error, message: resolved.message }
      };
    }
    // Destructive actions must never run against an
    // unresolved project. `resolveMemoryScope` guarantees
    // `project_id !== undefined` whenever `scope === "project"`
    // and a `project_path` (or explicit `project_id`) was
    // supplied, so this assertion is the second line of
    // defense behind the resolver.
    if (resolved.value.scope === "project" && resolved.value.project_id === undefined) {
      return {
        action: input.action,
        changed: 0,
        details: {
          error: "invalid_scope",
          message: "project scope requires project_id or project_path"
        }
      };
    }
    const scope: ResolvedReadScope = {
      scope: resolved.value.scope,
      ...(resolved.value.project_id !== undefined ? { project_id: resolved.value.project_id } : {})
    };
    switch (input.action) {
      case "find_duplicates":
        return this.findDuplicatesChunked(scope, input);
      case "merge_duplicates":
        return this.mergeDuplicates(scope, input, ctx);
      case "rebuild_markdown_index":
        return this.rebuildMarkdownIndex(scope, ctx);
      case "expire_due":
        return this.expireDueMemories(scope, input.dry_run === true, ctx);
      case "archive_low_value":
        return this.archiveLowValueMemories(scope, input.dry_run === true, ctx);
      case "vacuum_fts":
        return this.vacuumFts(scope, ctx);
    }
  }

  // ============================================================
  // Per-action implementations
  // ============================================================

  /**
   * Stage 15 PR-M0-4 (issue #3, spec § 6.2): a targeted
   * single-group merge used by `apply_maintenance`.
   * Pre-PR-M0-4 the apply step called `maintainMemories`
   * with `action: "merge_duplicates"`, which re-scanned
   * the whole scope and re-merged every group. That was
   * the "broad merge_duplicates" path the spec called out
   * — apply would mutate entries that weren't part of the
   * plan. The new helper takes a fixed `targetIds` list
   * from the plan and only mutates those. The caller's
   * apply step has already validated the
   * `expected_revision` of every target; this method
   * does a final `peekEntry` check inside the transaction
   * and refuses on drift (defense in depth).
   */
  mergePlannedGroup(
    input: {
      scope: ResolvedReadScope;
      target_ids: string[];
      expected_revisions: Record<string, number>;
      reason: string;
      strategy: "keep_first" | "keep_newest";
      /**
       * Stage 16 v1.1.1 PR-5 (issue #12). When
       * `true`, the caller has already opened a
       * `store.transaction` that wraps the entire
       * apply. The helper skips the inner
       * `store.transaction` (it's a no-op when the
       * depth is > 0 anyway) and skips the
       * pre-mutation backup (which would fail with
       * `VACUUM INTO cannot run inside a
       * transaction`).
       */
      inTransaction?: boolean;
    },
    ctx?: RequestContext
  ): { ok: true; keep_id: string; superseded_ids: string[]; changed: number } | { ok: false; reason: "stale_revision" | "target_missing" | "scope_mismatch" | "non_dedup_group" } {
    assertProjectScope(input.scope, "merge_planned_group");
    if (input.target_ids.length < 2) {
      return { ok: false, reason: "non_dedup_group" };
    }
    if (input.inTransaction !== true) {
      // Pre-mutation backup (see expireDueMemories for
      // the rationale on the out-of-transaction placement).
      this.maybeBackup(input.target_ids.length, ctx);
    }
    const runMerge = (): { ok: true; keep_id: string; superseded_ids: string[]; changed: number } | { ok: false; reason: "stale_revision" | "target_missing" | "scope_mismatch" | "non_dedup_group" } => {
      const liveEntries: MemoryEntry[] = [];
      for (const id of input.target_ids) {
        // write-path; sensitivity filter at the SQL boundary (peekEntry overload is safe here)
        const entry = this.ctx.store.peekEntry(id);
        if (entry === undefined || entry.status !== "active") {
          return { ok: false as const, reason: "target_missing" as const };
        }
        // CAS guard: a different actor's update between
        // plan and apply must abort the merge.
        if (input.expected_revisions[id] !== entry.revision) {
          return { ok: false as const, reason: "stale_revision" as const };
        }
        if (entry.scope !== input.scope.scope) {
          return { ok: false as const, reason: "scope_mismatch" as const };
        }
        if (input.scope.project_id !== undefined && entry.project_id !== input.scope.project_id) {
          return { ok: false as const, reason: "scope_mismatch" as const };
        }
        liveEntries.push(entry);
      }
      const keepTarget = this.pickKeepTarget(liveEntries, input.strategy);
      const supersededIds = liveEntries
        .filter((e) => e.id !== keepTarget.id)
        .map((e) => e.id)
        .sort(compareText);
      this.applySupersede(keepTarget, supersededIds, input.reason, ctx);
      return {
        ok: true as const,
        keep_id: keepTarget.id,
        superseded_ids: supersededIds,
        changed: supersededIds.length
      };
    };
    if (input.inTransaction === true) {
      return runMerge();
    }
    return this.ctx.store.transaction(runMerge);
  }

  /**
   * Stage 15 PR-M0-4 (issue #3, spec § 6.2): a targeted
   * forget used by `apply_maintenance`. Only mutates the
   * targets in the plan; refuses on drift.
   */
  forgetPlannedEntries(
    input: {
      scope: ResolvedReadScope;
      target_ids: string[];
      expected_revisions: Record<string, number>;
      reason: string;
    },
    ctx?: RequestContext
  ): { ok: true; forgotten: string[] } | { ok: false; reason: "stale_revision" | "target_missing" | "scope_mismatch" } {
    if (input.target_ids.length === 0) {
      return { ok: true, forgotten: [] };
    }
    this.maybeBackup(input.target_ids.length, ctx);
    return this.ctx.store.transaction(() => {
      const forgotten: string[] = [];
      for (const id of input.target_ids) {
        // write-path; sensitivity filter at the SQL boundary (peekEntry overload is safe here)
        const entry = this.ctx.store.peekEntry(id);
        if (entry === undefined) {
          return { ok: false as const, reason: "target_missing" as const };
        }
        if (input.expected_revisions[id] !== entry.revision) {
          return { ok: false as const, reason: "stale_revision" as const };
        }
        if (entry.scope !== input.scope.scope) {
          return { ok: false as const, reason: "scope_mismatch" as const };
        }
        if (input.scope.project_id !== undefined && entry.project_id !== input.scope.project_id) {
          return { ok: false as const, reason: "scope_mismatch" as const };
        }
        this.ctx.store.updateEntry(id, {
          status: "forgotten",
          body: "",
          tags: [],
          char_count: 0,
          token_estimate: 0,
          updated_at: nowIso()
        });
        appendAudit(this.ctx.store, this.ctx.defaultActor, {
          memory_id: id,
          scope: entry.scope,
          ...(entry.project_id !== undefined ? { project_id: entry.project_id } : {}),
          event: "forgotten",
          actor: "system:maintenance",
          reason: input.reason,
          metadata: {
            reason: input.reason,
            requested_by: ctx?.actor_id ?? this.ctx.defaultActor
          }
        }, ctx);
        forgotten.push(id);
      }
      return { ok: true as const, forgotten };
    });
  }

  // ============================================================
  // Per-action implementations
  // ============================================================

  private findDuplicatesChunked(
    scope: ResolvedReadScope,
    input: MaintainMemoriesInput
  ): MaintainMemoriesResult {
    const batchSize = input.batch_size ?? 500;
    const onProgress = input.onProgress;
    // v1.1.3 GATE-03 (issue #33): the
    // active-entries scan is filtered at the
    // SQL boundary so a Core / Extended caller
    // never sees restricted rows in the
    // duplicate-group detection. The
    // pre-GATE-03 implementation walked every
    // row in the scope (the maintenance
    // service was an internal authorized path
    // — the new contract restricts the helper
    // to the caller's visible subset unless
    // the caller is Admin with a loaded
    // capability).
    const allEntries = this.ctx.store.listEntries({
      scope: scope.scope,
      ...(scope.project_id !== undefined ? { project_id: scope.project_id } : {}),
      status: "active",
      limit: 10_000,
      actor_max_sensitivity: this.maxSensitivity()
    });
    const total = allEntries.length;
    if (total === 0) {
      onProgress?.(0, 0);
      return { action: "find_duplicates", changed: 0, details: { groups: [] } };
    }
    // Stage 10 PR6: build the candidate index across the
    // entire dataset (spec § 5.1 "查重候选索引跨全局数据集
    // 构建") and only use the batch boundary for progress
    // reporting. Pre-PR6 the `seen` set lived inside
    // `findDuplicateGroups`, so a pair straddling a batch
    // boundary was missed because each batch got its own
    // empty set. The new helper accepts a caller-owned
    // seen set that survives across batches.
    const seenFingerprints = new Set<string>();
    const seenPairs = new Set<string>();
    const groups: DuplicateGroup[] = [];
    let processed = 0;
    for (let offset = 0; offset < total; offset += batchSize) {
      const batch = allEntries.slice(offset, offset + batchSize);
      const batchGroups = this.findDuplicateGroups(batch, seenPairs);
      for (const g of batchGroups) {
        if (seenFingerprints.has(g.fingerprint)) continue;
        seenFingerprints.add(g.fingerprint);
        groups.push(g);
      }
      processed += batch.length;
      onProgress?.(processed, total);
    }
    return { action: "find_duplicates", changed: 0, details: { groups } };
  }

  private mergeDuplicates(
    scope: ResolvedReadScope,
    input: MaintainMemoriesInput,
    ctx?: RequestContext
  ): MaintainMemoriesResult {
    assertProjectScope(scope, "merge_duplicates");
    const strategy: "keep_first" | "keep_newest" = input.strategy ?? "keep_first";
    const dryRun = input.dry_run === true;
    const onProgress = input.onProgress;
    // v1.1.3 GATE-03 (issue #33): mirror the
    // decision's filter on the merge scan.
    const allEntries = this.ctx.store.listEntries({
      scope: scope.scope,
      ...(scope.project_id !== undefined ? { project_id: scope.project_id } : {}),
      status: "active",
      limit: 10_000,
      actor_max_sensitivity: this.maxSensitivity()
    });
    const groups = this.findDuplicateGroups(allEntries);

    const wouldSupersede: Array<{
      reason: DuplicateGroup["reason"];
      keep_id: string;
      superseded_ids: string[];
    }> = [];
    const actuallySuperseded: typeof wouldSupersede = [];

    let processed = 0;
    const total = groups.length;
    onProgress?.(0, total);

    for (const group of groups) {
      const liveEntries: MemoryEntry[] = [];
      for (const id of group.memory_ids) {
        // write-path; sensitivity filter at the SQL boundary (peekEntry overload is safe here)
        const entry = this.ctx.store.peekEntry(id);
        if (entry !== undefined && entry.status === "active") liveEntries.push(entry);
      }
      if (liveEntries.length < 2) {
        processed += 1;
        onProgress?.(processed, total);
        continue;
      }
      const keepTarget = this.pickKeepTarget(liveEntries, strategy);
      const supersededIds = liveEntries
        .filter((e) => e.id !== keepTarget.id)
        .map((e) => e.id)
        .sort(compareText);
      const record = {
        reason: group.reason,
        keep_id: keepTarget.id,
        superseded_ids: supersededIds
      };
      // Stage 10 PR6: only auto-collapse when the entire
      // group is `same_title_and_body` AND every entry
      // belongs to the same scope/project (spec § 5.6
      // "只有规范化 title 和 body 均完全相同，且
      // scope/project 一致时，允许默认自动折叠").
      // Other reasons (same_title / same_body /
      // similar_title_and_body) only produce a plan; the
      // caller must explicitly apply the merge.
      const sameProject = liveEntries.every(
        (e) => e.scope === keepTarget.scope && e.project_id === keepTarget.project_id
      );
      const autoCollapse = !dryRun && group.reason === "same_title_and_body" && sameProject;
      if (autoCollapse) {
        if (liveEntries.length > 0) {
          this.maybeBackup(liveEntries.length, ctx);
        }
        this.applySupersede(keepTarget, supersededIds, "merge_duplicates auto-supersede", ctx);
        actuallySuperseded.push(record);
      } else {
        // Plan-only group: surface the proposed action
        // so the user / agent can decide.
        wouldSupersede.push({ ...record, plan_only: true } as typeof record & { plan_only: true });
      }
      processed += 1;
      onProgress?.(processed, total);
    }
    return {
      action: "merge_duplicates",
      changed: actuallySuperseded.length === 0 ? 0 : actuallySuperseded.reduce((acc, r) => acc + r.superseded_ids.length, 0),
      details: {
        strategy,
        dry_run: dryRun,
        // Backward-compatible `groups` field: every group
        // that would be / was collapsed. `applied` and
        // `plan_only` are the post-PR6 split for callers
        // that need to know which were auto-collapsed
        // versus surfaced as a plan for explicit
        // confirmation.
        groups: actuallySuperseded.length > 0 ? actuallySuperseded : wouldSupersede,
        applied: actuallySuperseded,
        plan_only: wouldSupersede
      }
    };
  }

  private rebuildMarkdownIndex(scope: ResolvedReadScope, ctx?: RequestContext): MaintainMemoriesResult {
    assertProjectScope(scope, "rebuild_markdown_index");
    const exporter = this.ctx.resolveExporter();
    // v1.1.3 GATE-03 (issue #33): the markdown
    // rebuild is filtered to the caller's visible
    // scope. Pre-GATE-03 the rebuild walked every
    // row in the scope (the maintenance path was
    // internally authorized); post-GATE-03 the
    // rebuild respects the same SQL-boundary
    // filter as the read surface.
    const entries = this.ctx.store.listEntries({
      scope: scope.scope,
      ...(scope.project_id !== undefined ? { project_id: scope.project_id } : {}),
      limit: 10_000,
      actor_max_sensitivity: this.maxSensitivity()
    });
    const staged = exporter.stageScope({
      scope: scope.scope,
      ...(scope.project_id !== undefined ? { project_id: scope.project_id } : {}),
      entries,
      budgetStatus: usageForScope(this.ctx.store, scope)
    });
    const changed = staged.topicPaths.length + 1;
    const paths = { indexPath: staged.indexPath, topicPaths: staged.topicPaths };
    let published: ReturnType<MarkdownExporter["publishStagedScope"]> | undefined;
    try {
      published = exporter.publishStagedScope(staged);
      const result = this.ctx.store.transaction(() => {
        appendAudit(this.ctx.store, this.ctx.defaultActor, {
          scope: scope.scope,
          ...(scope.project_id !== undefined ? { project_id: scope.project_id } : {}),
          event: "markdown_exported",
          actor: "system:export",
          metadata: { ...paths, requested_by: ctx?.actor_id ?? this.ctx.defaultActor }
        }, ctx);
        this.appendMaintenanceAudit(scope, "rebuild_markdown_index", changed, paths, ctx);
        return {
          action: "rebuild_markdown_index" as const,
          changed,
          details: paths
        };
      });
      published.complete();
      this.maybeBackup(changed, ctx);
      return result;
    } catch (error) {
      if (published === undefined) {
        rmSync(staged.stagingRoot, { recursive: true, force: true });
      } else {
        published.rollback();
      }
      throw error;
    }
  }

  private expireDueMemories(scope: ResolvedReadScope, dryRun = false, ctx?: RequestContext): MaintainMemoriesResult {
    assertProjectScope(scope, "expire_due");
    const now = nowIso();
    // v1.1.3 GATE-03 (issue #33): the expiry
    // scan is filtered at the SQL boundary. A
    // restricted row that has expired stays
    // untouched on a Core / Extended caller
    // (an Admin + capability caller still sees
    // it because the canonical decision lifts
    // visibility to `"restricted"`).
    const expired = this.ctx.store.listEntries({
      scope: scope.scope,
      ...(scope.project_id !== undefined ? { project_id: scope.project_id } : {}),
      status: "active",
      limit: 10_000,
      actor_max_sensitivity: this.maxSensitivity()
    })
      .filter((entry) => isDue(entry.expires_at, now))
      .sort((a, b) => compareText(a.expires_at ?? "", b.expires_at ?? "") || compareText(a.id, b.id));

    if (dryRun) {
      const sample = expired.slice(0, 10).map((e) => ({ id: e.id, expires_at: e.expires_at ?? "" }));
      return {
        action: "expire_due",
        changed: 0,
        details: { dry_run: true, would_expire_count: expired.length, would_expire_sample: sample }
      };
    }
    if (expired.length > 0) {
      // Pre-mutation backup. Runs OUTSIDE the store
      // transaction (VACUUM INTO cannot execute while a
      // BEGIN IMMEDIATE is open on the same connection).
      // Throws on failure; the caller sees the
      // `backup_failed` error and the mutation does not
      // run.
      this.maybeBackup(expired.length, ctx);
    }
    return this.ctx.store.transaction(() => {
      const forgotten: Array<{ memory_id: string; expires_at: string }> = [];
      for (const entry of expired) {
        // write-path; sensitivity filter at the SQL boundary (peekEntry overload is safe here)
        const entryRef = this.ctx.store.peekEntry(entry.id);
        if (entryRef === undefined) continue;
        this.ctx.store.updateEntry(entry.id, {
          status: "forgotten",
          body: "",
          tags: [],
          char_count: 0,
          token_estimate: 0,
          updated_at: nowIso()
        });
        appendAudit(this.ctx.store, this.ctx.defaultActor, {
          memory_id: entry.id,
          scope: entryRef.scope,
          ...(entryRef.project_id !== undefined ? { project_id: entryRef.project_id } : {}),
          event: "forgotten",
          actor: "system:expiry",
          reason: "expired by maintain_memories",
          metadata: {
            expires_at: entry.expires_at ?? "",
            requested_by: ctx?.actor_id ?? this.ctx.defaultActor
          }
        }, ctx);
        forgotten.push({ memory_id: entry.id, expires_at: entry.expires_at ?? "" });
      }
      const details = { expired: forgotten };
      this.appendMaintenanceAudit(scope, "expire_due", forgotten.length, details, ctx);
      return { action: "expire_due", changed: forgotten.length, details };
    });
  }

  private archiveLowValueMemories(scope: ResolvedReadScope, dryRun = false, ctx?: RequestContext): MaintainMemoriesResult {
    assertProjectScope(scope, "archive_low_value");
    // v1.1.3 GATE-03 (issue #33): the
    // archive-low-value scan is filtered at the
    // SQL boundary. A restricted row that
    // matches the low-value predicate stays
    // untouched on a Core / Extended caller.
    const lowValue = this.ctx.store.listEntries({
      scope: scope.scope,
      ...(scope.project_id !== undefined ? { project_id: scope.project_id } : {}),
      status: "active",
      limit: 10_000,
      actor_max_sensitivity: this.maxSensitivity()
    })
      .filter((entry) => entry.importance <= 2 && entry.confidence <= 2 && entry.access_count === 0 && entry.source.kind !== "user")
      .sort(compareLowValueCandidates);

    if (dryRun) {
      const sample = lowValue.slice(0, 10).map((e) => ({
        id: e.id,
        importance: e.importance,
        confidence: e.confidence,
        access_count: e.access_count
      }));
      return {
        action: "archive_low_value",
        changed: 0,
        details: { dry_run: true, would_archive_count: lowValue.length, would_archive_sample: sample }
      };
    }
    if (lowValue.length > 0) {
      // Pre-mutation backup (see expireDueMemories for the
      // rationale on the out-of-transaction placement).
      this.maybeBackup(lowValue.length, ctx);
    }
    return this.ctx.store.transaction(() => {
      const archived: Array<{ memory_id: string; reason: string }> = [];
      for (const entry of lowValue) {
        this.ctx.store.updateEntry(entry.id, { status: "archived", updated_at: nowIso() });
        appendAudit(this.ctx.store, this.ctx.defaultActor, {
          memory_id: entry.id,
          scope: entry.scope,
          ...(entry.project_id !== undefined ? { project_id: entry.project_id } : {}),
          event: "archived",
          actor: "system:archive",
          reason: "low importance, low confidence, never accessed",
          metadata: {
            reason: "low importance, low confidence, never accessed",
            requested_by: ctx?.actor_id ?? this.ctx.defaultActor
          }
        }, ctx);
        archived.push({ memory_id: entry.id, reason: "low importance, low confidence, never accessed" });
      }
      const details = { archived };
      this.appendMaintenanceAudit(scope, "archive_low_value", archived.length, details, ctx);
      return { action: "archive_low_value", changed: archived.length, details };
    });
  }

  private vacuumFts(scope: ResolvedReadScope, ctx?: RequestContext): MaintainMemoriesResult {
    const vacuum = (this.ctx.store as SQLiteMemoryStore & { vacuumFts?: () => void }).vacuumFts;
    if (typeof vacuum === "function") {
      vacuum.call(this.ctx.store);
      const details = { status: "vacuumed" };
      this.appendMaintenanceAudit(scope, "vacuum_fts", 1, details);
      return { action: "vacuum_fts", changed: 1, details };
    }
    const details = { status: "noop", reason: "SQLiteMemoryStore does not expose FTS vacuum support" };
    this.appendMaintenanceAudit(scope, "vacuum_fts", 0, details);
    return { action: "vacuum_fts", changed: 0, details };
  }

  // ============================================================
  // Duplicate detection (Stage 3 + Stage 7 T4 inverted index)
  // ============================================================

  private findDuplicateGroups(entries: MemoryEntry[], crossBatchSeen: Set<string> = new Set()): DuplicateGroup[] {
    const sortedEntries = [...entries].sort((a, b) => compareText(a.id, b.id));
    const exactGroups: DuplicateGroup[] = [
      ...this.duplicateGroupsFor(sortedEntries, "same_title_and_body", (entry) => `${normalizeDuplicateText(entry.title)}\n${normalizeDuplicateText(entry.body)}`),
      ...this.duplicateGroupsFor(sortedEntries, "same_title", (entry) => normalizeDuplicateText(entry.title)),
      ...this.duplicateGroupsFor(sortedEntries, "same_body", (entry) => normalizeDuplicateText(entry.body))
    ];
    // Stage 10 PR6: share the seen-pairs set across
    // batches so a near-duplicate pair straddling the
    // batch boundary is not detected twice (or, more
    // importantly, not missed because each batch's
    // similarDuplicateGroups used to start with an empty
    // seen set).
    const similarGroups = this.similarDuplicateGroups(
      sortedEntries,
      this.coveredPairKeys(exactGroups),
      crossBatchSeen
    );
    const groups: DuplicateGroup[] = [...exactGroups, ...similarGroups];
    const reasonRank: Record<DuplicateGroup["reason"], number> = {
      same_title_and_body: 0,
      same_title: 1,
      same_body: 2,
      similar_title_and_body: 3
    };
    return groups.sort((a, b) => {
      const reasonOrder = reasonRank[a.reason] - reasonRank[b.reason];
      if (reasonOrder !== 0) return reasonOrder;
      const firstIdOrder = compareText(a.memory_ids[0] ?? "", b.memory_ids[0] ?? "");
      if (firstIdOrder !== 0) return firstIdOrder;
      return compareText(a.fingerprint, b.fingerprint);
    });
  }

  private coveredPairKeys(groups: DuplicateGroup[]): Set<string> {
    const keys = new Set<string>();
    for (const group of groups) {
      const ids = [...group.memory_ids].sort(compareText);
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          keys.add(`${ids[i]}|${ids[j]}`);
        }
      }
    }
    return keys;
  }

  private similarDuplicateGroups(
    entries: MemoryEntry[],
    covered: Set<string>,
    crossBatchSeen: Set<string> = new Set()
  ): DuplicateGroup[] {
    // Stage 10 PR6: cap on a single bucket's size is
    // removed for the cross-batch path because the
    // pre-PR6 behaviour silently dropped every entry
    // that shared a high-frequency token (e.g. project
    // names, common code identifiers). For batches small
    // enough that the original 200-entry bucket cap
    // protected us, we keep the cap; for the merged
    // candidate index we let the bucket grow and rely on
    // SIMILARITY_THRESHOLD to keep the candidate pairs
    // bounded. (The original cap is a heuristic, not an
    // invariant.)
    const capEntries = entries.length <= 500;
    const BUCKET_CAP = 200;
    const bucket = new Map<string, MemoryEntry[]>();
    for (const entry of entries) {
      const tokens = tokenizeForSimilarity(`${entry.title}\n${entry.body}`);
      for (const token of tokens) {
        const list = bucket.get(token);
        if (list === undefined) bucket.set(token, [entry]);
        else list.push(entry);
      }
    }
    const groups: DuplicateGroup[] = [];
    for (const entriesInBucket of bucket.values()) {
      if (capEntries && entriesInBucket.length > BUCKET_CAP) continue;
      for (let i = 0; i < entriesInBucket.length; i += 1) {
        const a = entriesInBucket[i];
        if (a === undefined) continue;
        for (let j = i + 1; j < entriesInBucket.length; j += 1) {
          const b = entriesInBucket[j];
          if (b === undefined) continue;
          const pairKey = compareText(a.id, b.id) <= 0 ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
          if (crossBatchSeen.has(pairKey)) continue;
          crossBatchSeen.add(pairKey);
          if (covered.has(pairKey)) continue;
          const titleSim = textSimilarity(a.title, b.title);
          const bodySim = textSimilarity(a.body, b.body);
          const max = Math.max(titleSim, bodySim);
          if (max < SIMILARITY_THRESHOLD) continue;
          const memory_ids = [a.id, b.id].sort(compareText);
          const titles = [a.title.trim(), b.title.trim()].filter((t) => t.length > 0).sort(compareText);
          groups.push({
            reason: "similar_title_and_body",
            fingerprint: duplicateFingerprint("similar_title_and_body", `${max.toFixed(3)}|${pairKey}`),
            memory_ids,
            titles,
            details: { similarity: max }
          });
        }
      }
    }
    return groups;
  }

  private duplicateGroupsFor(
    entries: MemoryEntry[],
    reason: DuplicateGroup["reason"],
    keyForEntry: (entry: MemoryEntry) => string
  ): DuplicateGroup[] {
    const buckets = new Map<string, MemoryEntry[]>();
    for (const entry of entries) {
      const key = keyForEntry(entry);
      if (key.length === 0) continue;
      buckets.set(key, [...(buckets.get(key) ?? []), entry]);
    }
    return [...buckets.entries()]
      .filter(([, group]) => group.length > 1)
      .map(([key, group]) => {
        const memory_ids = group.map((entry) => entry.id).sort(compareText);
        const titles = [...new Set(group.map((entry) => entry.title.trim()).filter((title) => title.length > 0))].sort(compareText);
        return {
          reason,
          fingerprint: duplicateFingerprint(reason, `${key}|${memory_ids.join(",")}`),
          memory_ids,
          titles
        };
      });
  }

  // ============================================================
  // Helpers
  // ============================================================

  private pickKeepTarget(entries: MemoryEntry[], strategy: "keep_first" | "keep_newest"): MemoryEntry {
    if (strategy === "keep_newest") {
      return [...entries].sort((a, b) => compareText(b.created_at, a.created_at))[0]!;
    }
    return [...entries].sort((a, b) => compareText(a.id, b.id))[0]!;
  }

  private applySupersede(keepTarget: MemoryEntry, supersededIds: string[], reason: string, ctx?: RequestContext): void {
    this.ctx.store.transaction(() => {
      for (const oldId of supersededIds) {
        this.ctx.store.updateEntry(oldId, {
          status: "superseded",
          superseded_by: keepTarget.id,
          updated_at: nowIso()
        });
        appendAudit(this.ctx.store, this.ctx.defaultActor, {
          memory_id: oldId,
          scope: keepTarget.scope,
          ...(keepTarget.project_id !== undefined ? { project_id: keepTarget.project_id } : {}),
          event: "superseded",
          actor: "system:dedup",
          reason,
          metadata: {
            superseded_by: keepTarget.id,
            requested_by: ctx?.actor_id ?? this.ctx.defaultActor
          }
        }, ctx);
      }
    });
  }

  /**
   * Stage 16 v1.1.1 PR-5 (issue #12): the apply
   * entry point. Runs the entire plan in one
   * transaction. The caller is responsible for the
   * pre-mutation backup (which must run OUTSIDE the
   * transaction because `VACUUM INTO` cannot run
   * against a connection holding an open
   * transaction).
   */
  applyPlannedGroupInTransaction(input: {
    scope: ResolvedReadScope;
    target_ids: string[];
    expected_revisions: Record<string, number>;
    reason: string;
    strategy: "keep_first" | "keep_newest";
  }, ctx?: RequestContext): { ok: true; keep_id: string; superseded_ids: string[]; changed: number } | { ok: false; reason: "stale_revision" | "target_missing" | "scope_mismatch" | "non_dedup_group" } {
    // write-path; sensitivity filter at the SQL boundary (peekEntry overload is safe here).
    // The public `applyPlannedGroupInTransaction` API is a thin wrapper around
    // `mergePlannedGroup(..., inTransaction: true)`; the actual `peekEntry` lives
    // in `mergePlannedGroup`. The comment is repeated here so future drift in
    // the public surface is also hardened.
    return this.mergePlannedGroup({ ...input, inTransaction: true }, ctx);
  }

  /**
   * Stage 16 v1.1.1 PR-5 (issue #12): the apply
   * entry point for a one-shot pre-mutation backup.
   * The apply layer calls this BEFORE the
   * transaction opens so the `VACUUM INTO` runs
   * against a connection with no open transaction.
   */
  applyPlannedPreBackup(changed: number): void {
    this.maybeBackup(changed);
  }

  private maybeBackup(changed: number, ctx?: RequestContext): void {
    if (changed <= 0 || this.ctx.dataHome === undefined) return;
    // Stage 10 PR5: backup failures are now fatal. A
    // destructive maintenance that wants to back up before
    // mutating must fail loud instead of silently
    // emitting a `backup_created` audit row that points at
    // a file that does not exist. Callers must invoke this
    // OUTSIDE the store transaction (VACUUM INTO cannot
    // run against a connection holding an open
    // transaction), and the corresponding entry mutations
    // have already committed by the time we get here.
    const backupDir = join(this.ctx.dataHome, "backups");
    const result = runBackup(this.ctx.store.backupHandle(), { backupDir });
    const verified = verifyBackup(result.path);
    appendAudit(this.ctx.store, this.ctx.defaultActor, {
      scope: "global",
      event: "backup_created",
      actor: "system:backup",
      reason: "backup_created",
      metadata: {
        path: result.path,
        size: result.size,
        duration_ms: result.durationMs,
        schema_version: verified.schemaVersion,
        quick_check: verified.quickCheck,
        requested_by: ctx?.actor_id ?? this.ctx.defaultActor
      }
    }, ctx);
  }

  private appendMaintenanceAudit(
    scope: ResolvedReadScope,
    action: MaintenanceAction,
    changed: number,
    details: Record<string, unknown>,
    ctx?: RequestContext
  ): void {
    appendAudit(this.ctx.store, this.ctx.defaultActor, {
      scope: scope.scope,
      ...(scope.project_id !== undefined ? { project_id: scope.project_id } : {}),
      event: "maintenance_run",
      actor: "system:maintenance",
      reason: action,
      metadata: {
        action,
        changed,
        ...details,
        requested_by: ctx?.actor_id ?? this.ctx.defaultActor
      }
    }, ctx);
  }

  // The private `resolveScope` helper used to live here. It was
  // removed in Stage 10 PR2 — every entry point must call
  // `resolveMemoryScope` from `../scope-resolver.js` instead, so
  // there is exactly one ProjectIdentityResolver in the codebase.
}

// Re-export so the old top-level helpers used by memory-service.ts still resolve.
export { createHash };
