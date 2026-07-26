// src/tools/descriptions.ts
//
// Three-segment MCP tool descriptions: TRIGGER / INPUT / OUTPUT / FAILURE.
// Total length per tool is capped at 400 characters; each segment at 80.
// The MCP SDK passes these to the client as the `description` field on each
// tool registration, so agent prompts that read tool metadata get clear,
// actionable guidance rather than terse one-liners.

import type { MemoryToolName } from "./schemas.js";

type Segment = "TRIGGER" | "INPUT" | "OUTPUT" | "FAILURE";

const TEXT: Record<MemoryToolName, Record<Segment, string>> = {
  recall_context: {
    TRIGGER: "Call near the start of a coding task, before planning or editing.",
    INPUT: "scope, query, project_id|project_path, budget_chars, include_global?",
    OUTPUT: "Markdown context pack (budget-bounded). Paste into system prompt.",
    FAILURE: "Empty string on invalid_scope. Do not retry blindly; fix the input."
  },
  remember: {
    TRIGGER: "After learning a durable, reusable user/project fact, decision, or procedure.",
    INPUT: "scope, type, topic, title, body, tags, source, importance, confidence.",
    OUTPUT: "{memory_id, status, budget_after, warnings[]}. dup blocks, near_dup is advisory.",
    FAILURE: "capacity_exceeded -> run maintain_memories. secret_detected -> strip and retry."
  },
  search_memories: {
    TRIGGER: "Before writing, or when you need a specific past fact about the project or user.",
    INPUT: "query, scope, type?, topic?, tags?, actor?, since?, last_accessed?",
    OUTPUT: "items[] FTS bm25: id, scope, type, topic, title, tags, source, updated_at.",
    FAILURE: "Empty on no hits. Broaden scope (include_global) or relax topic/type filters."
  },
  get_memory: {
    TRIGGER: "When you have a memory id and need its full body plus the lifecycle history.",
    INPUT: "id | memory_id (both accepted; if both present, must match).",
    OUTPUT: "{ entry, audit[] } where audit is the ordered lifecycle of the memory.",
    FAILURE: "not_found if id is unknown. Use list_memories or search_memories to find it."
  },
  list_memories: {
    TRIGGER: "When you need a flat dump of memories, not a relevance-ranked search.",
    INPUT: "scope, project_id, type?, topic?, tags?, actor?, since?, until?, status.",
    OUTPUT: "{ items[] } ordered by updated_at desc, optionally filtered.",
    FAILURE: "Empty list = no active memories in scope. Use get_memory_budget first."
  },
  update_memory: {
    TRIGGER: "When a known memory needs correction, importance bump, or status change.",
    INPUT: "id | memory_id, then EITHER patch OR top-level fields (topic|title|body|...).",
    OUTPUT: "{ memory_id }. Mutation is atomic; old body is preserved in audit.",
    FAILURE: "invalid_state if superseded|forgotten. invalid_schema on bad field combos."
  },
  supersede_memory: {
    TRIGGER: "When a memory is wrong, outdated, or split across entries that should merge.",
    INPUT: "old_memory_ids[] (>=1), replacement (a remember-shaped object), reason.",
    OUTPUT: "{ memory_id } of the new entry. Old entries are marked superseded atomically.",
    FAILURE: "not_found if any old id is missing. invalid_scope on cross-scope replace."
  },
  merge_memories: {
    TRIGGER: "When 2+ near-duplicate memories from different sources should collapse to one.",
    INPUT: "old_memory_ids[] (>=2), replacement, reason, strategy?: keep_first|keep_newest.",
    OUTPUT: "{ memory_id, merged_from[] }. Old marked superseded; budget is relaxed.",
    FAILURE: "not_found if any old id is missing. invalid_state if any old is forgotten."
  },
  forget_memory: {
    TRIGGER: "When a memory is no longer true or relevant. Use sparingly; prefer supersede.",
    INPUT: "id | memory_id, reason.",
    OUTPUT: "{ memory_id, released_chars } indicating budget freed.",
    FAILURE: "not_found. Forgotten memories keep their id and audit history; body is cleared."
  },
  get_memory_budget: {
    TRIGGER: "When you need to know how full the budget is, or what to clean up next.",
    INPUT: "scope, project_id (required when scope=project).",
    OUTPUT: "{ budget, usage, cleanup_candidates[] }. Candidates are suggestions to act on.",
    FAILURE: "invalid_scope when project_id is missing for scope=project."
  },
  maintain_memories: {
    TRIGGER: "For cleanup, or as a fallback when remember returns capacity_exceeded.",
    INPUT: "action: archive_low_value|expire_due|rebuild_index|vacuum_fts|find_duplicates.",
    OUTPUT: "{action, changed, details}. find_duplicates -> same|similar groups (read-only).",
    FAILURE: "invalid_scope. vacuum_fts may be a no-op if the engine does not support it."
  },
  export_memory_context: {
    TRIGGER: "When a human-readable markdown snapshot of memories is needed (review, handoff).",
    INPUT: "scope, project_id, query?, budget_chars, types?, topics?, include_global?",
    OUTPUT: "Full markdown document with budget-bounded entries. Plain text, not JSON.",
    FAILURE: "Empty on invalid_scope. Output is plain text; do not parse as JSON."
  },
  // Stage 12 PR9 (spec § 6.2, § 6.3, § 6.4).
  plan_maintenance: {
    TRIGGER: "Before destructive cleanup (dedup, archive, expire) to get a plan_id.",
    INPUT: "scope, project_id (when scope=project), max_groups? (cap on plan size).",
    OUTPUT: "{ plan_id, expected_revisions, proposed_actions[], summary[] }.",
    FAILURE: "invalid_scope when project_id is missing. Empty actions is success."
  },
  apply_maintenance: {
    TRIGGER: "Only after reviewing a plan. Same plan_id + key is a safe retry.",
    INPUT: "plan_id, confirm: true, idempotency_key (any stable string).",
    OUTPUT: "{ plan_id, applied } on success; { plan_id, error } on plan_invalidated.",
    FAILURE: "plan_invalidated when any entry's revision drifted. Re-plan after invalidation."
  },
  explain_recall: {
    TRIGGER: "Why was a memory ranked? Get the score breakdown without recording an access.",
    INPUT: "query, scope, project_id?, include_global?, top_k? (default 10).",
    OUTPUT: "{ ranking_version, items: [{ memory_id, score, components, trust_boost }] }.",
    FAILURE: "invalid_scope. No access is recorded; safe to call as a diagnostic."
  },
  list_backups: {
    TRIGGER: "Before restore_backup, or to audit backup hygiene.",
    INPUT: "None. Reads from the data home configured at server start.",
    OUTPUT: "{ backup_dir, entries: [{ name, size, mtimeMs }] } newest first.",
    FAILURE: "Empty entries when data home is unknown or the directory does not exist."
  },
  // Stage 16 v1.1.1 PR-7 (issue #17, spec § 5.4):
  // the four new memory-semantics tools. Concise
  // descriptions that fit the 80-char segment
  // limit; the full contract is in the schema.
  record_memory_feedback: {
    TRIGGER: "When a memory was useful (up), misleading (down), or should always/hide.",
    INPUT: "id | memory_id, kind: up|down|pin|hide. Actor is the request context, not input.",
    OUTPUT: "{ ok: true } on success; { error: 'not_found' } when the id is unknown.",
    FAILURE: "not_found. The feedback row is appended, not deduplicated."
  },
  record_memory_provenance: {
    TRIGGER: "When you can link a memory to an issue, PR, commit, session, or import.",
    INPUT: "id | memory_id, source_kind, source_ref (the canonical upstream id).",
    OUTPUT: "{ ok: true, link: { source_kind, source_ref, recorded_by, recorded_at } }.",
    FAILURE: "not_found. Repeat calls with the same triple are no-ops (PRIMARY KEY)."
  },
  explain_memory_provenance: {
    TRIGGER: "When you need the full source-of-truth chain for a memory.",
    INPUT: "id | memory_id. Nothing else; the chain lives in memory_provenance.",
    OUTPUT: "{ memory_id, links[], summary[] } ordered by source_kind, recorded_at.",
    FAILURE: "not_found. Empty links = the memory has no recorded provenance."
  },
  confirm_memory_trust: {
    TRIGGER: "When a trusted user explicitly approves a memory's trust tier.",
    INPUT: "id | memory_id, trust_level, user_confirmed: true, reason?.",
    OUTPUT: "{ ok: true } on success; audits the transition with previous/next.",
    FAILURE: "unauthorized without user_confirmed. not_found on unknown id."
  }
};

export const memoryToolDescriptions: Record<MemoryToolName, string> = Object.fromEntries(
  (Object.keys(TEXT) as MemoryToolName[]).map((name) => [
    name,
    `[TRIGGER] ${TEXT[name].TRIGGER}\n[INPUT] ${TEXT[name].INPUT}\n[OUTPUT] ${TEXT[name].OUTPUT}\n[FAILURE] ${TEXT[name].FAILURE}`
  ])
) as Record<MemoryToolName, string>;
