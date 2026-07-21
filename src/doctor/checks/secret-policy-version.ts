// src/doctor/checks/secret-policy-version.ts
//
// Stage 14 PR-C (spec § 9.1): the secret-detection
// catalogue the store applies to `remember` / `update` is
// a moving target (new high-entropy patterns get added
// every release). When the catalogue version baked into
// the running build falls behind the version the data
// was scanned with, an entry that was admitted as
// "clean" under the old rules can be re-classified as a
// secret under the new rules, breaking the
// "what we wrote is what we read" contract.
//
// This check pins the *current* expected version and
// returns a `warn` if the build's catalogue version is
// below it. We expose the version via a constant the
// rest of the codebase can read (the secret detector
// itself doesn't currently carry a version field, so the
// version is a release marker maintained by hand in
// `secret-detector.ts`; this check is the consumer that
// surfaces drift in the doctor report).

import { SECRET_POLICY_VERSION } from "../../secret-detector.js";
import type { CheckContext, CheckResult } from "../types.js";

const EXPECTED = "v1";

export function checkSecretPolicyVersion(_ctx: CheckContext): CheckResult {
  if (SECRET_POLICY_VERSION !== EXPECTED) {
    return {
      name: "secret_policy_version",
      status: "warn",
      message: `secret detector at ${SECRET_POLICY_VERSION}, expected ${EXPECTED}`,
      details: { actual: SECRET_POLICY_VERSION, expected: EXPECTED }
    };
  }
  return {
    name: "secret_policy_version",
    status: "ok",
    message: `${SECRET_POLICY_VERSION}`,
    details: { actual: SECRET_POLICY_VERSION, expected: EXPECTED }
  };
}
