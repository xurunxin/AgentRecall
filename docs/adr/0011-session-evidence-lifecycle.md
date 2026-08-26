# ADR-0011: Session evidence lifecycle (issue #49)

## Context

v1.2.0-alpha.0 introduced the durable derivation job substrate (#48). v1.2.0-alpha.1 needed the input half of that pipeline: a place for coding-agent lifecycle hooks to **persist captured events** before they are routed into the distillation pipeline (#50) and reviewed.

A captured event is a stable record of something the agent saw or did: a `user_message`, a `tool_call`, an `assistant_message`, a `decision_confirmed`, an `error`, etc. The capture surface must be:

- **Replayable**: re-running an ingest with the same `(source_kind, source_version, source_instance_id, source_session_id)` must be a no-op (or a re-attestation of the same bundle).
- **Content-addressed**: bodies are large and noisy; only their digest needs to live in the row, with the body fetched on demand.
- **Mutation-free before review/apply**: capturing must NOT touch the live memory store. The session evidence is the input ledger, not the destination.

The pre-v1.2 codebase had no concept of a captured trace; tool output was either in the agent's working memory or the admin app's ad-hoc export. We needed a canonical place to land it.

## Decision

We add the v1.2.0-alpha.1 schema v15 migration (`migrate_v14_to_v15`) introducing three additive tables:

- `sessions` — the canonical identity for a captured trace. The `UNIQUE (source_kind, source_version, source_instance_id, source_session_id)` constraint is the contract that makes `ingest` replayable. The `bundle_hash` column is the source-of-truth for replay; a different `bundle_hash` for the same source-identity throws `bundle_hash_drift` and the entire ingest is rejected.
- `session_events` — the per-event row. `event_id` is the adapter-stable identity supplied by the source (OpenCode lifecycle hook, JSONL fixture, future Claude Code / Codex adapter). The row is the canonical durable record.
- `session_event_blobs` — the content-addressed body cache. SQLite is still the authoritative manifest / index; large bodies live in a content-addressed local file. `head_bytes` + `tail_bytes` (1KB each) are kept in-row for inspection; the full body is resolved on demand via `SessionService.getEventBody`.

`SessionService.ingest` is replay-safe: a re-ingest with the same source-identity + same `bundle_hash` returns the original `session_id`; a different `bundle_hash` throws `bundle_hash_drift`. Plan counts (`accepted` / `redacted` / `skipped` / `rejected`) are decided by a pure walk **before** the row write — no half-applied state. The service also:

- Tags events with `redaction_flags = ['risk_injection', ...]` when the content matches the agent's prompt-injection patterns
- Truncates over-cap events head/tail (per-event 256KB / per-session 8MB) and preserves the original `content_digest` so the full body is still resolvable
- Surfaces the plan counters in the CLI `sessions ingest` output so the operator can audit what was redacted

The JSONL adapter (`JsonlSessionAdapter`) is the v1 reference implementation. Line 1 of the JSONL stream is the bundle header; subsequent lines are `SessionTraceEventV1` events. Zod validation reuses the shared `@agent-recall/contracts` schema, so any future adapter (Claude Code, Codex, ...) is one Zod shape away from being wire-compatible.

## Schema invariants

Documented in the JSDoc on `migrate_v14_to_v15` in `src/sqlite-store.ts`:

- `sessions` UNIQUE `(source_kind, source_version, source_instance_id, source_session_id)` is the replay contract.
- `session_events.event_id` is the adapter-stable identity; the row is the canonical durable record.
- `session_event_blobs` is content-addressed; SQLite is the manifest / index, the body lives in a content-addressed local file.
- All three tables use `TEXT` ISO 8601 for timestamps (matching the v13 portability surface and the rest of the recall layer).
- `redaction_flags` is a JSON array; the service walks it for downstream consumer (e.g. distillation skip rules).
- The body digest is `sha256:hex64`; the JSONL adapter recomputes the digest on every parse and surfaces a `policy_redacted` flag on digest drift (the v1 contract is "the digest is the source of truth; we do NOT trust the body").

## Trade-offs

- **JSONL over a typed RPC**: the JSONL wire format is hand-readable + diff-friendly + replay-friendly. The trade-off is zod validation on every line; that's paid once per ingest, not per event.
- **Content-addressed local file under data home**: the body cache is part of the agent's data home, so backups and migrations are local. The trade-off is the body is NOT in SQLite — a fresh restore that doesn't have the body file renders the digest + head/tail slices only. The v0.5.0 portability story is "include the body file in the export bundle".
- **`bundle_hash` as the replay contract** (rather than `(source_identity, timestamp)`): the hash captures the body, not the wall clock. A re-ingest with the same body is a no-op; a re-ingest with a different body is a hard error (`bundle_hash_drift`). This is deliberately strict — silent re-ingest of mutated bodies was the #21 v1.1.2 footgun.
- **One row per event** (vs. one row per session with a JSON-blob events column): the relational shape lets downstream consumers (`DistillationService`, future per-event reviewer) walk events without parsing a blob. The trade-off is more rows; the v1.2 scale (thousands of events per session) is well within SQLite's per-table row budget.

## What ships in v1.2.0-alpha.1

- `src/sessions/service.ts` — `SessionService` (ingest / inspect / list / show / forget / getEventBody)
- `src/sessions/adapters/jsonl.ts` — `JsonlSessionAdapter`
- CLI: `agent-recall sessions inspect | ingest | list | show | forget`
- MCP resource: `agentrecall://sessions/{session_id}`
- Contracts: `packages/contracts/src/sessions.ts` 7 zod schemas
- Tests: `test/unit/sessions-service.test.ts` (13) + `test/cli/sessions.test.ts` (7) + `packages/contracts/tests/sessions.test.ts` (10)
- OpenCode plugin: `opencode-plugin/capture.mjs` opt-in prompt

## Out of scope (deferred)

- Provider-backed distillation (#50) — lands in v1.2.0-alpha.2
- Body file compaction / GC — v1.2 ships 256KB head/tail windows, never deletes; a future maintenance release adds a TTL
- HTTP bridge sessions endpoints — Phase 3
- Admin app session browser — Phase 3
