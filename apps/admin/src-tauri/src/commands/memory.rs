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

/// `get_memory` 返回的完整详情(在 `Memory` 全字段基础上加 `related`)。
///
/// wire 兼容 v0.1:所有 `Memory` 字段名 + 类型保持不变,新加的 `related` 字段
/// 是后置的(用 `#[serde(rename = "type")]` 复用 v0.1 的 wire 字段名),所以
/// v0.1 前端如果只看 `Memory` 字段,序列化结果不会变。
#[derive(Debug, Serialize, Deserialize)]
pub struct MemoryDetail {
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
    pub related: MemoryRelations,
}

/// `get_memory` 返回的关联节点集。`Default` 让 `get_memory_for_test` / 前端
/// mock 可以空初始化,正常路径走全字段填充。
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct MemoryRelations {
    pub supersedes: Vec<RelatedNode>,
    pub superseded_by: Vec<RelatedNode>,
    /// TODO v0.3: GraphEdge 持久化后,从 `graph_edges` 表填充;v0.2 阶段
    /// `merge` 始终为空,前端按"无 merge 边"渲染。
    pub merge: Vec<RelatedNode>,
    pub co_topic: Vec<RelatedNode>,
    pub co_topic_total: u32,
    pub co_scope: Vec<RelatedNode>,
    pub co_scope_total: u32,
}

/// 关联节点摘要,wire 上叫 `RelatedNode`(contracts package 同名)。
#[derive(Debug, Serialize, Deserialize)]
pub struct RelatedNode {
    pub id: String,
    pub title: String,
    pub topic: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub status: String,
    pub importance: u8,
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

/// Tauri command: 单条 memory 详情,返回 `MemoryDetail`(`Memory` 全字段 + 4 类
/// 关联节点)。找不到直接返回 `Sqlite` error(rusqlite 在 `query_row` 找不到时
/// 给 `QueryReturnedNoRows`,前端 catch 即可)。
#[tauri::command]
pub async fn get_memory(
    state: State<'_, AppState>,
    id: String,
) -> Result<MemoryDetail, AppError> {
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
    let detail = build_memory_detail(conn, &mem, &id)?;
    Ok(detail)
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

// ---------------------------------------------------------------------------
// get_memory / MemoryDetail 相关(related 4 子查询 + test helper)
// ---------------------------------------------------------------------------

/// 在主行已查到 `Memory` 之后,跑 4 类关联子查询并组装成 `MemoryDetail`。
///
/// 与 `get_memory_for_test` 共享同一段逻辑,避免 wire 行为漂移。
fn build_memory_detail(
    conn: &Connection,
    mem: &Memory,
    self_id: &str,
) -> Result<MemoryDetail, AppError> {
    let supersedes = related_summary_for_ids(conn, &mem.supersedes)?;
    let superseded_by = related_superseded_by(conn, self_id)?;
    let merge: Vec<RelatedNode> = vec![]; // TODO v0.3: GraphEdge 持久化后填充
    let (co_topic, co_topic_total) = related_by_field(
        conn,
        "topic",
        &mem.topic,
        std::slice::from_ref(&self_id),
        5,
    )?;
    let scope_value = memory_scope_str(&mem.scope).to_string();
    let (co_scope, co_scope_total) = related_by_scope(
        conn,
        &scope_value,
        mem.project_id.as_deref(),
        self_id,
        3,
    )?;
    Ok(MemoryDetail {
        id: mem.id.clone(),
        scope: mem.scope.clone(),
        project_id: mem.project_id.clone(),
        memory_type: mem.memory_type.clone(),
        topic: mem.topic.clone(),
        title: mem.title.clone(),
        body: mem.body.clone(),
        tags: mem.tags.clone(),
        importance: mem.importance,
        confidence: mem.confidence,
        sensitivity: mem.sensitivity.clone(),
        status: mem.status.clone(),
        supersedes: mem.supersedes.clone(),
        source: mem.source.clone(),
        created_at: mem.created_at,
        updated_at: mem.updated_at,
        revision: mem.revision,
        related: MemoryRelations {
            supersedes,
            superseded_by,
            merge,
            co_topic,
            co_topic_total,
            co_scope,
            co_scope_total,
        },
    })
}

/// 按 id 列表拉 `RelatedNode` 摘要(给 `supersedes` 用)。空 id 列表直接
/// 返回空 vec,跳过 SQL(避免生成 `IN ()` 这种非法 SQL)。
fn related_summary_for_ids(
    conn: &Connection,
    ids: &[String],
) -> Result<Vec<RelatedNode>, AppError> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT id, title, topic, type, status, importance FROM memory_entries \
         WHERE id IN ({}) ORDER BY updated_at DESC",
        placeholders
    );
    let mut stmt = conn.prepare(&sql)?;
    let params: Vec<&dyn ToSql> = ids.iter().map(|i| i as &dyn ToSql).collect();
    let rows = stmt.query_map(params_from_iter(params), parse_related_row)?;
    rows.collect::<Result<_, _>>().map_err(AppError::Sqlite)
}

/// 反查"被哪些 mem supersede 了"。SQLite 没有 JSON 函数,用 `LIKE` 做
/// 模糊匹配,前缀/后缀都加 `"` 防止 `mem_alpha` 误中 `mem_alpha_v2`。
/// `LIMIT 50` 上界兜底,避免一个被大量引用的节点拉爆响应。
fn related_superseded_by(
    conn: &Connection,
    self_id: &str,
) -> Result<Vec<RelatedNode>, AppError> {
    let pattern = format!("%\"{}\"%", self_id);
    let mut stmt = conn.prepare(
        "SELECT id, title, topic, type, status, importance FROM memory_entries \
         WHERE supersedes_json LIKE ? AND id != ? ORDER BY updated_at DESC LIMIT 50",
    )?;
    let rows = stmt.query_map(params![pattern, self_id], parse_related_row)?;
    rows.collect::<Result<_, _>>().map_err(AppError::Sqlite)
}

/// 按单字段(只允许 `topic` / `scope`,白名单防御)匹配 + exclude ids,
/// 返回 `(items, total)`。`total` 是全量命中数,`items` 是带 LIMIT 的截断后
/// 列表 —— 前端展示"还有 N 条"用 `total - items.len()` 计算。
fn related_by_field(
    conn: &Connection,
    field: &str,
    value: &str,
    exclude_ids: &[&str],
    limit: u32,
) -> Result<(Vec<RelatedNode>, u32), AppError> {
    if !matches!(field, "topic" | "scope") {
        return Err(AppError::Sqlite(rusqlite::Error::InvalidQuery));
    }
    let excl = exclude_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let total_sql = format!(
        "SELECT COUNT(*) FROM memory_entries WHERE {} = ? AND id NOT IN ({})",
        field, excl
    );
    let mut total_params: Vec<Box<dyn ToSql>> = vec![Box::new(value.to_string())];
    for id in exclude_ids {
        total_params.push(Box::new(id.to_string()));
    }
    let total_refs: Vec<&dyn ToSql> = total_params.iter().map(|b| b.as_ref()).collect();
    let total: u32 = conn.query_row(&total_sql, params_from_iter(total_refs), |r| r.get(0))?;

    let items_sql = format!(
        "SELECT id, title, topic, type, status, importance FROM memory_entries \
         WHERE {} = ? AND id NOT IN ({}) \
         ORDER BY updated_at DESC, id ASC LIMIT ?",
        field, excl
    );
    let mut all_params = total_params;
    all_params.push(Box::new(limit as i64));
    let mut stmt = conn.prepare(&items_sql)?;
    let all_refs: Vec<&dyn ToSql> = all_params.iter().map(|b| b.as_ref()).collect();
    let items: Vec<RelatedNode> = stmt
        .query_map(params_from_iter(all_refs), parse_related_row)?
        .collect::<Result<_, _>>()
        .map_err(AppError::Sqlite)?;
    Ok((items, total))
}

/// 按 `scope` (+ 可选 `project_id`)找 sibling,语义与 v0.1
/// `reader::graph::get_graph` 的 `co_scope` 一致:同 scope + 同 project_id
/// 才算 co-scope;`project_id IS NULL` 视作"全局项目"与显式 None 匹配。
fn related_by_scope(
    conn: &Connection,
    scope: &str,
    project_id: Option<&str>,
    exclude_id: &str,
    limit: u32,
) -> Result<(Vec<RelatedNode>, u32), AppError> {
    if let Some(pid) = project_id {
        let total: u32 = conn.query_row(
            "SELECT COUNT(*) FROM memory_entries WHERE scope = ? AND project_id = ? AND id != ?",
            params![scope, pid, exclude_id],
            |r| r.get(0),
        )?;
        let mut stmt = conn.prepare(
            "SELECT id, title, topic, type, status, importance FROM memory_entries \
             WHERE scope = ? AND project_id = ? AND id != ? \
             ORDER BY updated_at DESC, id ASC LIMIT ?",
        )?;
        let items: Vec<RelatedNode> = stmt
            .query_map(
                params![scope, pid, exclude_id, limit as i64],
                parse_related_row,
            )?
            .collect::<Result<_, _>>()
            .map_err(AppError::Sqlite)?;
        Ok((items, total))
    } else {
        let total: u32 = conn.query_row(
            "SELECT COUNT(*) FROM memory_entries WHERE scope = ? AND project_id IS NULL AND id != ?",
            params![scope, exclude_id],
            |r| r.get(0),
        )?;
        let mut stmt = conn.prepare(
            "SELECT id, title, topic, type, status, importance FROM memory_entries \
             WHERE scope = ? AND project_id IS NULL AND id != ? \
             ORDER BY updated_at DESC, id ASC LIMIT ?",
        )?;
        let items: Vec<RelatedNode> = stmt
            .query_map(
                params![scope, exclude_id, limit as i64],
                parse_related_row,
            )?
            .collect::<Result<_, _>>()
            .map_err(AppError::Sqlite)?;
        Ok((items, total))
    }
}

/// 6 列 `RelatedNode` 投影的 row parser,与 `parse_memory_row` 解同张表
/// 但只取摘要需要的 6 个字段。
fn parse_related_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RelatedNode> {
    Ok(RelatedNode {
        id: row.get(0)?,
        title: row.get(1)?,
        topic: row.get(2)?,
        r#type: row.get(3)?,
        status: row.get(4)?,
        importance: row.get(5)?,
    })
}

/// 集成测试 helper:打开一个独立 `rusqlite` 连接跑与 `get_memory` 同款逻辑。
///
/// 必须是 `pub`(不挂 `#[cfg(test)]`),让 `tests/memory_detail_test.rs`
/// 这种"lib 之外"的集成测试能调到。生产代码路径上不要走它 —— 那里有
/// `tauri::State<AppState>` 复用 reader 连接,这是单测/集成测试专用入口。
pub async fn get_memory_for_test(db_path: &str, id: &str) -> Result<MemoryDetail, AppError> {
    let conn = rusqlite::Connection::open(db_path)?;
    let mem = conn.query_row(
        "SELECT id, scope, project_id, type, topic, title, body, tags_json, importance, confidence, sensitivity, status, supersedes_json, source_json, created_at, updated_at, revision \
         FROM memory_entries WHERE id = ?",
        params![id],
        parse_memory_row,
    )?;
    build_memory_detail(&conn, &mem, id)
}
