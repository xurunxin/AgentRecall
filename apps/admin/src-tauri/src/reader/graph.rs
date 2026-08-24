use crate::reader::types::{
    DbStatus, EdgeKind, GraphEdge, GraphFilter, GraphFilterScope, GraphNode, GraphResponse,
    MemoryScope, MemoryStatus, MemoryType,
};
use chrono::{DateTime, Utc};
use rusqlite::{params, params_from_iter, Connection, ToSql};
use std::collections::{HashMap, HashSet};

/// v0.1 真实 SQL 实现 `SQLiteReader::get_graph`。
///
/// 数据源:`memory_entries` 表(`src/sqlite-store.ts:805` 的 `CREATE TABLE`),
/// 不是 brief 假设的 `memories`(实际 schema 早已迁移到 v4+ 的 `memory_entries`)。
///
/// 边类型:
/// - `supersede`:从 `memory_entries.supersedes_json` 数组展开
///   (NOTE: v4 之后会写一份到 `memory_relations`,但 v0.1 仍以 `supersedes_json` 为权威,
///   见 `src/sqlite-store.ts:1144` 的 `migrate_v3_to_v4` 注释)。
/// - `merge`:v0.1 不实现(merge 边的关系在 audit log 不在 memory 表里),留 v0.2。
/// - `co_topic`:同 topic 的节点两两组合(`include_co_topic=true`,默认 true)。
/// - `co_scope`:同 project_id 的节点两两组合(`include_co_scope=true`,默认 false)。
pub fn get_graph(conn: &Connection, filter: &GraphFilter) -> Result<GraphResponse, rusqlite::Error> {
    // 1. 拼 WHERE + bind (count 复用)
    let (where_sql, bind_values) = build_where(filter);

    // 2. total count
    let total_sql = format!("SELECT COUNT(*) FROM memory_entries {}", where_sql);
    let bind_refs: Vec<&dyn ToSql> = bind_values.iter().map(|b| b.as_ref()).collect();
    let total: u32 = conn.query_row(&total_sql, params_from_iter(bind_refs), |r| r.get(0))?;

    // 3. nodes — 重新拼一次 bind(避免 Box<dyn ToSql> clone),并把 LIMIT 拼到 SQL 末尾。
    let (where_sql2, mut all_bind) = build_where(filter);
    all_bind.push(Box::new(filter.max_nodes as i64));
    let nodes_sql = format!(
        "SELECT id, substr(title, 1, 60) AS label, type, topic, scope, project_id, importance, status, created_at \
         FROM memory_entries {} ORDER BY importance DESC, updated_at DESC LIMIT ?",
        where_sql2
    );

    let mut stmt = conn.prepare(&nodes_sql)?;
    let bind_refs2: Vec<&dyn ToSql> = all_bind.iter().map(|b| b.as_ref()).collect();
    let node_iter = stmt.query_map(params_from_iter(bind_refs2), |row| {
        let scope_str: String = row.get(4)?;
        let type_str: String = row.get(2)?;
        let status_str: String = row.get(7)?;
        Ok(GraphNode {
            id: row.get(0)?,
            label: row.get(1)?,
            node_type: parse_memory_type(&type_str)?,
            topic: row.get(3)?,
            scope: parse_memory_scope(&scope_str)?,
            project_id: row.get(5)?,
            importance: row.get::<_, u8>(6)?,
            status: parse_memory_status(&status_str)?,
            created_at: row.get::<_, DateTime<Utc>>(8)?,
        })
    })?;
    let nodes: Vec<GraphNode> = node_iter.collect::<Result<_, _>>()?;
    let truncated = total > nodes.len() as u32;

    // 4. edges: supersede (从 memory_entries.supersedes_json JSON 字段展开)
    let mut edges = vec![];
    for n in &nodes {
        let supersedes_json: Option<String> = conn
            .query_row(
                "SELECT supersedes_json FROM memory_entries WHERE id = ?",
                params![n.id],
                |r| r.get(0),
            )
            .ok()
            .flatten();
        if let Some(s) = supersedes_json {
            // v0.1 容忍:有些 entry 的 supersedes_json 是 'null' / 空字符串 / 不是有效 JSON,
            // 解析失败就跳过这一条(不让一个坏 row 把整图打空)。
            if let Ok(arr) = serde_json::from_str::<Vec<String>>(&s) {
                for old_id in arr {
                    edges.push(GraphEdge {
                        source: old_id,
                        target: n.id.clone(),
                        kind: EdgeKind::Supersede,
                        weight: 1.0,
                    });
                }
            }
        }
    }

    // 5. edges: co_topic
    if filter.include_co_topic {
        let mut by_topic: HashMap<String, Vec<String>> = HashMap::new();
        for n in &nodes {
            by_topic
                .entry(n.topic.clone())
                .or_default()
                .push(n.id.clone());
        }
        for (_topic, ids) in by_topic {
            if ids.len() < 2 {
                continue;
            }
            for i in 0..ids.len() {
                for j in (i + 1)..ids.len() {
                    edges.push(GraphEdge {
                        source: ids[i].clone(),
                        target: ids[j].clone(),
                        kind: EdgeKind::CoTopic,
                        weight: 1.0,
                    });
                }
            }
        }
    }

    // 6. edges: co_scope (默认关)
    if filter.include_co_scope {
        let mut by_scope: HashMap<Option<String>, Vec<String>> = HashMap::new();
        for n in &nodes {
            by_scope
                .entry(n.project_id.clone())
                .or_default()
                .push(n.id.clone());
        }
        for (_scope, ids) in by_scope {
            if ids.len() < 2 {
                continue;
            }
            for i in 0..ids.len() {
                for j in (i + 1)..ids.len() {
                    edges.push(GraphEdge {
                        source: ids[i].clone(),
                        target: ids[j].clone(),
                        kind: EdgeKind::CoScope,
                        weight: 1.0,
                    });
                }
            }
        }
    }

    // 7. 去重(同 source+target+kind)
    let mut seen: HashSet<(String, String, EdgeKind)> = HashSet::new();
    edges.retain(|e| {
        seen.insert((e.source.clone(), e.target.clone(), e.kind.clone()))
    });

    Ok(GraphResponse {
        nodes,
        edges,
        total,
        truncated,
        generated_at: Utc::now(),
    })
}

/// 构造 `WHERE` 片段 + 对应的 bind 列表。count query 和 nodes query 各调一次,
/// 避免 `Vec<Box<dyn ToSql>>` 的 clone(它不是 `Clone`)。
fn build_where(filter: &GraphFilter) -> (String, Vec<Box<dyn ToSql>>) {
    let mut where_clauses: Vec<String> = vec![];
    let mut bind_values: Vec<Box<dyn ToSql>> = vec![];

    match filter.scope {
        GraphFilterScope::All => {}
        GraphFilterScope::Project => {
            where_clauses.push("project_id IS NOT NULL".to_string());
        }
        GraphFilterScope::Global => {
            where_clauses.push("project_id IS NULL".to_string());
        }
    }
    if let Some(pid) = &filter.project_id {
        where_clauses.push("project_id = ?".to_string());
        bind_values.push(Box::new(pid.clone()));
    }
    if let Some(topics) = &filter.topic {
        if !topics.is_empty() {
            let placeholders = topics.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            where_clauses.push(format!("topic IN ({})", placeholders));
            for t in topics {
                bind_values.push(Box::new(t.clone()));
            }
        }
    }
    if let Some(types) = &filter.node_type {
        if !types.is_empty() {
            let placeholders = types.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            where_clauses.push(format!("type IN ({})", placeholders));
            for t in types {
                bind_values.push(Box::new(memory_type_str(t).to_string()));
            }
        }
    }
    if !filter.status.is_empty() {
        let placeholders = filter.status.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        where_clauses.push(format!("status IN ({})", placeholders));
        for s in &filter.status {
            bind_values.push(Box::new(memory_status_str(s).to_string()));
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

fn memory_type_str(t: &MemoryType) -> &'static str {
    match t {
        MemoryType::Preference => "preference",
        MemoryType::Procedure => "procedure",
        MemoryType::Fact => "fact",
        MemoryType::Decision => "decision",
        MemoryType::Lesson => "lesson",
        MemoryType::Debugging => "debugging",
        MemoryType::Constraint => "constraint",
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

#[allow(dead_code)]
fn memory_scope_str(s: &MemoryScope) -> &'static str {
    match s {
        MemoryScope::Global => "global",
        MemoryScope::Project => "project",
    }
}

fn parse_memory_type(s: &str) -> Result<MemoryType, rusqlite::Error> {
    Ok(match s {
        "preference" => MemoryType::Preference,
        "procedure" => MemoryType::Procedure,
        "fact" => MemoryType::Fact,
        "decision" => MemoryType::Decision,
        "lesson" => MemoryType::Lesson,
        "debugging" => MemoryType::Debugging,
        "constraint" => MemoryType::Constraint,
        _ => return Err(rusqlite::Error::InvalidQuery),
    })
}

fn parse_memory_scope(s: &str) -> Result<MemoryScope, rusqlite::Error> {
    Ok(match s {
        "global" => MemoryScope::Global,
        "project" => MemoryScope::Project,
        _ => return Err(rusqlite::Error::InvalidQuery),
    })
}

fn parse_memory_status(s: &str) -> Result<MemoryStatus, rusqlite::Error> {
    Ok(match s {
        "active" => MemoryStatus::Active,
        "archived" => MemoryStatus::Archived,
        "superseded" => MemoryStatus::Superseded,
        "forgotten" => MemoryStatus::Forgotten,
        _ => return Err(rusqlite::Error::InvalidQuery),
    })
}

#[allow(dead_code)]
pub fn status_for_db(s: &DbStatus) -> &DbStatus {
    s
}
