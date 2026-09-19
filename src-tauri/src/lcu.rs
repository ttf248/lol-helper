mod global_key;
mod listener;
mod matchlisthanle;

use matchlisthanle::MatchListDetails;

use crate::lcu::global_key::init_global_keyboard;
use crate::shaco::ingame;
use crate::shaco::rest::RESTClient;
use crate::shaco::utils::process_info::get_auth_info;
use configparser::ini::Ini;
use listener::listen_client;
use once_cell::sync::OnceCell;
use serde_json::{from_value, Value};
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

// 定义全局的 REST 客户端
static REST_CLIENT: OnceCell<RESTClient> = OnceCell::new();

// 获取 REST_CLIENT 的函数
fn get_client() -> Result<&'static RESTClient, Value> {
    REST_CLIENT.get().ok_or(Value::Null)
}

#[tauri::command]
pub async fn invoke_lcu(method: &str, uri: &str, body: &str) -> Result<Value, Value> {
    let started = Instant::now();
    let client = get_client()?;
    let result = if method == "get" {
        client.get(uri).await
    } else if method == "patch" {
        let parsed = serde_json::from_str::<Value>(body).unwrap_or(Value::Null);
        client.patch(uri, parsed).await
    } else if method == "post" {
        let parsed = serde_json::from_str::<Value>(body).unwrap_or(Value::Null);
        client.post(uri, parsed).await
    } else if method == "delete" {
        client.delete(uri).await
    } else {
        tracing::warn!(
            target: "lcu",
            cmd = "invoke_lcu",
            method = %method,
            uri = %uri,
            body_len = body.len(),
            "tauri.invoke_lcu unknown method"
        );
        return Ok(Value::Null);
    };
    match result {
        Ok(value) => {
            let duration_ms = started.elapsed().as_millis() as u64;
            tracing::info!(
                target: "lcu",
                cmd = "invoke_lcu",
                method = %method,
                uri = %uri,
                duration_ms,
                "tauri.invoke_lcu ok"
            );
            Ok(value)
        }
        Err(error) => {
            let duration_ms = started.elapsed().as_millis() as u64;
            tracing::warn!(
                target: "lcu",
                cmd = "invoke_lcu",
                method = %method,
                uri = %uri,
                error = %error,
                duration_ms,
                "tauri.invoke_lcu failed"
            );
            Err(Value::Null)
        }
    }
}

#[tauri::command]
pub async fn get_match_list(uri: &str) -> Result<MatchListDetails, Value> {
    let started = Instant::now();
    let client = get_client()?;
    let res = match client.get(uri).await {
        Ok(res) => res,
        Err(error) => {
            let duration_ms = started.elapsed().as_millis() as u64;
            tracing::warn!(
                target: "lcu",
                cmd = "get_match_list",
                uri = %uri,
                error = %error,
                duration_ms,
                "tauri.get_match_list fetch failed"
            );
            return Err(Value::Null);
        }
    };
    match from_value::<MatchListDetails>(res) {
        Ok(match_list) => {
            let duration_ms = started.elapsed().as_millis() as u64;
            tracing::info!(
                target: "lcu",
                cmd = "get_match_list",
                uri = %uri,
                duration_ms,
                "tauri.get_match_list ok"
            );
            Ok(match_list)
        }
        Err(error) => {
            let duration_ms = started.elapsed().as_millis() as u64;
            tracing::warn!(
                target: "lcu",
                cmd = "get_match_list",
                uri = %uri,
                error = %error,
                duration_ms,
                "tauri.get_match_list deserialize failed"
            );
            Err(Value::Null)
        }
    }
}

#[tauri::command]
pub fn get_lol_region() -> Result<String, String> {
    tracing::debug!(
        target: "lcu",
        cmd = "get_lol_region",
        "tauri.get_lol_region invoked"
    );
    match get_auth_info() {
        Ok(info) => {
            tracing::info!(
                target: "lcu",
                cmd = "get_lol_region",
                region = %info.region,
                "tauri.get_lol_region ok"
            );
            Ok(info.region)
        }
        Err(error) => {
            tracing::warn!(
                target: "lcu",
                cmd = "get_lol_region",
                error = %error,
                "tauri.get_lol_region failed"
            );
            Err("客户端未运行".to_string())
        }
    }
}

#[tauri::command]
pub fn listen_for_client_start(app: AppHandle) {
    tracing::info!(
        target: "lcu",
        cmd = "listen_for_client_start",
        timeout_secs = 180,
        "tauri.listen_for_client_start invoked"
    );
    tokio::spawn({
        async move {
            let start_time = Instant::now();
            let timeout = Duration::from_secs(180);

            loop {
                let is_exist = get_auth_info();
                match is_exist {
                    Ok(value) => {
                        if let Ok(client) = RESTClient::new(value.token, value.port) {
                            let _ = REST_CLIENT
                                .set(client)
                                .map_err(|_| "REST_CLIENT is already initialized".to_string());
                            let _ = app.emit_to("background", "client_status", "ClientStarted");
                            tracing::info!(
                                target: "lcu",
                                cmd = "listen_for_client_start",
                                wait_ms = start_time.elapsed().as_millis() as u64,
                                "lcu client connected, listener done"
                            );
                            break;
                        }
                    }
                    Err(error) => {
                        tracing::trace!(
                            target: "lcu",
                            cmd = "listen_for_client_start",
                            error = %error,
                            "lcu client not ready yet"
                        );
                    }
                }

                if start_time.elapsed() > timeout {
                    tracing::warn!(
                        target: "lcu",
                        cmd = "listen_for_client_start",
                        timeout_secs = 180,
                        "lcu client start timeout"
                    );
                    break;
                }

                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        }
    });
}

#[tauri::command]
pub async fn start_listener(app: AppHandle) {
    tracing::info!(
        target: "lcu.ws",
        cmd = "start_listener",
        "tauri.start_listener invoked"
    );
    tokio::spawn(async move {
        listen_client(app).await;
    });
}

#[tauri::command]
pub async fn is_game_start() -> bool {
    let started = Instant::now();
    tracing::debug!(
        target: "lcu",
        cmd = "is_game_start",
        "tauri.is_game_start invoked"
    );
    let client = match ingame::IngameClient::new() {
        Ok(client) => client,
        Err(error) => {
            tracing::warn!(
                target: "lcu",
                cmd = "is_game_start",
                error = %error,
                "tauri.is_game_start client init failed"
            );
            return false;
        }
    };
    let result = client.active_game_loadingscreen().await;
    let duration_ms = started.elapsed().as_millis() as u64;
    tracing::info!(
        target: "lcu",
        cmd = "is_game_start",
        result,
        duration_ms,
        "tauri.is_game_start result"
    );
    result
}

/// 获取游戏内实际加载的全部玩家。gameflow session 在加载阶段可能只返回部分队伍。
#[tauri::command]
pub async fn get_ingame_players(
) -> Result<Vec<crate::shaco::model::ingame::Player>, String> {
    let started = Instant::now();
    tracing::info!(
        target: "lcu",
        cmd = "get_ingame_players",
        "tauri.get_ingame_players invoked"
    );
    let client = match ingame::IngameClient::new() {
        Ok(client) => client,
        Err(error) => {
            tracing::warn!(
                target: "lcu",
                cmd = "get_ingame_players",
                error = %error,
                "tauri.get_ingame_players client init failed"
            );
            return Err(error.to_string());
        }
    };
    match client.player_list(None).await {
        Ok(players) => {
            let duration_ms = started.elapsed().as_millis() as u64;
            tracing::info!(
                target: "lcu",
                cmd = "get_ingame_players",
                count = players.len(),
                duration_ms,
                "tauri.get_ingame_players ok"
            );
            Ok(players)
        }
        Err(error) => {
            let duration_ms = started.elapsed().as_millis() as u64;
            tracing::warn!(
                target: "lcu",
                cmd = "get_ingame_players",
                error = %error,
                duration_ms,
                "tauri.get_ingame_players player_list failed"
            );
            Err(error.to_string())
        }
    }
}

#[tauri::command]
pub async fn init_keyboard(app: AppHandle) {
    tracing::info!(
        target: "lcu",
        cmd = "init_keyboard",
        "tauri.init_keyboard invoked"
    );
    tokio::spawn(async move { init_global_keyboard(app) });
}

#[tauri::command]
pub async fn launch_lol(path: &str) -> Result<(), String> {
    tracing::info!(
        target: "lcu",
        cmd = "launch_lol",
        path = %path,
        "tauri.launch_lol invoked"
    );
    std::process::Command::new(path)
        .spawn()
        .map(|_| {
            tracing::info!(
                target: "lcu",
                cmd = "launch_lol",
                path = %path,
                "tauri.launch_lol spawned"
            );
            ()
        })
        .map_err(|e| {
            tracing::error!(
                target: "lcu",
                cmd = "launch_lol",
                path = %path,
                error = %e,
                "tauri.launch_lol spawn failed"
            );
            e.to_string()
        })
}

// 检查是否游戏窗口模式为无边框
#[tauri::command]
pub async fn check_borderless_mode(config_path: &str) -> Result<i32, String> {
    tracing::debug!(
        target: "lcu",
        cmd = "check_borderless_mode",
        config_path = %config_path,
        "tauri.check_borderless_mode invoked"
    );
    if !Path::new(config_path).exists() {
        tracing::warn!(
            target: "lcu",
            cmd = "check_borderless_mode",
            config_path = %config_path,
            "tauri.check_borderless_mode config missing"
        );
        return Ok(-1);
    }

    let mut config = Ini::new();
    if let Err(e) = config.load(config_path) {
        tracing::warn!(
            target: "lcu",
            cmd = "check_borderless_mode",
            config_path = %config_path,
            error = %e,
            "tauri.check_borderless_mode load failed"
        );
        return Err(format!("读取配置文件失败: {}", e));
    }

    if let Some(mode_str) = config.get("General", "WindowMode") {
        match mode_str.trim().parse::<i32>() {
            Ok(id) => {
                tracing::info!(
                    target: "lcu",
                    cmd = "check_borderless_mode",
                    config_path = %config_path,
                    mode = id,
                    "tauri.check_borderless_mode ok"
                );
                Ok(id)
            }
            Err(_) => {
                tracing::warn!(
                    target: "lcu",
                    cmd = "check_borderless_mode",
                    config_path = %config_path,
                    mode_str = %mode_str,
                    "tauri.check_borderless_mode parse failed"
                );
                Err(format!("配置项格式非法: {}", mode_str))
            }
        }
    } else {
        tracing::warn!(
            target: "lcu",
            cmd = "check_borderless_mode",
            config_path = %config_path,
            "tauri.check_borderless_mode missing key"
        );
        Err("配置文件中缺少 WindowMode 项".into())
    }
}

// 设置游戏窗口模式为无边框
#[tauri::command]
pub async fn set_borderless_mode(config_path: &str) -> Result<String, String> {
    tracing::info!(
        target: "lcu",
        cmd = "set_borderless_mode",
        config_path = %config_path,
        "tauri.set_borderless_mode invoked"
    );
    let path = Path::new(config_path);

    if !path.exists() {
        tracing::warn!(
            target: "lcu",
            cmd = "set_borderless_mode",
            config_path = %config_path,
            "tauri.set_borderless_mode config missing"
        );
        return Err("找不到游戏配置文件，请确认路径是否正确。".into());
    }

    let metadata = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!(
                target: "lcu",
                cmd = "set_borderless_mode",
                config_path = %config_path,
                error = %e,
                "tauri.set_borderless_mode metadata failed"
            );
            return Err(e.to_string());
        }
    };
    let mut permissions = metadata.permissions();
    if permissions.readonly() {
        permissions.set_readonly(false);
        if let Err(e) = fs::set_permissions(path, permissions) {
            tracing::warn!(
                target: "lcu",
                cmd = "set_borderless_mode",
                config_path = %config_path,
                error = %e,
                "tauri.set_borderless_mode chmod failed"
            );
            return Err(e.to_string());
        }
    }

    let mut config = Ini::new();
    config.set_comment_symbols(&[';', '#']);
    if let Err(e) = config.load(config_path) {
        tracing::warn!(
            target: "lcu",
            cmd = "set_borderless_mode",
            config_path = %config_path,
            error = %e,
            "tauri.set_borderless_mode load failed"
        );
        return Err(e.to_string());
    }

    config.set("General", "WindowMode", Some("2".to_string()));

    match config.write(config_path) {
        Ok(_) => {
            tracing::info!(
                target: "lcu",
                cmd = "set_borderless_mode",
                config_path = %config_path,
                "tauri.set_borderless_mode ok"
            );
            Ok("成功设置为无边框模式".into())
        }
        Err(e) => {
            tracing::error!(
                target: "lcu",
                cmd = "set_borderless_mode",
                config_path = %config_path,
                error = %e,
                "tauri.set_borderless_mode write failed"
            );
            Err(format!("写入文件失败: {}", e))
        }
    }
}