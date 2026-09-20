use crate::shaco::{model::ws::LcuSubscriptionType, ws};
use futures_util::stream::StreamExt;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, EventTarget};

/// 最大重连次数：连续失败超过此次数后停止监听。
const MAX_RECONNECT_ATTEMPTS: u32 = 5;
/// 连续稳定运行时间，超过此值后重置 attempt 计数（避免偶发抖动累加到上限）。
const RESET_AFTER_STABLE: Duration = Duration::from_secs(30);
/// 基础退避时间，单位毫秒。按 `attempt` 指数翻倍：1s、2s、4s、8s、16s（最多 16s）。
const BASE_BACKOFF_MS: u64 = 1_000;

/// 启动 LCU 客户端状态 WebSocket 监听，连接断开时按指数退避自动重连。
pub async fn listen_client(app: AppHandle) {
    let mut attempt: u32 = 0;
    loop {
        let started_at = Instant::now();
        match run_one_session(&app).await {
            Ok(SessionOutcome::Stable) => {
                tracing::info!(
                    target = "lcu.ws",
                    "LCU 客户端状态监听流已稳定结束"
                );
            }
            Ok(SessionOutcome::ClosedByServer) => {
                tracing::warn!(
                    target = "lcu.ws",
                    "WS 服务端关闭，准备重连"
                );
            }
            Err(error) => {
                tracing::warn!(
                    target = "lcu.ws",
                    error = %error,
                    "WS 会话异常结束"
                );
            }
        }

        // 连续运行足够久视为健康，重置 attempt 计数。
        if started_at.elapsed() >= RESET_AFTER_STABLE {
            attempt = 0;
        }

        if attempt >= MAX_RECONNECT_ATTEMPTS {
            tracing::error!(
                target = "lcu.ws",
                attempts = attempt,
                "WS 重连次数耗尽，停止监听"
            );
            break;
        }

        attempt += 1;
        let shift = (attempt.saturating_sub(1)).min(4);
        let backoff_ms = BASE_BACKOFF_MS << shift;
        tracing::info!(
            target = "lcu.ws",
            attempt,
            max = MAX_RECONNECT_ATTEMPTS,
            backoff_ms,
            "WS 重连尝试中"
        );
        tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
    }
}

enum SessionOutcome {
    /// 流自然结束（LCU 客户端退出）。
    Stable,
    /// 服务端主动关闭。
    ClosedByServer,
}

async fn run_one_session(app: &AppHandle) -> Result<SessionOutcome, String> {
    tracing::info!(
        target = "lcu.ws",
        subscription = "/lol-gameflow/v1/gameflow-phase",
        "启动 LCU WebSocket 监听"
    );
    let mut client = ws::LcuWebsocketClient::connect().await.map_err(|e| e.to_string())?;
    client
        .subscribe(LcuSubscriptionType::JsonApiEvent(
            "/lol-gameflow/v1/gameflow-phase".to_string(),
        ))
        .await
        .map_err(|e| e.to_string())?;

    while let Some(event) = client.next().await {
        tracing::trace!(
            target = "lcu.ws",
            event_type = %event.event_type,
            subscription = %event.subscription_type,
            "WS 事件"
        );
        if let Err(error) = app.emit_to(
            EventTarget::labeled("background"),
            "client_status",
            event.data,
        ) {
            tracing::warn!(
                target = "lcu.ws",
                error = %error,
                "WS 事件转发到后台失败"
            );
        }
    }
    // 流自然结束视作服务端关闭；走重连流程。
    Ok(SessionOutcome::ClosedByServer)
}