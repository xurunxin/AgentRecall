// src/doctor/index.ts
//
// Health-check orchestrator. Runs a fixed set of independent checks and
// returns a structured report. Each check is a pure function over a
// `CheckContext` so they can be unit-tested in isolation.

import { nowIso } from "../domain.js";
import { checkActorDistribution } from "./checks/actor-distribution.js";
import { checkActorOwnership } from "./checks/actor-ownership.js";
import { checkAuditHealth } from "./checks/audit-health.js";
import { checkAuditRevisionGap } from "./checks/audit-revision-gap.js";
import { checkBackupDirectory } from "./checks/backup-directory.js";
import { checkBackupVerification } from "./checks/backup-verification.js";
import { checkCapacityHeadroom } from "./checks/capacity-headroom.js";
import { checkDataHome } from "./checks/data-home.js";
import { checkDiskFree } from "./checks/disk-free.js";
import { checkExportCollision } from "./checks/export-collision.js";
import { checkFtsConsistency } from "./checks/fts-consistency.js";
import { checkIdempotencyIntegrity } from "./checks/idempotency-integrity.js";
import { checkIntegrity } from "./checks/integrity.js";
import { checkJournalMode } from "./checks/journal-mode.js";
import { checkLastAccessedBy } from "./checks/last-accessed-by.js";
import { checkLockHealth } from "./checks/lock-health.js";
import { checkProjectAliasCollision } from "./checks/project-alias-collision.js";
import { checkRankingHealth } from "./checks/ranking-health.js";
import { checkRevisionIntegrity } from "./checks/revision-integrity.js";
import { checkSchemaVersion } from "./checks/schema-version.js";
import { checkScopeSafety } from "./checks/scope-safety.js";
import { checkSecretPolicyVersion } from "./checks/secret-policy-version.js";
import { checkSqliteRuntime } from "./checks/sqlite-runtime.js";
import { checkStaleMemories } from "./checks/stale-memories.js";
import type { CheckContext, CheckResult, DoctorReport } from "./types.js";

const CHECKS: Array<(ctx: CheckContext) => CheckResult> = [
  // Stage 1-13: existing checks (data home, integrity, schema, FTS,
  // backup directory, disk free, audit, capacity, actor distribution,
  // last accessed by, actor ownership, stale memories).
  checkDataHome,
  checkIntegrity,
  checkSchemaVersion,
  checkFtsConsistency,
  checkBackupDirectory,
  checkDiskFree,
  checkAuditHealth,
  checkCapacityHeadroom,
  checkActorDistribution,
  checkLastAccessedBy,
  checkActorOwnership,
  checkStaleMemories,
  // Stage 14 PR-C (spec § 9.1): the 12 acceptance-criteria
  // health checks for v1.0. These guard the v4 schema /
  // mutation-safety contracts the PR-A/B1/B2 work put
  // in place; a green doctor report is the operational
  // signal that the runtime still meets the spec
  // promises the rest of the codebase depends on.
  checkScopeSafety,
  checkRevisionIntegrity,
  checkJournalMode,
  checkSqliteRuntime,
  checkLockHealth,
  checkBackupVerification,
  checkProjectAliasCollision,
  checkRankingHealth,
  checkExportCollision,
  checkAuditRevisionGap,
  checkSecretPolicyVersion,
  checkIdempotencyIntegrity
];

export function runDoctor(ctx: CheckContext): DoctorReport {
  const started = nowIso(ctx.now());
  const results = CHECKS.map((check) => check(ctx));
  const summary = results.reduce(
    (acc, r) => {
      acc[r.status] += 1;
      return acc;
    },
    { ok: 0, warn: 0, fail: 0 }
  );
  const exitCode: 0 | 1 | 2 = summary.fail > 0 ? 2 : summary.warn > 0 ? 1 : 0;
  return {
    started_at: started,
    finished_at: nowIso(ctx.now()),
    results,
    summary,
    exit_code: exitCode
  };
}
