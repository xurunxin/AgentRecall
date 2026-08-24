// v0.1: 让 main 调 lib::run 以支持移动端 + 桌面端统一入口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    agent_recall_admin_lib::run()
}
