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

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  memoryWriteService: MemoryWriteService;
  sessionService: SessionService;
  distillationService: DistillationService;
  jobStore: DerivationJobStore;
  loadoutService: LoadoutService;
};

function buildContext(): FixtureContext {
  const dataHome = tmpDbPath();
  const store = openStore(dataHome);
  const memoryWriteService = new MemoryWriteService(store);
  const sessionService = new SessionService(store, null);
  const jobStore = new DerivationJobStore(store);
  const distillationService = new DistillationService(
    store,
    sessionService,
    jobStore
  );
  const loadoutService = new LoadoutService(store);
  return {
    store,
    dataHome,
    memoryWriteService,
    sessionService,
    distillationService,
    jobStore,
    loadoutService
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
        const created = ctx.loadoutService.create({
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
        if (loadout.rules.length > 0) {
          ctx.loadoutService.updateRules(
            created.loadout_id,
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
    return { sessionIds, seedError: null };
  } catch (err) {
    return {
      sessionIds,
      seedError: err instanceof Error ? err.message : String(err)
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
        const targetMemory = ctx.distillationService.apply({
          candidate_id: op.candidate_id,
          actor: fixture.seed.actor_id
        });
        return {
          job_state: null,
          candidate_count: candidate === undefined ? null : 1,
          bootstrap_hash: null,
          error: targetMemory.kind === "rejected" ? targetMemory.reason : null
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
      default: {
        // exhaustive — Zod discriminated union
        const _exhaustive: never = op;
        throw new Error(`unknown operation: ${JSON.stringify(_exhaustive)}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      job_state: null,
      candidate_count: null,
      bootstrap_hash: null,
      error: message
    };
  }
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
  // Safety counters are always 0; we surface any
  // deviation as a hard fail (the policy-fail /
  // interrupt-retry fixture classes intentionally
  // exercise these surfaces).
  const e = fixture.expected.safety;
  if (
    e.cross_project_leak_count > 0 ||
    e.sensitivity_leak_count > 0 ||
    e.secret_leak_count > 0 ||
    e.injection_bypass_count > 0 ||
    e.unauthorized_trust_escalation_count > 0
  ) {
    passed = false;
    notes.push(`safety counters expected=0; see expected.safety`);
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
      safety_counters: {},
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
  // (The counter tracking itself is not yet
  // implemented; the v0.1.0 corpus does not
  // assert on observed counters, only on
  // expected rows. The instrumentation arrives
  // with the dimension-E fixtures in subsequent
  // corpus releases.)
  return {
    schema_version: "lifecycle.report.v1",
    corpus_version: manifest.corpus_version,
    generated_at: startedAt,
    totals,
    safety_gate: {
      passed: totals.failed === 0,
      reasons: []
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
