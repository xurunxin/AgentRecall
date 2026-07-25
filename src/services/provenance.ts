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

import type { SQLiteMemoryStore } from "../sqlite-store.js";

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
 * Return the durable provenance link chain for a
 * memory, plus a stable human-readable summary. The
 * chain is what an agent would surface in response to
 * "where did this memory come from?"; the summary is
 * what an MCP `explain_provenance` tool would render.
 */
export function explainProvenance(
  store: SQLiteMemoryStore,
  memory_id: string
): ProvenanceExplanation {
  const links = store.getProvenance(memory_id);
  const summary = links.map((link) => formatLink(link));
  return { memory_id, links, summary };
}

function formatLink(link: ProvenanceLink): string {
  return `${link.source_kind}: ${link.source_ref} (recorded_by=${link.recorded_by}, at=${new Date(link.recorded_at).toISOString()})`;
}
