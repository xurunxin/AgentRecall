use crate::reader::schema_version::mtime_ms;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::task::JoinHandle;

pub fn start(app: AppHandle, db_path: PathBuf, interval_secs: u64) -> JoinHandle<()> {
    tokio::spawn(async move {
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
