import { CURRENT_SCHEMA_VERSION } from "../../sqlite-store.js";
import type { CheckContext, CheckResult } from "../types.js";

export function checkSchemaVersion(ctx: CheckContext): CheckResult {
  const current = ctx.store.getUserVersion();
  if (current === CURRENT_SCHEMA_VERSION) {
    return {
      name: "schema_version",
      status: "ok",
      message: `${current} (latest)`,
      details: { current, latest: CURRENT_SCHEMA_VERSION }
    };
  }
  if (current > CURRENT_SCHEMA_VERSION) {
    return {
      name: "schema_version",
      status: "fail",
      message: `downgrade: db is v${current}, code expects v${CURRENT_SCHEMA_VERSION}`,
      details: { current, latest: CURRENT_SCHEMA_VERSION }
    };
  }
  return {
    name: "schema_version",
    status: "warn",
    message: `db is v${current}, code expects v${CURRENT_SCHEMA_VERSION}; run agent-recall migrate`,
    details: { current, latest: CURRENT_SCHEMA_VERSION }
  };
}
