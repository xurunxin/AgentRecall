// src/actor.ts
//
// Audit-event actor identifier resolver and parser.
//
// The SQLite `audit_events.actor` column is a free-form TEXT. We standardise
// on a `kind:name` shape (e.g. `agent:claude-code`) so the cross-agent story
// (which client wrote this row?) is queryable and human-readable. Legacy bare
// values (`agent` / `user` / `system`) are still accepted as valid input AND
// produced as valid output for backwards compatibility with v1 audit rows.

export type ActorKind = "agent" | "user" | "system";

export const ACTOR_KINDS: readonly ActorKind[] = ["agent", "user", "system"];

/**
 * Stage 14 PR-B1 (spec § 5.2 AR-P0-002): the structured actor
 * identifier. Either the legacy bare form ("agent" / "user"
 * / "system") for backwards compatibility with v1 audit rows,
 * or the canonical `kind:name` form ("agent:claude-code",
 * "system:expiry", etc.).
 *
 * The `name` segment is the only free-form part; the `kind`
 * prefix is type-checked so audit consumers can dispatch on
 * `kind` without parsing the suffix.
 */
export type ActorId =
  | `${ActorKind}:${string}`
  | "agent"
  | "user"
  | "system";

export const RECOMMENDED_ACTOR_NAMES: Readonly<Record<ActorKind, readonly string[]>> = {
  agent: [
    "claude-code",
    "cursor",
    "codex",
    "aider",
    "cline",
    "continue",
    "windsurf",
    "roo-cline",
    "copilot"
  ],
  user: ["cli", "editor", "me"],
  system: [
    "expiry",
    "archive",
    "dedup",
    "doctor",
    "backup",
    "migration",
    "unknown"
  ]
};

export type ResolvedActor = {
  raw: string;
  kind: ActorKind;
  name: string;
};

const LEGACY_ACTOR_VALUES = new Set<string>(["agent", "user", "system"]);

function isActorKind(value: string): value is ActorKind {
  return (ACTOR_KINDS as readonly string[]).includes(value);
}

/**
 * Resolve the actor identifier to persist in audit_events.actor.
 *
 * Priority:
 *   1. explicit override (caller-provided)
 *   2. AGENT_RECALL_ACTOR environment variable
 *   3. fallback "agent:unknown"
 *
 * Accepts legacy bare values ("agent", "user", "system") and returns them
 * unchanged so v1 audit rows continue to validate against the v1 CHECK
 * constraint before migration.
 */
export function resolveActor(
  override: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): ActorId {
  const candidate = (override ?? env.AGENT_RECALL_ACTOR ?? "").trim();
  if (candidate.length === 0) {
    return DEFAULT_ACTOR;
  }
  if (LEGACY_ACTOR_VALUES.has(candidate)) {
    return candidate as ActorId;
  }
  return candidate as ActorId;
}

/** Parse a stored actor string into structured form. Used for read-side display. */
export function parseActor(value: string): ResolvedActor {
  if (LEGACY_ACTOR_VALUES.has(value)) {
    return { raw: value, kind: value as ActorKind, name: value };
  }
  const separator = value.indexOf(":");
  if (separator === -1) {
    return { raw: value, kind: "system", name: value };
  }
  const kind = value.slice(0, separator);
  const name = value.slice(separator + 1);
  if (isActorKind(kind)) {
    return { raw: value, kind, name };
  }
  return { raw: value, kind: "system", name };
}

/** Test whether an actor value is a known recommended name. */
export function isRecommendedActor(value: string): boolean {
  const parsed = parseActor(value);
  return (RECOMMENDED_ACTOR_NAMES[parsed.kind] as readonly string[]).includes(parsed.name);
}

export const CLI_ACTOR: ActorId = "user:cli";
export const DEFAULT_ACTOR: ActorId = "agent:unknown";
