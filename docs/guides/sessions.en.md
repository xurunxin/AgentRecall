# Session Evidence Layer (v1.2.0-alpha.1)

> 🌏 Language: English. 中文(默认): [sessions.md](sessions.md)

This guide covers the **session evidence layer** introduced in v1.2.0-alpha.1 (issue #49) — the input half of AgentRecall's evolution from "explicit memory control plane" to "memory lifecycle system". Phase 1 lands the durable ledger for "what the agent saw / did". Phase 2 (#50) runs distillation over this ledger to produce reviewable candidates.

## What this subsystem solves

A coding-agent session produces a stream of events: `user_message` / `assistant_message` / `tool_call` / `tool_result` / `decision_confirmed` / `error` / `session_started` / `session_ended`. Pre-v1.2 these events lived only in the agent's working memory; the session ended, the events were gone. The session evidence layer **persists** the raw stream to a replay-safe ledger as input to the distillation pipeline.

Key properties:

- **Replay-safe**: re-ingesting the same `(source_kind, source_version, source_instance_id, source_session_id)` is a no-op; a different body throws `bundle_hash_drift`.
- **Content-addressed**: event bodies keep head/tail 1KB slices in the SQLite row (so the row is greppable + inspectable), with the full body looked up by `content_digest` from a local file under the data home. The v0.5.0 portability bundle will include the local file.
- **Zero mutation to the live memory store**: the evidence layer only writes `sessions` / `session_events` / `session_event_blobs`. The memory table is **not** touched until a candidate is reviewed + applied (Phase 2 #50 explicit contract).
- **Secret scan + injection tag**: secret-like patterns raise `redaction_flags: ['contains_secret']`, prompt-injection patterns raise `risk_injection`. The distillation extractor skips both by default.

## Data model

```sql
sessions               -- one session = one row; primary key = session_id
session_events         -- one event = one row; primary key = event_id
session_event_blobs    -- content-addressed body cache; primary key = digest (= content_digest)
```

The three tables relate via `session_events.session_id` ↔ `sessions.session_id` and `session_events.content_digest` ↔ `session_event_blobs.digest`.

`UNIQUE (source_kind, source_version, source_instance_id, source_session_id)` is the replay-safe contract. Re-ingesting the same source-identity:
- same `bundle_hash` → returns the original `session_id`, writes no new rows
- different `bundle_hash` → throws `bundle_hash_drift`, the entire ingest is rejected

## CLI

```bash
# Ingest a JSONL bundle (emitted by the OpenCode lifecycle hook or a JSONL fixture)
agent-recall sessions ingest <bundle.jsonl>

# List existing sessions
agent-recall sessions list

# Inspect a single session's metadata + event list
agent-recall sessions show <session_id>

# View the ingest plan counts (accepted / redacted / skipped / rejected)
agent-recall sessions inspect <session_id> --json | jq .plan

# Permanently delete a session + its events (dangerous; `--confirm` required)
agent-recall sessions forget <session_id> --confirm
```

### JSONL bundle format

```jsonl
{"schema_version":"1","bundle_id":"...","source_kind":"opencode","source_version":"1.0.0","source_instance_id":"...","source_session_id":"...","project_id":null,"actor_id":"...","client_name":"opencode","client_version":"1.0.0","scope":"global","sensitivity":"normal","started_at":"...","ended_at":"...","adapter_id":"jsonl","adapter_version":"1.0.0","events":[]}
{"schema_version":"1","source_kind":"opencode","source_version":"1.0.0","source_instance_id":"...","source_session_id":"...","project_id":null,"actor_id":"...","client_name":"opencode","client_version":"1.0.0","event_id":"evt_1","sequence":1,"turn_id":"turn-1","event_type":"user_message","role":"user","content":"...","content_digest":"sha256:...","timestamp":"...","sensitivity":"normal","redaction_flags":[],"metadata":{}}
...
```

Line 1 is the bundle header (`events: []`); subsequent lines are events. The Zod schema lives in the shared `@agent-recall/contracts` package (`packages/contracts/src/sessions.ts`, 7 schemas). Any adapter (OpenCode, Claude Code, Codex, custom) writes this shape.

## Size caps + auto-truncation

| Item | Cap | Overflow behaviour |
|---|---|---|
| Per-event body | 256 KB | head/tail 1KB truncated; `redaction_flags: ['truncated']` set |
| Per-session cumulative | 8 MB | subsequent events marked `skipped` |

Both caps are decided by `planBundle` (a pure walk) before any row is written — no half-written state. The `bundle_hash` is the SHA-256 of `bundle.events` AFTER truncation, so the same bundle produces the same hash across ingest paths (replay-safe).

## Secret scan + risk_injection

`SessionService.ingest` runs `secret-detector.ts` over every event's `content`. Matches are replaced with `[redacted:<category>]`; the original digest is preserved. Prompt-injection patterns (e.g. "ignore previous instructions" / "disregard the system prompt") raise `redaction_flags: ['risk_injection']`.

`DistillationService.DeterministicBaselineExtractor` skips events with `risk_injection` or `contains_secret` in their `redaction_flags` by default — preventing secret / injection pollution of the candidate set.

## MCP resource

```
agentrecall://sessions/{session_id}
```

Returns the session's metadata + event list (read-only). MCP clients (the OpenCode plugin) can pull this resource for in-context review.

## Integration with the distillation pipeline

`DistillationService.runOnBundle` (Phase 2 #50) consumes `SessionService.inspect(session_id)` output directly (see `bundleFromSessionInspection` in `src/distillation/service.ts`). No bridge layer is needed. The `runOnce` executor runs `DeterministicBaselineExtractor` in the `extract` stage; the emitted candidate is written to `derivation_candidates` (job_id from `enqueueAndRunSessionDistill` enqueue, run_id from `startStage`).

## Out of scope (deferred)

- HTTP bridge `sessions` endpoint — Phase 3
- Admin app session browser — Phase 3
- Cross-session conversation-graph tracking — v1.3+
- Auto-compaction / GC of body-file cache — v1.3 maintenance
