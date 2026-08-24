pub mod graph;
pub mod schema_version;
pub mod types;

use crate::reader::graph::get_graph as get_graph_impl;
use crate::reader::schema_version::check;
use crate::reader::types::{DbStatus, GraphFilter, GraphResponse};
use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("schema version mismatch: expected {expected}, actual {actual}")]
    SchemaVersionMismatch { expected: u32, actual: u32 },
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let (code, message) = match self {
            AppError::SchemaVersionMismatch { expected, actual } => (
                "SCHEMA_VERSION_MISMATCH",
                format!("expected {}, actual {}", expected, actual),
            ),
            AppError::Sqlite(e) => ("DB_QUERY_FAILED", e.to_string()),
            AppError::Io(e) => ("IO_ERROR", e.to_string()),
        };
        let mut st = s.serialize_struct("AppError", 2)?;
        st.serialize_field("code", code)?;
        st.serialize_field("message", &message)?;
        st.end()
    }
}

pub struct SQLiteReader {
    conn: Connection,
    db_path: PathBuf,
}

impl SQLiteReader {
    pub fn open(path: &Path) -> Result<Self, AppError> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        check(&conn)?;
        Ok(Self {
            conn,
            db_path: path.to_path_buf(),
        })
    }

    pub fn db_status(&self) -> Result<DbStatus, AppError> {
        let v: u32 = self.conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        let mtime_ms = schema_version::mtime_ms(&self.db_path)?;
        let size_bytes = std::fs::metadata(&self.db_path)?.len();
        Ok(DbStatus {
            schema_version: v,
            mtime_ms,
            size_bytes,
        })
    }

    /// v0.1: 真实 SQL 实现(详见 `reader::graph::get_graph`)。
    pub fn get_graph(&self, filter: GraphFilter) -> Result<GraphResponse, AppError> {
        get_graph_impl(&self.conn, &filter).map_err(AppError::Sqlite)
    }

    /// 暴露只读 `Connection` 引用,给 Tauri commands(`list_memories` /
    /// `get_memory` / `get_memory_stats`)用。reader 内部仍以 read-only +
    /// no-mutex 打开,调用方拿到的也是只读句柄。
    pub fn conn_ref(&self) -> &Connection {
        &self.conn
    }
}
