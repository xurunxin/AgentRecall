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
import { runBackup } from "../backup.js";
import { resolveMemoryScope } from "../scope-resolver.js";
import { createHash } from "node:crypto";

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
  dataHome?: string;
  exporter?: MarkdownExporter;
  /** Returns a MarkdownExporter (shared with read side via a factory). */
  resolveExporter: () => MarkdownExporter;
};

export class MemoryMaintenanceService {
  constructor(private readonly ctx: MaintenanceContext) {}

  maintainMemories(input: MaintainMemoriesInput): MaintainMemoriesResult {
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
    const resolved = resolveMemoryScope({
      scope: input.scope,
      ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
      ...(input.project_path !== undefined ? { project_path: input.project_path } : {})
    });
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
        return this.mergeDuplicates(scope, input);
      case "rebuild_markdown_index":
        return this.rebuildMarkdownIndex(scope);
      case "expire_due":
        return this.expireDueMemories(scope, input.dry_run === true);
      case "archive_low_value":
        return this.archiveLowValueMemories(scope, input.dry_run === true);
      case "vacuum_fts":
        return this.vacuumFts(scope);
    }
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
    const allEntries = activeEntriesForScope(this.ctx.store, scope);
    const total = allEntries.length;
    if (total === 0) {
      onProgress?.(0, 0);
      return { action: "find_duplicates", changed: 0, details: { groups: [] } };
    }
    const seenFingerprints = new Set<string>();
    const groups: DuplicateGroup[] = [];
    let processed = 0;
    for (let offset = 0; offset < total; offset += batchSize) {
      const batch = allEntries.slice(offset, offset + batchSize);
      const batchGroups = this.findDuplicateGroups(batch);
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
    input: MaintainMemoriesInput
  ): MaintainMemoriesResult {
    assertProjectScope(scope, "merge_duplicates");
    const strategy: "keep_first" | "keep_newest" = input.strategy ?? "keep_first";
    const dryRun = input.dry_run === true;
    const onProgress = input.onProgress;
    const allEntries = activeEntriesForScope(this.ctx.store, scope);
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
      wouldSupersede.push(record);
      if (!dryRun) {
        this.applySupersede(keepTarget, supersededIds, "merge_duplicates auto-supersede");
        actuallySuperseded.push(record);
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
        groups: actuallySuperseded.length > 0 ? actuallySuperseded : wouldSupersede
      }
    };
  }

  private rebuildMarkdownIndex(scope: ResolvedReadScope): MaintainMemoriesResult {
    assertProjectScope(scope, "rebuild_markdown_index");
    const exporter = this.ctx.resolveExporter();
    const staged = exporter.stageScope({
      scope: scope.scope,
      ...(scope.project_id !== undefined ? { project_id: scope.project_id } : {}),
      entries: allEntriesForScope(this.ctx.store, scope),
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
          actor: "agent",
          metadata: paths
        });
        this.appendMaintenanceAudit(scope, "rebuild_markdown_index", changed, paths);
        return {
          action: "rebuild_markdown_index" as const,
          changed,
          details: paths
        };
      });
      published.complete();
      this.maybeBackup(changed);
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

  private expireDueMemories(scope: ResolvedReadScope, dryRun = false): MaintainMemoriesResult {
    assertProjectScope(scope, "expire_due");
    const now = nowIso();
    const expired = activeEntriesForScope(this.ctx.store, scope)
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
    return this.ctx.store.transaction(() => {
      const forgotten: Array<{ memory_id: string; expires_at: string }> = [];
      for (const entry of expired) {
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
          actor: "agent",
          reason: "expired by maintain_memories",
          metadata: { expires_at: entry.expires_at ?? "" }
        });
        forgotten.push({ memory_id: entry.id, expires_at: entry.expires_at ?? "" });
      }
      const details = { expired: forgotten };
      this.appendMaintenanceAudit(scope, "expire_due", forgotten.length, details);
      this.maybeBackup(forgotten.length);
      return { action: "expire_due", changed: forgotten.length, details };
    });
  }

  private archiveLowValueMemories(scope: ResolvedReadScope, dryRun = false): MaintainMemoriesResult {
    assertProjectScope(scope, "archive_low_value");
    const lowValue = activeEntriesForScope(this.ctx.store, scope)
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
    return this.ctx.store.transaction(() => {
      const archived: Array<{ memory_id: string; reason: string }> = [];
      for (const entry of lowValue) {
        this.ctx.store.updateEntry(entry.id, { status: "archived", updated_at: nowIso() });
        appendAudit(this.ctx.store, this.ctx.defaultActor, {
          memory_id: entry.id,
          scope: entry.scope,
          ...(entry.project_id !== undefined ? { project_id: entry.project_id } : {}),
          event: "archived",
          actor: "agent",
          reason: "low importance, low confidence, never accessed",
          metadata: { reason: "low importance, low confidence, never accessed" }
        });
        archived.push({ memory_id: entry.id, reason: "low importance, low confidence, never accessed" });
      }
      const details = { archived };
      this.appendMaintenanceAudit(scope, "archive_low_value", archived.length, details);
      this.maybeBackup(archived.length);
      return { action: "archive_low_value", changed: archived.length, details };
    });
  }

  private vacuumFts(scope: ResolvedReadScope): MaintainMemoriesResult {
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

  private findDuplicateGroups(entries: MemoryEntry[]): DuplicateGroup[] {
    const sortedEntries = [...entries].sort((a, b) => compareText(a.id, b.id));
    const exactGroups: DuplicateGroup[] = [
      ...this.duplicateGroupsFor(sortedEntries, "same_title_and_body", (entry) => `${normalizeDuplicateText(entry.title)}\n${normalizeDuplicateText(entry.body)}`),
      ...this.duplicateGroupsFor(sortedEntries, "same_title", (entry) => normalizeDuplicateText(entry.title)),
      ...this.duplicateGroupsFor(sortedEntries, "same_body", (entry) => normalizeDuplicateText(entry.body))
    ];
    const similarGroups = this.similarDuplicateGroups(sortedEntries, this.coveredPairKeys(exactGroups));
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

  private similarDuplicateGroups(entries: MemoryEntry[], covered: Set<string>): DuplicateGroup[] {
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
    const seen = new Set<string>();
    const groups: DuplicateGroup[] = [];
    for (const entriesInBucket of bucket.values()) {
      if (entriesInBucket.length > BUCKET_CAP) continue;
      for (let i = 0; i < entriesInBucket.length; i += 1) {
        const a = entriesInBucket[i];
        if (a === undefined) continue;
        for (let j = i + 1; j < entriesInBucket.length; j += 1) {
          const b = entriesInBucket[j];
          if (b === undefined) continue;
          const pairKey = compareText(a.id, b.id) <= 0 ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);
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

  private applySupersede(keepTarget: MemoryEntry, supersededIds: string[], reason: string): void {
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
          actor: "agent",
          reason,
          metadata: { superseded_by: keepTarget.id }
        });
      }
    });
  }

  private maybeBackup(changed: number): void {
    if (changed <= 0 || this.ctx.dataHome === undefined) return;
    try {
      const backupDir = join(this.ctx.dataHome, "backups");
      const result = runBackup(this.ctx.store.backupHandle(), { backupDir });
      appendAudit(this.ctx.store, this.ctx.defaultActor, {
        scope: "global",
        event: "backup_created",
        actor: "system:backup",
        reason: "backup_created",
        metadata: { path: result.path, size: result.size, duration_ms: result.durationMs }
      });
    } catch {
      // Backup failures after a successful maintenance are
      // non-fatal. The audit row from the failed backup is
      // emitted elsewhere (in the public backup() method).
    }
  }

  private appendMaintenanceAudit(
    scope: ResolvedReadScope,
    action: MaintenanceAction,
    changed: number,
    details: Record<string, unknown>
  ): void {
    appendAudit(this.ctx.store, this.ctx.defaultActor, {
      scope: scope.scope,
      ...(scope.project_id !== undefined ? { project_id: scope.project_id } : {}),
      event: "maintenance_run",
      actor: "agent",
      reason: action,
      metadata: { action, changed, ...details }
    });
  }

  // The private `resolveScope` helper used to live here. It was
  // removed in Stage 10 PR2 — every entry point must call
  // `resolveMemoryScope` from `../scope-resolver.js` instead, so
  // there is exactly one ProjectIdentityResolver in the codebase.
}

// Re-export so the old top-level helpers used by memory-service.ts still resolve.
export { createHash };
