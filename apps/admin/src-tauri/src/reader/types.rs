use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MemoryType {
    Preference,
    Procedure,
    Fact,
    Decision,
    Lesson,
    Debugging,
    Constraint,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MemoryStatus {
    Active,
    Archived,
    Superseded,
    Forgotten,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MemoryScope {
    Global,
    Project,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub node_type: MemoryType,
    pub topic: String,
    pub scope: MemoryScope,
    pub project_id: Option<String>,
    pub importance: u8,
    pub status: MemoryStatus,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    Supersede,
    Merge,
    CoTopic,
    CoScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub kind: EdgeKind,
    pub weight: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum GraphFilterScope {
    #[default]
    All,
    Project,
    Global,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphFilter {
    #[serde(default)]
    pub scope: GraphFilterScope,
    pub project_id: Option<String>,
    pub topic: Option<Vec<String>>,
    #[serde(rename = "type")]
    pub node_type: Option<Vec<MemoryType>>,
    #[serde(default = "default_status")]
    pub status: Vec<MemoryStatus>,
    pub min_importance: Option<u8>,
    #[serde(default = "default_max_nodes")]
    pub max_nodes: u32,
    #[serde(default = "default_true")]
    pub include_co_topic: bool,
    #[serde(default)]
    pub include_co_scope: bool,
}

impl Default for GraphFilter {
    /// v0.1: 必须与每个字段的 `#[serde(default = "...")]` 注解保持一致。
    ///
    /// 历史 bug:`#[derive(Default)]` 只对字段类型本身的 `Default` 起作用,
    /// 会给出 `max_nodes: 0, status: vec![], include_co_topic: false`,
    /// 落到 `get_graph` 上等同于 `LIMIT 0` 且不生成 co_topic 边。
    /// 这里手写实现,让 `Default::default()` 与 Serde 反序列化的默认值对齐。
    fn default() -> Self {
        Self {
            scope: GraphFilterScope::default(),
            project_id: None,
            topic: None,
            node_type: None,
            status: default_status(),
            min_importance: None,
            max_nodes: default_max_nodes(),
            include_co_topic: default_true(),
            include_co_scope: false,
        }
    }
}

fn default_status() -> Vec<MemoryStatus> {
    vec![MemoryStatus::Active]
}
fn default_max_nodes() -> u32 {
    500
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphResponse {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub total: u32,
    pub truncated: bool,
    pub generated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbStatus {
    pub schema_version: u32,
    pub mtime_ms: i64,
    pub size_bytes: u64,
}
