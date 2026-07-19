// src/doctor/index.ts
//
// Health-check orchestrator. Runs a fixed set of independent checks and
// returns a structured report. Each check is a pure function over a
// `CheckContext` so they can be unit-tested in isolation.

import { nowIso } from "../domain.js";
import { checkActorDistribution } from "./checks/actor-distribution.js";
import { checkAuditHealth } from "./checks/audit-health.js";
import { checkBackupDirectory } from "./checks/backup-directory.js";
import { checkCapacityHeadroom } from "./checks/capacity-headroom.js";
import { checkDataHome } from "./checks/data-home.js";
import { checkDiskFree } from "./checks/disk-free.js";
import { checkFtsConsistency } from "./checks/fts-consistency.js";
import { checkIntegrity } from "./checks/integrity.js";
import { checkSchemaVersion } from "./checks/schema-version.js";
import type { CheckContext, CheckResult, DoctorReport } from "./types.js";

const CHECKS: Array<(ctx: CheckContext) => CheckResult> = [
  checkDataHome,
  checkIntegrity,
  checkSchemaVersion,
  checkFtsConsistency,
  checkBackupDirectory,
  checkDiskFree,
  checkAuditHealth,
  checkCapacityHeadroom,
  checkActorDistribution
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
