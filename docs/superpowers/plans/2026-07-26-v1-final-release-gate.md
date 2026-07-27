# V1 Final Release Gate (#19) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Each task is independently reviewable and must preserve the release evidence required by Issue #19.

**Goal:** Close GitHub Issue #19 by making AgentRecall v1.1.2 correct under real multi-process contention, strictly isolated by project identity, safe by default at the MCP boundary, recoverable with verifiable full-history import lineage, and proven from the exact cross-platform packaged artifacts.

**Architecture:** Keep `MemoryService` as the façade over the existing read/write/maintenance services. Extend the existing SQLite transaction and portability layers rather than introducing a parallel persistence path. Public MCP and CLI calls remain the acceptance boundary; direct store tests supplement but do not replace them. Use one independently reviewable PR per SubIssue, with the release candidate frozen only after #20–#26 are merged.

**Tech Stack:** TypeScript, Node.js >=24, SQLite/WAL, Vitest, MCP SDK, npm packaging, GitHub Actions on Linux/macOS/Windows.

## Global Constraints

- The release version is `1.1.2`; `v1.1.1`, `v1.1.0`, and `v1.0.0` are immutable and must not move.
- Issue #25 uses **Option B: implement `full_history` recovery**, not snapshot-only removal.
- Full-history import must restore entries, revisions, relevant audit metadata, relations, provenance, and import-batch lineage atomically.
- Project-scoped calls resolve through the store-backed `ProjectIdentityResolver`; unknown `project_id` values cannot create namespaces in the default mode.
- The packaged MCP default is the documented Core profile; Extended/Admin capabilities require explicit opt-in and a trusted local boundary.
- No release-critical test may be skipped, suppressed with `|| true`, or treated as passing while emitting an unexpected protocol/internal exception.
- Every schema change requires a forward migration test from all documented supported v1 schemas and a rollback/compatibility note.
- Every SubIssue completion requires its exact files, schema version, test commands/results, public-boundary evidence, and rollback notes in the GitHub issue comment.
- Do not modify or publish a tag until the exact release SHA has passed the complete release-candidate workflow.

## Baseline and Decisions

- Repository: `xurunxin/AgentRecall`.
- Current baseline: `main` at `41a3203`, package/server version `1.1.1`, latest schema `v11`, existing tag `v1.1.1`.
- Parent gate: https://github.com/xurunxin/AgentRecall/issues/19.
- SubIssues: #20 through #29, all open at planning time; #19 itself documents the authoritative dependency order.
- Admin-boundary decision for this plan: a local capability file under `AGENT_RECALL_HOME`, created and revoked only by an operator-facing CLI command. The MCP request boolean is never treated as proof of authorization. POSIX permissions must be restrictive; Windows must use an equivalent owner-only ACL or fail closed.
- History-bundle decision for #25: add a versioned bundle format that carries current entries plus revisions, audit events, relations, provenance, and source identifiers. Restore through deterministic source-to-target id remapping inside the same transaction as entries.

## Files and Responsibilities

| Area | Existing files | Planned additions/changes |
|---|---|---|
| Concurrency | `test/multi-process-stress.test.ts`, `test/multi-process-stress.worker.ts`, `vitest.config.ts` | Real concurrent launcher, barrier, crash/retry scenarios, profile controls |
| Identity | `src/scope-resolver.ts`, `src/services/memory-read-service.ts`, `src/services/memory-write-service.ts`, `src/portability/importer.ts` | Remove default unbound fallback; test every public path |
| MCP profiles | `src/index.ts`, `src/tools/register-tools.ts`, `src/mcp/resources.ts`, `src/tools/descriptions.ts` | Core default, explicit Extended/Admin selection, health metadata |
| Admin/sensitivity | `src/write-validator.ts`, `src/sqlite-store.ts`, `src/memory-service.ts`, CLI command registration | `src/admin/capability.ts`, admin CLI commands, read/export/resource policy enforcement |
| Import preflight | `src/portability/importer.ts`, `src/budget-governor.ts`, `src/scope-resolver.ts` | Authoritative identity and aggregate budget plan |
| Full history | `src/portability/exporter.ts`, `src/portability/importer.ts`, `src/portability/manifest.ts`, `src/portability/migration-adapter.ts`, `src/sqlite-store.ts` | Versioned history bundle, remapping, atomic restore, migration fixtures |
| Import lineage | `src/sqlite-store.ts`, `src/portability/importer.ts`, `src/services/provenance.ts`, `src/cli/commands/import.ts`, `src/mcp/resources.ts` | `import_batches` persistence, audit/provenance overlay, inspect surface |
| Release proof | `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `scripts/verify-artifact-globs.mjs`, `test/blackbox/*` | Exact-SHA candidate workflow and extracted-artifact lifecycle tests |
| Release metadata | `package.json`, `src/server-version.ts`, `CHANGELOG.md`, Issue #19 evidence comment | Version consistency, checksums, immutable tag and release notes |

---

## Phase 0: Stabilize the Test Baseline

### Task 0: Remove false-positive worker heartbeat noise

**Issue:** prerequisite for #20 and #27; document as infrastructure work before the release gate.

**Files:**
- Modify: `vitest.config.ts` and the existing concurrency-test configuration.
- Modify: `test/multi-process-stress.test.ts` only where needed to avoid the known birpc heartbeat failure without weakening assertions.
- Test: the complete existing suite and the stress test.

**Steps:**

- [ ] Reproduce the current worker-heartbeat behavior with `npm test` and record failures, unhandled errors, duration, and test count.
- [ ] Apply the smallest configuration/startup fix that removes the known `onTaskUpdate` heartbeat error without increasing test skips or accepting child-process failures.
- [ ] Run `npm test -- test/multi-process-stress.test.ts` and confirm the baseline stress test has zero unhandled heartbeat errors.
- [ ] Run `npm test` and `npm run typecheck`; record both outputs in the infrastructure PR.
- [ ] Commit only the heartbeat/test-infrastructure change with a message such as `test: stabilize worker heartbeat for release stress gate`.

**Exit gate:** the baseline suite has zero unhandled heartbeat/timeouts before the genuine-concurrency behavior is changed.

---

## Phase A: Runtime Correctness and Public Boundaries

### Task 1: Close #20 with a genuinely concurrent stress profile

**Files:**
- Modify: `test/multi-process-stress.test.ts`.
- Modify: `test/multi-process-stress.worker.ts`.
- Modify: `.github/workflows/ci.yml` for the CI profile.
- Modify: `.github/workflows/release.yml` or the later candidate workflow for the release profile.

**Interfaces:**
- The launcher starts every worker before awaiting any result.
- Workers receive a shared barrier path and scenario/profile parameters.
- Each worker reports `pid`, `started_at`, `first_mutation_at`, `finished_at`, operation count, and scenario result.

**Steps:**

- [ ] Replace the sequential `for`/`await runWorker(...)` creation loop with process creation followed by `Promise.all` over all child completions.
- [ ] Add a file/socket barrier: each worker announces readiness, the parent releases the barrier only after all expected workers are ready, and every worker records the release timestamp before its first mutation.
- [ ] Add scenarios for independent writes, the same `(actor, tool, idempotency_key)` mutation, same-revision CAS updates, concurrent access/feedback writes, termination during a transaction, and retry after an interrupted/busy operation.
- [ ] Add assertions for overlapping worker lifetimes, exactly one idempotent side effect, one CAS winner, no lost writes, revision/audit count consistency, project isolation, and no orphaned child/temp files.
- [ ] Run `PRAGMA quick_check` and the application invariants after each scenario, not only after the whole test.
- [ ] Support explicit profiles: CI must run at least 8 workers and 1,600 total operations; release must run at least 8 workers and 10,000 total operations. Keep the profile values in environment/configuration so local focused runs remain bounded.
- [ ] Run `npm test -- test/multi-process-stress.test.ts` locally, then run the CI profile on all three OS runners. Record overlap evidence and invariant results in #20.
- [ ] Commit as `test: make multi-process release stress genuinely concurrent`.

**Exit gate:** the worker launcher proves overlap and all #20 invariants pass without suppression on Linux, macOS, and Windows.

### Task 2: Close #21 by removing the default unbound project-id fallback

**Files:**
- Modify: `src/scope-resolver.ts`.
- Modify: all public callers that resolve project scope, especially `src/memory-service.ts`, `src/services/memory-read-service.ts`, `src/services/memory-write-service.ts`, `src/services/memory-maintenance-service.ts`, `src/portability/importer.ts`, `src/mcp/resources.ts`, and `src/cli/commands/*` where project scope is accepted.
- Modify: `test/release-gate/p3-project-identity-public-path.test.ts` and related scope tests.
- Modify: `README.md` and `CHANGELOG.md` for compatibility/migration behavior.

**Steps:**

- [ ] Enumerate every production call to `ProjectIdentityResolver.resolve` and classify it as `lookup`, `register`, or `strict_existing`; fail the review if a normal read/import/maintenance path still uses a store-less fallback.
- [ ] Make `project_id` without `project_path` succeed only for an existing identity. Reject unknown ids before creating project scope, alias, memory, audit, or budget rows.
- [ ] Retain an explicit, default-off legacy escape hatch only if existing v1 compatibility requires it; expose `identity_status: unbound` and document that strict isolation is disabled while it is enabled.
- [ ] Add migration/backfill behavior for supported v1 databases containing project scopes without identity rows. The backfill must detect path/id conflicts and refuse ambiguous mappings rather than guessing.
- [ ] Add public-path tests for registered success, unknown-id rejection, id/path conflict, read-only non-creation, maintenance, import, CLI, MCP resource, symlink/worktree, and Windows case-folding behavior.
- [ ] Run `npm test -- test/release-gate/p3-project-identity-public-path.test.ts test/scope-resolver.test.ts`, then `npm run typecheck`.
- [ ] Commit as `fix: enforce bound project identities on every public path`.

**Exit gate:** no normal project-scope production path can address an unbound namespace.

### Task 3: Close #22 with Core as the packaged MCP default

**Files:**
- Modify: `src/index.ts`.
- Modify: `src/tools/register-tools.ts`.
- Modify: `src/mcp/resources.ts`.
- Modify: `src/tools/descriptions.ts` and profile-related tests.
- Modify: `README.md`, example configurations, and `CHANGELOG.md`.
- Modify: `test/blackbox/mcp-all-tools-e2e.test.ts` or split it into profile-specific suites.

**Interfaces:**
- `AGENT_RECALL_PROFILE` selects `core` by default and `extended` only explicitly.
- Unknown profile values fail closed with a stable startup error or a documented Core fallback; they never enable extra tools.
- The health resource exposes the active profile without writing protocol diagnostics to stdout.

**Steps:**

- [ ] Define the exact Core and Extended lists from `CORE_TOOL_NAMES` and `EXTENDED_TOOL_NAMES`; add a test that compares `tools/list` to those canonical lists rather than duplicating an unsynchronized list.
- [ ] Wire `src/index.ts` to the profile selector, with no-profile startup registering Core only.
- [ ] Decide and document whether the CLI profile flag is needed for this release; if retained, parse `--profile=core|extended` through the existing CLI parser and apply the same fail-closed validator instead of maintaining a second parser.
- [ ] Add `active_profile` to `memory://health` and assert it through a real MCP client.
- [ ] Split source/artifact black-box expectations so Core tests do not assume all 20 tools, while Extended tests still exercise the full non-admin set.
- [ ] Run `npm run build`, `npm run smoke:blackbox`, and the profile-specific black-box tests against the built server.
- [ ] Commit as `fix: default packaged MCP server to core profile`.

**Exit gate:** an unconfigured packaged server exposes only Core; explicit Extended exposes the documented additional set.

### Task 4: Close #23 with a trusted local admin boundary and sensitivity enforcement

**Files:**
- Create: `src/admin/capability.ts`.
- Modify: `src/write-validator.ts`.
- Modify: `src/memory-service.ts` and the relevant service methods for trust/sensitivity transitions.
- Modify: `src/sqlite-store.ts` read queries and mutation helpers.
- Modify: `src/tools/schemas.ts`, `src/tools/register-tools.ts`, and `src/tools/descriptions.ts`.
- Modify: `src/mcp/resources.ts`.
- Modify: `bin/agent-recall.ts`, `src/cli/index.ts`, and add an admin command under `src/cli/commands/`.
- Create: `docs/adr/0001-local-admin-capability-boundary.md`.
- Create/modify: release-gate and black-box admin/sensitivity tests.

**Interfaces:**
- `CapabilityStore` exposes `grant()`, `revoke()`, `status()`, and `authorize(capability, requestContext)`.
- The capability is stored under `AGENT_RECALL_HOME`, generated by the operator CLI, and never accepted as a raw `user_confirmed` proof.
- Unauthorized calls return a stable domain error without revealing restricted memory existence or content.

**Steps:**

- [ ] Write ADR-0001 choosing the local capability-file boundary, defining POSIX permissions, Windows ACL behavior, rotation/revocation, failure-closed startup/read behavior, and the fact that this is local operator separation rather than cryptographic multi-user security.
- [ ] Implement capability creation/revocation/status using atomic file replacement, restrictive permissions/ACLs, redacted diagnostics, and no secret value in audit or error output.
- [ ] Add `agent-recall admin grant`, `admin revoke`, and `admin status`; ensure ordinary MCP tools cannot invoke these commands internally.
- [ ] Change trust promotion and restricted-sensitivity writes to require server-side capability authorization. Ignore/reject a client-supplied `user_confirmed: true` when the capability is absent.
- [ ] Enforce visibility on `get`, `list`, `search`, `recall_context`, context export, MCP resources, portability export, maintenance/diagnostics, and CLI reads. The SQL/store boundary must prevent title/body/tags/source leakage, not merely filter final response fields.
- [ ] Make trust/sensitivity transitions CAS/revision/audit aware, recording actor, reason, request id, previous value, and next value without credentials or memory secrets.
- [ ] Add Core, Extended, and authorized-admin black-box tests for rejected/accepted trust transitions, restricted reads, exports, resources, and imports.
- [ ] Run focused admin tests, `npm run typecheck`, `npm run build`, and all existing MCP contract tests.
- [ ] Commit as `security: enforce trusted admin boundary for sensitive memory operations`.

**Exit gate:** a normal Core client cannot self-promote trust or read restricted data; the operator path can authorize and audit the transition.

---

## Phase B: Recovery and Portability

### Task 5: Close #24 with authoritative import preflight and aggregate budgets

**Files:**
- Modify: `src/portability/importer.ts`.
- Modify: `src/budget-governor.ts` and/or the existing budget calculation helpers, reusing them rather than creating a second model.
- Modify: `src/scope-resolver.ts` integration points if preflight needs a public resolver helper.
- Modify: `src/portability/migration-adapter.ts` for the supported bundle version.
- Create/modify: `test/release-gate/p3-import-preflight-budget.test.ts` and public import black-box tests.

**Interfaces:**
- `preflightImport(bundle, context)` returns deterministic per-entry decisions plus aggregate `before`/`after` budget summaries.
- `applyImport(plan, context)` revalidates revision-sensitive assumptions inside the transaction and rejects the complete batch atomically.

**Steps:**

- [ ] Route every project entry through `ProjectIdentityResolver.resolve(..., "strict_existing")`; reject unknown/unbound/conflicting identities before any mutation.
- [ ] Compute batch impact from real configured usage and limits: active-entry count, total characters, per-topic characters, index characters, replacement/merge release, and all entries in the batch.
- [ ] Validate schema version, enums, secret policy, sensitivity/trust authorization, conflict policy, and revision assumptions for every operation.
- [ ] Emit deterministic decisions and before/after budget values so the plan is inspectable and reproducible.
- [ ] Revalidate revisions, identity, and aggregate assumptions inside the apply transaction; on mismatch roll back entries, revisions, audit, provenance, FTS, scopes, and budgets together.
- [ ] Add tests for malicious re-hashed bundles, cross-project bundles, active/total/topic/index overflow, mixed insert/replace batches, and preflight/apply races.
- [ ] Run the focused strict-import/preflight suites, then `npm run typecheck` and the portability regression suite.
- [ ] Commit as `fix: enforce strict identity and aggregate import preflight`.

**Exit gate:** an invalid import produces no database mutation, and a valid import has a deterministic plan matching the live budget model.

### Task 6: Close #25 using full-history recovery Option B

**Files:**
- Modify: `src/portability/canonical-model.ts`.
- Modify: `src/portability/exporter.ts`.
- Modify: `src/portability/manifest.ts`.
- Modify: `src/portability/migration-adapter.ts`.
- Modify: `src/portability/importer.ts`.
- Modify: `src/sqlite-store.ts` and migration definitions; advance the schema version only if required by the persisted bundle/import mapping structures.
- Modify: `src/services/provenance.ts` as needed to restore links without bypassing invariants.
- Create/modify: full-history release-gate tests and migration fixtures.
- Modify: `README.md`, `CHANGELOG.md`, and portability documentation.

**Interfaces:**
- Bundle format version `v3` contains current entries plus `memory_revisions`, relevant audit events/request metadata, relations, provenance, and source identifiers.
- Import uses a deterministic source-id → target-id map for memory, revision, audit, relation, and provenance references; source autoincrement identifiers are never blindly inserted into a target database.
- `history_mode: "full_history"` is a real operation. Unsupported bundle/history versions return a stable machine-readable error before mutation.

**Steps:**

- [ ] Define the v3 canonical bundle schema and field-by-field preservation policy. Include source schema version, source database identity, entry post-images, revision order/post-images, audit actor/reason/request metadata, relation endpoints, provenance links, and any import lineage fields required by #26.
- [ ] Extend export to collect the history graph for each selected memory and serialize it canonically before hashing; preserve deterministic ordering and exclude secrets from errors/logging, not from the explicitly requested exported memory data.
- [ ] Extend manifest validation and migration-adapter checks to reject unsupported versions, broken references, duplicate source identifiers, invalid ordering, and mismatched bundle hashes before apply.
- [ ] Implement a source-to-target remapping phase. Resolve target memory ids according to the documented conflict policy, then remap revision/audit/relation/provenance references before insertion.
- [ ] Restore entries and all history rows in one transaction with the preflight identity/budget checks from Task 5. Preserve original writer/source metadata while recording the import operation as the new source of the import change.
- [ ] Make rollback cover entries, revisions, audit events, relations, provenance, FTS, and import lineage. No failed transaction may leave a completed history restore marker.
- [ ] Add migration tests from every supported v1 schema through the current schema, and export→clean database import tests that assert persisted row ordering/content rather than only response flags.
- [ ] Document exactly what full-history import preserves, how id collisions are remapped, how conflicts are handled, and how older snapshot bundles behave.
- [ ] Run the full portability, migration, and public import tests; then `npm run typecheck` and `npm run build`.
- [ ] Commit as `feat: implement versioned full-history import recovery`.

**Exit gate:** a v3 export imported into a clean database reproduces the documented history graph atomically and is verifiable through supported public diagnostics.

### Task 7: Close #26 with durable import-batch lineage and inspection

**Files:**
- Modify: `src/sqlite-store.ts` and schema migration definitions.
- Create: `src/portability/import-batch-store.ts`.
- Modify: `src/portability/importer.ts`.
- Modify: `src/services/provenance.ts` and audit-writing helpers.
- Modify: `src/request-context.ts` call wiring if import metadata is missing.
- Modify: `src/cli/commands/import.ts` and CLI routing.
- Modify: `src/mcp/resources.ts` and resource registration.
- Create: `test/release-gate/p3-import-batch-lineage.test.ts`.

**Interfaces:**
- `ImportBatchStore.start(input)`, `complete(batchId, counts)`, `fail(batchId, errorCode)`, and `inspect(batchId)` provide a redacted operator-readable record.
- The record contains `import_batch_id`, canonical `bundle_hash` plus algorithm, source format/schema, target scope/project identity, conflict/history policy, available actor/request/session/tool-call metadata, timestamps, status, counts, and affected memory ids.
- Every imported entry mutation emits audit/provenance metadata linking to the same batch id and bundle hash.

**Steps:**

- [ ] Add the durable `import_batches` table using a non-destructive migration. Include indexes for batch id, status, and target project; store counts/affected ids in a structured form with bounded size or a normalized child table.
- [ ] Generate one batch id and canonical bundle hash before apply. Thread both plus `RequestContext` through insert/replace/merge, full-history restoration, revision, audit, and provenance writers.
- [ ] Make the batch status transition part of the documented atomicity boundary: successful batch metadata and mutations commit together; failed/rolled-back attempts are either recorded as failure outside the data transaction or leave no completed batch record, but never remain `completed`.
- [ ] Preserve prior writer/history on replacement/merge while recording import actor/source metadata for the new change.
- [ ] Add `agent-recall import inspect <batch_id> [--json]` and an MCP resource such as `memory://imports/{batch_id}`. Return status, policy, counts, and ids only; never return memory bodies, secret values, raw filesystem paths, or credentials.
- [ ] Test successful insert/replace/merge lineage, same-bundle repeat as a new auditable attempt, rollback/failure status, redaction, migration from pre-batch databases, and full-history integration with Task 6.
- [ ] Run the focused lineage suite, CLI tests, resource tests, migration tests, `npm run typecheck`, and `npm run build`.
- [ ] Commit as `feat: persist import batch lineage and inspection`.

**Exit gate:** every successful import is queryably linked to one exact bundle hash and batch id through audit/provenance, and failed imports are never marked successful.

---

## Phase C: Exact Release Proof

### Task 8: Close #27 with a frozen release candidate and exact-SHA 3-OS CI

**Files:**
- Create/modify: `.github/workflows/release-candidate.yml`.
- Modify: `.github/workflows/ci.yml` and `.github/workflows/release.yml`.
- Modify: `scripts/verify-artifact-globs.mjs`.
- Modify: release-gate test configuration so required tests cannot silently skip.

**Steps:**

- [ ] Merge #20–#26 and record the resulting candidate SHA in #19 before starting the release workflow.
- [ ] Create a candidate branch/tag convention that prevents feature changes after the SHA is frozen; any release-blocking code change creates a new SHA and invalidates all previous evidence.
- [ ] Run the complete matrix on the exact SHA: `npm ci`, `npm run typecheck`, `npm run build`, `npm test`, migration tests, genuine concurrency release profile, backup/restore, import/full-history lineage, Core/Extended/Admin black-box, cleanup checks, and artifact-glob verification on Linux/macOS/Windows with Node 24.
- [ ] Make skipped tests explicit failures for release-critical paths. Fail on unexpected stderr, protocol errors, `_zod`/internal exceptions, child-process leaks, or suppressed exit codes.
- [ ] Emit an evidence artifact containing candidate SHA, workflow/job URLs, conclusions, durations, OS, Node version, test counts, artifact names, and hashes.
- [ ] Add a tag guard so release publication checks that the tag commit SHA equals the recorded green candidate SHA; do not rely only on legacy status contexts.
- [ ] Run the candidate workflow twice only when evidence is invalidated by a candidate-code change; otherwise retain the exact successful run links.
- [ ] Commit workflow-only changes as `ci: gate release on exact verified candidate commit`.

**Exit gate:** one exact SHA has green, unsuppressed Linux/macOS/Windows evidence and is recorded in #19.

### Task 9: Close #28 with extracted-artifact MCP lifecycle E2E

**Files:**
- Create: `test/blackbox/packaged-install.test.ts`.
- Modify: `test/blackbox/mcp-client-e2e.test.ts` and `test/blackbox/mcp-all-tools-e2e.test.ts` to accept an extracted package/entry-point and selected profile.
- Modify: `.github/workflows/release-candidate.yml` and `.github/workflows/release.yml`.
- Modify: platform extraction helpers/scripts, using Node or PowerShell on Windows rather than assuming Unix `unzip`.

**Steps:**

- [ ] Build each platform package independently and upload the exact artifact produced by that job.
- [ ] Download and extract into a clean temporary directory with no source checkout `dist`, tests, or `node_modules` dependency; install only documented runtime dependencies with `npm install --omit=dev` or the supported equivalent.
- [ ] Start the extracted `dist/src/index.js` and run the MCP lifecycle through a real SDK client: initialize, capabilities, exact tools/resources discovery, remember/idempotent replay/key-reuse rejection, CAS/stale rejection, identity registration/conflict, search/recall, sensitivity/trust authorized and unauthorized paths, maintenance in the permitted profile, full-history export/import round trip, backup/doctor/CLI, clean shutdown.
- [ ] Run Core by default and explicit Extended/Admin paths using the documented profile/capability mechanism; assert exact tool lists and active-profile health metadata.
- [ ] Assert archive file lists, entry-point paths, Windows ZIP extraction/invocation, empty-or-allowed stderr, process cleanup, and temporary-directory cleanup.
- [ ] Run the packaged suite against Linux `.tar.gz`, macOS `.tar.gz`, and Windows `.zip`, record names/sizes/SHA-256 hashes and workflow URLs.
- [ ] Commit as `test: verify complete MCP lifecycle from release artifacts`.

**Exit gate:** all three downloaded artifacts pass the lifecycle independently of the source checkout.

### Task 10: Close #29 by publishing v1.1.2 immutably

**Files:**
- Modify: `package.json` from `1.1.1` to `1.1.2`.
- Modify: `src/server-version.ts` and any version assertions.
- Modify: `CHANGELOG.md` with the verified release contents and migration notes.
- Modify: `.github/workflows/release.yml` and release scripts.
- Update: GitHub Release metadata and Issue #19 evidence comment.

**Steps:**

- [ ] Update all version sources and tests together: package metadata, server output, changelog heading, release-gate assertions, artifact metadata, and release title.
- [ ] Re-run Task 8 because the version commit is part of the exact release SHA; do not reuse evidence from a different commit.
- [ ] Publish only artifacts produced and tested by Task 9. Generate SHA-256 checksums and independently verify them after upload/download.
- [ ] Create an annotated `v1.1.2` tag from the verified SHA. Refuse to force-update any existing tag.
- [ ] Publish release notes containing source SHA, CI/release workflow links, artifact names/sizes/checksums, migration/full-history compatibility notes, and known non-blocking limitations.
- [ ] If npm publication is intended, first resolve the current `private: true` policy explicitly; otherwise keep npm publication out of scope and verify the GitHub artifacts only. Do not silently publish a private package.
- [ ] Add the required evidence comment to #19 with exactly these fields:

```text
release_commit:
tag:
ci_runs:
release_workflow:
artifacts:
sha256_checksums:
test_summary:
migration_summary:
known_non_blocking_limits:
```

- [ ] Close #29 and then #20–#28 only after each issue has its implementation/evidence comment. Close #19 last.

**Exit gate:** `v1.1.2` is immutable, reproducible, checksum-verified, and backed by exact-SHA cross-platform artifact evidence.

---

## Dependency Graph and Merge Order

```text
Task 0 ───────────────────────────────────────────────────────────────┐
Task 1 (#20) ────────────────────────────────────────────────────────┤
Task 2 (#21) ───────────────┬──> Task 5 (#24) ───────────────┐       │
Task 3 (#22) ───────┬───────┤                                │       │
                    └──> Task 4 (#23) ───────────────────────┤       │
Task 6 (#25 full history) ──────────────────────────────────┬─> Task 7 (#26)
                                                             └──────────┤
Task 1 + Task 2 + Task 3 + Task 4 + Task 5 + Task 6 + Task 7 ──> Task 8 (#27)
Task 3 + Task 4 + Task 8 ─────────────────────────────────────────> Task 9 (#28)
Task 8 + Task 9 ──────────────────────────────────────────────────> Task 10 (#29)
Task 10 evidence ─────────────────────────────────────────────────> close #19
```

Recommended merge order is one PR per task. Development may proceed in parallel for Tasks 1–4 where file ownership is disjoint, but merge and public-boundary verification must respect the graph. Task 7 depends on the final history contract from Task 6 because its lineage tests must cover the actual v3 full-history path.

## Verification Matrix

| Gate | Required evidence |
|---|---|
| G0 | `npm test` with zero unhandled worker-heartbeat errors |
| #20 | Overlap timestamps, 8-worker/1,600-op CI profile, 10,000-op release profile, quick-check/invariant output on all OS |
| #21 | Public MCP/CLI/resource/import tests showing no unbound namespace creation |
| #22 | Core default exact `tools/list`, explicit Extended list, health `active_profile`, invalid-profile fail-closed test |
| #23 | Capability grant/revoke/status, unauthorized/authorized trust and sensitivity tests, no restricted-content leakage |
| #24 | Deterministic preflight budget before/after, identity/conflict/overflow/race tests, no mutation on failure |
| #25 | v3 export/import with persisted revision/audit/relation/provenance state, remapping and rollback tests, migration coverage |
| #26 | Durable batch record, every mutation linked to batch/hash, inspect CLI/resource, failure/retry/redaction tests |
| #27 | Exact candidate SHA, green Linux/macOS/Windows Node 24 matrix, no skipped critical tests, workflow evidence artifact |
| #28 | Clean extracted Linux/macOS/Windows artifacts pass full MCP lifecycle and cleanup checks |
| #29 | `v1.1.2` annotated tag, unchanged prior tags, checksums, release notes, #19 evidence comment |

## Risks and Explicit Mitigations

- **Full-history scope expansion:** keep the v3 bundle schema and remapping policy bounded to the entities named in #25; do not add unrelated synchronization or embedding features.
- **History identifier collisions:** never insert source autoincrement ids blindly; use deterministic source-to-target maps and assert referential integrity before commit.
- **Admin boundary portability:** fail closed when capability permissions/ACLs cannot be verified; test POSIX and Windows separately.
- **Windows concurrency duration:** measure the real release profile before freezing #27. If the documented profile cannot complete within the workflow budget, treat that as a release-blocking capacity problem and adjust only through an explicit #20 evidence decision, never by silently reducing required invariants.
- **Profile regression:** keep canonical profile names in one source (`register-tools.ts`) and make every black-box test consume the selected profile rather than hard-code the old 20-tool union.
- **Evidence invalidation:** any code, package metadata, workflow, or artifact change after the candidate SHA resets Tasks 8–10 verification.

## Plan Self-Review

- All ten linked SubIssues have a task and an exit gate.
- The user-selected #25 Option B is explicit in the header, baseline decisions, Task 6, dependency graph, and verification matrix.
- Public-boundary tests are required for MCP, CLI, resources, import, and extracted artifacts; direct SQLite tests are supplementary.
- No existing release tag is moved; version/package/release evidence is tied to one SHA.
- The only intentional new schema elements are the versioned full-history/batch-lineage structures, each with migration and rollback tests.
- The plan contains no unresolved scope marker or silent test suppression.
