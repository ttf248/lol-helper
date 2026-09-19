mod lcu;
mod database;
mod lol_window_tracker;
mod shaco;
use database::{
    cache_match_history, database_status, database_summary, get_cached_match_history,
    get_cached_player_summary,
    DatabaseState,
};
use lcu::{
    check_borderless_mode, get_lol_region, get_match_list, init_keyboard, invoke_lcu,
    get_ingame_players, is_game_start, launch_lol, listen_for_client_start, set_borderless_mode,
    start_listener,
};
use lol_window_tracker::{start_tracking_loop, sync_tracker_config};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, EventTarget, Manager};
use tauri_plugin_window_state::StateFlags;

pub struct LocalTestState {
    pub is_enabled: Arc<AtomicBool>,
    pub is_running: Arc<AtomicBool>,   // 防止重复启动的锁
    pub dock_side: Arc<Mutex<String>>, // "Left" 或 "Right"
}

#[tokio::main]
pub async fn run() {
    // 应用启动阶段先完成 PostgreSQL 连接和表结构检查，前端可通过 database_status 展示结果。
    let database = DatabaseState::initialize().await;
    tauri::Builder::default()
        .manage(database)
        .manage(LocalTestState {
            is_enabled: Arc::new(AtomicBool::new(false)), // 初始设为 false，等前端同步
            is_running: Arc::new(AtomicBool::new(false)), // 初始为未运行
            dock_side: Arc::new(Mutex::new("Right".to_string())),
        })
        .invoke_handler(tauri::generate_handler![
            get_lol_region,
            start_listener,
            invoke_lcu,
            get_match_list,
            is_game_start,
            get_ingame_players,
            init_keyboard,
            listen_for_client_start,
            launch_lol,
            start_tracking_loop,
            sync_tracker_config,
            set_borderless_mode,
            check_borderless_mode,
            database_status,
            cache_match_history,
            get_cached_match_history,
            database_summary,
            get_cached_player_summary,
        ])
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 当尝试启动新实例时，聚焦主窗口，并让后台重新检查当前对局。
            if let Some(main_window) = app.get_webview_window("mainWindow") {
                let _ = main_window.show();
                let _ = main_window.set_focus();
            }
            let _ = app.emit_to(
                EventTarget::labeled("background"),
                "recoverGameWindow",
                (),
            );
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::POSITION)
                .with_denylist(&[
                    "background",
                    "queryMatchWindow",
                    "recentMatchWindow",
                ])
                .build(),
        )
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
