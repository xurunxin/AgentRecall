import { isRecommendedActor } from "../../actor.js";
import type { CheckContext, CheckResult } from "../types.js";

const LEGACY = new Set(["agent", "user", "system"]);

export function checkActorDistribution(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();
  const rows = handle
    .prepare("SELECT actor, COUNT(*) AS c FROM audit_events GROUP BY actor ORDER BY c DESC")
    .all() as Array<{ actor: string; c: number }>;
  const unknown = rows.filter((r) => !isRecommendedActor(r.actor) && !LEGACY.has(r.actor));
  if (rows.length === 0) {
    return {
      name: "actor_distribution",
      status: "ok",
      message: "no audit events yet",
      details: { distribution: [] }
    };
  }
  if (unknown.length === 0) {
    return {
      name: "actor_distribution",
      status: "ok",
      message: `${rows.length} distinct actors, all known`,
      details: { distribution: rows }
    };
  }
  return {
    name: "actor_distribution",
    status: "ok",
    message: `${rows.length} distinct actors, ${unknown.length} unknown`,
    details: { distribution: rows, unknown: unknown.map((u) => u.actor) }
  };
}
