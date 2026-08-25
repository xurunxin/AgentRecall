//! MemoryDetail 集成测试,验证 get_memory 返回的 related 字段正确。
//!
//! Fixture (3 行 memory_entries,3 个 project 组合):
//!   - mem_alpha: scope=project, project_id=p1, topic=auth,    type=decision, supersedes=[]
//!   - mem_beta:  scope=project, project_id=p1, topic=auth,    type=fact,     supersedes=[mem_alpha]
//!   - mem_gamma: scope=project, project_id=p2, topic=cache,   type=lesson,   supersedes=[]
//!
//! 注意:mem_alpha 和 mem_beta 共享 project_id=p1,所以 per `related_by_scope`
//! 实现(与 v0.1 `reader::graph::get_graph` 的 co_scope 语义一致 —— "同
//! project_id 的节点"),mem_beta 会出现在 mem_alpha 的 co_scope 里。
//! 这与 brief 中描述的"co_scope=[]"不一致,以实现为准并在报告里标注。

use std::collections::HashSet;
use std::path::PathBuf;

use agent_recall_admin_lib::commands::memory::{get_memory_for_test, MemoryDetail};
use rusqlite::{params, Connection};
use tempfile::TempDir;

/// 创建一个独立 SQLite 文件,写好 schema + 3 行 fixture,返回 `(TempDir, path)`。
/// `get_memory_for_test` 后续用 `path` 字符串独立打开一个新连接读取。
fn setup_db_file() -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let db_path = dir.path().join("memory_detail.db");
    let conn = Connection::open(&db_path).expect("open");

    conn.execute_batch(
        r#"
        CREATE TABLE memory_entries (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          project_id TEXT,
          type TEXT NOT NULL,
          topic TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          tags_json TEXT NOT NULL DEFAULT '[]',
          importance INTEGER NOT NULL,
          confidence INTEGER NOT NULL,
          sensitivity TEXT NOT NULL,
          status TEXT NOT NULL,
          supersedes_json TEXT NOT NULL DEFAULT '[]',
          source_json TEXT NOT NULL DEFAULT '{"kind":"user"}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          revision INTEGER NOT NULL
        );
        "#,
    )
    .expect("schema");

    conn.execute(
        "INSERT INTO memory_entries (id, scope, project_id, type, topic, title, body, \
         tags_json, importance, confidence, sensitivity, status, supersedes_json, \
         source_json, created_at, updated_at, revision) \
         VALUES (?1, 'project', 'p1', 'decision', 'auth', 'Use JWT', 'body1', '[]', \
         4, 5, 'normal', 'active', '[]', '{\"kind\":\"user\"}', \
         '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z', 1)",
        params!["mem_alpha"],
    )
    .expect("alpha");

    conn.execute(
        "INSERT INTO memory_entries (id, scope, project_id, type, topic, title, body, \
         tags_json, importance, confidence, sensitivity, status, supersedes_json, \
         source_json, created_at, updated_at, revision) \
         VALUES (?1, 'project', 'p1', 'fact', 'auth', 'JWT libs', 'body2', '[]', \
         3, 4, 'normal', 'active', '[\"mem_alpha\"]', '{\"kind\":\"user\"}', \
         '2026-08-25T00:00:01.000Z', '2026-08-25T00:00:01.000Z', 1)",
        params!["mem_beta"],
    )
    .expect("beta");

    conn.execute(
        "INSERT INTO memory_entries (id, scope, project_id, type, topic, title, body, \
         tags_json, importance, confidence, sensitivity, status, supersedes_json, \
         source_json, created_at, updated_at, revision) \
         VALUES (?1, 'project', 'p2', 'lesson', 'cache', 'LRU wins', 'body3', '[]', \
         3, 4, 'normal', 'active', '[]', '{\"kind\":\"user\"}', \
         '2026-08-25T00:00:02.000Z', '2026-08-25T00:00:02.000Z', 1)",
        params!["mem_gamma"],
    )
    .expect("gamma");

    drop(conn);
    (dir, db_path)
}

#[tokio::test]
async fn get_memory_alpha_returns_superseded_by_beta_and_co_topic() {
    let (_dir, db_path) = setup_db_file();
    let path = db_path.to_str().expect("utf-8 path");
    let detail: MemoryDetail = get_memory_for_test(path, "mem_alpha")
        .await
        .expect("get_memory should succeed");

    assert_eq!(detail.id, "mem_alpha");
    assert!(
        detail.related.supersedes.is_empty(),
        "alpha's supersedes_json is [] so supersedes should be empty"
    );

    let superseded_by_ids: HashSet<&str> = detail
        .related
        .superseded_by
        .iter()
        .map(|n| n.id.as_str())
        .collect();
    assert!(
        superseded_by_ids.contains("mem_beta"),
        "beta's supersedes_json=[mem_alpha] should list alpha as superseded_by"
    );

    let co_topic_ids: HashSet<&str> =
        detail.related.co_topic.iter().map(|n| n.id.as_str()).collect();
    assert!(
        co_topic_ids.contains("mem_beta"),
        "beta shares topic=auth with alpha"
    );
    assert_eq!(detail.related.co_topic_total, 1);

    // co_scope 包含 mem_beta(同 scope + 同 project_id=p1)。v0.1 `get_graph`
    // 的 co_scope 语义也是"同 project_id",所以保留这个行为。
    let co_scope_ids: HashSet<&str> =
        detail.related.co_scope.iter().map(|n| n.id.as_str()).collect();
    assert!(
        co_scope_ids.contains("mem_beta"),
        "beta shares scope=project + project_id=p1 with alpha"
    );
    assert_eq!(detail.related.co_scope_total, 1);

    assert!(
        detail.related.merge.is_empty(),
        "TODO v0.3: GraphEdge not persisted, merge is always empty"
    );
}

#[tokio::test]
async fn get_memory_alpha_co_topic_includes_beta_with_importance() {
    let (_dir, db_path) = setup_db_file();
    let path = db_path.to_str().expect("utf-8 path");
    let detail: MemoryDetail = get_memory_for_test(path, "mem_alpha").await.unwrap();

    let beta = detail
        .related
        .co_topic
        .iter()
        .find(|n| n.id == "mem_beta")
        .expect("beta should be in co_topic");
    assert_eq!(beta.title, "JWT libs");
    assert_eq!(beta.importance, 3);
    assert_eq!(beta.topic, "auth");
    assert_eq!(beta.r#type, "fact");
    assert_eq!(beta.status, "active");
}

#[tokio::test]
async fn get_memory_gamma_has_no_relations() {
    let (_dir, db_path) = setup_db_file();
    let path = db_path.to_str().expect("utf-8 path");
    let detail: MemoryDetail = get_memory_for_test(path, "mem_gamma").await.unwrap();

    assert_eq!(detail.related.supersedes.len(), 0);
    assert_eq!(detail.related.superseded_by.len(), 0);
    assert_eq!(detail.related.co_topic.len(), 0);
    assert_eq!(detail.related.co_topic_total, 0);
    // gamma 在 project p2,没有其它同 project_id 行。
    assert_eq!(detail.related.co_scope.len(), 0);
    assert_eq!(detail.related.co_scope_total, 0);
    assert!(detail.related.merge.is_empty());
}
