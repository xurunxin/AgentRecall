pub mod reader;

use reader::SQLiteReader;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

pub struct AppState {
    pub reader: Mutex<Option<SQLiteReader>>,
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
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            reader: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![get_db_status])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
