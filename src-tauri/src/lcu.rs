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
use tauri::{AppHandle, Emitter};

// 定义全局的 REST 客户端
static REST_CLIENT: OnceCell<RESTClient> = OnceCell::new();

// 获取 REST_CLIENT 的函数
fn get_client() -> Result<&'static RESTClient, Value> {
    REST_CLIENT.get().ok_or(Value::Null)
}

#[tauri::command]
pub async fn invoke_lcu(method: &str, uri: &str, body: &str) -> Result<Value, Value> {
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
            target: "lcu.cmd",
            method = %method,
            uri = %uri,
            body_bytes = body.len(),
            "LCU 命令桥收到未知方法"
        );
        return Ok(Value::Null);
    };
    // 成功/失败日志由 RESTClient 的 lcu.http 输出覆盖；这里只兜底异常。
    result.map_err(|_| Value::Null)
}

#[tauri::command]
pub async fn get_match_list(uri: &str) -> Result<MatchListDetails, Value> {
    let client = get_client()?;
    let res = match client.get(uri).await {
        Ok(res) => res,
        Err(error) => {
            tracing::warn!(
                target: "lcu.cmd",
                uri = %uri,
                error = %error,
                "获取对局列表失败"
            );
            return Err(Value::Null);
        }
    };
    match from_value::<MatchListDetails>(res) {
        Ok(match_list) => Ok(match_list),
        Err(error) => {
            tracing::warn!(
                target: "lcu.cmd",
                uri = %uri,
                error = %error,
                "对局列表响应反序列化失败"
            );
            Err(Value::Null)
        }
    }
}

#[tauri::command]
pub fn get_lol_region() -> Result<String, String> {
    match get_auth_info() {
        Ok(info) => {
            tracing::info!(
                target: "lcu.cmd",
                region = %info.region,
                "LCU 大区识别完成"
            );
            Ok(info.region)
        }
        Err(error) => {
            tracing::warn!(
                target: "lcu.cmd",
                error = %error,
                "LCU 大区识别失败"
            );
            Err("客户端未运行".to_string())
        }
    }
}

#[tauri::command]
pub fn listen_for_client_start(app: AppHandle) {
    tracing::info!(
        target: "lcu.cmd",
        timeout_secs = 180,
        "开始监听 LCU 客户端启动"
    );
    tokio::spawn({
        async move {
            let start_time = std::time::Instant::now();
            let timeout = std::time::Duration::from_secs(180);

            loop {
                match get_auth_info() {
                    Ok(value) => {
                        if let Ok(client) = RESTClient::new(value.token, value.port) {
                            let _ = REST_CLIENT
                                .set(client)
                                .map_err(|_| "REST_CLIENT is already initialized".to_string());
                            let _ = app.emit_to("background", "client_status", "ClientStarted");
                            tracing::info!(
                                target: "lcu.cmd",
                                wait_ms = start_time.elapsed().as_millis() as u64,
                                "LCU 客户端已连接，监听完成"
                            );
                            break;
                        }
                    }
                    Err(error) => {
                        tracing::trace!(
                            target: "lcu.cmd",
                            error = %error,
                            "LCU 客户端尚未就绪"
                        );
                    }
                }

                if start_time.elapsed() > timeout {
                    tracing::warn!(
                        target: "lcu.cmd",
                        timeout_secs = 180,
                        "LCU 客户端启动等待超时"
                    );
                    break;
                }

                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            }
        }
    });
}

#[tauri::command]
pub async fn start_listener(app: AppHandle) {
    tracing::info!(
        target: "lcu.cmd",
        "启动 LCU 客户端状态 WebSocket 监听"
    );
    tokio::spawn(async move {
        listen_client(app).await;
    });
}

#[tauri::command]
pub async fn is_game_start() -> bool {
    let started = std::time::Instant::now();
    let client = match ingame::IngameClient::new() {
        Ok(client) => client,
        Err(error) => {
            tracing::warn!(
                target: "lcu.cmd",
                error = %error,
                "游戏内客户端初始化失败"
            );
            return false;
        }
    };
    let result = client.active_game_loadingscreen().await;
    let duration_ms = started.elapsed().as_millis() as u64;
    tracing::info!(
        target: "lcu.cmd",
        result,
        duration_ms,
        "游戏内对局开始探测完成"
    );
    result
}

/// 获取游戏内实际加载的全部玩家。gameflow session 在加载阶段可能只返回部分队伍。
#[tauri::command]
pub async fn get_ingame_players(
) -> Result<Vec<crate::shaco::model::ingame::Player>, String> {
    let started = std::time::Instant::now();
    let client = match ingame::IngameClient::new() {
        Ok(client) => client,
        Err(error) => {
            tracing::warn!(
                target: "lcu.cmd",
                error = %error,
                "游戏内客户端初始化失败"
            );
            return Err(error.to_string());
        }
    };
    match client.player_list(None).await {
        Ok(players) => {
            let duration_ms = started.elapsed().as_millis() as u64;
            tracing::info!(
                target: "lcu.cmd",
                count = players.len(),
                duration_ms,
                "游戏内玩家列表获取完成"
            );
            Ok(players)
        }
        Err(error) => {
            tracing::warn!(
                target: "lcu.cmd",
                error = %error,
                "游戏内玩家列表获取失败"
            );
            Err(error.to_string())
        }
    }
}

#[tauri::command]
pub async fn init_keyboard(app: AppHandle) {
    tracing::info!(
        target: "lcu.cmd",
        "初始化全局键盘监听"
    );
    tokio::spawn(async move { init_global_keyboard(app) });
}

#[tauri::command]
pub async fn launch_lol(path: &str) -> Result<(), String> {
    tracing::info!(
        target: "lcu.cmd",
        path = %path,
        "启动 LeagueClient 客户端"
    );
    std::process::Command::new(path)
        .spawn()
        .map(|_| {
            tracing::info!(
                target: "lcu.cmd",
                path = %path,
                "LeagueClient 进程已拉起"
            );
            ()
        })
        .map_err(|e| {
            tracing::error!(
                target: "lcu.cmd",
                path = %path,
                error = %e,
                "LeagueClient 进程拉起失败"
            );
            e.to_string()
        })
}

// 检查是否游戏窗口模式为无边框
#[tauri::command]
pub async fn check_borderless_mode(config_path: &str) -> Result<i32, String> {
    if !Path::new(config_path).exists() {
        tracing::warn!(
            target: "lcu.cmd",
            config_path = %config_path,
            "无边框配置文件不存在"
        );
        return Ok(-1);
    }

    let mut config = Ini::new();
    if let Err(e) = config.load(config_path) {
        tracing::warn!(
            target: "lcu.cmd",
            config_path = %config_path,
            error = %e,
            "无边框配置文件读取失败"
        );
        return Err(format!("读取配置文件失败: {}", e));
    }

    if let Some(mode_str) = config.get("General", "WindowMode") {
        match mode_str.trim().parse::<i32>() {
            Ok(id) => {
                tracing::info!(
                    target: "lcu.cmd",
                    config_path = %config_path,
                    mode = id,
                    "读取无边框窗口模式成功"
                );
                Ok(id)
            }
            Err(_) => {
                tracing::warn!(
                    target: "lcu.cmd",
                    config_path = %config_path,
                    mode_str = %mode_str,
                    "无边框窗口模式字段格式非法"
                );
                Err(format!("配置项格式非法: {}", mode_str))
            }
        }
    } else {
        tracing::warn!(
            target: "lcu.cmd",
            config_path = %config_path,
            "无边框配置缺少 WindowMode 字段"
        );
        Err("配置文件中缺少 WindowMode 项".into())
    }
}

// 设置游戏窗口模式为无边框
#[tauri::command]
pub async fn set_borderless_mode(config_path: &str) -> Result<String, String> {
    tracing::info!(
        target: "lcu.cmd",
        config_path = %config_path,
        "设置游戏为无边框窗口"
    );
    let path = Path::new(config_path);

    if !path.exists() {
        tracing::warn!(
            target: "lcu.cmd",
            config_path = %config_path,
            "无边框配置文件不存在"
        );
        return Err("找不到游戏配置文件，请确认路径是否正确。".into());
    }

    let metadata = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!(
                target: "lcu.cmd",
                config_path = %config_path,
                error = %e,
                "无边框配置文件元数据读取失败"
            );
            return Err(e.to_string());
        }
    };
    let mut permissions = metadata.permissions();
    if permissions.readonly() {
        permissions.set_readonly(false);
        if let Err(e) = fs::set_permissions(path, permissions) {
            tracing::warn!(
                target: "lcu.cmd",
                config_path = %config_path,
                error = %e,
                "无边框配置文件权限调整失败"
            );
            return Err(e.to_string());
        }
    }

    let mut config = Ini::new();
    config.set_comment_symbols(&[';', '#']);
    if let Err(e) = config.load(config_path) {
        tracing::warn!(
            target: "lcu.cmd",
            config_path = %config_path,
            error = %e,
            "无边框配置文件重新读取失败"
        );
        return Err(e.to_string());
    }

    config.set("General", "WindowMode", Some("2".to_string()));

    match config.write(config_path) {
        Ok(_) => {
            tracing::info!(
                target: "lcu.cmd",
                config_path = %config_path,
                "无边框窗口模式写入成功"
            );
            Ok("成功设置为无边框模式".into())
        }
        Err(e) => {
            tracing::error!(
                target: "lcu.cmd",
                config_path = %config_path,
                error = %e,
                "无边框窗口模式写入失败"
            );
            Err(format!("写入文件失败: {}", e))
        }
    }
}