//! Integration tests for the AgentRecall Admin Tauri backend (v0.1).
//!
//! These tests sit one layer above the pure unit tests in
//! `tests/reader_graph_test.rs`: they call the same `SQLiteReader` API
//! the Tauri commands dispatch to, but in a small "integration" frame:
//!
//! 1. They seed a real SQLite file via `common::fixture_db()` (the
//!    same fixture the unit tests use, so the test corpus stays
//!    consistent).
//! 2. They verify wire-level contracts: the JSON shape returned by
//!    `SQLiteReader::db_status` and `SQLiteReader::get_graph` must
//!    match the field names defined in `@agent-recall/contracts`
//!    (see `packages/contracts/src/graph.ts`).
//!
//! ## Why no Tauri builder here?
//!
//! Brief Task 12 originally planned to spin up an in-process Tauri
//! builder via `tauri::test::mock_builder() + mock_context(noop_assets())`
//! and call `app.handle().invoke()` to exercise the `#[tauri::command]`
//! wrappers end-to-end. Tauri 2.0 ships the `tauri::test` module
//! behind the `test` cargo feature (`#[cfg(any(test, feature = "test"))]`),
//! and the exact surface (`mock_builder` / `mock_context` / `noop_assets` /
//! `MockRuntime`) is still churning across minor versions. We are on
//! `tauri v2.11.5` and the feature is **not** enabled in `Cargo.toml`
//! because pulling it in would also flip on dev-only `tokio`/`runtime`
//! machinery for a real desktop build. Per the brief's own fallback
//! ("v0.1 退化为只跑单元测试(Task 10 已覆盖),把 Tauri 集成测试整体挪到 v0.2"),
//! v0.1 ships without the Tauri builder integration test. The two
//! tests below cover the same contract surface (response shape) by
//! going through the public Rust API the commands wrap. v0.2 picks
//! this up when the Tauri 2.0 mock helpers are stable.

mod common;

use agent_recall_admin_lib::reader::types::{GraphFilter, GraphResponse};
use agent_recall_admin_lib::reader::SQLiteReader;

/// `SQLiteReader::db_status()` returns the schema version from
/// `PRAGMA user_version` plus the file's mtime and size.
///
/// The Tauri command `get_db_status` forwards this object straight
/// to the frontend (see `src/lib.rs::get_db_status`), so its field
/// set is part of the wire contract. We assert the *Rust-side*
/// values here; the TypeScript-side `zod` schema lives in
/// `packages/contracts/` and is exercised by the contract-sync CI.
#[test]
fn get_db_status_returns_schema_version_and_mtime() {
    let (_dir, db_path) = common::fixture_db();
    let reader = SQLiteReader::open(&db_path).unwrap();
    let s = reader.db_status().unwrap();

    // The fixture's seed.sql sets `PRAGMA user_version = 13` to match
    // `reader::schema_version::SCHEMA_VERSION` (production = 13).
    assert_eq!(s.schema_version, 13, "schema_version should reflect PRAGMA user_version");
    assert!(s.mtime_ms > 0, "mtime_ms should be a positive Unix-ms timestamp");
    assert!(s.size_bytes > 0, "size_bytes should be the real file size");
}

/// `SQLiteReader::get_graph()` returns a `GraphResponse` whose top-
/// level field names must match the zod schema in
/// `packages/contracts/src/graph.ts::GraphResponseSchema`.
///
/// This is a *shape* test, not a *value* test: we serialize the
/// response to `serde_json::Value` and check the top-level keys are
/// exactly `{nodes, edges, total, truncated, generated_at}`. Field-
/// level value checks (e.g. `weight ∈ [0,1]`, `importance ∈ [1,5]`)
/// are owned by the contracts package's own zod tests.
#[test]
fn get_graph_matches_zod_schema_shape() {
    let (_dir, db_path) = common::fixture_db();
    let reader = SQLiteReader::open(&db_path).unwrap();
    let r: GraphResponse = reader.get_graph(GraphFilter::default()).unwrap();

    let j = serde_json::to_value(&r).unwrap();
    let obj = j.as_object().expect("GraphResponse should serialize to a JSON object");

    // Every key in `packages/contracts/src/graph.ts::GraphResponseSchema`
    // must be present at the top level.
    assert!(obj.get("nodes").is_some(), "top-level `nodes` missing");
    assert!(obj.get("edges").is_some(), "top-level `edges` missing");
    assert!(obj.get("total").is_some(), "top-level `total` missing");
    assert!(obj.get("truncated").is_some(), "top-level `truncated` missing");
    assert!(obj.get("generated_at").is_some(), "top-level `generated_at` missing");

    // No drift: a stray top-level key would mean the Rust struct and
    // the zod schema have diverged. Catch it here so the next contract-
    // sync CI pass can flag it.
    let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
    keys.sort();
    assert_eq!(
        keys,
        vec!["edges", "generated_at", "nodes", "total", "truncated"],
        "GraphResponse top-level keys must match the zod schema"
    );
}
