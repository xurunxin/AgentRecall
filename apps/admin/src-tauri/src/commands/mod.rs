//! Tauri command handlers exposed to the frontend.
//!
//! v0.1 只暴露**只读** commands:
//! - `graph::get_graph`  —— 图谱查询
//! - `memory::list_memories` / `memory::get_memory` / `memory::get_memory_stats`
//! - 顶层 `get_db_status`(放在 `lib.rs` 避免循环引用)
//!
//! 写操作 commands(创建/更新/删除 memory 等)在 v0.1 暂不实现,见
//! `AppError::DisabledInV01` 的预留位置与 v0.2 路线图。
pub mod graph;
pub mod memory;
