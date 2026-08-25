use crate::reader::schema_version::mtime_ms;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri::async_runtime::JoinHandle;

pub fn start(app: AppHandle, db_path: PathBuf, interval_secs: u64) -> JoinHandle<()> {
    // Tauri 2.0 的 `setup` 闭包是同步的,不在 tokio runtime 上下文里。
    // 直接调用 `tokio::spawn` 会立即 panic:
    //   "there is no reactor running, must be called from the context of a Tokio 1.x runtime"
    // 必须用 `tauri::async_runtime::spawn`(Tauri 暴露的运行时,tokio-backed),
    // 内部继续用 `tokio::time::interval` / `tokio::time::sleep` 是安全的。
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(interval_secs));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut last_mtime: Option<i64> = None;
        loop {
            ticker.tick().await;
            let current = match mtime_ms(&db_path) {
                Ok(m) => Some(m),
                Err(_) => None, // DB 不存在,跳过这一轮
            };
            if current != last_mtime {
                last_mtime = current;
                if let Some(m) = current {
                    let _ = app.emit("db:changed", serde_json::json!({ "mtime_ms": m }));
                }
            }
        }
    })
}
