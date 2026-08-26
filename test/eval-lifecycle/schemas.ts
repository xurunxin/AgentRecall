// test/eval-lifecycle/schemas.ts
//
// v1.2.0-alpha.2 (issue #55): the wire schemas for the
// lifecycle evaluation harness. A fixture is a
// self-contained scenario: pre-populated data +
// operations to perform + expected outcomes. The
// runner loads fixtures, executes the operations
// against an in-process memory store, and compares
// the resulting state to the expected outcomes.
// Safety / isolation / atomicity invariants are
// checked as numeric counters; quality metrics
// are scored against the documented baselines.
//
// The wire format is versioned via
// `schema_version: "lifecycle.eval.v1"`. A v2 can
// add fields additively without breaking v1
// consumers (the runner ignores unknown fields).

import { z } from "zod";

/**
 * The five evaluation dimensions from issue #55
 * `## Evaluation dimensions`. Each fixture is
 * tagged with the dimension it exercises; a single
 * fixture can exercise multiple dimensions.
 */
export const EVALUATION_DIMENSIONS = [
  "A.ingestion",
  "B.derivation",
  "C.recall_assembly",
  "D.assets_skills_bootstrap",
  "E.safety_resilience"
] as const;

export const LifecycleDimensionSchema = z.enum(EVALUATION_DIMENSIONS);

/**
 * The four v1.2 workstreams. A fixture is also
 * tagged with the workstream it exercises so the
 * phase-2 coverage matrix is explicit (per #55
 * AC: "Every v1.2 workstream has at least one
 * happy-path, policy-failure and interruption/retry
 * fixture").
 */
export const WORKSTREAMS = [
  "ingestion",
  "distillation",
  "loadouts",
  "skills",
  "bootstrap"
] as const;

export const WorkstreamSchema = z.enum(WORKSTREAMS);

/**
 * The three classes of fixture that #55 AC
 * requires per workstream: a happy-path, a
 * policy-failure, and an interruption / retry
 * scenario. Every fixture is exactly one class;
 * the runner computes coverage matrix from
 * `(workstream, class)` pairs.
 */
export const FIXTURE_CLASSES = ["happy", "policy_fail", "interrupt_retry"] as const;

export const FixtureClassSchema = z.enum(FIXTURE_CLASSES);

/**
 * Determinism flag. A `deterministic` fixture MUST
 * produce byte-identical results across reruns
 * (same db path, same env, same node version).
 * `stochastic` fixtures may produce a small
 * variance (e.g. when a provider-backed extractor
 * is wired in) and the runner reports mean /
 * variance in addition to raw artifacts.
 */
export const DETERMINISM_KINDS = ["deterministic", "stochastic"] as const;
export const DeterminismKindSchema = z.enum(DETERMINISM_KINDS);

/**
 * Pre-populated data the runner materialises into
 * a fresh in-process memory store before executing
 * the operations. The runner is responsible for
 * applying these seeds via the same service-layer
 * APIs a real agent would call.
 */
export const FixtureSeedSchema = z.object({
  /**
   * Optional actor identity. Defaults to
   * `agent:eval-fixture` when omitted.
   */
  actor_id: z.string().default("agent:eval-fixture"),
  /**
   * Optional project identity. Defaults to
   * `null` (global scope) when omitted.
   */
  project_id: z.string().nullable().default(null),
  /**
   * Pre-populated memories. The runner inserts
   * these as the first step so the operations
   * have something to query / mutate.
   */
  memories: z
    .array(
      z.object({
        id: z.string(),
        tier: z.enum(["core", "working", "archival"]),
        title: z.string(),
        body: z.string(),
        pinned: z.boolean().default(false),
        tags: z.array(z.string()).default([]),
        trust_level: z.enum(["inferred", "agent_observed", "user_confirmed"]).default("agent_observed"),
        sensitivity: z.enum(["normal", "private", "restricted"]).default("normal")
      })
    )
    .default([]),
  /**
   * Pre-populated loadouts. Created via
   * `LoadoutService.create`. The rules array is
   * applied via `updateRules` (CAS-bumps version).
   */
  loadouts: z
    .array(
      z.object({
        name: z.string(),
        scope: z.enum(["global", "project"]),
        project_id: z.string().nullable().default(null),
        rules: z
          .array(
            z.object({
              channel: z.enum(["bootstrap", "query", "tool_only"]),
              max_items: z.number().int().positive().default(32),
              max_chars: z.number().int().positive().default(8000),
              include_memory_ids: z.array(z.string()).default([]),
              include_tiers: z.array(z.enum(["core", "working", "archival"])).default([]),
              include_tags: z.array(z.string()).default([]),
              exclude_tags: z.array(z.string()).default([]),
              required_refs: z.array(z.string()).default([])
            })
          )
          .default([]),
        /**
         * Bindings to attach to the loadout after
         * the create + updateRules steps. The
         * happy-path resolve fixture uses these
         * to exercise the 4-step resolve cascade.
         */
        bindings: z
          .array(
            z.object({
              actor_id: z.string().nullable().default(null),
              client_name: z.string().nullable().default(null),
              project_id: z.string().nullable().default(null),
              task_mode: z.string().nullable().default(null),
              priority: z.number().int().default(0)
            })
          )
          .default([])
      })
    )
    .default([]),
  /**
   * Pre-populated session bundles. Created via
   * `SessionService.ingest` from the in-process
   * `JsonlSessionAdapter`. The bundle is given
   * as a normalised JSONL string for v1; future
   * versions can switch to typed `SessionBundleV1`.
   */
  session_bundles: z
    .array(
      z.object({
        bundle_id: z.string(),
        source_kind: z.string(),
        source_session_id: z.string(),
        jsonl: z.string()
      })
    )
    .default([]),
  /**
   * Optional bootstrap seed. When present, the
   * runner calls `BootstrapService.configure` with
   * the listed sources; when `scan` is true, a
   * follow-up `scan` writes a fresh `plan_id`
   * into the fixture context so a downstream
   * operation (`apply_bootstrap_plan`) can address
   * it. The project_id must match a project the
   * store already knows about (the fixture's seed
   * is the only consumer; the runner does not
   * auto-create project identities).
   */
  bootstrap: z
    .object({
      project_id: z.string(),
      scan: z.boolean().default(false),
      sources: z
        .array(
          z.object({
            kind: z.enum(["file", "external_ref"]),
            canonical_ref: z.string()
          })
        )
        .min(1)
    })
    .nullable()
    .default(null),
  /**
   * Pre-populated skill imports. Each entry is
   * forwarded to `SkillService.importSkillMd`; the
   * resulting `asset_id` is stashed in the
   * fixture context so a downstream operation
   * (e.g. `append_skill_version`) can target it
   * by name.
   */
  skills: z
    .array(
      z.object({
        name: z.string(),
        skill_md: z.string(),
        source: z.enum(["manual", "derived", "imported"]).default("manual")
      })
    )
    .default([])
});

/**
 * The ordered operations the runner executes
 * against the in-process memory store. Each
 * operation maps to a real CLI / service call;
 * the runner does NOT bypass the public surface.
 */
export const FixtureOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("distill_session"),
    session_id: z.string()
  }),
  z.object({
    kind: z.literal("accept_candidate"),
    candidate_id: z.string(),
    actor_id: z.string().default("agent:eval-fixture")
  }),
  z.object({
    kind: z.literal("apply_candidate"),
    candidate_id: z.string()
  }),
  z.object({
    kind: z.literal("resolve_loadout"),
    actor_id: z.string(),
    project_id: z.string().nullable().default(null),
    task_mode: z.string().nullable().default(null)
  }),
  z.object({
    kind: z.literal("assemble_bootstrap"),
    loadout_id: z.string(),
    actor_id: z.string()
  }),
  z.object({
    kind: z.literal("re_ingest_session"),
    /**
     * The JSONL body of the session bundle to
     * re-ingest. The runner re-computes the
     * content digests so the v1 contract
     * (digest = sha256(body)) holds. The seed
     * step must have already ingested the same
     * source-identity for the re-ingest to be
     * a no-op (`bundle_hash_drift` would throw).
     */
    jsonl: z.string()
  }),
  z.object({
    kind: z.literal("import_skill_md"),
    /**
     * The full canonical SKILL.md body. The
     * runner passes it to
     * `SkillService.importSkillMd` and asserts
     * the resulting `asset_id` / `version`
     * come back. Used by the v0.2.0 skills
     * import-roundtrip happy fixture.
     */
    skill_md: z.string(),
    name: z.string(),
    source: z.enum(["manual", "derived", "imported"]).default("manual")
  }),
  // ============================================================
  // v0.3.0 (#55a) — additional operations for the
  // 15-fixture coverage matrix. Each new operation
  // pairs with a fixture class (happy /
  // policy_fail / interrupt_retry) so the runner
  // can exercise CAS guards, secret scans and
  // path-safety rejection without taking CLI
  // shortcuts.
  // ============================================================
  z.object({
    kind: z.literal("update_loadout_rules"),
    /**
     * The loadout name to address. The runner
     * resolves the name to a loadout_id through
     * the seed context (loadouts are seeded by
     * name in `seed.loadouts[]`).
     */
    name: z.string(),
    patches: z
      .array(
        z.object({
          channel: z.enum(["bootstrap", "query", "tool_only"]),
          max_items: z.number().int().positive().default(32),
          max_chars: z.number().int().positive().default(8000),
          include_memory_ids: z.array(z.string()).default([]),
          include_tiers: z.array(z.enum(["core", "working", "archival"])).default([]),
          include_tags: z.array(z.string()).default([]),
          exclude_tags: z.array(z.string()).default([]),
          required_refs: z.array(z.string()).default([])
        })
      )
      .min(1),
    /**
     * The CAS guard value. A wrong value
     * (deliberately chosen by `interrupt_retry`
     * fixtures) makes the service throw
     * `cas_mismatch`; the runner surfaces the
     * error in `result.error`.
     */
    expected_previous_version: z.number().int().nonnegative()
  }),
  z.object({
    kind: z.literal("append_skill_version"),
    /**
     * The skill name to address. The runner
     * resolves the name to an `asset_id` through
     * the seed context (skills are imported by
     * name in `seed.skills[]`).
     */
    name: z.string(),
    skill_md: z.string(),
    /**
     * CAS on the asset envelope. A wrong value
     * (deliberately chosen by `interrupt_retry`
     * fixtures) makes `AssetService.appendSkillVersion`
     * throw `cas_mismatch`.
     */
    expected_previous_version: z.number().int().nonnegative()
  }),
  z.object({
    kind: z.literal("configure_bootstrap"),
    project_id: z.string(),
    sources: z
      .array(
        z.object({
          kind: z.enum(["file", "external_ref"]),
          canonical_ref: z.string()
        })
      )
      .min(1)
  }),
  z.object({
    kind: z.literal("scan_bootstrap_twice"),
    project_id: z.string()
  }),
  z.object({
    kind: z.literal("apply_bootstrap_plan"),
    /**
     * Inject a forced failure when the dispatch
     * `remember` closure is called for the
     * Nth time. `0` means fail on the first
     * `remember` call. The runner reads the
     * plan_id from the seed context.
     */
    fault_at_index: z.number().int().nonnegative()
  })
]);

/**
 * Expected outcomes. The runner compares the
 * post-operation state to these expectations
 * and emits a per-fixture pass / fail result.
 */
export const ExpectedOutcomesSchema = z.object({
  /**
   * The expected terminal job state after all
   * operations. `null` means the job is not
   * expected to be touched by this fixture.
   */
  job_state: z.enum([
    "succeeded",
    "failed",
    "queued",
    "running",
    "cancelled"
  ]).nullable().default(null),
  /**
   * The expected candidate count for the job
   * (or `null` when no candidates are expected).
   * Used by #55 dimension B (derivation quality).
   */
  candidate_count: z.number().int().nonnegative().nullable().default(null),
  /**
   * The expected assembled bootstrap output
   * (text or selected_ids). Used by dimension C
   * (recall + assembly).
   */
  bootstrap_hash: z.string().nullable().default(null),
  /**
   * Safety counters (#55 dimension E). Every
   * counter MUST be exactly 0 for the release
   * gate to pass.
   */
  safety: z
    .object({
      cross_project_leak_count: z.number().int().nonnegative().default(0),
      sensitivity_leak_count: z.number().int().nonnegative().default(0),
      secret_leak_count: z.number().int().nonnegative().default(0),
      injection_bypass_count: z.number().int().nonnegative().default(0),
      unauthorized_trust_escalation_count: z.number().int().nonnegative().default(0)
    })
    .default({}),
  /**
   * Optional explicit error code expected from
   * the last operation (e.g. `cas_mismatch`,
   * `project_id_required`). When set, the runner
   * asserts the operation exits with this code.
   * Used by `policy_fail` and `interrupt_retry`
   * fixtures.
   */
  last_error_code: z.string().nullable().default(null)
});

/**
 * One fixture, the atomic unit of the harness. A
 * fixture is a single self-contained scenario
 * that exercises one or more evaluation
 * dimensions and asserts on the post-operation
 * state. Fixtures are versioned via
 * `corpus_version` so a v2 corpus can ship
 * alongside v1 and the runner reports coverage
 * per version.
 */
export const LifecycleFixtureSchema = z.object({
  schema_version: z.literal("lifecycle.eval.v1"),
  fixture_id: z.string().min(3).regex(/^[a-z0-9_.-]+$/, {
    message: "fixture_id must be kebab/snake lowercase"
  }),
  /**
   * Human-readable description. Surfaced in the
   * Markdown report; not used for pass / fail.
   */
  description: z.string().default(""),
  dimension: LifecycleDimensionSchema,
  workstream: WorkstreamSchema,
  fixture_class: FixtureClassSchema,
  determinism: DeterminismKindSchema.default("deterministic"),
  /**
   * Schema references the fixture depends on.
   * The runner asserts the on-disk
   * `CURRENT_SCHEMA_VERSION` is at least this
   * value before executing the fixture.
   */
  requires_schema_version: z.number().int().nonnegative().default(20),
  seed: FixtureSeedSchema.default({}),
  operations: z
    .array(FixtureOperationSchema)
    // v1.2.0-alpha.3 (issue #55b): safety / counter
    // fixtures assert on the post-seed state alone
    // (the SessionService.ingest hook records the
    // counter when the seed is admitted). An
    // empty `operations` array is the canonical
    // shape for these fixtures.
    .default([]),
  expected: ExpectedOutcomesSchema.default({})
});

/**
 * The corpus is a versioned directory of fixtures
 * with a manifest declaring schema version +
 * baseline expectations. The runner loads the
 * manifest, walks the listed fixtures, and
 * reports per-fixture + aggregate results.
 */
export const LifecycleCorpusManifestSchema = z.object({
  schema_version: z.literal("lifecycle.corpus.v1"),
  corpus_version: z.string().regex(/^v\d+\.\d+\.\d+$/, {
    message: "corpus_version must be semver-style (e.g. v0.1.0)"
  }),
  description: z.string().default(""),
  /**
   * Baseline thresholds (#55 ## Baselines and
   * gates). The release gate fails when any
   * metric drops below its baseline. Initial
   * values are deliberately conservative; the
   * evaluation team raises them once a stable
   * corpus + harness have produced enough
   * data to justify the move.
   */
  baselines: z
    .object({
      distillation_supported_claim_rate: z
        .number()
        .min(0)
        .max(1)
        .default(0.9),
      distillation_hallucination_rejection_rate: z
        .number()
        .min(0)
        .max(1)
        .default(0.95),
      bootstrap_hash_byte_determinism: z
        .number()
        .min(0)
        .max(1)
        .default(1.0)
    })
    .default({}),
  fixtures: z.array(z.string()).min(1)
});

/**
 * One per-fixture result. Emitted by the runner
 * after the operation(s) complete. The runner
 * also emits the full operation log so a failure
 * can be reproduced locally without re-running
 * the corpus.
 */
export const FixtureResultSchema = z.object({
  schema_version: z.literal("lifecycle.result.v1"),
  fixture_id: z.string(),
  dimension: LifecycleDimensionSchema,
  workstream: WorkstreamSchema,
  fixture_class: FixtureClassSchema,
  determinism: DeterminismKindSchema,
  passed: z.boolean(),
  duration_ms: z.number().int().nonnegative(),
  /**
   * Human-readable notes for the Markdown report.
   * Set by the runner; never parsed for pass / fail.
   */
  notes: z.array(z.string()).default([]),
  observed: z
    .object({
      job_state: z.string().nullable().default(null),
      candidate_count: z.number().int().nullable().default(null),
      bootstrap_hash: z.string().nullable().default(null)
    })
    .default({}),
  safety_counters: z
    .object({
      cross_project_leak_count: z.number().int().nonnegative().default(0),
      sensitivity_leak_count: z.number().int().nonnegative().default(0),
      secret_leak_count: z.number().int().nonnegative().default(0),
      injection_bypass_count: z.number().int().nonnegative().default(0),
      unauthorized_trust_escalation_count: z.number().int().nonnegative().default(0)
    })
    .default({}),
  error: z.string().nullable().default(null)
});

/**
 * The aggregate corpus report. Contains every
 * fixture result + a per-dimension roll-up +
 * safety gate decision.
 */
export const CorpusReportSchema = z.object({
  schema_version: z.literal("lifecycle.report.v1"),
  corpus_version: z.string(),
  generated_at: z.string(),
  totals: z.object({
    fixture_count: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    duration_ms: z.number().int().nonnegative()
  }),
  safety_gate: z.object({
    passed: z.boolean(),
    reasons: z.array(z.string())
  }),
  results: z.array(FixtureResultSchema)
});

export type LifecycleFixture = z.infer<typeof LifecycleFixtureSchema>;
export type LifecycleDimension = z.infer<typeof LifecycleDimensionSchema>;
export type Workstream = z.infer<typeof WorkstreamSchema>;
export type FixtureClass = z.infer<typeof FixtureClassSchema>;
export type LifecycleCorpusManifest = z.infer<typeof LifecycleCorpusManifestSchema>;
export type FixtureResult = z.infer<typeof FixtureResultSchema>;
export type CorpusReport = z.infer<typeof CorpusReportSchema>;
export type FixtureSeed = z.infer<typeof FixtureSeedSchema>;
export type FixtureOperation = z.infer<typeof FixtureOperationSchema>;
export type ExpectedOutcomes = z.infer<typeof ExpectedOutcomesSchema>;
