# ADR-0010: Typed asset registry (issue #51)

## Context

v1.2.0-alpha.0 added the derivation job substrate (#48); v1.2.0-alpha.1 added the session evidence ledger (#49). v1.2.0-alpha.1 also needed a place to **land the durable, versioned outputs** of the future pipeline: skill assets, context packs, external references, and the memory_ref binding that ties an asset version to a memory revision.

The pre-v1.2 codebase had no concept of a versioned asset. Derived knowledge lived either in the memory store (one row per fact) or in the agent's filesystem (one file per skill, no versioning, no cross-link). We needed:

- A canonical envelope (asset_id + asset_type + lifecycle) that survives schema migrations
- An append-only version log so every state change is auditable
- A typed binding (e.g. `memory_ref`) that ties a specific asset version to a specific memory revision
- A forward-compatible shape: the v1.2-alpha.1 envelope ships with one type-specific table (`memory_ref_bindings`); `skill` / `context_pack` / `external_reference` type-specific tables land with their owning Phase 2 issues (#53 / #54)

## Decision

We add the v1.2.0-alpha.1 schema v16 migration (`migrate_v15_to_v16`) introducing four additive tables:

- `assets` — the canonical envelope. `asset_id` is the identity; `asset_type` is a CHECK-constrained string (`memory_ref` | `skill` | `context_pack` | `external_reference`); `lifecycle_state` is a 4-value state machine (`draft` → `active` → `deprecated` → `archived`); `current_version` is the head pointer. `archived` is a one-way transition (`asset_already_terminal` rejects un-archive).
- `asset_versions` — the append-only version log. `(asset_id, version)` is the composite primary key; `content_hash` is `sha256:hex64` over the canonicalised type-specific payload; `schema_version` is the version of the per-type schema; `manifest_json` is the JSON-encoded body (the full type-specific row lives in the type-specific table, keyed on `(asset_id, version)`).
- `asset_relations` — directional links between assets (or from an asset to an external target). The CHECK constraint `(to_asset_id IS NOT NULL) <> (external_target_ref IS NOT NULL)` ensures the relation has exactly one of the two.
- `memory_ref_bindings` — the only v16-shipped type-specific table. Binds an `(asset_id, version)` to a `(memory_id, memory_revision)` so the asset version is causally pinned to the memory revision that produced it. Immutable: a new version appends a row, the previous version stays.

`AssetService` (issue #51) wraps the registry:

- `createMemoryRef` does a CAS-style version append + immutable binding insert in a single transaction
- `list` / `show` / `history` are read-only
- `setLifecycle` is the only state transition; `archived` is one-way
- All read paths honour the SQL-boundary sensitivity filter; the `archived` state hides the asset from the search recall

The contracts surface (`packages/contracts/src/assets.ts`) is the v1 wire shape: 11 zod schemas, including 4 type-specific discriminated unions. The `MemoryRefBindingV1` schema is the v1.2-alpha.1-shipped type; the other three are placeholders for #53 / #54.

## Schema invariants

Documented in the JSDoc on `migrate_v15_to_v16` in `src/sqlite-store.ts`:

- `assets.current_version` is the head; new versions append monotonically and `asset_versions.content_hash` is the SHA-256 over the canonicalised type-specific payload.
- `asset_relations` is directional; the CHECK constraint ensures the relation has exactly one of `to_asset_id` or `external_target_ref`.
- `memory_ref_bindings` is the only v16 type-specific table. The binding is immutable: a new version appends a row, the previous version stays.
- `lifecycle_state = 'archived'` requires `archived_at IS NOT NULL` (the row knows when it was archived).
- The scope guard: `scope = 'project'` requires `project_id IS NOT NULL`; `scope = 'global'` requires `project_id IS NULL`.
- The trust + sensitivity + lifecycle state machines are all CHECK-constrained; the v1.2 sensitivity policy (`docs/adr/0006`) is the source of truth for the 3-value sensitivity enum.

## Trade-offs

- **Envelope + version-log + type-specific table** (vs. a single polymorphic blob): the three-table shape lets every type land its own primary schema (skill rows for `SKILL.md` parsing, context_pack rows for compression metadata, etc.) without touching the envelope. The trade-off is more tables; the v1.2 scale (thousands of assets) is well within SQLite's per-table row budget.
- **Append-only version log**: every state change is a new row, never an UPDATE. The trade-off is more rows + a `current_version` pointer that has to be CAS-bumped. The benefit is `asset_versions` is a perfect audit trail.
- **Type-specific table per `asset_type`**: the envelope's `asset_type` decides which type-specific table to read for the body. The v1.2-alpha.1 contract reserves four type-specific tables (`memory_ref_bindings` is shipped; `skills` / `context_packs` / `external_references` land with #53 / #54). The trade-off is a switch statement on `asset_type`; the v1.2 alternative would be one JSON-blob column, but that loses SQL-boundary validation.
- **`memory_ref_bindings` is the v1.2-alpha.1 anchor**: every future `memory`-derived asset version is causally pinned to a memory revision. The trade-off is a 1-row-per-version cascade; the benefit is "why does this skill exist?" is answerable by joining the binding to `memory_revisions` (issue #6 history table).

## What ships in v1.2.0-alpha.1

- `src/assets/service.ts` — `AssetService` (createMemoryRef / list / show / history / setLifecycle)
- CLI: `agent-recall assets list | show | history | lifecycle | create-memory-ref`
- MCP resource: `agentrecall://assets/{asset_id}`
- Contracts: `packages/contracts/src/assets.ts` 11 zod schemas (4 type-specific discriminated unions)
- Tests: `test/unit/assets-service.test.ts` (8) + `test/cli/assets.test.ts` (5) + `packages/contracts/tests/assets.test.ts` (17)

## Out of scope (deferred)

- `skill` / `context_pack` / `external_reference` type-specific tables + executor — land with their owning Phase 2 issues (#53 / #54)
- HTTP bridge assets endpoints — Phase 3
- Admin app asset browser — Phase 3
- Cross-asset cascade delete (today, `assets` `ON DELETE CASCADE` is wired to `asset_versions`; cross-type cleanup is a v1.3 maintenance concern)
