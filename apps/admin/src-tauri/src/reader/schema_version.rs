use crate::reader::AppError;
use rusqlite::Connection;
use std::path::Path;

/// v0.1: 必须与 `src/sqlite-store.ts` 中的 `CURRENT_SCHEMA_VERSION` 保持一致。
///
/// 实际值来自 `src/sqlite-store.ts:141`: `export const CURRENT_SCHEMA_VERSION = 13;`
/// (在 Task 8 实现时,该版本号 = 13。后续 v0.1.x 升级 schema 时,这里必须同步改;
/// CI 会在 Task 5 之外另加一个 contract 校验。)
pub const SCHEMA_VERSION: u32 = 13;

pub fn check(conn: &Connection) -> Result<(), AppError> {
    let v: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if v != SCHEMA_VERSION {
        return Err(AppError::SchemaVersionMismatch {
            expected: SCHEMA_VERSION,
            actual: v,
        });
    }
    Ok(())
}

pub fn mtime_ms(path: &Path) -> Result<i64, AppError> {
    let meta = std::fs::metadata(path)?;
    let mtime = meta.modified()?;
    let dt: chrono::DateTime<chrono::Utc> = mtime.into();
    Ok(dt.timestamp_millis())
}
