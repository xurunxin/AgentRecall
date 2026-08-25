use crate::reader::types::{GraphFilter, GraphResponse};
use crate::reader::AppError;
use crate::AppState;
use tauri::State;

/// Tauri command: 查询 memory graph。
///
/// `filter` 由前端从 `@agent-recall/contracts` 的 `GraphFilterSchema` 序列化过来;
/// Rust 端用 serde 校验,缺字段时套用 Task 11 fix 后的 `GraphFilter::default()`。
#[tauri::command]
pub async fn get_graph(
    state: State<'_, AppState>,
    filter: GraphFilter,
) -> Result<GraphResponse, AppError> {
    let guard = state.reader.lock().unwrap();
    let reader = guard.as_ref().ok_or_else(|| {
        AppError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "DB not opened; call init_reader first",
        ))
    })?;
    reader.get_graph(filter)
}
