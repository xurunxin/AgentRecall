pub mod commands;
pub mod reader;

use reader::SQLiteReader;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State};

/// Tauri-managed application state.
///
/// v0.1 全部 state 都放在这一个 struct 里,不再分文件:
/// - `reader`:  可选只读 DB 句柄;启动时 `setup` 尝试打开,失败不 panic,
///              让前端用 `get_db_status` 看到 `DB not opened` 走错误 UI。
/// - `db_path`: DB 路径,前端可通过 `open_db` 命令触发懒打开。
pub struct AppState {
    pub reader: Mutex<Option<SQLiteReader>>,
    pub db_path: PathBuf,
}

impl AppState {
    pub fn new(db_path: PathBuf) -> Self {
        Self {
            reader: Mutex::new(None),
            db_path,
        }
    }
}

#[tauri::command]
fn open_db(state: State<'_, AppState>) -> Result<(), reader::AppError> {
    let mut guard = state.reader.lock().unwrap();
    if guard.is_none() {
        let reader = SQLiteReader::open(&state.db_path)?;
        *guard = Some(reader);
    }
    Ok(())
}

#[tauri::command]
fn get_db_status(state: State<'_, AppState>) -> Result<reader::types::DbStatus, reader::AppError> {
    let guard = state.reader.lock().unwrap();
    let reader = guard.as_ref().ok_or_else(|| {
        reader::AppError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "DB not opened",
        ))
    })?;
    reader.db_status()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // v0.1: 默认 data-home 用环境变量 `AGENT_RECALL_DATA_HOME`,fallback 到
    // `~/.agent-recall/agent-recall.db`(`HOME` / `USERPROFILE` 任一非空即可)。
    let db_path = std::env::var("AGENT_RECALL_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .unwrap_or_default();
            PathBuf::from(home)
                .join(".agent-recall")
                .join("agent-recall.db")
        });

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState::new(db_path))
        .setup(|app| {
            // 启动时尝试打开 DB,失败不 panic(返回 error 让前端展示)。
            let state: State<AppState> = app.state();
            match SQLiteReader::open(&state.db_path) {
                Ok(r) => *state.reader.lock().unwrap() = Some(r),
                Err(e) => eprintln!("[admin] failed to open DB at startup: {}", e),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_db,
            get_db_status,
            commands::graph::get_graph,
            commands::memory::list_memories,
            commands::memory::get_memory,
            commands::memory::get_memory_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
