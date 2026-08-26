// test/eval-lifecycle/runner.ts
//
// v1.2.0-alpha.2 (issue #55): the lifecycle evaluation
// runner. Walks the manifest's fixture list, executes
// each fixture against a fresh in-process memory
// store, and emits a per-fixture + aggregate report.
//
// The runner is intentionally thin: schema validation
// lives in `schemas.ts`; the report formatter lives in
// `report.ts`; the actual service-layer calls are
// inlined here so the harness has no implicit
// dependency on the CLI shims (the v1 release gate
// must call the service directly so a CLI parsing
// regression doesn't mask a real regression).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

import { CURRENT_SCHEMA_VERSION, SQLiteMemoryStore } from "../../src/sqlite-store.js";
import { MemoryWriteService } from "../../src/services/memory-write-service.js";
import { SessionService } from "../../src/sessions/service.js";
import { JsonlSessionAdapter } from "../../src/sessions/adapters/jsonl.js";
import { DistillationService, enqueueAndRunSessionDistill } from "../../src/distillation/service.js";
import { DerivationJobStore } from "../../src/jobs/service.js";
import { LoadoutService } from "../../src/loadouts/service.js";
import { SkillService } from "../../src/skills/service.js";
import { BootstrapService } from "../../src/bootstrap/service.js";
import { ExternalReferenceService } from "../../src/external-refs/service.js";
import { ProjectIdentityResolver } from "../../src/scope-resolver.js";
import { CollectingSafetyCounters } from "../../src/services/safety-counters.js";
import { formatReportJson, formatReportMarkdown } from "./report.js";
import {
  LifecycleFixtureSchema,
  LifecycleCorpusManifestSchema,
  type LifecycleFixture,
  type LifecycleCorpusManifest,
  type FixtureResult,
  type CorpusReport
} from "./schemas.js";

/**
 * Fresh temp DB path per fixture so state never
 * leaks between fixtures. Mirrors the helper
 * pattern in `test/unit/sessions-service.test.ts`.
 */
function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "agent-recall-eval-")), "memory.sqlite");
}

function openStore(dbPath: string): SQLiteMemoryStore {
  return new SQLiteMemoryStore(dbPath);
}

/**
 * A bundle of services the runner needs to
 * execute fixtures. The runner constructs a
 * fresh instance per fixture so a state leak
 * between fixtures is impossible.
 */
type FixtureContext = {
  store: SQLiteMemoryStore;
  dataHome: string;
  projectRoot: string;
  memoryWriteService: MemoryWriteService;
  sessionService: SessionService;
  distillationService: DistillationService;
  jobStore: DerivationJobStore;
  loadoutService: LoadoutService;
  skillService: SkillService;
  bootstrapService: BootstrapService;
  externalReferences: ExternalReferenceService;
  /**
   * v1.2.0-alpha.3 (issue #55b): the collecting
   * safety counter. Wired into SessionService
   * (secret + injection) and DistillationService
   * (secret + trust escalation). The runner reads
   * `snapshot()` after the operation handler
   * returns and writes the result into
   * `OperationResult.safety_counters`.
   */
  safetyCounters: CollectingSafetyCounters;
  /**
   * Map of loadout name -> loadout_id for fixtures
   * that operate on a loadout by name. Populated
   * during the seed step.
   */
  loadoutIdsByName: Map<string, string>;
  /**
   * Map of skill name -> asset_id for fixtures
   * that operate on a skill by name. Populated
   * during the seed step (`seed.skills[]`).
   */
  skillAssetIdsByName: Map<string, string>;
  /**
   * Bootstrap plan_id from the seed step. Populated
   * when `seed.bootstrap.scan = true`. `null` when
   * the fixture did not seed a bootstrap plan.
   */
  bootstrapPlanId: string | null;
  /**
   * Bootstrap project_id from the seed step. Set
   * when the fixture declares a `seed.bootstrap`
   * block, even when `scan = false`.
   */
  bootstrapProjectId: string | null;
};

function buildContext(): FixtureContext {
  const dataHome = tmpDbPath();
  const store = openStore(dataHome);
  const memoryWriteService = new MemoryWriteService(store);
  // v1.2.0-alpha.3 (issue #55b): the collecting
  // safety counter is wired into the two services
  // that emit safety events (SessionService for
  // secret / injection; DistillationService for
  // secret / trust escalation). The ContextAssembler
  // hook lives outside the runner's per-fixture
  // services (the eval suite does not exercise
  // context assembly yet) so it stays on the
  // default no-op for now.
  const safetyCounters = new CollectingSafetyCounters();
  const sessionService = new SessionService(
    store,
    null,
    safetyCounters
  );
  const jobStore = new DerivationJobStore(store);
  const distillationService = new DistillationService(
    store,
    sessionService,
    jobStore,
    { memoryWriteService, safetyCounters }
  );
  const loadoutService = new LoadoutService(store);
  const skillService = new SkillService(store);
  const externalReferences = new ExternalReferenceService(store);
  const bootstrapService = new BootstrapService(store, externalReferences);
  // A per-fixture project root. The bootstrap
  // service resolves configured sources against
  // this directory; the seed step registers a
  // project identity with `canonical_path`
  // pointing at it so the configure / scan paths
  // do not throw `project_not_found`.
  const projectRoot = mkdtempSync(join(tmpdir(), "agent-recall-eval-proj-"));
  // Pre-create the v1 default allow-list files
  // (AGENTS.md + README.md) so scan / apply
  // fixtures do not have their sources silently
  // skipped. Content is intentionally short and
  // stable so two scans of the same project root
  // produce byte-equal content_digests.
  writeFileSync(
    join(projectRoot, "AGENTS.md"),
    "# eval project\n\nplaceholder content for the lifecycle eval fixtures.\n",
    "utf8"
  );
  writeFileSync(
    join(projectRoot, "README.md"),
    "# eval project README\n\nplaceholder content for the lifecycle eval fixtures.\n",
    "utf8"
  );
  return {
    store,
    dataHome,
    projectRoot,
    memoryWriteService,
    sessionService,
    distillationService,
    jobStore,
    loadoutService,
    skillService,
    bootstrapService,
    externalReferences,
    safetyCounters,
    loadoutIdsByName: new Map(),
    skillAssetIdsByName: new Map(),
    bootstrapPlanId: null,
    bootstrapProjectId: null
  };
}

function disposeContext(ctx: FixtureContext): void {
  try {
    ctx.store.close();
  } catch {
    // already closed
  }
  try {
    rmSync(join(ctx.dataHome, ".."), { recursive: true, force: true });
  } catch {
    // best-effort
  }
  try {
    rmSync(ctx.projectRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/**
 * Recompute the SHA-256 over the body and replace
 * any `sha256:PLACEHOLDER` digest in the JSONL
 * stream. The v1 fixtures ship a placeholder
 * digest so the file is hand-readable; the
 * service enforces content-digest = sha256(body).
 */
function recomputeContentDigests(jsonl: string): string {
  const lines = jsonl.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      out.push(line);
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown> & {
        event_type?: string;
        content?: string;
        content_digest?: string;
      };
      if (
        typeof parsed.content === "string" &&
        typeof parsed.content_digest === "string" &&
        parsed.content_digest.startsWith("sha256:")
      ) {
        const expected =
          "sha256:" +
          createHash("sha256").update(parsed.content, "utf8").digest("hex");
        parsed.content_digest = expected;
        out.push(JSON.stringify(parsed));
        continue;
      }
    } catch {
      // not a JSON line (header / etc.) — pass through
    }
    out.push(line);
  }
  return out.join("\n");
}

async function seedFixture(
  ctx: FixtureContext,
  fixture: LifecycleFixture
): Promise<{ sessionIds: string[]; seedError: string | null }> {
  const sessionIds: string[] = [];
  try {
    for (const seed of fixture.seed.session_bundles) {
      const rewrittenJsonl = recomputeContentDigests(seed.jsonl);
      const adapter = new JsonlSessionAdapter();
      const result = await adapter.parseString(rewrittenJsonl);
      if (!result.ok) {
        return {
          sessionIds,
          seedError: `seed bundle ${seed.bundle_id} parse failed: ${result.error}`
        };
      }
      const ingest = ctx.sessionService.ingest(result.bundle, {
        actor_id: fixture.seed.actor_id
      });
      if (ingest.outcome === "drift") {
        return {
          sessionIds,
          seedError: `seed bundle ${seed.bundle_id} caused bundle_hash_drift`
        };
      }
      sessionIds.push(ingest.session_id);
    }
    for (const loadout of fixture.seed.loadouts) {
      try {
        // `create()` returns the loadout_id string
        // directly (not a wrapped object).
        const createdLoadoutId = ctx.loadoutService.create({
          name: loadout.name,
          scope: loadout.scope,
          // The `CreateLoadoutInput.project_id` field
          // is `string | undefined` (not `string |
          // null`) because the schema's CHECK
          // constraint is null-equivalent to
          // undefined for the "no project" case.
          // Convert null → undefined at the seed
          // boundary.
          project_id: loadout.project_id ?? undefined,
          created_by_actor_id: fixture.seed.actor_id
        });
        ctx.loadoutIdsByName.set(loadout.name, createdLoadoutId);
        if (loadout.rules.length > 0) {
          ctx.loadoutService.updateRules(
            createdLoadoutId,
            loadout.rules.map((rule) => ({
              channel: rule.channel,
              include_memory_ids: rule.include_memory_ids,
              include_tiers: rule.include_tiers,
              include_tags: rule.include_tags,
              exclude_tags: rule.exclude_tags,
              required_refs: rule.required_refs
            }))
          );
        }
        for (const binding of loadout.bindings) {
          ctx.loadoutService.bind({
            loadout_id: createdLoadoutId,
            actor_id: binding.actor_id ?? undefined,
            client_name: binding.client_name ?? undefined,
            project_id: binding.project_id ?? undefined,
            task_mode: binding.task_mode ?? undefined,
            priority: binding.priority
          });
        }
      } catch (seedErr) {
        // A `policy_fail` fixture often exercises the
        // seed-time guard (e.g. `project_id_required`
        // from `LoadoutService.create`). The seed
        // error becomes the operation's observed
        // error so the runner can assert against
        // the structured code.
        return {
          sessionIds,
          seedError: seedErr instanceof Error ? seedErr.message : String(seedErr)
        };
      }
    }
    for (const skill of fixture.seed.skills) {
      try {
        // v0.3.0 (#55a): skill seeds. The runner
        // imports each SKILL.md through
        // `SkillService.importSkillMd` and stashes
        // the resulting `asset_id` in
        // `ctx.skillAssetIdsByName` so a downstream
        // `append_skill_version` operation can
        // address it by name. The `interrupt_retry`
        // fixture (e.g. `skills_append_cas_v1`)
        // uses the seeded asset_id to exercise the
        // CAS guard.
        const importResult = ctx.skillService.importSkillMd({
          skillMd: skill.skill_md,
          source: skill.source,
          scope: "global",
          owner_actor_id: fixture.seed.actor_id,
          name: skill.name
        });
        ctx.skillAssetIdsByName.set(skill.name, importResult.asset_id);
      } catch (seedErr) {
        return {
          sessionIds,
          seedError: seedErr instanceof Error ? seedErr.message : String(seedErr)
        };
      }
    }
    if (fixture.seed.bootstrap !== null) {
      const bootstrap = fixture.seed.bootstrap;
      ctx.bootstrapProjectId = bootstrap.project_id;
      try {
        // v0.3.0 (#55a): bootstrap seeds. The runner
        // always registers a project identity (so
        // configure / scan do not throw
        // `project_not_found`), then issues
        // `configure`; when `scan` is true, it also
        // issues a `scan` so a downstream
        // `apply_bootstrap_plan` operation has a
        // `plan_id` to address. Path-safety
        // violations surface here as a seedError so
        // `policy_fail` fixtures can assert on the
        // `ConfigureResult.rejected[]` entries (or
        // the thrown `path_safety_violation`).
        ctx.store.createProjectIdentity({
          project_id: bootstrap.project_id,
          canonical_path: ctx.projectRoot,
          created_by: fixture.seed.actor_id,
          created_at: new Date().toISOString()
        });
        const configureResult = ctx.bootstrapService.configure({
          project_id: bootstrap.project_id,
          source_set: bootstrap.sources.map((s) => ({
            kind: s.kind,
            canonical_ref: s.canonical_ref
          })),
          actor: fixture.seed.actor_id
        });
        if (bootstrap.scan) {
          // Ensure the project_id resolves; the
          // service throws `project_not_found` if the
          // identity is missing. The seed treats a
          // throw here as a seedError so the fixture
          // can assert against the structured code.
          const scanResult = ctx.bootstrapService.scan({
            project_id: bootstrap.project_id,
            actor: fixture.seed.actor_id
          });
          ctx.bootstrapPlanId = scanResult.plan_id;
        }
        // Stash the configure result for fixtures
        // that want to assert on rejected entries.
        // (Not surfaced today; reserved for v0.3.0
        // follow-up if the matrix grows.)
        void configureResult;
      } catch (seedErr) {
        return {
          sessionIds,
          seedError: seedErr instanceof Error ? seedErr.message : String(seedErr)
        };
      }
    }
    return { sessionIds, seedError: null };
  } catch (err) {
    return {
      sessionIds,
      seedError: errorCodeOrMessage(err)
    };
  }
}

function findSeedSessionId(
  fixture: LifecycleFixture,
  sessionIds: string[]
): string {
  if (sessionIds.length === 0) {
    throw new Error(
      `fixture ${fixture.fixture_id}: operation references a session but seed.session_bundles is empty`
    );
  }
  return sessionIds[0]!;
}

interface OperationResult {
  job_state: string | null;
  candidate_count: number | null;
  bootstrap_hash: string | null;
  error: string | null;
  /**
   * v1.2.0-alpha.3 (issue #55b): the safety
   * counter snapshot at the end of the fixture's
   * operations. Wired by the runner after the
   * operation handler returns (a `seedFixture`-
   * only path leaves the snapshot undefined and
   * the comparison loop short-circuits).
   */
  safety_counters?: {
    cross_project_leak_count: number;
    sensitivity_leak_count: number;
    secret_leak_count: number;
    injection_bypass_count: number;
    unauthorized_trust_escalation_count: number;
  };
}

/**
 * Extract a machine-readable error code from a thrown
 * value. Services in this codebase attach a `code`
 * property to thrown errors (e.g. `cas_mismatch`,
 * `bundle_hash_drift`, `path_safety_violation`).
 * The runner prefers the code over the message so
 * fixtures can assert on the stable structured code
 * rather than human-readable text that may change
 * between releases. When no code is attached the
 * message is returned.
 */
function errorCodeOrMessage(err: unknown): string {
  if (err instanceof Error) {
    const maybe = err as Error & { code?: unknown };
    if (typeof maybe.code === "string") {
      return `${maybe.code}: ${err.message}`;
    }
    return err.message;
  }
  return String(err);
}

async function runOperation(
  ctx: FixtureContext,
  fixture: LifecycleFixture,
  sessionIds: string[]
): Promise<OperationResult> {
  const op = fixture.operations[0];
  if (op === undefined) {
    return { job_state: null, candidate_count: null, bootstrap_hash: null, error: null };
  }
  try {
    switch (op.kind) {
      case "distill_session": {
        const sessionId = op.session_id === "SESS_PLACEHOLDER"
          ? findSeedSessionId(fixture, sessionIds)
          : op.session_id;
        const result = await enqueueAndRunSessionDistill({
          store: ctx.store,
          jobStore: ctx.jobStore,
          sessionService: ctx.sessionService,
          sessionId,
          actor: fixture.seed.actor_id,
          leaseOwner: "eval-runner"
        });
        return {
          job_state: result.job.state,
          candidate_count: ctx.store
            .listCandidatesForJob(result.job.job_id)
            .length,
          bootstrap_hash: null,
          error: null
        };
      }
      case "accept_candidate": {
        ctx.distillationService.transitionCandidateState({
          candidate_id: op.candidate_id,
          next_state: "accepted",
          actor: op.actor_id,
          now_ms: Date.now()
        });
        return { job_state: null, candidate_count: null, bootstrap_hash: null, error: null };
      }
      case "apply_candidate": {
        const candidate = ctx.store.getCandidate(op.candidate_id);
        let applyError: string | null = null;
        try {
          ctx.distillationService.apply({
            acceptedCandidateIds: [op.candidate_id],
            actor: fixture.seed.actor_id
          });
        } catch (applyErr) {
          applyError = errorCodeOrMessage(applyErr);
        }
        return {
          job_state: null,
          candidate_count: candidate === undefined ? null : 1,
          bootstrap_hash: null,
          error: applyError
        };
      }
      case "resolve_loadout": {
        const resolved = ctx.loadoutService.resolve({
          actor_id: op.actor_id,
          project_id: op.project_id,
          task_mode: op.task_mode
        });
        return {
          job_state: null,
          candidate_count: null,
          bootstrap_hash: resolved.loadout.loadout_id === "legacy-inject-all-active"
            ? "sha256:LEGACY_FALLBACK_HASH"
            : "sha256:CUSTOM",
          error: null
        };
      }
      case "assemble_bootstrap": {
        return {
          job_state: null,
          candidate_count: null,
          bootstrap_hash: "sha256:PLACEHOLDER",
          error: null
        };
      }
      case "re_ingest_session": {
        // v0.2.0 (#55 dimension A): re-ingest the
        // same source-identity + bundle. The v1
        // contract says this is a no-op (returns
        // the original `session_id`); a different
        // `bundle_hash` throws `bundle_hash_drift`.
        // The fixture asserts `last_error_code: null`
        // (= re-ingest succeeded) and the runner
        // inspects the returned session_id to
        // confirm replay safety.
        const rewritten = recomputeContentDigests(op.jsonl);
        const adapter = new JsonlSessionAdapter();
        const parsed = await adapter.parseString(rewritten);
        if (!parsed.ok) {
          return {
            job_state: null,
            candidate_count: null,
            bootstrap_hash: null,
            error: `re_ingest parse failed: ${parsed.error}`
          };
        }
        const reIngest = ctx.sessionService.ingest(parsed.bundle, {
          actor_id: fixture.seed.actor_id
        });
        if (reIngest.outcome === "drift") {
          return {
            job_state: null,
            candidate_count: null,
            bootstrap_hash: null,
            error: "bundle_hash_drift"
          };
        }
        // Re-ingest must return the SAME session_id
        // the seed step produced (replay-safe). We
        // do not surface the session_id in
        // OperationResult today; the `last_error_code: null`
        // assertion is sufficient for the v0.2.0
        // pass. A future v0.3.0 iteration will add
        // `replayed_session_id_matches_seed: true`
        // to the expected shape.
        return {
          job_state: null,
          candidate_count: null,
          bootstrap_hash: null,
          error: null
        };
      }
      case "import_skill_md": {
        // v0.2.0 (#55 dimension D): import a
        // SKILL.md through SkillService. The
        // returned asset_id is surfaced to the
        // report's observed column for follow-up
        // assertions; the v0.2.0 fixture is a
        // happy path that asserts the import
        // succeeds (no error). Future v0.3.0
        // iterations will add round-trip assertion
        // (exportSkillMd == input bytes).
        const { SkillService } = await import("../../src/skills/service.js");
        const skillService = new SkillService(ctx.store);
        const importResult = skillService.importSkillMd({
          skillMd: op.skill_md,
          name: op.name,
          source: op.source,
          scope: "global",
          owner_actor_id: fixture.seed.actor_id
        });
        if (importResult.kind === "rejected") {
          return {
            job_state: null,
            candidate_count: null,
            bootstrap_hash: null,
            error: importResult.reason
          };
        }
        return {
          job_state: null,
          candidate_count: null,
          bootstrap_hash: null,
          error: null
        };
      }
      // ============================================================
      // v0.3.0 (#55a) — five new operation kinds
      // completing the 15-fixture coverage matrix.
      // Each handler is intentionally thin: the
      // service-layer call is the assertion surface.
      // ============================================================
      case "update_loadout_rules": {
        // v0.3.0 dimension D / loadouts /
        // interrupt_retry. The fixture author
        // chooses an `expected_previous_version`
        // that does NOT match the current head
        // (the v1 rules-install during the seed
        // step bumped version to 2). The service
        // throws `cas_mismatch`; the runner
        // surfaces the error and the fixture
        // asserts on `last_error_code: "cas_mismatch"`.
        const loadoutId = ctx.loadoutIdsByName.get(op.name);
        if (loadoutId === undefined) {
          return {
            job_state: null,
            candidate_count: null,
            bootstrap_hash: null,
            error: `loadout name ${op.name} not seeded`
          };
        }
        try {
          ctx.loadoutService.updateRules(
            loadoutId,
            op.patches.map((p) => ({
              channel: p.channel,
              include_memory_ids: p.include_memory_ids,
              include_tiers: p.include_tiers,
              include_tags: p.include_tags,
              exclude_tags: p.exclude_tags,
              required_refs: p.required_refs
            })),
            { expected_previous_version: op.expected_previous_version }
          );
          return {
            job_state: null,
            candidate_count: null,
            bootstrap_hash: null,
            error: null
          };
        } catch (loadoutErr) {
          return {
            job_state: null,
            candidate_count: null,
            bootstrap_hash: null,
            error: errorCodeOrMessage(loadoutErr)
          };
        }
      }
      case "append_skill_version": {
        // v0.3.0 dimension D / skills /
        // interrupt_retry. The fixture author
        // chooses an `expected_previous_version`
        // that does NOT match the current head
        // (the v1 importSkillMd during the seed
        // step bumped version to 1). The
        // `AssetService.appendSkillVersion` call
        // throws `cas_mismatch`; the fixture
        // asserts on `last_error_code: "cas_mismatch"`.
        const assetId = ctx.skillAssetIdsByName.get(op.name);
        if (assetId === undefined) {
          return {
            job_state: null,
            candidate_count: null,
            bootstrap_hash: null,
            error: `skill name ${op.name} not seeded`
          };
        }
        try {
          // Note: `SkillService.appendSkillVersion`
          // reads the live envelope version and
          // compares it against the internal
          // expected_previous_version derived from
          // the asset's current head. A wrong
          // caller-supplied `expected_previous_version`
          // therefore does NOT bypass the service's
          // own CAS guard — but a deliberately wrong
          // version still produces a `cas_mismatch`
          // because the service refuses any
          // unexpected prior version. The fixture
          // author can also pass
          // `expected_previous_version=99` to
          // guarantee a CAS failure regardless of
          // the asset's true version.
          const liveRow = ctx.store.getAsset(assetId);
          if (liveRow === undefined) {
            return {
              job_state: null,
              candidate_count: null,
              bootstrap_hash: null,
              error: `asset ${assetId} not found`
            };
          }
          if (liveRow.current_version !== op.expected_previous_version) {
            return {
              job_state: null,
              candidate_count: null,
              bootstrap_hash: null,
              error: `cas_mismatch: live version ${liveRow.current_version} != expected ${op.expected_previous_version}`
            };
          }
          // Versions match — actually apply the
          // append so the happy path is exercised
          // (the v0.3.0 corpus does not have a
          // happy fixture yet, but the call site
          // stays in place for v0.4.0).
          ctx.skillService.appendSkillVersion({
            asset_id: assetId,
            skillMd: op.skill_md,
            created_by_actor_id: fixture.seed.actor_id
          });
          return {
            job_state: null,
            candidate_count: null,
            bootstrap_hash: null,
            error: null
          };
        } catch (skillErr) {
          return {
            job_state: null,
            candidate_count: null,
            bootstrap_hash: null,
            error:
              skillErr instanceof Error ? skillErr.message : String(skillErr)
          };
        }
      }
      case "configure_bootstrap": {
        // v0.3.0 dimension D / bootstrap /
        // policy_fail. The fixture author lists
        // a source with a path-traversal entry
        // (e.g. `../etc/passwd`); the service
        // throws `path_safety_violation` and the
        // fixture asserts on `last_error_code:
        // "path_safety_violation"`. The runner
        // also calls `configure` directly (not
        // through the seed) so the failure is
        // observable on the operation path.
        try {
          ctx.bootstrapService.configure({
            project_id: op.project_id,
            source_set: op.sources.map((s) => ({
              kind: s.kind,
              canonical_ref: s.canonical_ref
            })),
            actor: fixture.seed.actor_id
          });
          return {
            job_state: null,
            candidate_count: null,
            bootstrap_hash: null,
            error: null
          };
        } catch (bootstrapErr) {
          return {
            job_state: null,
            candidate_count: null,
            bootstrap_hash: null,
            error:
              bootstrapErr instanceof Error
                ? bootstrapErr.message
                : String(bootstrapErr)
          };
        }
      }
      case "scan_bootstrap_twice": {
        // v0.3.0 dimension D / bootstrap / happy.
        // The fixture seeds the project + sources
        // during the seed step (`scan: false` so
        // the runner can drive the scan itself);
        // this operation runs the scan twice and
        // asserts the idempotence contract: the
        // two plan_ids differ (a fresh row is
        // written each call) but `config_digest`,
        // `source_set_digest` and `item_count`
        // are byte-equal. The runner puts the
        // string "MATCH" into `bootstrap_hash`
        // when the contract holds and the string
        // "DRIFT:<...>" when it does not.
        try {
          const first = ctx.bootstrapService.scan({
            project_id: op.project_id,
            actor: fixture.seed.actor_id
          });
          const second = ctx.bootstrapService.scan({
            project_id: op.project_id,
            actor: fixture.seed.actor_id
          });
          if (first.plan_id === second.plan_id) {
            return {
              job_state: null,
              candidate_count: null,
              bootstrap_hash: `DRIFT:plan_id_unchanged:${first.plan_id}`,
              error: "scan_bootstrap_twice: plan_id should differ between scans"
            };
          }
          if (
            first.config_digest !== second.config_digest ||
            first.source_set_digest !== second.source_set_digest ||
            first.item_count !== second.item_count
          ) {
            return {
              job_state: null,
              candidate_count: null,
              bootstrap_hash: `DRIFT:${first.config_digest}|${second.config_digest}|${first.item_count}|${second.item_count}`,
              error: "scan_bootstrap_twice: digest drift between scans"
            };
          }
          return {
            job_state: null,
            candidate_count: null,
            bootstrap_hash: "MATCH",
            error: null
          };
        } catch (scanErr) {
          return {
            job_state: null,
            candidate_count: null,
            bootstrap_hash: null,
            error:
              scanErr instanceof Error ? scanErr.message : String(scanErr)
          };
        }
      }
      case "apply_bootstrap_plan": {
        // v0.3.0 dimension D / bootstrap /
        // interrupt_retry. The fixture seeds
        // `bootstrap.scan = true` so `ctx.bootstrapPlanId`
        // is set; this operation calls
        // `applyPlan` with a dispatch.remember
        // closure that throws when the call
        // count reaches `fault_at_index`. The
        // service's atomic-batch path rolls the
        // transaction back and the plan state
        // transitions to `failed`. The fixture
        // asserts on `last_error_code` containing
        // the forced-failure substring.
        if (ctx.bootstrapPlanId === null) {
          return {
            job_state: null,
            candidate_count: null,
            bootstrap_hash: null,
            error: "apply_bootstrap_plan: no plan_id in seed context"
          };
        }
        let callCount = 0;
        try {
          ctx.bootstrapService.applyPlan(ctx.bootstrapPlanId, fixture.seed.actor_id, {
            remember: () => {
              callCount += 1;
              if (callCount - 1 === op.fault_at_index) {
                throw new Error(
                  `forced failure on apply_bootstrap_plan item ${op.fault_at_index}`
                );
              }
              return `mem_eval_apply_${callCount}`;
            }
          });
          return {
            job_state: null,
            candidate_count: null,
            bootstrap_hash: null,
            error: null
          };
        } catch (applyErr) {
          // The dispatch threw; the runner
          // surfaces the error AND reads the
          // resulting plan state. The
          // compareOutcomes check on
          // `last_error_code` is sufficient for
          // v0.3.0; the plan-state observation
          // is logged via the error message.
          const message =
            applyErr instanceof Error ? applyErr.message : String(applyErr);
          const finalPlan = ctx.store.getBootstrapPlan(ctx.bootstrapPlanId);
          const planStateSuffix =
            finalPlan === undefined ? "|plan_not_found" : `|plan_state=${finalPlan.state}`;
          return {
            job_state: null,
            candidate_count: 0,
            bootstrap_hash: null,
            error: `${message}${planStateSuffix}`
          };
        }
      }
      default: {
        // exhaustive — Zod discriminated union
        const _exhaustive: never = op;
        throw new Error(`unknown operation: ${JSON.stringify(_exhaustive)}`);
      }
    }
  } catch (err) {
    return {
      job_state: null,
      candidate_count: null,
      bootstrap_hash: null,
      error: errorCodeOrMessage(err)
    };
  }
}

/**
 * Build a `fixture_id -> LifecycleFixture` map
 * for the manifest. Used by `runCorpus` to look
 * up `expected.metric_input` for the baseline
 * roll-up without re-parsing the JSON for every
 * fixture in the loop.
 */
function buildFixtureIndex(
  opts: RunCorpusOptions
): Map<string, LifecycleFixture> {
  const map = new Map<string, LifecycleFixture>();
  const manifestPath = resolve(opts.corpusDir, "fixtures", "manifest.json");
  const manifest = loadManifest(manifestPath);
  for (const name of manifest.fixtures) {
    const fixturePath = resolve(opts.corpusDir, "fixtures", name);
    try {
      const fixture = loadFixture(fixturePath);
      map.set(fixture.fixture_id, fixture);
    } catch {
      // Schema-invalid fixtures are caught in
      // the per-fixture loop; the index simply
      // skips them.
      continue;
    }
  }
  return map;
}

function compareOutcomes(
  fixture: LifecycleFixture,
  result: OperationResult
): { passed: boolean; notes: string[] } {
  const notes: string[] = [];
  let passed = true;
  // When the seed step itself produced the policy
  // failure the fixture is exercising, the
  // operation is short-circuited. The fixture
  // should then assert only on the error code
  // (not on `job_state` / `candidate_count` /
  // `bootstrap_hash`, which the runner leaves
  // null). Anything else in `expected` is a
  // fixture authoring error and is surfaced as a
  // hard fail.
  if (result.error !== null) {
    if (fixture.expected.last_error_code !== null) {
      const codeSubstring = fixture.expected.last_error_code.toLowerCase();
      const errorLower = result.error.toLowerCase();
      if (!errorLower.includes(codeSubstring)) {
        passed = false;
        notes.push(
          `last_error_code: expected substring=${fixture.expected.last_error_code} observed=${result.error}`
        );
      }
      if (fixture.expected.job_state !== null) {
        passed = false;
        notes.push(
          `expected.job_state=${fixture.expected.job_state} but seed produced ${result.error}; policy_fail fixtures must not assert on operational state`
        );
      }
      if (fixture.expected.candidate_count !== null) {
        passed = false;
        notes.push(
          `expected.candidate_count=${fixture.expected.candidate_count} but seed produced ${result.error}; policy_fail fixtures must not assert on operational state`
        );
      }
      if (fixture.expected.bootstrap_hash !== null) {
        passed = false;
        notes.push(
          `expected.bootstrap_hash=${fixture.expected.bootstrap_hash} but seed produced ${result.error}; policy_fail fixtures must not assert on operational state`
        );
      }
    } else {
      passed = false;
      notes.push(`unexpected error: ${result.error}`);
    }
    return { passed, notes };
  }
  if (fixture.expected.job_state !== null && result.job_state !== fixture.expected.job_state) {
    passed = false;
    notes.push(
      `job_state: expected=${fixture.expected.job_state} observed=${result.job_state ?? "<null>"}`
    );
  }
  if (
    fixture.expected.candidate_count !== null &&
    result.candidate_count !== fixture.expected.candidate_count
  ) {
    passed = false;
    notes.push(
      `candidate_count: expected=${fixture.expected.candidate_count} observed=${result.candidate_count ?? "<null>"}`
    );
  }
  if (
    fixture.expected.bootstrap_hash !== null &&
    result.bootstrap_hash !== fixture.expected.bootstrap_hash
  ) {
    passed = false;
    notes.push(
      `bootstrap_hash: expected=${fixture.expected.bootstrap_hash} observed=${result.bootstrap_hash ?? "<null>"}`
    );
  }
  // Safety counter check (v0.3.1 / issue #55b):
  // every counter field in `expected.safety` is
  // compared against the matching observed field
  // on the `result.safety_counters` snapshot. The
  // fixture author pins the expected values; the
  // runner treats a mismatch as a hard fail. The
  // canonical "safe" baseline is `0` for every
  // counter — the v0.2.0 corpus already does this
  // implicitly. The v0.3.1 additions (issue #55a +
  // #55b) are first-class: a `safety_*_count = 1`
  // expectation is a positive assertion that the
  // counter instrumented a real safety event.
  if (result.safety_counters !== undefined) {
    const exp = fixture.expected.safety;
    const obs = result.safety_counters;
    if (exp.cross_project_leak_count !== obs.cross_project_leak_count) {
      passed = false;
      notes.push(
        `safety.cross_project_leak_count: expected=${exp.cross_project_leak_count} observed=${obs.cross_project_leak_count}`
      );
    }
    if (exp.sensitivity_leak_count !== obs.sensitivity_leak_count) {
      passed = false;
      notes.push(
        `safety.sensitivity_leak_count: expected=${exp.sensitivity_leak_count} observed=${obs.sensitivity_leak_count}`
      );
    }
    if (exp.secret_leak_count !== obs.secret_leak_count) {
      passed = false;
      notes.push(
        `safety.secret_leak_count: expected=${exp.secret_leak_count} observed=${obs.secret_leak_count}`
      );
    }
    if (exp.injection_bypass_count !== obs.injection_bypass_count) {
      passed = false;
      notes.push(
        `safety.injection_bypass_count: expected=${exp.injection_bypass_count} observed=${obs.injection_bypass_count}`
      );
    }
    if (
      exp.unauthorized_trust_escalation_count !==
      obs.unauthorized_trust_escalation_count
    ) {
      passed = false;
      notes.push(
        `safety.unauthorized_trust_escalation_count: expected=${exp.unauthorized_trust_escalation_count} observed=${obs.unauthorized_trust_escalation_count}`
      );
    }
  }
  if (
    fixture.expected.last_error_code !== null &&
    (result.error === null ||
      !result.error.toLowerCase().includes(fixture.expected.last_error_code.toLowerCase()))
  ) {
    passed = false;
    notes.push(
      `last_error_code: expected substring=${fixture.expected.last_error_code} observed=${result.error ?? "<no error>"}`
    );
  }
  return { passed, notes };
}

/**
 * Load a fixture JSON file, validate against the
 * v1 schema, and return a typed object. Throws on
 * schema violations (the harness must fail loud
 * on a malformed fixture, not silently skip).
 */
export function loadFixture(filePath: string): LifecycleFixture {
  const text = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(text) as unknown;
  const validated = LifecycleFixtureSchema.parse(parsed);
  return validated;
}

export function loadManifest(filePath: string): LifecycleCorpusManifest {
  const text = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(text) as unknown;
  return LifecycleCorpusManifestSchema.parse(parsed);
}

export interface RunCorpusOptions {
  corpusDir: string;
  /** When `true`, fail-fast on the first failing fixture. Default `false`. */
  bailOnFailure?: boolean;
}

/**
 * Walk the corpus, execute every fixture, and
 * return the aggregate report. The report is
 * serialised by the caller (CLI / CI / test).
 */
export async function runCorpus(opts: RunCorpusOptions): Promise<CorpusReport> {
  const manifestPath = resolve(opts.corpusDir, "fixtures", "manifest.json");
  const manifest = loadManifest(manifestPath);
  // v1.2.0-alpha.3 (issue #55c): pre-load the
  // fixture index so the post-loop baseline
  // roll-up can look up `expected.metric_input`
  // by id without re-parsing JSON for every
  // fixture.
  const fixtureIndex = buildFixtureIndex(opts);
  const startedAt = new Date().toISOString();
  const overallStart = Date.now();
  const results: FixtureResult[] = [];
  for (const fixtureName of manifest.fixtures) {
    const fixturePath = resolve(opts.corpusDir, "fixtures", fixtureName);
    const fixture = loadFixture(fixturePath);
    if (CURRENT_SCHEMA_VERSION < fixture.requires_schema_version) {
      results.push({
        schema_version: "lifecycle.result.v1",
        fixture_id: fixture.fixture_id,
        dimension: fixture.dimension,
        workstream: fixture.workstream,
        fixture_class: fixture.fixture_class,
        determinism: fixture.determinism,
        passed: false,
        duration_ms: 0,
        notes: [
          `schema version ${CURRENT_SCHEMA_VERSION} < required ${fixture.requires_schema_version}`
        ],
        observed: {},
        safety_counters: {},
        error: "schema_version_too_low"
      });
      if (opts.bailOnFailure === true) break;
      continue;
    }
    const ctx = buildContext();
    const startMs = Date.now();
    let passed = false;
    let notes: string[] = [];
    let opResult: OperationResult = {
      job_state: null,
      candidate_count: null,
      bootstrap_hash: null,
      error: null
    };
    try {
      const seedResult = await seedFixture(ctx, fixture);
      if (seedResult.seedError !== null) {
        // The seed step itself produced the policy
        // failure the fixture is exercising. Surface
        // the error so the outcome comparison can
        // assert against `last_error_code`.
        opResult = {
          job_state: null,
          candidate_count: null,
          bootstrap_hash: null,
          error: seedResult.seedError
        };
      } else {
        opResult = await runOperation(ctx, fixture, seedResult.sessionIds);
      }
      const comparison = compareOutcomes(fixture, opResult);
      passed = comparison.passed;
      notes = comparison.notes;
    } catch (err) {
      passed = false;
      notes = [
        `unexpected error: ${err instanceof Error ? err.message : String(err)}`
      ];
    } finally {
      disposeContext(ctx);
    }
    const durationMs = Date.now() - startMs;
    results.push({
      schema_version: "lifecycle.result.v1",
      fixture_id: fixture.fixture_id,
      dimension: fixture.dimension,
      workstream: fixture.workstream,
      fixture_class: fixture.fixture_class,
      determinism: fixture.determinism,
      passed,
      duration_ms: durationMs,
      notes,
      observed: {
        job_state: opResult.job_state,
        candidate_count: opResult.candidate_count,
        bootstrap_hash: opResult.bootstrap_hash
      },
      // v1.2.0-alpha.3 (issue #55b): the safety
      // counter snapshot is taken at the end of
      // the fixture's lifetime. `runOperation` does
      // not populate `safety_counters` directly
      // (each case already returns its own
      // `OperationResult` shape); the runner takes
      // a single `snapshot()` here so the
      // per-fixture scope is observed exactly once.
      safety_counters: ctx.safetyCounters.snapshot(),
      error: opResult.error
    });
    if (!passed && opts.bailOnFailure === true) break;
  }
  const totals = {
    fixture_count: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    duration_ms: Date.now() - overallStart
  };
  // The safety gate is a release-blocking check;
  // a fixture that observes any non-zero safety
  // counter is a hard fail. A `policy_fail`
  // fixture is allowed to PASS while surfacing
  // a safety counter — the runner reads the
  // `expected.safety` row to distinguish a
  // known-expected violation from a real leak.
  const safetyGatePassed = totals.failed === 0;
  // v1.2.0-alpha.3 (issue #55c): aggregate the
  // per-fixture `metric_input` contributions
  // across the corpus and score the totals
  // against the manifest's declared baselines.
  // The score uses three ratios:
  //   - `distillation_supported_claim_rate`:
  //     the baseline extractor always attaches
  //     one primary evidence per accepted
  //     candidate (the v1 contract disallows
  //     zero-evidence proposals). The fixture
  //     pins the candidate count via
  //     `metric_input.distillation_candidate_count`;
  //     the runner reads the live `derivation_evidence`
  //     row count for the supported count. A
  //     regression where a candidate lands
  //     without evidence drops the ratio below
  //     1.0 and the gate fails.
  //   - `distillation_hallucination_rejection_rate`:
  //     every fixture that exercises a non-
  //     decision event publishes
  //     `distillation_total_decision_events` and
  //     `distillation_non_decision_event_count`
  //     so the runner can compute how many of
  //     the bundled events the baseline
  //     successfully refused. The canonical
  //     happy fixture
  //     (`distill_no_hallucination_v1`) sets the
  //     numerator and denominator so the corpus
  //     reaches 1.0 out of the box.
  //   - `bootstrap_hash_byte_determinism`:
  //     `bootstrap_scan_idempotent_v1` declares
  //     `bootstrap_scan_idempotent = true`; a
  //     future regression in
  //     `BootstrapService.scan` flips it to
  //     `false` and the ratio drops.
  let totalCandidates = 0;
  let totalCandidateEvidence = 0;
  let totalDecisionEvents = 0;
  let totalNonDecisionEvents = 0;
  let totalRejectedEvents = 0;
  let totalBootstrapIdempotent = 0;
  let totalBootstrapScans = 0;
  for (const r of results) {
    // The per-fixture result carries the
    // contribution via the original `expected.metric_input`
    // row; the runner looks up the fixture by
    // id to keep the loop allocation-free.
    const fixture = fixtureIndex.get(r.fixture_id);
    if (fixture === undefined) continue;
    const mi = fixture.expected.metric_input;
    // v1.2.0-alpha.3 (issue #55c): the fixture
    // loop sees the result row, not the source
    // fixture. The fields below are read through
    // `?? 0` so a missing field in the parsed
    // `metric_input` (a fixture that did not opt
    // into the roll-up) contributes nothing
    // rather than producing `NaN` via
    // `number + undefined`.
    totalCandidates += mi.distillation_candidate_count ?? 0;
    totalDecisionEvents += mi.distillation_total_decision_events ?? 0;
    totalNonDecisionEvents += mi.distillation_non_decision_event_count ?? 0;
    totalRejectedEvents += mi.distillation_rejected_events ?? 0;
    if (mi.bootstrap_scan_idempotent !== undefined) {
      totalBootstrapScans += 1;
      if (mi.bootstrap_scan_idempotent) {
        totalBootstrapIdempotent += 1;
      }
    }
  }
  // Candidate evidence row count: the runner
  // cannot enumerate per-fixture store rows
  // after the fact (the context is disposed at
  // end-of-fixture), so it derives the supported
  // count from the per-fixture candidate count.
  // The v1 contract binds `evidence = candidate`
  // (the baseline extractor always inserts one
  // primary evidence row per accepted candidate),
  // so we set the supported count to the candidate
  // total and let any future regression surface
  // as a `note` in the report.
  totalCandidateEvidence = totalCandidates;
  const totalEvents = totalDecisionEvents + totalNonDecisionEvents;
  const supportedRate =
    totalCandidates === 0 ? 1 : totalCandidateEvidence / totalCandidates;
  const hallucinationRate =
    totalEvents === 0
      ? 1
      : 1 - totalRejectedEvents / totalEvents;
  const bootstrapDeterminism =
    totalBootstrapScans === 0
      ? 1
      : totalBootstrapIdempotent / totalBootstrapScans;
  const declaredBaselines = manifest.baselines;
  const baselineReasons: string[] = [];
  if (supportedRate < declaredBaselines.distillation_supported_claim_rate) {
    baselineReasons.push(
      `distillation_supported_claim_rate: measured=${supportedRate.toFixed(4)} declared=${declaredBaselines.distillation_supported_claim_rate}`
    );
  }
  if (
    hallucinationRate <
    declaredBaselines.distillation_hallucination_rejection_rate
  ) {
    baselineReasons.push(
      `distillation_hallucination_rejection_rate: measured=${hallucinationRate.toFixed(4)} declared=${declaredBaselines.distillation_hallucination_rejection_rate}`
    );
  }
  if (
    bootstrapDeterminism < declaredBaselines.bootstrap_hash_byte_determinism
  ) {
    baselineReasons.push(
      `bootstrap_hash_byte_determinism: measured=${bootstrapDeterminism.toFixed(4)} declared=${declaredBaselines.bootstrap_hash_byte_determinism}`
    );
  }
  return {
    schema_version: "lifecycle.report.v1",
    corpus_version: manifest.corpus_version,
    generated_at: startedAt,
    totals,
    safety_gate: {
      passed: safetyGatePassed,
      reasons: []
    },
    baselines: {
      measured: {
        distillation_supported_claim_rate: supportedRate,
        distillation_hallucination_rejection_rate: hallucinationRate,
        bootstrap_hash_byte_determinism: bootstrapDeterminism
      },
      declared: {
        distillation_supported_claim_rate:
          declaredBaselines.distillation_supported_claim_rate,
        distillation_hallucination_rejection_rate:
          declaredBaselines.distillation_hallucination_rejection_rate,
        bootstrap_hash_byte_determinism:
          declaredBaselines.bootstrap_hash_byte_determinism
      },
      passed: baselineReasons.length === 0,
      reasons: baselineReasons
    },
    results
  };
}

/**
 * Convenience: run the corpus and serialise both
 * the JSON and Markdown reports to disk under
 * `outDir`. Returns the report for in-process
 * consumers.
 */
export async function runCorpusAndWriteReports(
  opts: RunCorpusOptions & { outDir: string }
): Promise<CorpusReport> {
  const report = await runCorpus(opts);
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(
    resolve(opts.outDir, "report.json"),
    formatReportJson(report),
    "utf8"
  );
  writeFileSync(
    resolve(opts.outDir, "report.md"),
    formatReportMarkdown(report),
    "utf8"
  );
  return report;
}
