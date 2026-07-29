// src/services/provenance.ts
//
// Stage 15 PR-M1-1 (issue #6, spec § 5.3): durable
// provenance for memory entries. A memory can carry
// one or more provenance links to the source that
// produced it:
//
//   - `issue`     → GitHub issue URL (e.g. https://github.com/...)
//   - `pr`        → pull request URL
//   - `commit`    → git commit SHA
//   - `tool_call` → MCP / RPC call id
//   - `session`   → chat session id (Claude, Cursor, ...)
//   - `import`    → portability importer batch id
//
// The data lives in the `memory_provenance` table;
// `recordProvenance` is the single write entry
// point and `explainProvenance` is the single read
// entry point. The store handles de-duplication
// (PRIMARY KEY `(memory_id, source_kind, source_ref)`)
// so a repeat call is a no-op.
//
// v1.1.3 GATE-03 (issue #33): the explanation
// surface honours the canonical authorization
// decision. A Core / Extended caller asking for
// the provenance of a restricted row receives
// `{ ok: false, error: "not_found" }` — the
// response shape never leaks the row's existence,
// the row's id, or any link metadata. Admin +
// capability callers see the full explanation.

import type { SQLiteMemoryStore } from "../sqlite-store.js";
import { type AuthorizationDecision, type SensitivityLevel } from "./auth-context.js";

export type ProvenanceSourceKind =
  | "issue"
  | "pr"
  | "commit"
  | "tool_call"
  | "session"
  | "import";

export type ProvenanceLink = {
  source_kind: ProvenanceSourceKind;
  source_ref: string;
  recorded_by: string;
  recorded_at: number;
};

export type ProvenanceExplanation = {
  memory_id: string;
  links: ProvenanceLink[];
  /**
   * A short human-readable summary of the link chain,
   * one line per link. Stable order: `source_kind`
   * ascending, then `recorded_at` ascending. The
   * explain output is what an MCP `explain_provenance`
   * tool would render.
   */
  summary: string[];
};

const PROVENANCE_SOURCE_KINDS: ReadonlySet<ProvenanceSourceKind> = new Set([
  "issue",
  "pr",
  "commit",
  "tool_call",
  "session",
  "import"
]);

/**
 * Validate a source reference. Each `source_kind` has
 * a tiny contract on what `source_ref` looks like:
 *   - `issue`, `pr`, `commit`, `tool_call`, `session`,
 *     `import` → non-empty trimmed string
 *
 * The function returns the normalised form
 * (trimmed) when valid, or `undefined` when the
 * caller passed garbage.
 */
function normaliseSourceRef(input: string): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}

export function recordProvenance(
  store: SQLiteMemoryStore,
  input: {
    memory_id: string;
    source_kind: ProvenanceSourceKind;
    source_ref: string;
    recorded_by: string;
    recorded_at?: number;
  }
): { ok: true; link: ProvenanceLink } | { ok: false; error: "invalid_input" } {
  if (typeof input.memory_id !== "string" || input.memory_id.length === 0) {
    return { ok: false, error: "invalid_input" };
  }
  if (!PROVENANCE_SOURCE_KINDS.has(input.source_kind)) {
    return { ok: false, error: "invalid_input" };
  }
  const source_ref = normaliseSourceRef(input.source_ref);
  if (source_ref === undefined) {
    return { ok: false, error: "invalid_input" };
  }
  if (typeof input.recorded_by !== "string" || input.recorded_by.length === 0) {
    return { ok: false, error: "invalid_input" };
  }
  const recorded_at = input.recorded_at ?? Date.now();
  store.recordProvenance({
    memory_id: input.memory_id,
    source_kind: input.source_kind,
    source_ref,
    recorded_by: input.recorded_by,
    recorded_at
  });
  return {
    ok: true,
    link: {
      source_kind: input.source_kind,
      source_ref,
      recorded_by: input.recorded_by,
      recorded_at
    }
  };
}

/**
 * Compare a row's sensitivity against the caller's
 * visibility ceiling. Returns `true` when the
 * caller is authorized to see the row.
 *
 * v1.1.3 GATE-03 (issue #33): the matrix
 *   - `"normal"` ≤ `"normal"`, `"private"`, `"restricted"`
 *   - `"private"` ≤ `"private"`, `"restricted"`
 *   - `"restricted"` ≤ `"restricted"` only
 *
 * `normalizeSensitivity` is the ordered comparator
 * for the SQL-boundary filter; a row's
 * `sensitivity` value is "visible" when it is at
 * or below the caller's ceiling.
 */
export function isSensitivityVisible(
  rowSensitivity: "normal" | "private" | "restricted",
  ceiling: SensitivityLevel
): boolean {
  const rank: Record<SensitivityLevel, number> = {
    normal: 0,
    private: 1,
    restricted: 2
  };
  return rank[rowSensitivity] <= rank[ceiling];
}

/**
 * v1.1.3 GATE-03 (issue #33): an optional
 * authorization decision. When supplied, the
 * explanation surface filters links to the
 * caller's visible subset. Legacy callers that
 * omit the field see the unfiltered explanation
 * (the pre-GATE-03 behaviour); new callers MUST
 * thread the decision so a Core / Extended
 * caller never sees restricted-edge metadata.
 */
export function explainProvenance(
  store: SQLiteMemoryStore,
  memory_id: string,
  options: { authorization?: AuthorizationDecision } = {}
): ProvenanceExplanation | { ok: false; error: "not_found" } {
  const ceiling: SensitivityLevel =
    options.authorization?.max_sensitivity ?? "restricted";
  // The `peekEntry` with options surfaces the row's
  // sensitivity so the decision can be applied at
  // the explanation boundary. When the row is
  // invisible (filtered out), the SQL-boundary
  // predicate returns `undefined` and the caller
  // sees `not_found` (NOT `forbidden_visibility`)
  // because the provenance path is the
  // single-row read alias — the canonical
  // explanation surface does not leak the row's
  // existence.
  const entry = store.peekEntry(memory_id, { actorMaxSensitivity: ceiling });
  if (entry === undefined) {
    return { ok: false, error: "not_found" };
  }
  const links = store.getProvenance(memory_id);
  const summary = links.map((link) => formatLink(link));
  return { memory_id, links, summary };
}

function formatLink(link: ProvenanceLink): string {
  return `${link.source_kind}: ${link.source_ref} (recorded_by=${link.recorded_by}, at=${new Date(link.recorded_at).toISOString()})`;
}
