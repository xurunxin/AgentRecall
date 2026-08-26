// test/unit/jobs-service.test.ts
//
// v1.2.0-alpha.0 (issue #48): unit tests for the
// `DerivationJobStore` and the related
// `redactError` helper. The tests focus on the
// state-machine contract documented in
// `docs/adr/0009-derivation-job-lifecycle.md`:
//
//   - enqueue: idempotent on (creator, kind, key);
//     rejects a replay with a different digest
//     (issue #48 AC #3).
//   - claim: only one worker wins; passive reap
//     re-queues a stranded running job (issue #48
//     AC #2).
//   - cancel: written on the next stage boundary,
//     not in the middle of a stage (issue #48 AC #5).
//   - fail: redacted_error is scrubbed of secret-like
//     patterns and bounded to 2000 chars (issue #48
//     AC #6).
//   - outputs: duplicate (job_id, output_kind, output_id)
//     inserts are silently dropped so a reap takeover
//     cannot write the same `applied` row twice
//     (issue #48 AC #2 + #5).
//
// The tests use a fresh in-process SQLite store per
// `beforeEach` so the assertion on `attempt_count`
// and `lease_expires_at` is not affected by residual
// state from a previous test.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DerivationJobStore } from "../../src/jobs/service.js";
import { redactError } from "../../src/jobs/redactor.js";
import { CURRENT_SCHEMA_VERSION, SQLiteMemoryStore } from "../../src/sqlite-store.js";

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "lm-jobs-svc-"));
  return join(dir, "memory.sqlite");
}

function openStore(dbPath: string): SQLiteMemoryStore {
  return new SQLiteMemoryStore(dbPath);
}

describe("DerivationJobStore (v1.2.0-alpha.0, issue #48)", () => {
  let dbPath: string;
  let store: SQLiteMemoryStore;
  let jobs: DerivationJobStore;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = openStore(dbPath);
    jobs = new DerivationJobStore(store);
    // Sanity: the migration chain walks to v14 on a
    // fresh install. The test catches a missed migration
    // registration before the test body runs.
    expect(store.getUserVersion()).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(14);
  });

  afterEach(() => {
    if (store !== undefined) {
      try {
        store.close();
      } catch {
        // already closed
      }
    }
    try {
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  describe("enqueue", () => {
    it("inserts a queued job with no lease and returns its id", () => {
      const { job, replayed } = jobs.enqueue({
        kind: "session_distill",
        scope: "global",
        creator_actor_id: "user:tester",
        idempotency_key: "k1",
        input_digest: "sha256:abc",
        config_digest: "sha256:def"
      });
      expect(replayed).toBe(false);
      expect(job.state).toBe("queued");
      expect(job.attempt_count).toBe(0);
      expect(job.lease_owner).toBeNull();
      expect(job.lease_expires_at).toBeNull();
      expect(job.cancel_requested_at).toBeNull();
      expect(job.next_retry_at).toBeNull();
      expect(job.error_code).toBeNull();
      expect(job.redacted_error).toBeNull();
      expect(job.creator_actor_id).toBe("user:tester");
      expect(job.kind).toBe("session_distill");
      expect(job.scope).toBe("global");
    });

    it("returns the original job on a replay with the same digests", () => {
      const input = {
        kind: "skill_extract",
        scope: "project",
        project_id: "proj_alpha",
        creator_actor_id: "user:tester",
        idempotency_key: "k2",
        input_digest: "sha256:abc",
        config_digest: "sha256:def"
      } as const;
      const a = jobs.enqueue(input);
      const b = jobs.enqueue(input);
      expect(b.replayed).toBe(true);
      expect(b.job.job_id).toBe(a.job.job_id);
    });

    it("rejects a replay with a different input_digest", () => {
      const a = jobs.enqueue({
        kind: "session_distill",
        scope: "global",
        creator_actor_id: "user:tester",
        idempotency_key: "k3",
        input_digest: "sha256:abc",
        config_digest: "sha256:def"
      });
      expect(a.replayed).toBe(false);
      expect(() =>
        jobs.enqueue({
          kind: "session_distill",
          scope: "global",
          creator_actor_id: "user:tester",
          idempotency_key: "k3",
          input_digest: "sha256:zzz",
          config_digest: "sha256:def"
        })
      ).toThrow(/idempotency_digest_mismatch/);
    });

    it("rejects a replay with a different config_digest", () => {
      const a = jobs.enqueue({
        kind: "session_distill",
        scope: "global",
        creator_actor_id: "user:tester",
        idempotency_key: "k4",
        input_digest: "sha256:abc",
        config_digest: "sha256:def"
      });
      expect(a.replayed).toBe(false);
      expect(() =>
        jobs.enqueue({
          kind: "session_distill",
          scope: "global",
          creator_actor_id: "user:tester",
          idempotency_key: "k4",
          input_digest: "sha256:abc",
          config_digest: "sha256:zzz"
        })
      ).toThrow(/idempotency_digest_mismatch/);
    });
  });

  describe("claim", () => {
    function makeJob(kind: string = "session_distill") {
      return jobs.enqueue({
        kind,
        scope: "global",
        creator_actor_id: "user:tester",
        idempotency_key: `claim-${Math.random()}`,
        input_digest: "sha256:abc",
        config_digest: "sha256:def"
      }).job;
    }

    it("transitions a queued job to running with a lease", () => {
      const job = makeJob();
      const claim = jobs.claim({ job_id: job.job_id, lease_owner: "w1" });
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;
      expect(claim.job.state).toBe("running");
      expect(claim.job.lease_owner).toBe("w1");
      expect(claim.job.attempt_count).toBe(1);
      expect(claim.job.started_at).not.toBeNull();
      expect(claim.lease_expires_at).toBeGreaterThan(Date.now());
    });

    it("rejects a second concurrent claim on the same job", () => {
      const job = makeJob();
      const a = jobs.claim({ job_id: job.job_id, lease_owner: "w1" });
      const b = jobs.claim({ job_id: job.job_id, lease_owner: "w2" });
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(false);
      if (b.ok) return;
      expect(b.error).toBe("not_claimable");
    });

    it("reaps a stranded running job whose lease has expired", () => {
      const job = makeJob();
      const a = jobs.claim({
        job_id: job.job_id,
        lease_owner: "w1",
        lease_ttl_ms: 5
      });
      expect(a.ok).toBe(true);
      // Wait past the TTL; the reap path runs on the
      // next claim/listClaimable call.
      const future = Date.now() + 100;
      while (Date.now() < future) {
        // busy-wait until TTL is unambiguously past.
      }
      const claim = jobs.claim({ job_id: job.job_id, lease_owner: "w2" });
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;
      expect(claim.job.attempt_count).toBe(2);
      expect(claim.job.lease_owner).toBe("w2");
    });

    it("listClaimable returns only the requested kind", () => {
      const a = jobs.enqueue({
        kind: "session_distill",
        scope: "global",
        creator_actor_id: "user:tester",
        idempotency_key: "l-1",
        input_digest: "sha256:abc",
        config_digest: "sha256:def"
      });
      jobs.enqueue({
        kind: "bootstrap_scan",
        scope: "global",
        creator_actor_id: "user:tester",
        idempotency_key: "l-2",
        input_digest: "sha256:abc",
        config_digest: "sha256:def"
      });
      const only = jobs.listClaimable("session_distill", Date.now(), 50);
      expect(only.length).toBe(1);
      expect(only[0]?.job_id).toBe(a.job.job_id);
    });
  });

  describe("startStage + finishStage", () => {
    it("writes a derivation_runs row in started state and finalises it", () => {
      const job = jobs.enqueue({
        kind: "session_distill",
        scope: "global",
        creator_actor_id: "user:tester",
        idempotency_key: "stage-1",
        input_digest: "sha256:abc",
        config_digest: "sha256:def"
      }).job;
      const claim = jobs.claim({ job_id: job.job_id, lease_owner: "w1" });
      expect(claim.ok).toBe(true);
      const run = jobs.startStage({
        job_id: job.job_id,
        stage: "extract",
        input_refs: [{ kind: "session_event", id: "evt_1" }],
        policy_version: "1.2.0-alpha.0/test"
      });
      expect(run.status).toBe("started");
      const finished = jobs.finishStage({
        run_id: run.run_id,
        status: "succeeded",
        result_digest: "sha256:out",
        outputs: [
          {
            output_kind: "candidate",
            output_id: "cand_1",
            disposition: "proposed"
          }
        ]
      });
      expect(finished.status).toBe("succeeded");
      const inspection = jobs.inspect(job.job_id);
      expect(inspection?.runs.length).toBe(1);
      expect(inspection?.outputs.length).toBe(1);
      expect(inspection?.outputs[0]?.disposition).toBe("proposed");
    });
  });

  describe("terminal state transitions", () => {
    it("complete() flips a running job to succeeded", () => {
      const job = jobs.enqueue({
        kind: "session_distill",
        scope: "global",
        creator_actor_id: "user:tester",
        idempotency_key: "complete-1",
        input_digest: "sha256:abc",
        config_digest: "sha256:def"
      }).job;
      jobs.claim({ job_id: job.job_id, lease_owner: "w1" });
      const final = jobs.complete(job.job_id);
      expect(final.state).toBe("succeeded");
      expect(final.finished_at).not.toBeNull();
    });

    it("fail() redacts the error and persists the redacted string", () => {
      const job = jobs.enqueue({
        kind: "session_distill",
        scope: "global",
        creator_actor_id: "user:tester",
        idempotency_key: "fail-1",
        input_digest: "sha256:abc",
        config_digest: "sha256:def"
      }).job;
      jobs.claim({ job_id: job.job_id, lease_owner: "w1" });
      const final = jobs.fail(
        job.job_id,
        "internal_error",
        "boom: sk-abcdefghijklmnopqrstuv 1/2 [REDACTED]",
        null
      );
      expect(final.state).toBe("failed");
      expect(final.error_code).toBe("internal_error");
      expect(final.redacted_error).not.toBeNull();
      expect(final.redacted_error ?? "").not.toMatch(/sk-abcdefghijklmnopqrstuv/);
      expect(final.redacted_error ?? "").toMatch(/redacted:api_key_prefix/);
    });

    it("fail() truncates the redacted error at 2000 chars", () => {
      const job = jobs.enqueue({
        kind: "session_distill",
        scope: "global",
        creator_actor_id: "user:tester",
        idempotency_key: "fail-2",
        input_digest: "sha256:abc",
        config_digest: "sha256:def"
      }).job;
      jobs.claim({ job_id: job.job_id, lease_owner: "w1" });
      const big = "x".repeat(5000);
      const final = jobs.fail(job.job_id, "internal_error", big, null);
      expect((final.redacted_error ?? "").length).toBeLessThanOrEqual(2000);
    });

    it("requestCancel() sets cancel_requested_at; markCancelled() flips to terminal", () => {
      const job = jobs.enqueue({
        kind: "session_distill",
        scope: "global",
        creator_actor_id: "user:tester",
        idempotency_key: "cancel-1",
        input_digest: "sha256:abc",
        config_digest: "sha256:def"
      }).job;
      jobs.claim({ job_id: job.job_id, lease_owner: "w1" });
      const ok = jobs.requestCancel(job.job_id);
      expect(ok).toBe(true);
      const mid = jobs.inspect(job.job_id);
      expect(mid?.job.cancel_requested_at).not.toBeNull();
      const final = jobs.markCancelled(job.job_id);
      expect(final.state).toBe("cancelled");
    });

    it("requestCancel() returns false for a terminal job", () => {
      const job = jobs.enqueue({
        kind: "session_distill",
        scope: "global",
        creator_actor_id: "user:tester",
        idempotency_key: "cancel-2",
        input_digest: "sha256:abc",
        config_digest: "sha256:def"
      }).job;
      jobs.claim({ job_id: job.job_id, lease_owner: "w1" });
      jobs.complete(job.job_id);
      const ok = jobs.requestCancel(job.job_id);
      expect(ok).toBe(false);
    });
  });

  describe("outputs: reap-safe duplicate write", () => {
    it("silently drops a duplicate (job_id, output_kind, output_id) insert", () => {
      const job = jobs.enqueue({
        kind: "session_distill",
        scope: "global",
        creator_actor_id: "user:tester",
        idempotency_key: "dup-1",
        input_digest: "sha256:abc",
        config_digest: "sha256:def"
      }).job;
      jobs.claim({ job_id: job.job_id, lease_owner: "w1" });
      const run = jobs.startStage({
        job_id: job.job_id,
        stage: "extract",
        input_refs: [],
        policy_version: "1.2.0-alpha.0/test"
      });
      const first = jobs.finishStage({
        run_id: run.run_id,
        status: "succeeded",
        outputs: [
          {
            output_kind: "applied_memory",
            output_id: "mem_1",
            disposition: "applied"
          }
        ]
      });
      expect(first.status).toBe("succeeded");
      // Simulate a reap takeover that tries to commit
      // the same `applied` output row. The store must
      // return `inserted: false` so the runner can
      // log the no-op rather than surface an exception.
      const inserted = store.insertDerivationOutput({
        job_id: job.job_id,
        run_id: run.run_id,
        output_kind: "applied_memory",
        output_id: "mem_1",
        disposition: "applied",
        created_at: Date.now()
      });
      expect(inserted).toBe(false);
      const inspection = jobs.inspect(job.job_id);
      expect(inspection?.outputs.length).toBe(1);
    });
  });
});

describe("redactError (v1.2.0-alpha.0, issue #48)", () => {
  it("returns empty string for null / undefined / empty input", () => {
    expect(redactError(null)).toBe("");
    expect(redactError(undefined)).toBe("");
    expect(redactError("")).toBe("");
  });

  it("does not touch an error with no secret-like patterns", () => {
    expect(redactError("plain text error")).toBe("plain text error");
  });

  it("masks an API key prefix", () => {
    const masked = redactError("leaked sk-abcdefghijklmnopqrstuv in the wild");
    expect(masked).not.toMatch(/sk-abcdefghijklmnopqrstuv/);
    expect(masked).toMatch(/redacted:api_key_prefix/);
  });

  it("masks a private key header", () => {
    const masked = redactError("-----BEGIN RSA PRIVATE KEY-----");
    expect(masked).not.toMatch(/BEGIN RSA PRIVATE KEY/);
    expect(masked).toMatch(/redacted:private_key/);
  });

  it("masks a bearer token", () => {
    const masked = redactError("Authorization: Bearer abcdefghijklmnopqrstuvwx");
    expect(masked).not.toMatch(/Bearer abc/);
    expect(masked).toMatch(/redacted:bearer_token/);
  });

  it("masks an env secret pattern", () => {
    const masked = redactError("API_KEY=abcdef12345ghij");
    expect(masked).not.toMatch(/API_KEY=abc/);
    expect(masked).toMatch(/redacted:env_secret/);
  });

  it("truncates at 2000 chars", () => {
    const long = "x".repeat(5000);
    expect(redactError(long).length).toBe(2000);
  });
});
