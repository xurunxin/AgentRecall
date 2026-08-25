//! Unit tests for `SQLiteReader::get_graph`.
//!
//! Each test seeds an isolated SQLite file via `common::fixture_db` (or
//! builds a deliberately mismatched file) and exercises a single
//! contract: empty DB, topic pairing, scope filter default, truncation,
//! status filter, schema version guard, missing file.
//!
//! Note: `GraphFilter::default()` is hand-written to mirror the per-field
//! `#[serde(default = "fn")]` annotations. `test_default_filter()` here
//! exists for historical reasons; with the fix landed, `Default::default()`
//! is the source of truth and the helper is kept only for readability in
//! each test case. See the regression test at the bottom of this file.

mod common;

use agent_recall_admin_lib::reader::types::{EdgeKind, GraphFilter, MemoryStatus};
use agent_recall_admin_lib::reader::SQLiteReader;
use common::{fixture_db, fixture_db_empty};

/// Mirror of the documented production defaults (the `serde` defaults
/// on `GraphFilter`):
/// - `max_nodes: 500` (no truncation)
/// - `status: vec![Active]`
/// - `include_co_topic: true`
/// - `include_co_scope: false`
fn test_default_filter() -> GraphFilter {
    GraphFilter {
        max_nodes: 500,
        status: vec![MemoryStatus::Active],
        include_co_topic: true,
        include_co_scope: false,
        ..Default::default()
    }
}

#[test]
fn empty_db_returns_no_nodes() {
    // Schema in place, no rows: `get_graph` should return total = 0
    // and an empty node list — not error.
    let (_dir, db_path) = fixture_db_empty();
    let reader = SQLiteReader::open(&db_path).unwrap();
    let r = reader.get_graph(test_default_filter()).unwrap();
    assert_eq!(r.total, 0);
    assert!(r.nodes.is_empty());
    assert!(r.edges.is_empty());
    assert!(!r.truncated);
}

#[test]
fn seed_db_returns_ten_nodes() {
    let (_dir, db_path) = fixture_db();
    let reader = SQLiteReader::open(&db_path).unwrap();
    let r = reader.get_graph(test_default_filter()).unwrap();
    assert_eq!(r.total, 10);
    assert_eq!(r.nodes.len(), 10);
}

#[test]
fn co_topic_edges_pair_within_same_topic() {
    // Seed has 7 `cache` + 3 `auth` entries. co_topic pairs every pair
    // inside the same topic, so we expect C(7,2) + C(3,2) = 21 + 3 = 24.
    let (_dir, db_path) = fixture_db();
    let reader = SQLiteReader::open(&db_path).unwrap();
    let r = reader.get_graph(test_default_filter()).unwrap();

    let co_topic_count = r
        .edges
        .iter()
        .filter(|e| matches!(e.kind, EdgeKind::CoTopic))
        .count();
    assert_eq!(co_topic_count, 21 + 3);
}

#[test]
fn co_scope_disabled_by_default() {
    // All 10 seed rows share the same `project_id`, so co_scope *could*
    // pair them. The default filter keeps it off, so no co_scope edges
    // should appear.
    let (_dir, db_path) = fixture_db();
    let reader = SQLiteReader::open(&db_path).unwrap();
    let r = reader.get_graph(test_default_filter()).unwrap();

    let co_scope_count = r
        .edges
        .iter()
        .filter(|e| matches!(e.kind, EdgeKind::CoScope))
        .count();
    assert_eq!(co_scope_count, 0);
}

#[test]
fn max_nodes_truncates() {
    let (_dir, db_path) = fixture_db();
    let reader = SQLiteReader::open(&db_path).unwrap();
    let filter = GraphFilter {
        max_nodes: 5,
        ..test_default_filter()
    };
    let r = reader.get_graph(filter).unwrap();
    assert_eq!(r.total, 10);
    assert_eq!(r.nodes.len(), 5);
    assert!(r.truncated);
}

#[test]
fn filter_status_archived_returns_nothing() {
    // Seed has only `active` rows; filtering to `archived` should
    // produce an empty result without erroring.
    let (_dir, db_path) = fixture_db();
    let reader = SQLiteReader::open(&db_path).unwrap();
    let filter = GraphFilter {
        status: vec![MemoryStatus::Archived],
        ..test_default_filter()
    };
    let r = reader.get_graph(filter).unwrap();
    assert_eq!(r.total, 0);
}

#[test]
fn schema_version_mismatch_errors() {
    // Bump the pragma to an obviously wrong value and verify
    // `SQLiteReader::open` refuses with the structured error.
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("stale.db");
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    conn.execute_batch("PRAGMA user_version = 999;").unwrap();
    drop(conn);

    let r = SQLiteReader::open(&db_path);
    assert!(matches!(
        r,
        Err(agent_recall_admin_lib::reader::AppError::SchemaVersionMismatch { .. })
    ));
}

#[test]
fn nonexistent_db_errors() {
    // A path that was never created must surface as an open error.
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("nope.db");
    let r = SQLiteReader::open(&db_path);
    assert!(r.is_err());
}

/// Regression test for the `GraphFilter::default()` fix.
///
/// `#[derive(Default)]` only invokes each field's own `Default` impl, so it
/// ignored the `#[serde(default = "fn")]` annotations and produced the
/// "give me nothing" filter (`max_nodes: 0`, `status: vec![]`,
/// `include_co_topic: false`). The hand-written `Default` impl must match
/// the documented production defaults so that `Default::default()` is
/// usable as a `GraphFilter` value (for tests, internal calls, and any
/// Tauri command that accepts an omitted filter argument).
#[test]
fn graph_filter_default_matches_serde_defaults() {
    let f = GraphFilter::default();
    assert_eq!(f.max_nodes, 500, "max_nodes should default to 500");
    assert_eq!(f.status, vec![MemoryStatus::Active], "status should default to [Active]");
    assert!(f.include_co_topic, "include_co_topic should default to true");
    assert!(!f.include_co_scope, "include_co_scope should default to false");
    assert_eq!(f.project_id, None);
    assert_eq!(f.topic, None);
    assert_eq!(f.node_type, None);
    assert_eq!(f.min_importance, None);
}
