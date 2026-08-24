#![allow(dead_code)]

use rusqlite::Connection;
use std::path::PathBuf;
use tempfile::TempDir;

/// Build a fresh SQLite DB in a tempdir, run the seed fixture, and
/// return `(TempDir, db_path)`. Holding the `TempDir` keeps the file
/// alive for the duration of the test; dropping it removes everything.
///
/// The DB is created with `PRAGMA user_version = 13` so it matches the
/// production `SCHEMA_VERSION` and `SQLiteReader::open` accepts it.
pub fn fixture_db() -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("test.db");
    let conn = Connection::open(&db_path).unwrap();
    // `include_str!` is resolved relative to this file, which lives at
    // `tests/common/mod.rs`; the fixture sits one level up at
    // `tests/fixtures/seed.sql`.
    let seed = include_str!("../fixtures/seed.sql");
    conn.execute_batch(seed).unwrap();
    drop(conn);
    (dir, db_path)
}

/// Build a fresh SQLite DB with the same schema as `fixture_db()` but
/// **no rows**. Used to exercise the "empty graph" path: `get_graph`
/// should return `total = 0` and an empty node list instead of erroring.
pub fn fixture_db_empty() -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("empty.db");
    let conn = Connection::open(&db_path).unwrap();
    let seed = include_str!("../fixtures/seed.sql");
    // Run the schema + pragma only (everything before the first INSERT).
    // `seed.sql` is laid out so this works regardless of newlines.
    let schema_only: String = seed
        .split("INSERT INTO memory_entries")
        .next()
        .unwrap()
        .to_string();
    conn.execute_batch(&schema_only).unwrap();
    drop(conn);
    (dir, db_path)
}
