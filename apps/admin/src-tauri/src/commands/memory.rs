//! Tauri commands for memory row-level reads (list / get / stats).
//!
//! v0.1 数据源是 `memory_entries` 表(不是 `memories`,那是 brief 里的旧命名;
//! 实际 schema 早就迁到 v4+ 的 `memory_entries`,见 `src/sqlite-store.ts:805`)。
//!
//! 行 parser 把 DB 文本列解出来:
//! - `tags_json` (TEXT)        → `Vec<String>`  via `serde_json`
//! - `supersedes_json` (TEXT)  → `Vec<String>`  via `serde_json`
//! - `source_json` (TEXT)      → `serde_json::Value`
//!
//! 反序列化失败时降级为默认值,不阻断整页 / 整图(和 `reader/graph.rs` 对
//! `supersedes_json` 的容忍策略一致)。

use crate::reader::types::{MemoryScope, MemoryStatus, MemoryType};
use crate::reader::AppError;
use crate::AppState;
use rusqlite::{params, params_from_iter, Connection, ToSql};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;

/// Memory 行的 wire 类型。
///
/// 注意这里的 `Memory` 是 **Tauri command 的响应类型**,与 `packages/contracts`
/// 里的 `Memory` 是两套:DB 里 `sensitivity` 是 TEXT,所以这里用 `String` 透传,
/// 而不是 contracts 里的 enum(契约校验放前端,这里只负责"原样送过去")。
#[derive(Debug, Serialize, Deserialize)]
pub struct Memory {
    pub id: String,
    pub scope: MemoryScope,
    pub project_id: Option<String>,
    #[serde(rename = "type")]
    pub memory_type: MemoryType,
    pub topic: String,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub importance: u8,
    pub confidence: u8,
    pub sensitivity: String,
    pub status: MemoryStatus,
    pub supersedes: Vec<String>,
    pub source: serde_json::Value,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    pub revision: u32,
}

/// `list_memories` 过滤条件,所有字段可选。
///
/// 复刻 `@agent-recall/contracts` 的 `MemoryListFilter`(等 v0.2 在 contracts
/// 端补 zod schema;v0.1 后端先按这个形状接住前端请求)。
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct MemoryListFilter {
    pub scope: Option<MemoryScope>,
    pub project_id: Option<String>,
    pub topic: Option<String>,
    pub status: Option<Vec<MemoryStatus>>,
    pub min_importance: Option<u8>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MemoryListResponse {
    pub items: Vec<Memory>,
    pub total: u32,
    pub page: u32,
    pub page_size: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StatsResponse {
    pub total: u32,
    pub by_type: HashMap<String, u32>,
    pub by_status: HashMap<String, u32>,
}

/// Tauri command: 分页查询 memories。
///
/// v0.1 简化版:支持 `scope / project_id / topic / status / min_importance` 五个
/// 维度的 WHERE 拼装(参照 `reader/graph.rs::build_where` 的模式),
/// `page / page_size` 固定 `1..=200` 防御性 clamp。
#[tauri::command]
pub async fn list_memories(
    state: State<'_, AppState>,
    filter: Option<MemoryListFilter>,
    page: Option<u32>,
    page_size: Option<u32>,
) -> Result<MemoryListResponse, AppError> {
    let guard = state.reader.lock().unwrap();
    let reader = guard.as_ref().ok_or_else(|| {
        AppError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "DB not opened",
        ))
    })?;
    let filter = filter.unwrap_or_default();
    let page = page.unwrap_or(1).max(1);
    let page_size = page_size.unwrap_or(50).clamp(1, 200);
    let offset = (page - 1) * page_size;

    let conn = reader.conn_ref();
    let (where_sql, bind_values) = build_where(&filter);

    // 1) total
    let total_sql = format!("SELECT COUNT(*) FROM memory_entries {}", where_sql);
    let bind_refs: Vec<&dyn ToSql> = bind_values.iter().map(|b| b.as_ref()).collect();
    let total: u32 = conn.query_row(&total_sql, params_from_iter(bind_refs), |r| r.get(0))?;

    // 2) items
    let mut all_bind = bind_values;
    all_bind.push(Box::new(page_size as i64));
    all_bind.push(Box::new(offset as i64));
    let items_sql = format!(
        "SELECT id, scope, project_id, type, topic, title, body, tags_json, importance, confidence, sensitivity, status, supersedes_json, source_json, created_at, updated_at, revision \
         FROM memory_entries {} ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?",
        where_sql
    );
    let mut stmt = conn.prepare(&items_sql)?;
    let bind_refs2: Vec<&dyn ToSql> = all_bind.iter().map(|b| b.as_ref()).collect();
    let items: Vec<Memory> = stmt
        .query_map(params_from_iter(bind_refs2), parse_memory_row)?
        .collect::<Result<_, _>>()
        .map_err(AppError::Sqlite)?;

    Ok(MemoryListResponse {
        items,
        total,
        page,
        page_size,
    })
}

/// Tauri command: 单条 memory 查询,找不到直接返回 `Sqlite` error
/// (rusqlite 在 `query_row` 找不到时给 `QueryReturnedNoRows`,前端 catch 即可)。
#[tauri::command]
pub async fn get_memory(
    state: State<'_, AppState>,
    id: String,
) -> Result<Memory, AppError> {
    let guard = state.reader.lock().unwrap();
    let reader = guard.as_ref().ok_or_else(|| {
        AppError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "DB not opened",
        ))
    })?;
    let conn = reader.conn_ref();
    let mem = conn.query_row(
        "SELECT id, scope, project_id, type, topic, title, body, tags_json, importance, confidence, sensitivity, status, supersedes_json, source_json, created_at, updated_at, revision \
         FROM memory_entries WHERE id = ?",
        params![id],
        parse_memory_row,
    )?;
    Ok(mem)
}

/// Tauri command: 聚合统计,两条 `GROUP BY` + 一条总行数。
#[tauri::command]
pub async fn get_memory_stats(
    state: State<'_, AppState>,
) -> Result<StatsResponse, AppError> {
    let guard = state.reader.lock().unwrap();
    let reader = guard.as_ref().ok_or_else(|| {
        AppError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "DB not opened",
        ))
    })?;
    let conn = reader.conn_ref();

    let by_type = group_count(conn, "type")?;
    let by_status = group_count(conn, "status")?;
    let total: u32 =
        conn.query_row("SELECT COUNT(*) FROM memory_entries", [], |r| r.get(0))?;

    Ok(StatsResponse {
        total,
        by_type,
        by_status,
    })
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// `list_memories` 的 WHERE 拼装,字段全可选,模型参照
/// `reader::graph::build_where`(同一个项目里的同款 WHERE 拼装风格)。
fn build_where(filter: &MemoryListFilter) -> (String, Vec<Box<dyn ToSql>>) {
    let mut where_clauses: Vec<String> = vec![];
    let mut bind_values: Vec<Box<dyn ToSql>> = vec![];

    if let Some(scope) = &filter.scope {
        where_clauses.push("scope = ?".to_string());
        bind_values.push(Box::new(memory_scope_str(scope).to_string()));
    }
    if let Some(pid) = &filter.project_id {
        where_clauses.push("project_id = ?".to_string());
        bind_values.push(Box::new(pid.clone()));
    }
    if let Some(topic) = &filter.topic {
        where_clauses.push("topic = ?".to_string());
        bind_values.push(Box::new(topic.clone()));
    }
    if let Some(statuses) = &filter.status {
        if !statuses.is_empty() {
            let placeholders = statuses
                .iter()
                .map(|_| "?")
                .collect::<Vec<_>>()
                .join(",");
            where_clauses.push(format!("status IN ({})", placeholders));
            for s in statuses {
                bind_values.push(Box::new(memory_status_str(s).to_string()));
            }
        }
    }
    if let Some(min_imp) = filter.min_importance {
        where_clauses.push("importance >= ?".to_string());
        bind_values.push(Box::new(min_imp));
    }

    let where_sql = if where_clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", where_clauses.join(" AND "))
    };
    (where_sql, bind_values)
}

/// 通用 `SELECT <col>, COUNT(*) FROM memory_entries GROUP BY <col>`。
fn group_count(conn: &Connection, col: &str) -> Result<HashMap<String, u32>, AppError> {
    let sql = format!(
        "SELECT {}, COUNT(*) FROM memory_entries GROUP BY {}",
        col, col
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut out = HashMap::new();
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
    })?;
    for r in rows {
        let (k, v) = r?;
        out.insert(k, v);
    }
    Ok(out)
}

/// 把 `memory_entries` 一行解析成 `Memory`。DB 列顺序见
/// `commands::list_memories` 的 SQL;`get_memory` 共享同一段解析逻辑。
fn parse_memory_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Memory> {
    let scope_str: String = row.get(1)?;
    let type_str: String = row.get(3)?;
    let status_str: String = row.get(11)?;
    let tags_json: String = row.get(7)?;
    let supersedes_json: String = row.get(12)?;
    let source_json: String = row.get(13)?;
    Ok(Memory {
        id: row.get(0)?,
        scope: parse_scope(&scope_str).map_err(|_| rusqlite::Error::InvalidQuery)?,
        project_id: row.get(2)?,
        memory_type: parse_type(&type_str).map_err(|_| rusqlite::Error::InvalidQuery)?,
        topic: row.get(4)?,
        title: row.get(5)?,
        body: row.get(6)?,
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        importance: row.get(8)?,
        confidence: row.get(9)?,
        sensitivity: row.get(10)?,
        status: parse_status(&status_str).map_err(|_| rusqlite::Error::InvalidQuery)?,
        supersedes: serde_json::from_str(&supersedes_json).unwrap_or_default(),
        source: serde_json::from_str(&source_json).unwrap_or_else(|_| serde_json::json!({})),
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
        revision: row.get(16)?,
    })
}

// 列值 → enum 的解析器(失败时返回 `AppError::Sqlite`,前端会拿到 4xx +
// code=`DB_QUERY_FAILED`)。沿用 `reader::graph` 的字符串约定:
// scope ∈ {global, project} / type ∈ {preference..constraint} /
// status ∈ {active, archived, superseded, forgotten}。
fn parse_scope(s: &str) -> Result<MemoryScope, AppError> {
    match s {
        "global" => Ok(MemoryScope::Global),
        "project" => Ok(MemoryScope::Project),
        _ => Err(AppError::Sqlite(rusqlite::Error::InvalidQuery)),
    }
}

fn parse_type(s: &str) -> Result<MemoryType, AppError> {
    match s {
        "preference" => Ok(MemoryType::Preference),
        "procedure" => Ok(MemoryType::Procedure),
        "fact" => Ok(MemoryType::Fact),
        "decision" => Ok(MemoryType::Decision),
        "lesson" => Ok(MemoryType::Lesson),
        "debugging" => Ok(MemoryType::Debugging),
        "constraint" => Ok(MemoryType::Constraint),
        _ => Err(AppError::Sqlite(rusqlite::Error::InvalidQuery)),
    }
}

fn parse_status(s: &str) -> Result<MemoryStatus, AppError> {
    match s {
        "active" => Ok(MemoryStatus::Active),
        "archived" => Ok(MemoryStatus::Archived),
        "superseded" => Ok(MemoryStatus::Superseded),
        "forgotten" => Ok(MemoryStatus::Forgotten),
        _ => Err(AppError::Sqlite(rusqlite::Error::InvalidQuery)),
    }
}

fn memory_scope_str(s: &MemoryScope) -> &'static str {
    match s {
        MemoryScope::Global => "global",
        MemoryScope::Project => "project",
    }
}

fn memory_status_str(s: &MemoryStatus) -> &'static str {
    match s {
        MemoryStatus::Active => "active",
        MemoryStatus::Archived => "archived",
        MemoryStatus::Superseded => "superseded",
        MemoryStatus::Forgotten => "forgotten",
    }
}
