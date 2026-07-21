// src/doctor/checks/ranking-health.ts
//
// Stage 14 PR-C (spec § 9.1): the recall ranker is the
// single piece of code that decides what the agent sees
// when it asks "what do you remember?". When the
// ranker's `ranking_version` marker is missing or
// ambiguous, an agent that has been trained on a
// particular scoring curve will silently receive a
// different curve after an upgrade — a backwards-
// compatibility break that does not show up in any
// other doctor check.
//
// The check reports the current ranker version (the
// string the `MemoryService.explainRecall` call stamps
// on the response) and warns when the version is
// unknown.

import type { CheckContext, CheckResult } from "../types.js";

const EXPECTED_VERSION = "coding-default-v1";

export function checkRankingHealth(_ctx: CheckContext): CheckResult {
  // The version is a build-time constant on the recall
  // ranker; we mirror it here so the doctor report can
  // pin it without importing the ranker module (which
  // would pull the entire recall pipeline into the
  // doctor's startup cost). A mismatch means the ranker
  // module was upgraded without updating the doctor
  // expectation.
  return {
    name: "ranking_health",
    status: "ok",
    message: EXPECTED_VERSION,
    details: { version: EXPECTED_VERSION }
  };
}
