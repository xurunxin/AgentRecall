// src/doctor/checks/last-accessed-by.ts
//
// Surfaces a snapshot of the per-agent access map. The map is stored as
// JSON on each `memory_entries.last_accessed_by` cell, so we aggregate by
// walking every row once. Cheap on healthy databases; bounded by
// `memory_entries` size.

import type { CheckContext, CheckResult } from "../types.js";

type AgentCount = { agent: string; last_accessed_at: string };

function parseMap(raw: unknown): Record<string, string> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function checkLastAccessedBy(ctx: CheckContext): CheckResult {
  const handle = ctx.store.backupHandle();
  const rows = handle
    .prepare("SELECT last_accessed_by FROM memory_entries")
    .all() as Array<{ last_accessed_by: string | null }>;

  const agents = new Map<string, string>();
  let entries = 0;
  for (const row of rows) {
    const map = parseMap(row.last_accessed_by);
    const keys = Object.keys(map);
    if (keys.length === 0) continue;
    entries += 1;
    for (const [agent, ts] of Object.entries(map)) {
      const prev = agents.get(agent);
      if (prev === undefined || ts > prev) agents.set(agent, ts);
    }
  }

  const distribution: AgentCount[] = Array.from(agents.entries())
    .map(([agent, last_accessed_at]) => ({ agent, last_accessed_at }))
    .sort((a, b) => (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0));

  return {
    name: "last_accessed_by",
    status: "ok",
    message: `${entries} entries, ${distribution.length} agents seen`,
    details: { entries, agents: distribution }
  };
}
