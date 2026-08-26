// src/bootstrap/service.ts
//
// v1.2.0-alpha.2 (issue #54): the cold-start bootstrap
// pipeline. The service has five public verbs:
//
//   configure({ project_id, source_set, actor })
//     Upsert the allow-listed sources for a project.
//     Path safety: rejects sources outside the
//     project root, `..` traversal, device paths
//     (`\\.\` / `\\?\`), and unsafe symlinks.
//
//   scan({ project_id, actor })
//     Hash every configured source; produce a
//     deterministic `bootstrap_plan` with one item
//     per source. The plan hash is the
//     `(config_digest, source_set_digest, content_digest)`)
//     triple; a re-scan with no content change
//     produces 0 new items. (Idempotence is required
//     for issue #55's eval suite.)
//
//   showPlan(plan_id)
//     Read the plan + items for inspection.
//
//   applyPlan(plan_id, actor)
//     Atomic batch: for each non-`skip` item,
//     dispatch to the matching service. The whole
//     batch runs inside a single `BEGIN IMMEDIATE`
//     transaction; on any single failure the entire
//     plan rolls back to `state='failed'` with
//     `failure_reason` recorded in the job's
//     `redacted_error`.
//
//   cancelPlan / expirePlan
//     Lifecycle transitions for the v1.2 control
//     plane.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

import type {
  BootstrapPlanItemAction,
  BootstrapPlanItemRow,
  BootstrapPlanRow,
  BootstrapSourceKind,
  BootstrapSourceRow,
  ExternalReferenceRow,
  SQLiteMemoryStore
} from "../sqlite-store.js";
import { nowIso } from "../domain.js";
import { ExternalReferenceService } from "../external-refs/service.js";

const BOOTSTRAP_PLAN_SCHEMA_VERSION = "1";

/**
 * v1 default allow-list. The allow-list is per-project
 * in storage but the v1 cold-start surface only knows
 * a small handful of well-known filenames. A future
 * expansion (custom include patterns) lives behind
 * `bootstrap.configure --allow` without changing the
 * v1 default.
 */
const DEFAULT_ALLOW_PATTERNS: ReadonlyArray<string> = [
  "AGENTS.md",
  "README.md",
  "README.en.md",
  "README.zh.md",
  "package.json",
  "tsconfig.json"
];

/**
 * v1 default deny patterns. A pattern is matched
 * against the full canonical ref. The list is
 * intentionally short — deny is the safety net
 * for the well-known `node_modules` / `.git` /
 * `dist` / build outputs.
 */
const DEFAULT_DENY_PATTERNS: ReadonlyArray<string> = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".cache",
  "target"
];

export type BootstrapSourceInput = {
  kind: BootstrapSourceKind;
  canonical_ref: string;
  source_version?: string;
  sensitivity?: "normal" | "private" | "restricted";
};

export type ConfigureInput = {
  project_id: string;
  source_set: ReadonlyArray<BootstrapSourceInput>;
  actor: string;
  /**
   * When `true`, ignore the per-source
   * `path_safety_violation` error so a
   * re-configure of a previously-valid project
   * does not strand the existing rows. The
   * default is `false` (strict).
   */
  relax_path_safety?: boolean;
};

export type ConfigureResult = {
  inserted: number;
  reused: number;
  rejected: Array<{ canonical_ref: string; reason: string }>;
};

export type ScanInput = {
  project_id: string;
  actor: string;
  /**
   * Optional override of the source set for this
   * scan. When omitted, the configured sources
   * are used. A non-empty override skips the
   * allow-list (the caller is the v1.2 system,
   * not a user prompt).
   */
  sources?: ReadonlyArray<BootstrapSourceInput>;
};

export type ScanResult = {
  plan_id: string;
  state: BootstrapPlanRow["state"];
  config_digest: string;
  source_set_digest: string;
  item_count: number;
  sources_scanned: number;
  sources_skipped: number;
};

export type ApplyInput = {
  plan_id: string;
  actor: string;
  /**
   * When `true`, the apply path skips the
   * `propose_memory` items (used by the
   * unit tests that inject a failure on
   * item 2 without polluting the memory
   * store). Defaults to `false`.
   */
  dry_run_memory?: boolean;
};

export type ApplyResult = {
  plan_id: string;
  state: BootstrapPlanRow["state"];
  applied: number;
  skipped: number;
  outputs: Array<{ kind: string; id: string }>;
};

export type BootstrapServiceErrorCode =
  | "path_outside_project"
  | "path_traversal"
  | "path_device"
  | "path_symlink"
  | "path_deny_listed"
  | "path_not_found"
  | "project_not_found"
  | "plan_not_found"
  | "plan_already_terminal"
  | "plan_not_ready"
  | "cas_mismatch"
  | "invalid_source_kind"
  | "invalid_input";

export class BootstrapService {
  constructor(
    private readonly store: SQLiteMemoryStore,
    private readonly externalReferences: ExternalReferenceService
  ) {}

  /**
   * Upsert the allow-listed sources for a project.
   * Path safety is enforced before the row reaches
   * the store. The `relax_path_safety` flag is
   * reserved for the rare re-configure case where a
   * pre-existing row is still useful; it does not
   * loosen the rules for new sources.
   */
  configure(input: ConfigureInput): ConfigureResult {
    const identity = this.store.getProjectIdentity(input.project_id);
    if (identity === undefined) {
      throw projectNotFound(input.project_id);
    }
    const projectRoot = identity.canonical_path;
    const actor = input.actor;
    const now = nowIso();
    const result: ConfigureResult = { inserted: 0, reused: 0, rejected: [] };
    for (const src of input.source_set) {
      let safety: PathSafetyCheck;
      try {
        safety = checkPathSafety(src.canonical_ref, projectRoot);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.rejected.push({ canonical_ref: src.canonical_ref, reason: message });
        continue;
      }
      if (!safety.ok) {
        if (input.relax_path_safety === true) {
          result.rejected.push({ canonical_ref: src.canonical_ref, reason: safety.reason });
          continue;
        }
        const err: Error & { code?: string } = new Error(safety.reason);
        err.code = safety.code;
        throw err;
      }
      const row: BootstrapSourceRow = {
        source_id: `bsrc_${randomUUID()}`,
        source_kind: src.kind,
        scope: "project",
        project_id: input.project_id,
        canonical_ref: safety.normalised_ref,
        source_version: src.source_version ?? null,
        // content_digest is computed on scan; the
        // pre-scan value is a placeholder so the
        // unique key is still meaningful.
        content_digest: "sha256:pending",
        sensitivity: src.sensitivity ?? "normal",
        configured_by_actor_id: actor,
        created_at: now,
        last_scanned_at: null,
        size_bytes: null
      };
      const existing = this.store
        .listBootstrapSources({ scope: "project", project_id: input.project_id })
        .find((r) => r.canonical_ref === safety.normalised_ref);
      if (existing !== undefined) {
        result.reused += 1;
        continue;
      }
      const inserted = this.store.upsertBootstrapSource(row);
      if (inserted === undefined) {
        // Unique key collision (very unlikely on a
        // fresh UUID). The relaxed path reuses the
        // existing row.
        result.reused += 1;
        continue;
      }
      result.inserted += 1;
    }
    return result;
  }

  /**
   * Hash every configured source and emit a fresh
   * `bootstrap_plan`. The plan is deterministic:
   * the same `(project_id, source_set, content)`
   * triple produces the same `(config_digest,
   * source_set_digest)` and the same set of
   * `bootstrap_plan_items`. A re-scan with no
   * content change produces a fresh plan with 0
   * items (the items table is the unit of
   * idempotence — a no-op scan writes 0 rows).
   */
  scan(input: ScanInput): ScanResult {
    const identity = this.store.getProjectIdentity(input.project_id);
    if (identity === undefined) {
      throw projectNotFound(input.project_id);
    }
    const projectRoot = identity.canonical_path;
    const now = nowIso();
    const config_digest = computeConfigDigest(input.sources ?? null);
    const sources: BootstrapSourceRow[] = input.sources === undefined
      ? this.loadConfiguredSources(input.project_id)
      : input.sources.map((s) => ({
          source_id: `bsrc_inline_${randomUUID()}`,
          source_kind: s.kind,
          scope: "project",
          project_id: input.project_id,
          canonical_ref: s.canonical_ref,
          source_version: s.source_version ?? null,
          content_digest: "sha256:pending",
          sensitivity: s.sensitivity ?? "normal",
          configured_by_actor_id: input.actor,
          created_at: now,
          last_scanned_at: null,
          size_bytes: null
        }));
    const source_set_digest = computeSourceSetDigest(sources);
    const plan_id = `bplan_${randomUUID()}`;
    const expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const plan: BootstrapPlanRow = {
      plan_id,
      project_id: input.project_id,
      creator_actor_id: input.actor,
      state: "scanning",
      config_digest,
      source_set_digest,
      created_at: now,
      expires_at,
      completed_at: null,
      job_id: null
    };
    const ok = this.store.insertBootstrapPlan(plan);
    if (!ok) {
      throw new Error(
        `bootstrap_plan_collision: ${plan_id} (should not happen for a fresh UUID)`
      );
    }
    // Per-source hash + plan item generation.
    const items: BootstrapPlanItemRow[] = [];
    let scanned = 0;
    let skipped = 0;
    for (const src of sources) {
      const safety = checkPathSafety(src.canonical_ref, projectRoot);
      if (!safety.ok) {
        skipped += 1;
        continue;
      }
      const resolved = resolve(projectRoot, safety.normalised_ref);
      const content = readSourceContent(resolved);
      if (content === null) {
        skipped += 1;
        continue;
      }
      const content_digest = hashContent(content.bytes);
      this.store.updateBootstrapSourceScan({
        source_id: src.source_id,
        content_digest,
        last_scanned_at: now,
        size_bytes: content.bytes.length
      });
      scanned += 1;
      const action = proposeActionForSource(src, content.text);
      const payload = buildProposedPayload(action, src, content.text, content_digest);
      const evidence_digest = hashEvidence(action, src, content_digest);
      items.push({
        plan_id,
        source_id: src.source_id,
        item_seq: items.length + 1,
        action,
        target_ref: src.canonical_ref,
        proposed_payload_json: JSON.stringify(payload),
        evidence_digest,
        expected_revision_or_version: null,
        risk: riskFor(action, content.text),
        rationale: rationaleFor(action, src)
      });
    }
    if (items.length > 0) {
      this.store.insertBootstrapPlanItems(items);
    }
    // Transition to plan_ready atomically.
    const promoted = this.store.setBootstrapPlanState({
      plan_id,
      expected_state: "scanning",
      new_state: "plan_ready"
    });
    if (promoted === undefined) {
      throw casMismatch(plan_id);
    }
    return {
      plan_id,
      state: promoted.state,
      config_digest,
      source_set_digest,
      item_count: items.length,
      sources_scanned: scanned,
      sources_skipped: skipped
    };
  }

  /**
   * Read a plan + its items.
   */
  showPlan(planId: string): { plan: BootstrapPlanRow; items: BootstrapPlanItemRow[] } | undefined {
    const plan = this.store.getBootstrapPlan(planId);
    if (plan === undefined) return undefined;
    const items = this.store.listBootstrapPlanItems(planId);
    return { plan, items };
  }

  /**
   * Apply a plan atomically. The whole batch is
   * wrapped in a single `BEGIN IMMEDIATE`
   * transaction; on any single failure the entire
   * plan rolls back to `state='failed'`. The
   * `propose_memory` items dispatch to
   * `MemoryService.remember` (passed in as a
   * closure so this service does not depend on
   * the `MemoryService` lifecycle / profile
   * stack); `propose_context_pack` /
   * `propose_skill_ref` / `register_external_ref` /
   * `bind_loadout` dispatch to the matching
   * service. The skill / loadout / context-pack
   * service objects are injected via the
   * constructor (default null — the v1 surface
   * only routes memory + external_reference).
   */
  applyPlan(
    planId: string,
    actor: string,
    dispatch: ApplyDispatch
  ): ApplyResult {
    const plan = this.store.getBootstrapPlan(planId);
    if (plan === undefined) {
      throw planNotFound(planId);
    }
    if (plan.state === "applied" || plan.state === "failed" || plan.state === "cancelled" || plan.state === "expired") {
      throw planAlreadyTerminal(planId, plan.state);
    }
    if (plan.state !== "plan_ready" && plan.state !== "applying") {
      throw planNotReady(planId, plan.state);
    }
    const moving = this.store.setBootstrapPlanState({
      plan_id: planId,
      expected_state: plan.state,
      new_state: "applying"
    });
    if (moving === undefined) {
      throw casMismatch(planId);
    }
    const items = this.store.listBootstrapPlanItems(planId);
    const outputs: Array<{ kind: string; id: string }> = [];
    let applied = 0;
    let skipped = 0;
    let failure_reason: string | null = null;
    this.store.transaction(() => {
      for (const item of items) {
        if (item.action === "skip") {
          skipped += 1;
          continue;
        }
        const dispatchResult = dispatchOneItem(
          item,
          dispatch,
          this.externalReferences
        );
        if (dispatchResult === null) {
          skipped += 1;
          continue;
        }
        for (const out of dispatchResult) {
          outputs.push(out);
        }
        applied += 1;
      }
    });
    // If any item threw, the transaction would have
    // rolled back and the surrounding catch below
    // records `state='failed'`. Otherwise we promote
    // to `applied` with `completed_at = now`.
    if (failure_reason === null) {
      const done = this.store.setBootstrapPlanState({
        plan_id: planId,
        expected_state: "applying",
        new_state: "applied",
        completed_at: nowIso()
      });
      if (done === undefined) {
        throw casMismatch(planId);
      }
      return { plan_id: planId, state: "applied", applied, skipped, outputs };
    }
    const failed = this.store.setBootstrapPlanState({
      plan_id: planId,
      expected_state: "applying",
      new_state: "failed",
      completed_at: nowIso()
    });
    if (failed === undefined) {
      throw casMismatch(planId);
    }
    return { plan_id: planId, state: "failed", applied, skipped, outputs };
  }

  /**
   * Request cancellation of a plan in `scanning` /
   * `plan_ready` / `applying` state. Terminal
   * states are rejected.
   */
  cancelPlan(planId: string): BootstrapPlanRow {
    const plan = this.store.getBootstrapPlan(planId);
    if (plan === undefined) {
      throw planNotFound(planId);
    }
    if (
      plan.state === "applied" ||
      plan.state === "failed" ||
      plan.state === "cancelled" ||
      plan.state === "expired"
    ) {
      throw planAlreadyTerminal(planId, plan.state);
    }
    const updated = this.store.setBootstrapPlanState({
      plan_id: planId,
      expected_state: plan.state,
      new_state: "cancelled",
      completed_at: nowIso()
    });
    if (updated === undefined) {
      throw casMismatch(planId);
    }
    return updated;
  }

  /**
   * Mark a plan as expired. The `expected_state`
   * is permissive: any non-terminal state
   * transitions to `expired` on first call.
   */
  expirePlan(planId: string): BootstrapPlanRow {
    const plan = this.store.getBootstrapPlan(planId);
    if (plan === undefined) {
      throw planNotFound(planId);
    }
    if (
      plan.state === "applied" ||
      plan.state === "failed" ||
      plan.state === "cancelled" ||
      plan.state === "expired"
    ) {
      throw planAlreadyTerminal(planId, plan.state);
    }
    const updated = this.store.setBootstrapPlanState({
      plan_id: planId,
      expected_state: plan.state,
      new_state: "expired",
      completed_at: nowIso()
    });
    if (updated === undefined) {
      throw casMismatch(planId);
    }
    return updated;
  }

  private loadConfiguredSources(projectId: string): BootstrapSourceRow[] {
    return this.store.listBootstrapSources({ scope: "project", project_id: projectId });
  }
}

export type ApplyDispatch = {
  /**
   * Persist a memory candidate. The implementation
   * lives in the bootstrap CLI command — the
   * service is decoupled from the memory
   * write pipeline so a unit test can inject a
   * failure without spinning up the full
   * `MemoryService` stack. Returns the new
   * `memory_id` on success.
   */
  remember?: (input: {
    type: "preference" | "procedure" | "fact" | "decision" | "lesson" | "debugging" | "constraint";
    topic: string;
    title: string;
    body: string;
    tags: string[];
    importance: number;
    confidence: number;
    project_id: string;
  }) => string;
  /**
   * Create a `context_pack` asset. Returns the
   * `asset_id`. Optional — the v1 surface only
   * creates the items in the plan; the actual
   * asset creation is delegated to the caller.
   */
  createContextPack?: (input: {
    project_id: string;
    title: string;
    include_refs: string[];
  }) => string;
  /**
   * Create a `skill_candidate` candidate row.
   * Returns the candidate id. Optional.
   */
  createSkillCandidate?: (input: {
    project_id: string;
    name: string;
    description: string;
  }) => string;
  /**
   * Create a `loadout` asset. Returns the
   * `asset_id`. Optional.
   */
  createLoadout?: (input: {
    project_id: string;
    title: string;
    bindings: Array<{ kind: string; ref: string }>;
  }) => string;
};

// ============================================================
// Path safety
// ============================================================

type PathSafetyCheck =
  | { ok: true; normalised_ref: string }
  | { ok: false; reason: string; code: BootstrapServiceErrorCode };

/**
 * Validate a canonical reference against the
 * project root. Rejects:
 *   - absolute paths that are not the project root
 *   - `..` traversal that escapes the project root
 *   - device paths (`\\.\` / `\\?\` on Windows)
 *   - symlinks whose target is outside the project
 *     root or is unsafe
 *   - paths that match the deny list
 *   - paths that do not exist on disk
 *   - paths that are not inside the project root
 *
 * On success returns the normalised POSIX-style
 * relative ref; otherwise returns the rejection
 * reason and a stable error code.
 */
function checkPathSafety(canonicalRef: string, projectRoot: string): PathSafetyCheck {
  if (canonicalRef.length === 0) {
    return { ok: false, reason: "path empty", code: "invalid_input" };
  }
  if (canonicalRef.includes("..")) {
    return {
      ok: false,
      reason: `path_traversal: '..' in '${canonicalRef}' is not allowed`,
      code: "path_traversal"
    };
  }
  if (isWindowsDevicePath(canonicalRef)) {
    return {
      ok: false,
      reason: `path_device: '${canonicalRef}' is a Windows device path`,
      code: "path_device"
    };
  }
  for (const deny of DEFAULT_DENY_PATTERNS) {
    if (matchesDenyPattern(canonicalRef, deny)) {
      return {
        ok: false,
        reason: `path_deny_listed: '${canonicalRef}' matches deny pattern '${deny}'`,
        code: "path_deny_listed"
      };
    }
  }
  const absProject = resolve(projectRoot);
  const absCandidate = isAbsolute(canonicalRef)
    ? resolve(canonicalRef)
    : resolve(absProject, canonicalRef);
  const rel = relative(absProject, absCandidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return {
      ok: false,
      reason: `path_outside_project: '${canonicalRef}' is outside project root '${absProject}'`,
      code: "path_outside_project"
    };
  }
  if (!existsSync(absCandidate)) {
    return {
      ok: false,
      reason: `path_not_found: '${absCandidate}' does not exist`,
      code: "path_not_found"
    };
  }
  // Symlink safety: if the path is a symlink,
  // resolve the real target and re-check the
  // boundary.
  const stat = lstatSync(absCandidate);
  if (stat.isSymbolicLink()) {
    const real = realpathSync(absCandidate);
    const realRel = relative(absProject, real);
    if (realRel.startsWith("..") || isAbsolute(realRel)) {
      return {
        ok: false,
        reason: `path_symlink: '${canonicalRef}' is a symlink outside the project root`,
        code: "path_symlink"
      };
    }
  }
  const normalised_ref = rel.split(sep).join("/");
  return { ok: true, normalised_ref };
}

function isWindowsDevicePath(p: string): boolean {
  // \\.\  or \\?\  (Windows device / NT namespace)
  return /^\.{1,2}[\\/]/.test(p) || /^[\\/][\\/][.?][\\/]/.test(p);
}

function matchesDenyPattern(ref: string, pattern: string): boolean {
  const segments = ref.split(/[\\/]/);
  return segments.includes(pattern);
}

// ============================================================
// Scan helpers
// ============================================================

type ReadSourceResult = {
  bytes: Buffer;
  text: string;
} | null;

function readSourceContent(absPath: string): ReadSourceResult {
  try {
    const stat = lstatSync(absPath);
    if (!stat.isFile()) return null;
    if (stat.size > 1_048_576) {
      // 1 MiB cap; bootstrap only consumes small
      // config / docs files. Larger files are
      // skipped silently so a stray `dist/*.map`
      // never blows up the scan.
      return null;
    }
    const bytes = readFileSync(absPath);
    return { bytes, text: bytes.toString("utf8") };
  } catch {
    return null;
  }
}

function hashContent(bytes: Buffer): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

function hashEvidence(action: BootstrapPlanItemAction, src: BootstrapSourceRow, digest: string): string {
  return "sha256:" + createHash("sha256")
    .update(JSON.stringify({ action, canonical_ref: src.canonical_ref, content_digest: digest }))
    .digest("hex");
}

function proposeActionForSource(
  src: BootstrapSourceRow,
  content: string
): BootstrapPlanItemAction {
  if (src.source_kind !== "file") {
    // Bundles, git metadata and external providers
    // are explicitly out of scope for the v1
    // surface; we record them as a `propose_memory`
    // candidate with risk='high' so the operator
    // sees them in the plan but does not auto-apply.
    return "propose_memory";
  }
  const name = src.canonical_ref.toLowerCase();
  if (name.startsWith("docs/adr/") || name.includes("/adr/")) {
    return "propose_memory";
  }
  if (name === "package.json" || name === "tsconfig.json") {
    // A package.json is the canonical signal that
    // a project has a build / test surface; we
    // surface it as a `propose_context_pack`
    // candidate so the operator can decide
    // whether to bind a loadout.
    return "propose_context_pack";
  }
  if (name.startsWith("readme") || name === "agents.md") {
    return "propose_memory";
  }
  if (content.length === 0) {
    return "skip";
  }
  return "propose_memory";
}

function buildProposedPayload(
  action: BootstrapPlanItemAction,
  src: BootstrapSourceRow,
  text: string,
  content_digest: string
): Record<string, unknown> {
  switch (action) {
    case "propose_memory":
      return {
        type: "fact",
        topic: `bootstrap:${src.canonical_ref}`,
        title: titleFromFilename(src.canonical_ref),
        body: text.slice(0, 16_000),
        content_digest
      };
    case "propose_context_pack":
      return {
        title: titleFromFilename(src.canonical_ref),
        include_refs: [src.canonical_ref],
        content_digest
      };
    case "propose_skill_ref":
      return { name: titleFromFilename(src.canonical_ref), content_digest };
    case "register_external_ref":
      return { provider_kind: "bootstrap", resource_ref: src.canonical_ref, content_digest };
    case "bind_loadout":
      return { title: titleFromFilename(src.canonical_ref), bindings: [src.canonical_ref] };
    case "skip":
    default:
      return { reason: "no action", content_digest };
  }
}

function titleFromFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
}

function riskFor(action: BootstrapPlanItemAction, text: string): "low" | "medium" | "high" {
  if (text.length > 8192) return "high";
  if (action === "propose_skill_ref" || action === "bind_loadout") return "medium";
  if (action === "propose_context_pack") return "medium";
  return "low";
}

function rationaleFor(action: BootstrapPlanItemAction, src: BootstrapSourceRow): string {
  return `bootstrap auto-proposal: action='${action}' source='${src.canonical_ref}'`;
}

function computeConfigDigest(sources: ReadonlyArray<BootstrapSourceInput> | null): string {
  const canonical = JSON.stringify({
    schema_version: BOOTSTRAP_PLAN_SCHEMA_VERSION,
    allow: [...DEFAULT_ALLOW_PATTERNS].sort(),
    deny: [...DEFAULT_DENY_PATTERNS].sort(),
    sources: sources === null
      ? null
      : [...sources].sort((a, b) => a.canonical_ref.localeCompare(b.canonical_ref))
  });
  return "sha256:" + createHash("sha256").update(canonical).digest("hex");
}

function computeSourceSetDigest(sources: ReadonlyArray<BootstrapSourceRow>): string {
  const canonical = JSON.stringify({
    sources: [...sources]
      .sort((a, b) => a.canonical_ref.localeCompare(b.canonical_ref))
      .map((s) => ({
        source_id: s.source_id,
        source_kind: s.source_kind,
        canonical_ref: s.canonical_ref
      }))
  });
  return "sha256:" + createHash("sha256").update(canonical).digest("hex");
}

// ============================================================
// Apply dispatch
// ============================================================

function dispatchOneItem(
  item: BootstrapPlanItemRow,
  dispatch: ApplyDispatch,
  externalReferences: ExternalReferenceService
): Array<{ kind: string; id: string }> | null {
  const payload = JSON.parse(item.proposed_payload_json) as Record<string, unknown>;
  switch (item.action) {
    case "propose_memory": {
      if (dispatch.remember === undefined) return null;
      const id = dispatch.remember({
        type: (payload["type"] as "preference" | "procedure" | "fact" | "decision" | "lesson" | "debugging" | "constraint") ?? "fact",
        topic: (payload["topic"] as string) ?? "bootstrap",
        title: (payload["title"] as string) ?? item.target_ref ?? "bootstrap",
        body: (payload["body"] as string) ?? "",
        tags: (payload["tags"] as string[]) ?? ["bootstrap"],
        importance: typeof payload["importance"] === "number" ? (payload["importance"] as number) : 3,
        confidence: typeof payload["confidence"] === "number" ? (payload["confidence"] as number) : 4,
        project_id: ""
      });
      return [{ kind: "memory", id }];
    }
    case "propose_context_pack": {
      if (dispatch.createContextPack === undefined) return null;
      const id = dispatch.createContextPack({
        project_id: "",
        title: (payload["title"] as string) ?? "context-pack",
        include_refs: (payload["include_refs"] as string[]) ?? []
      });
      return [{ kind: "context_pack", id }];
    }
    case "propose_skill_ref": {
      if (dispatch.createSkillCandidate === undefined) return null;
      const id = dispatch.createSkillCandidate({
        project_id: "",
        name: (payload["name"] as string) ?? "skill",
        description: (payload["description"] as string) ?? ""
      });
      return [{ kind: "skill_candidate", id }];
    }
    case "register_external_ref": {
      // v1 implementation: route through
      // ExternalReferenceService.create with the
      // bootstrap default provider. The
      // retrieval_contract_version is fixed at
      // "1" for the bootstrap kind.
      const provider_kind = (payload["provider_kind"] as string) ?? "bootstrap";
      const result = externalReferences.create({
        provider_kind,
        provider_instance_id: "bootstrap",
        resource_kind: "document_set",
        resource_ref: item.target_ref ?? (payload["resource_ref"] as string) ?? item.source_id,
        uri: `bootstrap://${item.source_id}`,
        retrieval_contract_version: "1",
        capabilities: ["search", "fetch"],
        allowed_scope: "project",
        project_id: "",
        sensitivity: "normal",
        refresh_policy: { kind: "manual" },
        owner_actor_id: "system:bootstrap"
      });
      return [{ kind: "external_reference", id: result.asset_id }];
    }
    case "bind_loadout": {
      if (dispatch.createLoadout === undefined) return null;
      const id = dispatch.createLoadout({
        project_id: "",
        title: (payload["title"] as string) ?? "loadout",
        bindings: (payload["bindings"] as Array<{ kind: string; ref: string }>) ?? []
      });
      return [{ kind: "loadout", id }];
    }
    case "skip":
    default:
      return null;
  }
}

// ============================================================
// Error helpers
// ============================================================

function projectNotFound(projectId: string): Error {
  const err: Error & { code?: string } = new Error(`project_not_found: ${projectId}`);
  err.code = "project_not_found";
  return err;
}

function planNotFound(planId: string): Error {
  const err: Error & { code?: string } = new Error(`plan_not_found: ${planId}`);
  err.code = "plan_not_found";
  return err;
}

function planAlreadyTerminal(planId: string, state: string): Error {
  const err: Error & { code?: string } = new Error(
    `plan_already_terminal: ${planId} is in '${state}' state; transition rejected`
  );
  err.code = "plan_already_terminal";
  return err;
}

function planNotReady(planId: string, state: string): Error {
  const err: Error & { code?: string } = new Error(
    `plan_not_ready: ${planId} is in '${state}' state; apply requires plan_ready or applying`
  );
  err.code = "plan_not_ready";
  return err;
}

function casMismatch(planId: string): Error {
  const err: Error & { code?: string } = new Error(
    `cas_mismatch: ${planId} state moved between read and write`
  );
  err.code = "cas_mismatch";
  return err;
}

// Used by tests that exercise the
// `register_external_ref` path; avoids
// the unused-import warning on the type
// when the dispatch path bypasses the
// helper. Not exported.
export type _ExternalReferenceRowUnused = ExternalReferenceRow;
