use crate::shaco::{model::ws::LcuSubscriptionType, ws};
use futures_util::stream::StreamExt;
use tauri::{AppHandle, Emitter, EventTarget};

pub async fn listen_client(app: AppHandle) {
    tracing::info!(
        target = "lcu.listener",
        subscription = "/lol-gameflow/v1/gameflow-phase",
        "lcu.listener starting"
    );
    let mut client = match ws::LcuWebsocketClient::connect().await {
        Ok(client) => client,
        Err(error) => {
            tracing::error!(
                target = "lcu.listener",
                error = %error,
                "lcu.listener connect failed"
            );
            return;
        }
    };
    if let Err(error) = client
        .subscribe(LcuSubscriptionType::JsonApiEvent(
            "/lol-gameflow/v1/gameflow-phase".to_string(),
        ))
        .await
    {
        tracing::error!(
            target = "lcu.listener",
            error = %error,
            "lcu.listener subscribe failed"
        );
        return;
    }

    while let Some(event) = client.next().await {
        tracing::trace!(
            target = "lcu.listener",
            event_type = %event.event_type,
            subscription = %event.subscription_type,
            "lcu.listener event"
        );
        if let Err(error) = app.emit_to(
            EventTarget::labeled("background"),
            "client_status",
            event.data,
        ) {
            tracing::warn!(
                target = "lcu.listener",
                error = %error,
                "lcu.listener emit failed"
            );
        }
    }
    tracing::warn!(target = "lcu.listener", "lcu.listener stream ended");
}