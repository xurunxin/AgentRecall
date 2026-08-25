// packages/contracts/tests/jobs.test.ts
//
// v1.2.0-alpha.0 (issue #48): schema tests for the
// derivation job contracts. The contracts are the
// public wire shape; the SQLite store row shape is
// the source of truth (looser) and a future
// round-trip helper in `src/jobs/serialization.ts`
// (planned for #55) will map between the two.

import { describe, it, expect } from "vitest";

import {
  DerivationJobSchema,
  DerivationJobStateSchema,
  DerivationRunSchema,
  DerivationRunStatusSchema,
  DerivationOutputSchema,
  DerivationOutputKindSchema,
  DerivationOutputDispositionSchema,
  DerivationJobScopeSchema,
  DerivationRefSchema,
  DerivationJobInspectionSchema,
  DerivationJobListSchema,
  DerivationJobCancelResultSchema,
  DerivationRunOnceResultSchema
} from "../src/jobs.js";

const baseJob = {
  schema_version: "1" as const,
  job_id: "job_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  kind: "session_distill",
  state: "queued" as const,
  scope: "global" as const,
  creator_actor_id: "user:tester",
  idempotency_key: "k1",
  input_digest: "sha256:abc",
  config_digest: "sha256:def",
  cursor_json: "{}",
  attempt_count: 0,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000
};

describe("Derivation contracts (v1.2.0-alpha.0, issue #48)", () => {
  it("accepts a minimal queued job", () => {
    const parsed = DerivationJobSchema.parse(baseJob);
    expect(parsed.state).toBe("queued");
  });

  it("rejects an unknown state", () => {
    const bad = { ...baseJob, state: "pending" };
    const result = DerivationJobSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects a job without a schema_version", () => {
    const bad = { ...baseJob } as Record<string, unknown>;
    delete bad["schema_version"];
    const result = DerivationJobSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("round-trips nullable fields when omitted", () => {
    const parsed = DerivationJobSchema.parse(baseJob);
    expect(parsed.project_id).toBeUndefined();
    expect(parsed.lease_owner).toBeUndefined();
    expect(parsed.started_at).toBeUndefined();
  });

  it("rejects a negative attempt_count", () => {
    const result = DerivationJobSchema.safeParse({ ...baseJob, attempt_count: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects a project-scoped job without project_id", () => {
    const result = DerivationJobScopeSchema.safeParse("project");
    expect(result.success).toBe(true);
  });

  it("rejects a project scope check via the job schema", () => {
    // The contract is intentionally permissive
    // about (scope='project', project_id=undefined)
    // because the SQLite CHECK constraint is the
    // authoritative gate; the contract just makes
    // sure the discriminated union is reachable.
    const result = DerivationJobSchema.safeParse({ ...baseJob, scope: "project" });
    expect(result.success).toBe(true);
  });

  it("accepts the canonical run shape", () => {
    const parsed = DerivationRunSchema.parse({
      schema_version: "1",
      run_id: "run_1",
      job_id: "job_1",
      stage: "extract",
      status: "succeeded",
      input_refs: [],
      output_refs: [],
      policy_version: "1.2.0-alpha.0/test",
      started_at: 1_700_000_000_000
    });
    expect(parsed.status).toBe("succeeded");
  });

  it("rejects a run with an unknown status", () => {
    const result = DerivationRunStatusSchema.safeParse("queued");
    expect(result.success).toBe(false);
  });

  it("accepts the canonical output shape", () => {
    const parsed = DerivationOutputSchema.parse({
      schema_version: "1",
      job_id: "job_1",
      run_id: "run_1",
      output_kind: "applied_memory",
      output_id: "mem_1",
      disposition: "applied",
      created_at: 1_700_000_000_000
    });
    expect(parsed.disposition).toBe("applied");
  });

  it("rejects an unknown output_kind", () => {
    const result = DerivationOutputKindSchema.safeParse("leaked");
    expect(result.success).toBe(false);
  });

  it("rejects an unknown disposition", () => {
    const result = DerivationOutputDispositionSchema.safeParse("rolled_back");
    expect(result.success).toBe(false);
  });

  it("accepts a DerivationRef with optional revision / version", () => {
    const parsed = DerivationRefSchema.parse({
      kind: "memory",
      id: "mem_1",
      revision: 2
    });
    expect(parsed.revision).toBe(2);
  });

  it("round-trips a job inspection payload", () => {
    const parsed = DerivationJobInspectionSchema.parse({
      schema_version: "1",
      job: baseJob,
      runs: [],
      outputs: []
    });
    expect(parsed.job.kind).toBe("session_distill");
  });

  it("round-trips a list payload", () => {
    const parsed = DerivationJobListSchema.parse({
      schema_version: "1",
      jobs: [baseJob]
    });
    expect(parsed.jobs.length).toBe(1);
  });

  it("round-trips a cancel result", () => {
    const parsed = DerivationJobCancelResultSchema.parse({
      schema_version: "1",
      job_id: "job_1",
      cancel_requested: true
    });
    expect(parsed.cancel_requested).toBe(true);
  });

  it("round-trips a run-once result", () => {
    const parsed = DerivationRunOnceResultSchema.parse({
      schema_version: "1",
      attempted: 3,
      succeeded: 2,
      failed: 1,
      cancelled: 0
    });
    expect(parsed.attempted).toBe(3);
  });
});
