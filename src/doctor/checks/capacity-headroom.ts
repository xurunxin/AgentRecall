import { DEFAULT_GLOBAL_BUDGET, type MemoryBudget } from "../../domain.js";
import type { CheckContext, CheckResult } from "../types.js";

const WARN_RATIO = 0.8;

export function checkCapacityHeadroom(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();
  const row = handle
    .prepare("SELECT COUNT(*) AS c FROM memory_entries WHERE status = 'active' AND scope = 'global'")
    .get() as { c: number };
  const budget: MemoryBudget = DEFAULT_GLOBAL_BUDGET;
  const ratio = row.c / budget.max_active_entries;
  if (ratio >= 1) {
    return {
      name: "capacity_headroom",
      status: "fail",
      message: `global active = ${row.c}/${budget.max_active_entries} (${Math.round(ratio * 100)}%)`,
      details: { active: row.c, max: budget.max_active_entries }
    };
  }
  if (ratio >= WARN_RATIO) {
    return {
      name: "capacity_headroom",
      status: "warn",
      message: `global active = ${row.c}/${budget.max_active_entries} (${Math.round(ratio * 100)}%)`,
      details: { active: row.c, max: budget.max_active_entries }
    };
  }
  return {
    name: "capacity_headroom",
    status: "ok",
    message: `global active = ${row.c}/${budget.max_active_entries} (${Math.round(ratio * 100)}%)`,
    details: { active: row.c, max: budget.max_active_entries }
  };
}
